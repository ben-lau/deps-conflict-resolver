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
    'import Vue from "vue"; export const runtime = Vue; export const runtimeVersion = Vue.version;',
  );
  const entry = join(app, 'entry.js');
  writeFileSync(
    entry,
    'import { runtime } from "legacy"; import Vue from "vue2"; export { runtimeVersion } from "legacy"; export { version as hostVersion } from "vue"; export const shared = runtime === Vue;',
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
  assert.equal(ssr.shared, true);

  const ssrDev = {};
  const nativeDirectory = join(app, 'node_modules/native-addon');
  json(join(nativeDirectory, 'package.json'), {
    name: 'native-addon',
    version: '1.0.0',
    main: './index.js',
  });
  writeFileSync(
    join(nativeDirectory, 'index.js'),
    'exports.ready = true; exports.load = () => require("./binding.node");',
  );
  writeFileSync(join(nativeDirectory, 'binding.node'), '');
  for (const commonjs of [false, true]) {
    // Exercise Node-style packages as well as ESM; noExternal alone does not
    // transform CommonJS in the SSR development module runner.
    json(join(legacyDirectory, 'package.json'), {
      name: 'legacy',
      version: '1.0.0',
      type: commonjs ? 'commonjs' : 'module',
      exports: './index.js',
      peerDependencies: { vue: '^2.0.0' },
      dependencies: { 'native-addon': '1.0.0' },
    });
    writeFileSync(
      join(legacyDirectory, 'index.js'),
      commonjs
        ? 'const Vue = require("vue"); const native = require("native-addon"); exports.nativeReady = native.ready; exports.runtime = Vue; exports.runtimeVersion = Vue.version;'
        : 'import Vue from "vue"; export const nativeReady = true; export const runtime = Vue; export const runtimeVersion = Vue.version;',
    );
    writeFileSync(
      entry,
      'import { runtime } from "legacy"; import Vue from "vue2"; export { runtimeVersion, nativeReady } from "legacy"; export { version as hostVersion } from "vue"; export const shared = runtime === Vue;',
    );
    const server = await vite.createServer({
      root: app,
      configFile: false,
      logLevel: 'silent',
      server: { middlewareMode: true, hmr: false },
      plugins: [plugin()],
      optimizeDeps: { force: true },
      ssr: { external: ['native-addon'], optimizeDeps: { force: true } },
    });
    try {
      const result = await server.ssrLoadModule('/entry.js');
      const context = `Vite ${vite.version}, CommonJS=${commonjs}`;
      assert.equal(result.runtimeVersion, legacyVersion, context + ': alias version');
      assert.equal(result.hostVersion, hostVersion, context + ': host version');
      assert.equal(result.nativeReady, true, context + ': external native dependency');
      if (Number.parseInt(vite.version, 10) >= 5 || !commonjs) {
        assert.equal(result.shared, true, context + ': shared alias instance');
      } else {
        // Vite 4.0 resolves Vue 2's import/require branches to separate
        // implementations even without this plugin. Compare with native Vite
        // rather than asserting a stronger guarantee than that engine offers.
        writeFileSync(
          join(legacyDirectory, 'index.js'),
          'const Vue = require("vue2"); exports.nativeReady = true; exports.runtime = Vue; exports.runtimeVersion = Vue.version;',
        );
        const native = await vite.createServer({
          root: app,
          configFile: false,
          logLevel: 'silent',
          server: { middlewareMode: true, hmr: false },
          ssr: {
            noExternal: ['legacy', 'vue2'],
            optimizeDeps: {
              include: ['legacy', 'vue2'],
              disabled: false,
              force: true,
            },
          },
        });
        try {
          const baseline = await native.ssrLoadModule('/entry.js');
          assert.equal(result.shared, baseline.shared, context + ': native instance behavior');
        } finally {
          await native.close();
        }
      }
      ssrDev[commonjs ? 'commonjs' : 'esm'] = {
        host: result.hostVersion,
        legacy: result.runtimeVersion,
        shared: result.shared,
        nativeReady: result.nativeReady,
      };
    } finally {
      await server.close();
    }
  }
  process.stdout.write(
    JSON.stringify(
      {
        vite: vite.version,
        optimizer,
        dev: { host: host.version, legacy: legacy.runtimeVersion },
        ssr: { host: ssr.hostVersion, legacy: ssr.runtimeVersion },
        ssrDev,
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  console.info = originalInfo;
  rmSync(root, { recursive: true, force: true });
}
