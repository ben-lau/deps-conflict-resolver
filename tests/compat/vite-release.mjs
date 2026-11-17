import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// A consumer prefix with this package and the requested Vite version installed.
const prefix = process.argv[2];
if (!prefix) throw new Error('Pass the consumer installation directory');
const consumerRequire = createRequire(join(prefix, 'package.json'));
const { depsConflictResolverVitePlugin } = consumerRequire('deps-conflict-resolver/vite');
const viteManifest = consumerRequire.resolve('vite/package.json');
const { build } = await import(pathToFileURL(join(dirname(viteManifest), 'dist/node/index.js')));

const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'deps-release-vite-')));
async function writePackage(directory, manifest, source) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module', ...manifest }));
  await writeFile(join(directory, 'index.js'), source);
}

try {
  await writeFile(
    join(projectRoot, 'package.json'),
    JSON.stringify({
      name: 'release-vite-consumer',
      version: '1.0.0',
      type: 'module',
      dependencies: {
        vue: '3.5.0',
        vue2: 'npm:vue@2.7.16',
        'legacy-widget': '1.0.0',
      },
    }),
  );
  await writePackage(
    join(projectRoot, 'node_modules/vue'),
    { name: 'vue', version: '3.5.0', exports: './index.js' },
    "export const version = '3.5.0';\n",
  );
  await writePackage(
    join(projectRoot, 'node_modules/vue2'),
    { name: 'vue', version: '2.7.16', exports: './index.js' },
    "export const version = '2.7.16';\n",
  );
  await writePackage(
    join(projectRoot, 'node_modules/legacy-widget'),
    {
      name: 'legacy-widget',
      version: '1.0.0',
      exports: './index.js',
      peerDependencies: { vue: '^2.7.0' },
    },
    "import { version } from 'vue'; export const widgetVersion = version;\n",
  );
  const entry = join(projectRoot, 'entry.js');
  await writeFile(
    entry,
    "import { version } from 'vue'; import { widgetVersion } from 'legacy-widget'; export const hostVersion = version; export { widgetVersion };\n",
  );

  const bundle = await build({
    root: projectRoot,
    configFile: false,
    logLevel: 'silent',
    plugins: [
      depsConflictResolverVitePlugin({
        dependencies: ['legacy-widget'],
        projectRoot,
        autoInstall: false,
        packageManager: 'npm',
      }),
    ],
    build: {
      write: false,
      minify: false,
      lib: { entry, formats: ['es'] },
      rollupOptions: { external: [] },
    },
  });
  const outputs = Array.isArray(bundle) ? bundle : [bundle];
  const chunk = outputs.flatMap((item) => item.output).find((item) => item.type === 'chunk');
  assert.ok(chunk, 'Vite did not produce a JavaScript chunk');
  const result = await import(
    `data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`
  );
  assert.equal(result.hostVersion, '3.5.0');
  assert.equal(result.widgetVersion, '2.7.16');

  const manifest = JSON.parse(await readFile(viteManifest, 'utf8'));
  console.log(`Vite ${manifest.version}: host and conflicting widget resolved correctly`);
} finally {
  await rm(projectRoot, { recursive: true, force: true });
}
