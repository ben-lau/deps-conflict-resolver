import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { buildSync } from 'esbuild';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { runCli } from '../../src/core/cli-runner';
import { createResolver } from '../../src/index';
import { resetGlobalLogLevel } from '../../src/utils/logger';
import { clearPackageJsonCache } from '../../src/utils/fs';
import { mockRegistry } from '../support/registry';
import * as packageManager from '../../src/core/package-manager-adapter';

describe('doctor and prepare commands', () => {
  let root: string;
  let stdout: string;
  let stderr: string;
  const output = {
    stdout: (text: string) => {
      stdout += text;
    },
    stderr: (text: string) => {
      stderr += text;
    },
  };

  function writeAlias(): void {
    const directory = join(root, 'node_modules/vue2');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({ name: 'vue', version: '2.7.16' }),
    );
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'deps-cli-'));
    stdout = '';
    stderr = '';
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'host',
        dependencies: { legacy: '1.0.0', vue: '3.5.0', vue2: 'npm:vue@2.7.16' },
      }),
    );
    for (const [name, manifest] of Object.entries({
      legacy: { name: 'legacy', version: '1.0.0', peerDependencies: { vue: '^2.0.0' } },
      vue: { name: 'vue', version: '3.5.0' },
    })) {
      const directory = join(root, 'node_modules', name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest));
    }
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    resetGlobalLogLevel();
    clearPackageJsonCache();
    vi.restoreAllMocks();
  });

  it('emits clean JSON, discovers runtime dependencies, and leaves files unchanged', async () => {
    writeAlias();
    const fetch = vi.spyOn(globalThis, 'fetch');
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const before = readFileSync(join(root, 'package.json'), 'utf8');
    const code = await runCli(
      ['doctor', '--root', root, '--offline', '--strict', '--json'],
      output,
    );
    const report = JSON.parse(stdout);
    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(report.dependencies).toEqual(['legacy', 'vue']);
    expect(report.activeAliases).toEqual([expect.objectContaining({ aliasName: 'vue2' })]);
    expect(report.diagnostics).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(before);
    expect(info).not.toHaveBeenCalled();
    await createResolver({ projectRoot: root, dependencies: ['legacy'], offline: true });
    expect(info).toHaveBeenCalled();
  });

  it('returns a failing strict status with machine-readable unresolved diagnostics', async () => {
    const code = await runCli(
      ['doctor', 'legacy', '--root', root, '--offline', '--strict', '--json'],
      output,
    );
    expect(code).toBe(1);
    expect(JSON.parse(stdout).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'OFFLINE_ALIAS_MISSING' })]),
    );
    expect(JSON.parse(stdout).actions).toContainEqual(
      expect.objectContaining({
        code: 'OFFLINE_ALIAS_MISSING',
        message: expect.stringContaining('prepare --strict --write-plan'),
      }),
    );
  });

  it('guides init with a minimal offline configuration and only writes a new file on request', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const config = join(root, 'legacy-deps.json');
    expect(await runCli(['init', '--root', root, '--json'], output)).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      suggestedConfig: { dependencies: ['legacy'] },
      installation: null,
    });
    stdout = '';
    expect(await runCli(['init', '--root', root, '--write-config', config], output)).toBe(0);
    expect(JSON.parse(readFileSync(config, 'utf8'))).toEqual({ dependencies: ['legacy'] });
    expect(await runCli(['init', '--root', root, '--write-config', config], output)).toBe(1);
    expect(stderr).toContain('EEXIST');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('suggests a Vue peer override for a broad declaration without changing the plan', async () => {
    writeFileSync(
      join(root, 'node_modules/legacy/package.json'),
      JSON.stringify({ name: 'legacy', version: '1.0.0', peerDependencies: { vue: '>=2' } }),
    );
    writeFileSync(join(root, 'node_modules/legacy/index.js'), 'export default Vue.extend({});');
    expect(
      await runCli(
        ['doctor', 'legacy', '--root', root, '--offline', '--source-hints', '--json'],
        output,
      ),
    ).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      aliases: [],
      diagnostics: [],
      sourceHints: [
        { packageName: 'legacy', config: { peerOverrides: { 'legacy@1.0.0': { vue: '^2' } } } },
      ],
    });
  });

  it('warns when a visible optional peer is incompatible and passes in strict mode', async () => {
    writeFileSync(
      join(root, 'node_modules/legacy/package.json'),
      JSON.stringify({
        name: 'legacy',
        version: '1.0.0',
        peerDependencies: { vue: '^2' },
        peerDependenciesMeta: { vue: { optional: true } },
      }),
    );
    expect(
      await runCli(['doctor', 'legacy', '--root', root, '--offline', '--strict', '--json'], output),
    ).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      aliases: [],
      diagnostics: [{ code: 'OPTIONAL_PEER_MISMATCH', severity: 'warning', packageName: 'vue' }],
    });
  });

  it('reports measured analysis and filesystem work without probing a registry offline', async () => {
    writeAlias();
    expect(
      await runCli(
        ['doctor', 'legacy', '--root', root, '--offline', '--json', '--timings'],
        output,
      ),
    ).toBe(0);
    expect(JSON.parse(stdout).timings).toMatchObject({
      counts: {
        analysisPasses: 1,
        registryRequests: 0,
        packageManagerRuns: 0,
        lookupProbes: expect.any(Number),
        realpaths: expect.any(Number),
        manifestReads: expect.any(Number),
      },
      milliseconds: {
        analysis: expect.any(Number),
        graph: expect.any(Number),
        lockWait: expect.any(Number),
        install: 0,
        registry: 0,
      },
    });
    expect(JSON.parse(stdout).timings.counts.lookupProbes).toBeGreaterThan(0);
    expect(JSON.parse(stdout).timings.counts.manifestReads).toBeGreaterThan(0);
  });

  async function writePlan(dependency = 'legacy'): Promise<string> {
    const code = await runCli(
      ['prepare', dependency, '--root', root, '--strict', '--offline', '--write-plan', '--json'],
      output,
    );
    expect(code, stdout).toBe(0);
    return (JSON.parse(stdout) as { preparedPlan: string }).preparedPlan;
  }

  it.each(['doctor', 'prepare'] as const)(
    'honors the offline contract of a shared prepared-plan config in %s',
    async (command) => {
      const config = join(root, 'offline.json');
      writeFileSync(
        config,
        JSON.stringify({
          dependencies: ['legacy'],
          preparedPlan: true,
          strict: true,
          packageManager: 'npm',
          registry: 'https://unused.invalid/',
        }),
      );
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        throw new Error('Unexpected online query');
      });
      await runCli([command, '--config', config, '--root', root, '--json', '--timings'], output);
      expect(fetch).not.toHaveBeenCalled();
      expect(JSON.parse(stdout)).toMatchObject({
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: 'OFFLINE_ALIAS_MISSING' }),
        ]),
        timings: { counts: { analysisPasses: 1, packageManagerRuns: 0 } },
      });
    },
  );

  it('writes a reusable plan for a workspace with no local node_modules', async () => {
    writeAlias();
    const child = join(root, 'packages/app');
    mkdirSync(child, { recursive: true });
    writeFileSync(
      join(child, 'package.json'),
      JSON.stringify({
        name: 'app',
        dependencies: { legacy: '1.0.0', vue: '3.5.0', vue2: 'npm:vue@2.7.16' },
      }),
    );
    expect(
      await runCli(
        [
          'prepare',
          'legacy',
          '--root',
          child,
          '--package-manager',
          'npm',
          '--offline',
          '--strict',
          '--write-plan',
          '--json',
        ],
        output,
      ),
    ).toBe(0);
    expect(JSON.parse(stdout)).toHaveProperty('preparedPlan');
    const resolver = await createResolver({
      projectRoot: child,
      dependencies: ['legacy'],
      packageManager: 'npm',
      preparedPlan: true,
      strict: true,
    });
    expect(resolver.getTimings().counts).toMatchObject({ planHits: 1, analysisPasses: 0 });
  });

  it('only reuses a plan with the same effective Node package lookup paths', () => {
    rmSync(join(root, 'node_modules/legacy'), { recursive: true });
    const global = join(root, 'global');
    mkdirSync(join(global, 'legacy'), { recursive: true });
    writeFileSync(join(global, 'legacy/package.json'), '{"name":"legacy","version":"1.0.0"}');
    const bundle = join(root, 'resolver.cjs');
    buildSync({
      stdin: {
        contents:
          "export { runCli } from './src/core/cli-runner'; export { createResolver } from './src/index';",
        resolveDir: process.cwd(),
      },
      outfile: bundle,
      bundle: true,
      platform: 'node',
    });
    const script = String.raw`
      const {createResolver, runCli} = require(process.argv[1]);
      const root = process.argv[2];
      const registry = 'https://unused.invalid/';
      console.info = console.warn = () => {};
      (async () => {
        if (process.argv[3] === 'write') {
          process.exitCode = await runCli(['prepare','legacy','--root',root,'--offline','--strict','--write-plan','--json','--package-manager','npm','--registry',registry]);
          return;
        }
        try {
          const result = await createResolver({projectRoot: root, dependencies: ['legacy'], packageManager: 'npm', registry, preparedPlan: true, strict: true});
          console.log(JSON.stringify(result.getTimings().counts));
        } catch (error) {
          console.log(JSON.stringify({codes: error.diagnostics?.map(d => d.code)}));
        }
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    const run = (mode: 'read' | 'write', flags: string[] = []) =>
      JSON.parse(
        execFileSync(process.execPath, [...flags, '-e', script, bundle, root, mode], {
          env: { ...process.env, NODE_PATH: global },
          encoding: 'utf8',
        }),
      );
    expect(run('write')).toHaveProperty('preparedPlan');
    expect(run('read')).toMatchObject({ planHits: 1 });
    expect(run('read', ['--no-global-search-paths'])).toEqual({
      codes: expect.arrayContaining(['DEPENDENCY_NOT_FOUND']),
    });
  });

  it('uses the persisted plan without analysis, network, or installation and verifies provider links', async () => {
    const first = join(root, 'first-vue2');
    const second = join(root, 'second-vue2');
    const providerLink = join(root, 'node_modules/vue2');
    for (const directory of [first, second]) {
      mkdirSync(directory);
      writeFileSync(
        join(directory, 'package.json'),
        JSON.stringify({ name: 'vue', version: '2.7.16' }),
      );
    }
    symlinkSync(first, providerLink, 'junction');
    await writePlan();
    const fetch = vi.spyOn(globalThis, 'fetch');
    const start = () =>
      createResolver({
        projectRoot: root,
        dependencies: ['legacy'],
        strict: true,
        preparedPlan: true,
      });
    const hit = await start();
    expect(hit.getAliasPathMappings()[0]?.path).toMatch(/[/\\]first-vue2$/);
    expect(hit.getTimings().counts).toMatchObject({
      analysisPasses: 0,
      planHits: 1,
      registryRequests: 0,
      packageManagerRuns: 0,
    });
    expect(hit.getInstallResult()).toBeNull();

    rmSync(providerLink);
    symlinkSync(second, providerLink, 'junction');
    const changed = await start();
    expect(changed.getAliasPathMappings()[0]?.path).toMatch(/[/\\]second-vue2$/);
    expect(changed.getTimings().counts).toMatchObject({
      analysisPasses: 1,
      planMisses: 1,
      registryRequests: 0,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('invalidates an empty plan when a previously absent dependency appears', async () => {
    writeFileSync(
      join(root, 'node_modules/legacy/package.json'),
      JSON.stringify({ name: 'legacy', version: '1.0.0', dependencies: { child: '1.0.0' } }),
    );
    const file = await writePlan();
    const start = () =>
      createResolver({ projectRoot: root, dependencies: ['legacy'], preparedPlan: true });
    const hit = await start();
    expect(hit.getAliasPathMappings()).toEqual([]);
    expect(hit.getTimings().counts.analysisPasses).toBe(0);

    const child = join(root, 'node_modules/child');
    mkdirSync(child);
    writeFileSync(
      join(child, 'package.json'),
      JSON.stringify({ name: 'child', version: '1.0.0', peerDependencies: { vue: '^2' } }),
    );
    const changed = await start();
    expect(changed.getTimings().counts.planMisses).toBe(1);
    expect(changed.getDiagnostics()).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'TRANSITIVE_PEER_CONFLICT' })]),
    );
    writeFileSync(file, '{"payload":"corrupt"}');
    expect((await start()).getTimings().counts.analysisPasses).toBe(1);
  });

  it.each([
    ['cjs', 'module.exports = '],
    ['mjs', 'export default '],
    ['json', ''],
  ])(
    'loads entry points and peer overrides from an explicit %s file',
    async (extension, prefix) => {
      writeAlias();
      const file = join(root, `my resolver options.${extension}`);
      writeFileSync(
        file,
        prefix +
          JSON.stringify({
            dependencies: ['legacy'],
            offline: true,
            strict: true,
            peerOverrides: { legacy: { vue: '^2' } },
          }),
      );
      writeFileSync(
        join(root, 'node_modules/legacy/package.json'),
        JSON.stringify({ name: 'legacy', version: '1.0.0', peerDependencies: { vue: '>=2' } }),
      );
      expect(
        await runCli(
          ['prepare', '--root', root, '--config', relative(process.cwd(), file), '--json'],
          output,
        ),
      ).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({
        dependencies: ['legacy'],
        activeAliases: [expect.objectContaining({ aliasName: 'vue2' })],
        diagnostics: [],
        installation: null,
      });
    },
  );

  it('gives CLI flags and positional package names priority over the imported options', async () => {
    const file = join(root, 'options.cjs');
    writeFileSync(
      file,
      'module.exports = ' +
        JSON.stringify({
          projectRoot: join(root, 'other'),
          packageManager: 'pnpm',
          dependencies: ['missing'],
          offline: false,
          strict: true,
        }),
    );
    const code = await runCli(
      [
        'doctor',
        'vue',
        '--config',
        file,
        '--root',
        root,
        '--package-manager',
        'npm',
        '--offline',
        '--json',
      ],
      output,
    );
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      projectRoot: root,
      packageManager: 'npm',
      dependencies: ['vue'],
    });
  });

  it('only loads an options file explicitly requested by the CLI', async () => {
    writeAlias();
    writeFileSync(join(root, 'deps-conflict-resolver.config.json'), '{broken JSON');
    expect(
      await runCli(['doctor', '--root', root, '--offline', '--strict', '--json'], output),
    ).toBe(0);
    expect(JSON.parse(stdout).dependencies).toEqual(['legacy', 'vue']);
    const importer = join(root, 'node_modules/legacy/index.js');
    writeFileSync(importer, 'import "vue";');
    const resolver = await createResolver({
      projectRoot: root,
      dependencies: ['legacy'],
      offline: true,
      strict: true,
    });
    expect(resolver.resolveModule('vue', importer)).toBe('vue2');
  });

  it('identifies invalid imported options before preparing the project', async () => {
    const manifest = join(root, 'package.json');
    const before = readFileSync(manifest, 'utf8');
    const file = join(root, 'options.cjs');
    writeFileSync(file, 'module.exports = { dependencies: ["legacy"], offline: "true" };');
    expect(await runCli(['prepare', '--root', root, '--config', file, '--json'], output)).toBe(1);
    expect(JSON.parse(stdout).error).toMatch(/options\.cjs.*offline/);
    expect(readFileSync(manifest, 'utf8')).toBe(before);
  });

  it('treats undefined settings in a frozen config as omitted', async () => {
    writeAlias();
    const file = join(root, 'options.cjs');
    writeFileSync(
      file,
      'module.exports = Object.freeze({ dependencies: undefined, registry: undefined, packageManager: undefined, strict: true, offline: true });',
    );
    expect(await runCli(['doctor', '--root', root, '--config', file, '--json'], output)).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      dependencies: ['legacy', 'vue'],
      activeAliases: [expect.objectContaining({ aliasName: 'vue2' })],
      diagnostics: [],
    });
  });

  it.each([false, true])(
    'only scans an optional dependency automatically when installed: %s',
    async (installed) => {
      writeAlias();
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      manifest.optionalDependencies = { 'platform-addon': '1.0.0' };
      writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
      if (installed) {
        const directory = join(root, 'node_modules/platform-addon');
        mkdirSync(directory, { recursive: true });
        writeFileSync(
          join(directory, 'package.json'),
          JSON.stringify({ name: 'platform-addon', version: '1.0.0' }),
        );
      }
      const code = await runCli(
        ['doctor', '--root', root, '--offline', '--strict', '--json'],
        output,
      );
      const report = JSON.parse(stdout);
      expect(code).toBe(0);
      expect(report.dependencies).toEqual(
        installed ? ['legacy', 'platform-addon', 'vue'] : ['legacy', 'vue'],
      );
      expect(report.diagnostics).toEqual([]);
    },
  );

  it.each(['optional', 'required'])(
    'still reports an explicitly requested missing %s dependency',
    async (kind) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({
          name: 'host',
          [kind === 'optional' ? 'optionalDependencies' : 'dependencies']: { missing: '1.0.0' },
        }),
      );
      const code = await runCli(
        ['doctor', 'missing', '--root', root, '--offline', '--strict', '--json'],
        output,
      );
      expect(code).toBe(1);
      expect(JSON.parse(stdout).diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'DEPENDENCY_NOT_FOUND', packageName: 'missing' }),
        ]),
      );
    },
  );

  it('allows a non-strict doctor to report issues without failing the command', async () => {
    const code = await runCli(['doctor', 'legacy', '--root', root, '--offline'], output);
    expect(code).toBe(0);
    expect(stdout).toContain('OFFLINE_ALIAS_MISSING');
  });

  it('still checks missing required dependencies during automatic scanning', async () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'host', dependencies: { missing: '1.0.0' } }),
    );
    const code = await runCli(
      ['doctor', '--root', root, '--offline', '--strict', '--json'],
      output,
    );
    expect(code).toBe(1);
    expect(JSON.parse(stdout).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'DEPENDENCY_NOT_FOUND', packageName: 'missing' }),
      ]),
    );
  });

  it('requires explicit package selection before prepare can write dependencies', async () => {
    expect(await runCli(['prepare', '--root', root], output)).toBe(1);
    expect(stderr).toContain('requires at least one dependency');
  });

  it('keeps prepare offline when requested', async () => {
    writeAlias();
    const code = await runCli(['prepare', 'legacy', '--root', root, '--offline', '--json'], output);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).installation).toBeNull();
  });

  it('reports a strict preparation error before installing any planned aliases', async () => {
    writeFileSync(
      join(root, 'node_modules/legacy/package.json'),
      JSON.stringify({
        name: 'legacy',
        version: '1.0.0',
        peerDependencies: { vue: '^2', missing: '^1' },
      }),
    );
    mockRegistry({ name: 'vue', version: '2.7.16' });
    const install = vi.fn().mockResolvedValue({ success: false, errors: ['unexpected install'] });
    vi.spyOn(packageManager, 'createPackageManagerAdapter').mockReturnValue({ install });

    const code = await runCli(['prepare', 'legacy', '--root', root, '--strict', '--json'], output);
    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({
      schemaVersion: 1,
      command: 'prepare',
      aliases: [expect.objectContaining({ aliasName: 'aliased-vue2' })],
      diagnostics: [expect.objectContaining({ code: 'PEER_NOT_DECLARED', packageName: 'missing' })],
      installation: null,
      activeAliases: [],
    });
    expect(install).not.toHaveBeenCalled();
  });

  it('inherits package-manager registry settings and keeps install errors printed to stdout', async () => {
    mockRegistry({ name: 'vue', version: '2.7.16' });
    const adapter = vi.spyOn(packageManager, 'createPackageManagerAdapter').mockReturnValue({
      install: vi.fn().mockResolvedValue({
        success: false,
        exitCode: 1,
        stdout: 'ERR_PNPM_ADDING_TO_ROOT',
        stderr: 'warning from package manager',
        timedOut: false,
      }),
    });

    expect(
      await runCli(
        ['prepare', 'legacy', '--root', root, '--package-manager', 'pnpm', '--json'],
        output,
      ),
    ).toBe(1);
    const report = JSON.parse(stdout);
    expect(report.installation.errors[0]).toContain('ERR_PNPM_ADDING_TO_ROOT');
    expect(adapter.mock.calls[0]?.[0].registry).toBeUndefined();
  });

  it.each([['--unknown'], ['--root'], ['--package-manager', 'unknown']])(
    'rejects invalid options %j',
    async (...args) => {
      expect(await runCli(['doctor', ...args, '--json'], output)).toBe(1);
      expect(JSON.parse(stdout).error).toBeTypeOf('string');
    },
  );

  it('prints help without analyzing the project', async () => {
    expect(await runCli(['--help'], output)).toBe(0);
    expect(stdout).toContain('doctor');
    expect(stdout).toContain('--offline');
  });
});
