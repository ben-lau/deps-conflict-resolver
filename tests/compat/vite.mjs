import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const engineRoot = resolve(process.argv[2] ?? repository);
const root = mkdtempSync(join(tmpdir(), 'deps-vite-compat-'));
const originalInfo = console.info;
console.info = () => {};
function json(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}
function link(target, path) {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
}
try {
  link(join(engineRoot, 'node_modules/vite'), join(root, 'node_modules/vite'));
  for (const name of ['semver', 'yaml'])
    link(join(repository, 'node_modules', name), join(root, 'node_modules', name));
  const pluginRoot = join(root, 'node_modules/deps-conflict-resolver');
  mkdirSync(pluginRoot, { recursive: true });
  cpSync(join(repository, 'dist'), join(pluginRoot, 'dist'), { recursive: true });
  json(join(pluginRoot, 'package.json'), {
    name: 'deps-conflict-resolver',
    type: 'module',
    exports: { './vite': './dist/vite.js' },
  });
  const vite = await import(pathToFileURL(join(root, 'node_modules/vite/dist/node/index.js')).href);
  const { depsConflictResolverVitePlugin } = await import(
    pathToFileURL(join(pluginRoot, 'dist/vite.js')).href
  );
  const app = join(root, 'app');
  const repositoryRequire = createRequire(join(repository, 'package.json'));
  const vue3Manifest = repositoryRequire.resolve('vue/package.json');
  const vue2Manifest = repositoryRequire.resolve('vue2/package.json');
  const hostVersion = JSON.parse(readFileSync(vue3Manifest, 'utf8')).version;
  const legacyVersion = JSON.parse(readFileSync(vue2Manifest, 'utf8')).version;
  json(join(app, 'package.json'), {
    name: 'compat-app',
    type: 'module',
    dependencies: { legacy: '1.0.0', vue: hostVersion, vue2: 'npm:vue@' + legacyVersion },
  });
  link(dirname(vue3Manifest), join(app, 'node_modules/vue'));
  link(dirname(vue2Manifest), join(app, 'node_modules/vue2'));
  const legacyDirectory = join(app, 'node_modules/legacy');
  json(join(legacyDirectory, 'package.json'), {
    name: 'legacy',
    version: '1.0.0',
    type: 'module',
    exports: './index.js',
    peerDependencies: { vue: '^2.0.0' },
  });
  writeFileSync(
    join(legacyDirectory, 'index.js'),
    'import Vue from "vue"; export const runtimeVersion = Vue.version;',
  );
  const entry = join(app, 'entry.js');
  writeFileSync(
    entry,
    'export { runtimeVersion } from "legacy"; export { version as hostVersion } from "vue";',
  );
  const plugin = () =>
    depsConflictResolverVitePlugin({
      dependencies: ['legacy'],
      offline: true,
      strict: true,
      ssr: 'auto',
    });
  const config = await vite.resolveConfig(
    {
      root: app,
      configFile: false,
      logLevel: 'silent',
      plugins: [plugin()],
      optimizeDeps: { include: ['legacy', 'vue'], noDiscovery: true },
    },
    'serve',
  );
  const optimizer = Number.parseInt(vite.version, 10) >= 8 ? 'rolldown' : 'esbuild';
  if (optimizer === 'rolldown') {
    assert(
      config.optimizeDeps.rolldownOptions.plugins.some(
        (p) => p.name === 'deps-conflict-resolver-rolldown',
      ),
    );
  }
  const metadata = await vite.optimizeDeps(config, true);
  const legacy = await import(pathToFileURL(metadata.optimized.legacy.file).href);
  const host = await import(pathToFileURL(metadata.optimized.vue.file).href);
  assert.equal(legacy.runtimeVersion, legacyVersion);
  assert.equal(host.version, hostVersion);

  await vite.build({
    root: app,
    configFile: false,
    logLevel: 'silent',
    plugins: [plugin()],
    build: { ssr: entry, outDir: join(app, 'dist'), minify: false },
  });
  const ssr = await import(pathToFileURL(join(app, 'dist/entry.js')).href);
  assert.equal(ssr.runtimeVersion, legacyVersion);
  assert.equal(ssr.hostVersion, hostVersion);
  process.stdout.write(
    JSON.stringify(
      {
        vite: vite.version,
        optimizer,
        dev: { host: host.version, legacy: legacy.runtimeVersion },
        ssr: { host: ssr.hostVersion, legacy: ssr.runtimeVersion },
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  console.info = originalInfo;
  rmSync(root, { recursive: true, force: true });
}
