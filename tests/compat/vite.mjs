import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const strict = !args.includes('--non-strict');
const engineRoot = resolve(args.find((arg) => arg !== '--non-strict') ?? repository);
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
function customHook(replacement) {
  return (source, importer) =>
    source === 'vue' && /[\\/]legacy[\\/]/.test(importer ?? '') ? replacement : undefined;
}
function editedHook(source, importer) {
  return source === 'vue' && /[\\/]legacy[\\/]/.test(importer ?? '') ? 'vue2' : undefined;
}
async function hookVersion(bundle, pass) {
  return (await import(pathToFileURL(bundle.optimized.legacy.file).href + '?' + pass))
    .runtimeVersion;
}
function scheduleEdit(change, reject) {
  return setTimeout(() => {
    try {
      change();
    } catch (error) {
      reject(error);
    }
  }, 250);
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
    'import * as namespace from "vue"; export const runtime = namespace.default ?? namespace; export const runtimeVersion = runtime.version;',
  );
  const entry = join(app, 'entry.js');
  writeFileSync(
    entry,
    'import { runtime } from "legacy"; import Vue from "vue2"; export { runtimeVersion } from "legacy"; export { version as hostVersion } from "vue"; export const shared = runtime === Vue;',
  );
  const plugin = (overrides = {}) =>
    depsConflictResolverVitePlugin({
      dependencies: ['legacy'],
      offline: true,
      strict,
      ssr: 'auto',
      ...overrides,
    });
  const optimizerConfig = (overrides, configOptions = {}) =>
    vite.resolveConfig(
      {
        root: app,
        configFile: false,
        logLevel: 'silent',
        plugins: [plugin(overrides)],
        optimizeDeps: { include: ['legacy', 'vue'], noDiscovery: true },
        ...configOptions,
      },
      'serve',
    );
  const config = await optimizerConfig();
  const optimizer = Number.parseInt(vite.version, 10) >= 8 ? 'rolldown' : 'esbuild';
  if (optimizer === 'rolldown') {
    const redirect = config.optimizeDeps.rolldownOptions.plugins.find((candidate) =>
      candidate.name.startsWith('deps-conflict-resolver-rolldown-'),
    );
    assert(redirect);
    if (!strict) {
      const filter = redirect.resolveId.filter?.id;
      assert(filter instanceof RegExp);
      assert(filter.test('vue/dist/vue.esm-bundler.js'));
      assert(!filter.test('vue-extra'));
    }
  }
  const metadata = await vite.optimizeDeps(config, true);
  const legacy = await import(pathToFileURL(metadata.optimized.legacy.file).href);
  const host = await import(pathToFileURL(metadata.optimized.vue.file).href);
  assert.equal(legacy.runtimeVersion, legacyVersion);
  assert.equal(host.version, hostVersion);
  assert.equal((await vite.optimizeDeps(await optimizerConfig(), false)).hash, metadata.hash);
  const changed = await vite.optimizeDeps(
    await optimizerConfig({ excludeRedirects: { vue: ['legacy'] } }),
    false,
  );
  const changedLegacy = await import(
    pathToFileURL(changed.optimized.legacy.file).href + '?changed'
  );
  assert.equal(
    changedLegacy.runtimeVersion,
    hostVersion,
    'Redirect changes must invalidate the optimizer cache',
  );

  const customOptimizer = (beforeResolve, beforeResolveCacheKey, late = false) =>
    optimizerConfig(
      {
        dependencies: [],
        beforeResolveCacheKey,
        hooks: late
          ? {
              onAnalysisComplete() {
                this.beforeResolve = beforeResolve;
              },
            }
          : { beforeResolve },
      },
      {
        cacheDir: join(app, 'cache-custom-hook'),
        optimizeDeps: { include: ['legacy'], noDiscovery: true },
      },
    );
  const legacyHook = customHook('vue2');
  const hostHook = customHook('vue');
  assert.equal(legacyHook.toString(), hostHook.toString());
  const firstHook = await vite.optimizeDeps(await customOptimizer(legacyHook), false);
  assert.equal(await hookVersion(firstHook, 'first'), legacyVersion);
  const secondHook = await vite.optimizeDeps(await customOptimizer(hostHook), false);
  assert.notEqual(firstHook.hash, secondHook.hash);
  assert.equal(await hookVersion(secondHook, 'second'), hostVersion);

  const keyedHook = await vite.optimizeDeps(
    await customOptimizer(legacyHook, 'legacy', true),
    false,
  );
  const warmHook = await vite.optimizeDeps(
    await customOptimizer(legacyHook, 'legacy', true),
    false,
  );
  assert.equal(keyedHook.hash, warmHook.hash);
  assert.equal(await hookVersion(warmHook, 'keyed'), legacyVersion);
  const changedHook = await vite.optimizeDeps(await customOptimizer(hostHook, 'host', true), false);
  assert.notEqual(changedHook.hash, warmHook.hash);
  assert.equal(await hookVersion(changedHook, 'key-changed'), hostVersion);

  const edited = await vite.optimizeDeps(await customOptimizer(editedHook, 'host', true), false);
  assert.notEqual(
    edited.hash,
    changedHook.hash,
    'A hook body change must invalidate the optimizer',
  );
  assert.equal(await hookVersion(edited, 'body-edited'), legacyVersion);

  const hostAlias = join(app, 'host-vue.mjs');
  const aliasOutput = join(app, 'alias-dist');
  writeFileSync(hostAlias, 'export const version = "host-alias";');
  const optimizedGlobalAliases = {};
  for (const [kind, replacement, expectedHost] of [
    ['absolute', hostAlias, 'host-alias'],
    ['subpath', 'vue/dist/vue.esm-bundler.js', hostVersion],
  ]) {
    const configWithAlias = await optimizerConfig(undefined, {
      cacheDir: join(app, 'cache-global-alias-' + kind),
      resolve: { alias: { vue: replacement } },
    });
    const { optimized } = await vite.optimizeDeps(configWithAlias, true);
    const optimizedLegacy = await import(pathToFileURL(optimized.legacy.file).href);
    const optimizedHost = await import(pathToFileURL(optimized.vue.file).href);
    assert.equal(optimizedHost.version, expectedHost);
    assert.equal(optimizedLegacy.runtimeVersion, legacyVersion);
    if (kind === 'subpath') assert(optimized.vue.src.endsWith('/dist/vue.esm-bundler.js'));
    optimizedGlobalAliases[kind] = {
      host: optimizedHost.version,
      legacy: optimizedLegacy.runtimeVersion,
    };
  }

  await vite.build({
    root: app,
    configFile: false,
    logLevel: 'silent',
    plugins: [plugin()],
    resolve: { alias: { vue: hostAlias } },
    build: {
      lib: { entry, formats: ['es'], fileName: () => 'entry.mjs' },
      outDir: aliasOutput,
    },
  });
  const aliased = await import(pathToFileURL(join(aliasOutput, 'entry.mjs')).href);
  assert.equal(aliased.hostVersion, 'host-alias');
  assert.equal(aliased.runtimeVersion, legacyVersion);

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
        depsConflictResolverVitePlugin({ dependencies: ['legacy'], offline: true, strict }),
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
  const workers = {};
  writeFileSync(
    join(finalRoot, 'worker-entry.mjs'),
    'import {version} from "legacy";globalThis.mainVersion=version;new Worker(new URL("./worker.mjs",import.meta.url),{type:"module"});',
  );
  writeFileSync(
    join(finalRoot, 'worker.mjs'),
    'import {version} from "legacy";self.postMessage(version);',
  );
  for (const mode of ['dedicated', 'both', 'shared']) {
    let mainAnalyses = 0;
    let workerAnalyses = 0;
    const makePlugin = (worker) =>
      depsConflictResolverVitePlugin({
        dependencies: ['legacy'],
        offline: true,
        strict,
        ...(strict && {
          hooks: {
            onAnalysisComplete: () => {
              if (worker) workerAnalyses++;
              else mainAnalyses++;
            },
          },
        }),
      });
    const mainPlugin = makePlugin(false);
    const workerPlugins = () => [mode === 'shared' ? mainPlugin : makePlugin(true)];
    const output = await vite.build({
      root: finalRoot,
      configFile: false,
      logLevel: 'silent',
      plugins: mode === 'dedicated' ? [] : [mainPlugin],
      worker: {
        plugins: Number.parseInt(vite.version, 10) === 4 ? workerPlugins() : workerPlugins,
      },
      build: {
        write: false,
        minify: false,
        rollupOptions: { input: join(finalRoot, 'worker-entry.mjs') },
      },
    });
    const outputs = (Array.isArray(output) ? output : [output]).flatMap((result) => result.output);
    const asset = outputs.find(
      (result) => result.type === 'asset' && result.fileName.endsWith('.js'),
    );
    assert(asset, 'Worker output is missing');
    const messages = [];
    runInNewContext(
      typeof asset.source === 'string' ? asset.source : Buffer.from(asset.source).toString(),
      {
        self: { postMessage: (value) => messages.push(value) },
      },
    );
    assert.deepEqual(messages, ['2.7.16']);
    if (strict) {
      assert.equal(mainAnalyses, mode === 'dedicated' ? 0 : 1);
      assert.equal(workerAnalyses, mode === 'shared' ? 0 : 1);
    }
    const mainVersion = mode === 'dedicated' ? '3.0.0' : '2.7.16';
    const mainCode = outputs
      .filter((result) => result.type === 'chunk')
      .map((result) => result.code)
      .join('\n');
    assert(mainCode.includes(JSON.stringify(mainVersion)), 'Main instance lost its resolver');
    workers[mode] = { version: messages[0], ...(strict && { mainAnalyses, workerAnalyses }) };
  }

  const watchRoot = join(realpathSync(root), 'watch-app');
  json(join(watchRoot, 'package.json'), {
    name: 'watch-app',
    dependencies: { legacy: 'file:linked', vue: '3.0.0', vue2: 'npm:vue@2.7.16' },
  });
  for (const [request, version] of [
    ['vue', '3.0.0'],
    ['vue2', '2.7.16'],
  ]) {
    const directory = join(watchRoot, request + '-provider');
    json(join(directory, 'package.json'), {
      name: 'vue',
      version,
      type: 'module',
      main: 'index.js',
    });
    writeFileSync(join(directory, 'index.js'), 'export const version = ' + JSON.stringify(version));
    link(directory, join(watchRoot, 'node_modules', request));
  }
  const watchManifest = join(watchRoot, 'linked/package.json');
  const peer = (range) =>
    json(watchManifest, {
      name: 'legacy',
      version: '1.0.0',
      type: 'module',
      main: 'index.js',
      peerDependencies: { vue: range },
    });
  peer('^3');
  link(join(watchRoot, 'linked'), join(watchRoot, 'node_modules/legacy'));
  writeFileSync(join(watchRoot, 'linked/index.js'), 'export { version } from "vue";');
  writeFileSync(join(watchRoot, 'entry.mjs'), 'export { version } from "legacy";');
  const watchConfig = (preparedPlan = false) => ({
    root: watchRoot,
    configFile: false,
    logLevel: 'silent',
    plugins: [
      depsConflictResolverVitePlugin({
        dependencies: ['legacy'],
        offline: true,
        strict,
        preparedPlan,
        debug: preparedPlan,
      }),
    ],
    build: {
      minify: false,
      outDir: join(watchRoot, 'dist'),
      lib: { entry: join(watchRoot, 'entry.mjs'), formats: ['cjs'], fileName: () => 'watch.cjs' },
      rollupOptions: { output: { entryFileNames: 'watch.cjs' } },
      watch: { chokidar: { usePolling: true, interval: 30 } },
    },
  });
  const watcher = await vite.build(watchConfig());
  const watchOutput = join(watchRoot, 'dist/watch.cjs');
  const watchVersions = [];
  let timeout;
  let edit;
  try {
    await new Promise((complete, reject) => {
      timeout = setTimeout(
        () => reject(new Error('Watch produced ' + watchVersions.join(', '))),
        5000,
      );
      watcher.on('event', (event) => {
        if (event.code === 'ERROR') return reject(event.error);
        if (event.code !== 'END') return undefined;
        try {
          delete repositoryRequire.cache[watchOutput];
          const version = repositoryRequire(watchOutput).version;
          if (version === watchVersions.at(-1)) return undefined;
          watchVersions.push(version);
          if (watchVersions.length === 3) complete();
          else edit = setTimeout(() => peer(watchVersions.length === 1 ? '^2' : '^3'), 100);
        } catch (error) {
          reject(error);
        }
        return undefined;
      });
    });
    assert.deepEqual(watchVersions, ['3.0.0', '2.7.16', '3.0.0']);
  } finally {
    clearTimeout(timeout);
    clearTimeout(edit);
    await watcher.close();
  }

  const nativeWatch = Number(vite.version.split('.')[0]) >= 8;
  const installed = (name) => join(watchRoot, 'node_modules', name);
  const replaceLink = (name, target) => {
    const replacement = installed('provider-replacement');
    const slot = installed(name);
    link(target, replacement);
    if (process.platform === 'win32') rmSync(slot);
    renameSync(replacement, slot);
  };
  const readWatchOutput = () => {
    delete repositoryRequire.cache[watchOutput];
    return repositoryRequire(watchOutput).version;
  };
  const verifyRelink = async (settings, previous, output, change) => {
    const replacing = await vite.build(settings);
    let pendingEdit;
    let deadline;
    try {
      const result = await new Promise((complete, reject) => {
        deadline = setTimeout(() => reject(new Error('Link replacement did not rebuild')), 5000);
        replacing.on('event', (event) => {
          try {
            if (event.code === 'ERROR') {
              if (!nativeWatch) return reject(event.error);
              assert.match(String(event.error), /Restart vite build --watch/);
              assert.equal(readWatchOutput(), previous);
              return complete('restart required');
            }
            if (event.code !== 'END') return;
            const version = readWatchOutput();
            if (version === output) return complete(version);
            assert.equal(version, previous);
            pendingEdit ??= scheduleEdit(change, reject);
          } catch (error) {
            reject(error);
          }
        });
      });
      assert.equal(result, nativeWatch ? 'restart required' : output);
      return result;
    } finally {
      clearTimeout(deadline);
      clearTimeout(pendingEdit);
      await replacing.close();
    }
  };
  const retargetedProviders = {};
  for (const [name, range, previous, output] of [
    ['vue2', '^2', '2.7.16', 'retargeted'],
    ['legacy', '^2', '2.7.16', 'new-entry:2.7.16'],
    ['vue', '^3', '3.0.0', 'retargeted'],
  ]) {
    peer(range);
    const original = realpathSync(installed(name));
    const newProvider = join(watchRoot, 'replacement-' + name);
    cpSync(original, newProvider, { recursive: true });
    writeFileSync(
      join(newProvider, 'index.js'),
      name === 'legacy'
        ? 'import {version as peer} from "vue"; export const version = "new-entry:" + peer;'
        : 'export const version = "retargeted";',
    );
    try {
      retargetedProviders[name] = await verifyRelink(watchConfig(), previous, output, () =>
        replaceLink(name, newProvider),
      );
    } finally {
      replaceLink(name, original);
    }
  }

  // A valid plan must carry enough path information to detect a moved
  // transitive dependency even when this compilation never traversed the graph.
  const linkedEntry = join(watchRoot, 'linked/index.js');
  const originalAlias = realpathSync(installed('vue2'));
  const childManifest = {
    name: 'watch-child',
    version: '1.0.0',
    type: 'module',
    main: 'index.js',
    peerDependencies: { vue: '^2' },
  };
  const childTargets = ['original-child', 'new-child'].map((name) => {
    const directory = join(watchRoot, name);
    json(join(directory, 'package.json'), childManifest);
    writeFileSync(
      join(directory, 'index.js'),
      'import { version as peer } from "vue"; export const version = ' +
        JSON.stringify(name + ':') +
        ' + peer;',
    );
    return directory;
  });
  link(childTargets[0], installed('watch-child'));
  peer('^2');
  json(watchManifest, {
    ...JSON.parse(readFileSync(watchManifest, 'utf8')),
    dependencies: { 'watch-child': '1' },
  });
  writeFileSync(linkedEntry, 'export { version } from "watch-child";');
  const plan = JSON.parse(
    execFileSync(
      process.execPath,
      [
        join(pluginRoot, 'dist/cli.js'),
        'prepare',
        'legacy',
        '--offline',
        '--strict',
        '--write-plan',
        '--json',
      ],
      { cwd: watchRoot, encoding: 'utf8' },
    ),
  );
  assert(plan.preparedPlan);
  const prepared = watchConfig(true);
  let planHit = false;
  prepared.logLevel = 'info';
  prepared.customLogger = vite.createLogger('silent');
  prepared.customLogger.info = (message) => {
    if (/planHits: 1\b/.test(message)) planHit = true;
  };
  retargetedProviders.transitive = await verifyRelink(
    prepared,
    'original-child:2.7.16',
    'new-child:2.7.16',
    () => {
      replaceLink('watch-child', childTargets[1]);
      writeFileSync(join(watchRoot, 'entry.mjs'), 'export { version } from "legacy"; // changed');
    },
  );
  assert(planHit, 'The offline plan did not hit');
  writeFileSync(linkedEntry, 'export { version } from "vue";');
  peer('^2');

  const reactivating = await vite.build(watchConfig());
  try {
    retargetedProviders.reactivated = await new Promise((complete, reject) => {
      let stage = 0;
      timeout = setTimeout(() => reject(new Error('Reactivated alias did not rebuild')), 5000);
      reactivating.on('event', (event) => {
        try {
          if (event.code === 'ERROR') {
            assert(nativeWatch && stage === 2, String(event.error));
            assert.match(String(event.error), /Restart vite build --watch/);
            assert.equal(readWatchOutput(), '3.0.0');
            return complete('restart required');
          }
          if (event.code !== 'END') return;
          const output = readWatchOutput();
          if (stage === 0) {
            assert.equal(output, '2.7.16');
            stage++;
            edit = scheduleEdit(() => peer('^3'), reject);
          } else if (stage === 1 && output === '3.0.0') {
            stage++;
            edit = scheduleEdit(() => {
              replaceLink('vue2', join(watchRoot, 'replacement-vue2'));
              peer('^2');
            }, reject);
          } else if (stage === 2 && output === 'retargeted') {
            complete(output);
          } else if (stage === 2) {
            assert.equal(output, '3.0.0');
          }
        } catch (error) {
          reject(error);
        }
      });
    });
    assert.equal(retargetedProviders.reactivated, nativeWatch ? 'restart required' : 'retargeted');
  } finally {
    clearTimeout(timeout);
    clearTimeout(edit);
    await reactivating.close();
    replaceLink('vue2', originalAlias);
  }

  if (nativeWatch) {
    const original = realpathSync(installed('legacy'));
    rmSync(watchOutput);
    const nested = join(original, 'node_modules');
    for (const kind of ['relink', 'nearer peer']) {
      const builder = await vite.createBuilder(watchConfig(), true);
      if (kind === 'relink') replaceLink('legacy', join(watchRoot, 'replacement-legacy'));
      else {
        const provider = join(nested, 'vue');
        json(join(provider, 'package.json'), {
          name: 'vue',
          version: '2.7.16',
          type: 'module',
          main: 'index.js',
        });
        writeFileSync(join(provider, 'index.js'), 'export const version = "nearer-provider";');
      }
      const starting = await builder.build(builder.environments.client);
      edit = undefined;
      try {
        await new Promise((complete, reject) => {
          let retried = false;
          timeout = setTimeout(() => reject(new Error('First watch build did not settle')), 5000);
          starting.on('event', (event) => {
            try {
              if (event.code === 'END') assert.equal(existsSync(watchOutput), false);
              if (event.code !== 'ERROR') return;
              assert.match(String(event.error), /Restart vite build --watch/);
              if (kind === 'relink' || retried) return complete();
              assert.match(String(event.error), /package lookup/);
              edit ??= scheduleEdit(() => {
                retried = true;
                peer('^2');
              }, reject);
            } catch (error) {
              reject(error);
            }
          });
        });
        assert.equal(existsSync(watchOutput), false);
      } finally {
        clearTimeout(timeout);
        clearTimeout(edit);
        await starting.close();
        if (kind === 'relink') replaceLink('legacy', original);
        else rmSync(nested, { recursive: true });
      }
    }
  }
  process.stdout.write(
    JSON.stringify(
      {
        vite: vite.version,
        strict,
        optimizer,
        dev: { host: host.version, legacy: legacy.runtimeVersion },
        changedRedirect: changedLegacy.runtimeVersion,
        globalAlias: { host: aliased.hostVersion, legacy: aliased.runtimeVersion },
        optimizedGlobalAliases,
        ssr: { host: ssr.hostVersion, legacy: ssr.runtimeVersion },
        ssrDev,
        mixedSsrConfig,
        nestedSsrExternal,
        lateRoot,
        workers,
        watchVersions,
        retargetedProviders,
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  console.info = originalInfo;
  rmSync(root, { recursive: true, force: true });
}
