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
      ...(Number.parseInt(vite.version, 10) >= 6
        ? { environments: { ssr: { resolve: { external: ['other-external'] } } } }
        : {}),
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
  let mixedSsrConfig;
  let nestedSsrExternal;
  if (Number.parseInt(vite.version, 10) >= 5) {
    const server = await vite.createServer({
      root: app,
      configFile: false,
      logLevel: 'silent',
      server: { middlewareMode: true, hmr: false },
      plugins: [plugin()],
      ssr: {
        external: true,
        noExternal: ['legacy', 'vue2'],
        optimizeDeps: { force: true },
      },
      environments: { ssr: { resolve: { noExternal: ['other-internal'] } } },
    });
    try {
      const result = await server.ssrLoadModule('/entry.js');
      assert.equal(result.runtimeVersion, legacyVersion);
      assert.equal(result.hostVersion, hostVersion);
      assert.equal(result.shared, true);
      assert.equal(result.nativeReady, true);
      mixedSsrConfig = {
        host: result.hostVersion,
        legacy: result.runtimeVersion,
        shared: result.shared,
        nativeReady: result.nativeReady,
      };
    } finally {
      await server.close();
    }
    const nested = join(legacyDirectory, 'node_modules/nested-native-addon');
    json(join(nested, 'package.json'), {
      name: 'nested-native-addon',
      version: '1.0.0',
      type: 'module',
      exports: { '.': { import: './entry.mjs' } },
    });
    writeFileSync(
      join(nested, 'entry.mjs'),
      'import * as self from "./entry.mjs"; export {self}; export const token = {}; export let value = 0; export function increment(){value++;} export default { ready: true }; export const load = () => import("./binding.node");',
    );
    writeFileSync(join(nested, 'binding.node'), '');
    json(join(legacyDirectory, 'package.json'), {
      name: 'legacy',
      version: '1.0.0',
      type: 'module',
      exports: './index.js',
      peerDependencies: { vue: '^2.0.0' },
      dependencies: { 'nested-native-addon': '1.0.0' },
    });
    writeFileSync(
      join(legacyDirectory, 'index.js'),
      'import Vue from "vue"; import native, * as ns from "nested-native-addon"; export const namespaceStable = ns === ns.self; export const nativeToken = ns.token; export const increment = ns.increment; export function readNative(){return ns.value;} export const runtime = Vue; export const runtimeVersion = Vue.version; export const nativeReady = native.ready;',
    );
    writeFileSync(
      entry,
      readFileSync(entry, 'utf8') +
        '\nexport { namespaceStable, nativeToken, increment, readNative } from "legacy";',
    );
    const originalNative = await import(pathToFileURL(join(nested, 'entry.mjs')).href);
    let nativeMetadata;
    for (let pass = 0; pass < 2; pass++) {
      const esmServer = await vite.createServer({
        root: app,
        configFile: false,
        logLevel: 'silent',
        server: { middlewareMode: true, hmr: false },
        plugins: [plugin()],
        optimizeDeps: { force: pass === 0 },
        ssr: {
          external: true,
          noExternal: ['legacy', 'vue2'],
          optimizeDeps: { force: pass === 0 },
        },
      });
      try {
        const result = await esmServer.ssrLoadModule('/entry.js');
        assert.equal(result.runtimeVersion, legacyVersion);
        assert.equal(result.hostVersion, hostVersion);
        assert.equal(result.shared, true);
        assert.equal(result.nativeReady, true);
        assert.equal(result.namespaceStable, true);
        assert.equal(result.nativeToken, originalNative.token);
        result.increment();
        assert.equal(result.readNative(), originalNative.value);
        assert.equal(originalNative.value, pass + 1);
        const current = readFileSync(
          join(esmServer.config.cacheDir, 'deps_ssr/_metadata.json'),
          'utf8',
        );
        if (nativeMetadata) assert.equal(current, nativeMetadata);
        nativeMetadata = current;
        nestedSsrExternal = {
          shared: result.shared,
          nativeReady: result.nativeReady,
          namespaceStable: result.namespaceStable,
          nativeCache: true,
          warmCache: pass === 1,
        };
      } finally {
        await esmServer.close();
      }
    }
  }
  const lateRoot = {};
  const beforeRoot = join(root, 'before-root');
  const finalRoot = join(root, 'final-root');
  for (const [directory, version] of [
    [beforeRoot, '2.6.14'],
    [finalRoot, '2.7.16'],
  ]) {
    json(join(directory, 'package.json'), {
      name: 'root-fixture',
      dependencies: { legacy: '1', vue: '3', vue2: 'npm:vue@' + version },
    });
    for (const [request, name, v, code] of [
      ['legacy', 'legacy', '1.0.0', 'export {version} from "vue";'],
      ['vue', 'vue', '3.0.0', 'export const version="3.0.0";'],
      ['vue2', 'vue', version, 'export const version=' + JSON.stringify(version) + ';'],
    ]) {
      const packageRoot = join(directory, 'node_modules', request);
      json(join(packageRoot, 'package.json'), {
        name,
        version: v,
        type: 'module',
        main: 'index.js',
        peerDependencies: request === 'legacy' ? { vue: version } : {},
      });
      writeFileSync(join(packageRoot, 'index.js'), code);
    }
    writeFileSync(join(directory, 'entry.mjs'), 'export {version} from "legacy";');
  }
  for (const post of [false, true]) {
    const file = post ? 'post.cjs' : 'normal.cjs';
    await vite.build({
      root: beforeRoot,
      configFile: false,
      logLevel: 'silent',
      plugins: [
        depsConflictResolverVitePlugin({ dependencies: ['legacy'], offline: true, strict: true }),
        {
          name: 'framework-root',
          ...(post ? { enforce: 'post' } : {}),
          config: post
            ? { order: 'post', handler: () => ({ root: finalRoot }) }
            : () => ({ root: finalRoot }),
        },
      ],
      build: {
        lib: { entry: join(finalRoot, 'entry.mjs'), formats: ['cjs'], fileName: () => file },
        outDir: join(finalRoot, 'dist'),
        emptyOutDir: false,
        minify: false,
      },
    });
    const actual = repositoryRequire(join(finalRoot, 'dist', file)).version;
    assert.equal(actual, '2.7.16');
    lateRoot[post ? 'post' : 'normal'] = actual;
  }
  process.stdout.write(
    JSON.stringify(
      {
        vite: vite.version,
        optimizer,
        dev: { host: host.version, legacy: legacy.runtimeVersion },
        ssr: { host: ssr.hostVersion, legacy: ssr.runtimeVersion },
        ssrDev,
        mixedSsrConfig,
        nestedSsrExternal,
        lateRoot,
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  console.info = originalInfo;
  rmSync(root, { recursive: true, force: true });
}
