import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createResolver } from '../../src/core/resolver';
import { runCli } from '../../src/core/cli-runner';
import { resolvePackageManagerInvocation } from '../../src/core/package-manager-adapter';

const run = promisify(execFile);

it('prepares a real npm alias from imported options and reuses it offline after a frozen install', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deps-real-install-'));
  const server = createServer();
  try {
    const packageDir = join(root, 'package-source');
    const tarballs = join(root, 'tarballs');
    await mkdir(packageDir);
    await mkdir(tarballs);
    await writeFile(
      join(packageDir, 'package.json'),
      JSON.stringify({
        name: 'vue',
        version: '2.7.16',
        main: 'index.js',
        files: ['index.js'],
      }),
    );
    await writeFile(join(packageDir, 'index.js'), 'module.exports = { version: "2.7.16" };');
    const invocation = resolvePackageManagerInvocation('npm');
    const packed = await run(
      invocation.command,
      [
        ...invocation.argsPrefix,
        'pack',
        '--json',
        '--ignore-scripts',
        '--pack-destination',
        tarballs,
      ],
      {
        cwd: packageDir,
        env: {
          ...process.env,
          npm_config_cache: join(root, 'npm-cache'),
          npm_config_offline: 'true',
          npm_config_update_notifier: 'false',
        },
        timeout: 10_000,
      },
    );
    const filename = (JSON.parse(packed.stdout) as Array<{ filename: string }>)[0]!.filename;
    const tarball = await readFile(join(tarballs, filename));

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing registry address');
    const registry = 'http://127.0.0.1:' + address.port;
    const manifest = {
      name: 'vue',
      version: '2.7.16',
      main: 'index.js',
      dist: {
        tarball: registry + '/vue/-/' + filename,
        shasum: createHash('sha1').update(tarball).digest('hex'),
        integrity: 'sha512-' + createHash('sha512').update(tarball).digest('base64'),
      },
    };
    let requests = 0;
    server.on('request', (request, response) => {
      requests++;
      if (request.url === '/vue/-/' + filename) {
        response.end(tarball);
      } else if (request.url === '/vue/2.7.16') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(manifest));
      } else if (request.url === '/vue') {
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify({
            name: 'vue',
            'dist-tags': { latest: '2.7.16' },
            versions: { '2.7.16': manifest },
          }),
        );
      } else {
        response.statusCode = 404;
        response.end('{}');
      }
    });

    for (const [name, version, peers] of [
      ['vue', '3.5.0', {}],
      ['legacy', '1.0.0', { vue: '>=2' }],
    ] as const) {
      for (const directory of [join(root, 'fixtures', name), join(root, 'node_modules', name)]) {
        await mkdir(directory, { recursive: true });
        await writeFile(
          join(directory, 'package.json'),
          JSON.stringify({ name, version, main: 'index.js', peerDependencies: peers }),
        );
        await writeFile(join(directory, 'index.js'), 'module.exports = {};');
      }
    }
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'real-install-host',
        private: true,
        dependencies: { vue: 'file:fixtures/vue', legacy: 'file:fixtures/legacy' },
      }),
    );
    await writeFile(
      join(root, '.npmrc'),
      [
        'cache=' + join(root, 'npm-cache'),
        'ignore-scripts=true',
        'audit=false',
        'fund=false',
        'fetch-retries=0',
        'fetch-timeout=3000',
        'update-notifier=false',
      ].join('\n'),
    );

    const options = {
      dependencies: ['legacy'],
      peerOverrides: { legacy: { vue: '^2' } },
      aliasPrefix: 'compat-',
      packageManager: 'npm' as const,
      registry,
      strict: true,
    };
    const configFile = join(root, 'resolver-options.mjs');
    await writeFile(configFile, 'export default ' + JSON.stringify(options));
    let report = '';
    let error = '';
    const exit = await runCli(['prepare', '--root', root, '--config', configFile, '--json'], {
      stdout: (text) => {
        report += text;
      },
      stderr: (text) => {
        error += text;
      },
    });
    expect(exit, report + error).toBe(0);
    expect(JSON.parse(report).installation).toMatchObject({
      success: true,
      installed: ['compat-vue2'],
      failed: [],
    });
    const installed = JSON.parse(
      await readFile(join(root, 'node_modules/compat-vue2/package.json'), 'utf8'),
    );
    expect(installed).toMatchObject({ name: 'vue', version: '2.7.16' });
    expect(
      JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).dependencies['compat-vue2'],
    ).toBe('npm:vue@2.7.16');
    const importer = await realpath(join(root, 'node_modules/legacy/index.js'));

    const before = await Promise.all(
      ['package.json', 'package-lock.json'].map((file) => readFile(join(root, file), 'utf8')),
    );
    await run(
      invocation.command,
      [...invocation.argsPrefix, 'ci', '--legacy-peer-deps', '--ignore-scripts'],
      { cwd: root, env: { ...process.env, npm_config_registry: registry }, timeout: 10_000 },
    );
    const requestCount = requests;
    const offline = await createResolver({ ...options, projectRoot: root, offline: true });
    expect(offline.resolveModule('vue', importer)).toBe('compat-vue2');
    expect(offline.getInstallResult()).toBeNull();
    expect(requests).toBe(requestCount);
    expect(
      await Promise.all(
        ['package.json', 'package-lock.json'].map((file) => readFile(join(root, file), 'utf8')),
      ),
    ).toEqual(before);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
