import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  promises as fs,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { AsyncResource } from 'node:async_hooks';
import { expect, it, vi } from 'vitest';
import webpack from 'webpack';
import { DepsConflictResolverWebpackPlugin } from '../../src/plugins/webpack';
import { getProjectPreparation, withProjectPreparation } from '../../src/core/project-preparation';
import { clearPackageJsonCache } from '../../src/utils/fs';

const require = createRequire(import.meta.url);

function json(directory: string, value: object): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify(value));
}

function observeAnalyses() {
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  return {
    count: () =>
      log.mock.calls.filter(([, message]) => message === 'Starting dependency analysis...').length,
    restore: () => log.mockRestore(),
  };
}

function linkedConsumerFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'deps-webpack-watch-preparation-')));
  const consumer = join(root, 'packages', 'legacy');
  const manifest = { name: 'legacy', version: '1.0.0', peerDependencies: { vue: '^2' } };
  json(root, {
    name: 'host',
    workspaces: ['packages/*'],
    dependencies: { legacy: '1.0.0', vue: '3.0.0', vue2: 'npm:vue@2.7.16' },
  });
  for (const [name, version] of [
    ['vue', '3.0.0'],
    ['vue2', '2.7.16'],
  ] as const) {
    const directory = join(root, 'node_modules', name);
    json(directory, { name: 'vue', version });
    writeFileSync(join(directory, 'index.js'), `module.exports = '${version}';`);
  }
  json(consumer, manifest);
  writeFileSync(join(consumer, 'index.js'), 'module.exports = require("vue");');
  symlinkSync(consumer, join(root, 'node_modules', 'legacy'), 'junction');
  return { root, consumer, manifest, entry: join(root, 'entry.cjs'), dist: join(root, 'dist') };
}

it('attempts permissive preparation once per ordinary run and recovers on the next run', async () => {
  const { root, entry, dist } = linkedConsumerFixture();
  const output = join(dist, 'entry.cjs');
  writeFileSync(entry, 'module.exports = require("legacy");');
  const logger = vi.spyOn(console, 'error').mockImplementation(() => {});
  let broken = true;
  const onAnalysisComplete = vi.fn(() => {
    if (broken) throw new Error('Analysis hook failed');
  });
  const compiler = webpack({
    context: root,
    mode: 'development',
    target: 'node',
    entry,
    output: { path: dist, filename: 'entry.cjs', library: { type: 'commonjs2' } },
    plugins: [
      new DepsConflictResolverWebpackPlugin({
        dependencies: ['legacy'],
        offline: true,
        hooks: { onAnalysisComplete },
      }),
    ],
  });
  async function compile() {
    const stats = await new Promise<webpack.Stats>((resolve, reject) => {
      compiler.run((error, value) => (error || !value ? reject(error) : resolve(value)));
    });
    expect(stats.hasErrors(), stats.toString({ all: false, errors: true })).toBe(false);
    delete require.cache[output];
    return require(output);
  }
  try {
    expect(await compile()).toBe('3.0.0');
    expect(onAnalysisComplete).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledTimes(1);
    broken = false;
    expect(await compile()).toBe('2.7.16');
    expect(onAnalysisComplete).toHaveBeenCalledTimes(2);
  } finally {
    await new Promise<void>((resolve, reject) =>
      compiler.close((error) => (error ? reject(error) : resolve())),
    );
    logger.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

it('resolves a hook-relative request from the original importer', async () => {
  const { root, consumer, entry, dist } = linkedConsumerFixture();
  writeFileSync(entry, 'module.exports = require("legacy");');
  writeFileSync(join(consumer, 'shim.cjs'), 'module.exports = "from-importer";');
  writeFileSync(join(root, 'shim.cjs'), 'module.exports = "from-host";');
  const compiler = webpack({
    context: root,
    mode: 'development',
    target: 'node',
    entry,
    output: { path: dist, filename: 'entry.cjs', library: { type: 'commonjs2' } },
    plugins: [
      new DepsConflictResolverWebpackPlugin({
        dependencies: ['legacy'],
        offline: true,
        strict: true,
        hooks: { beforeResolve: (request) => (request === 'vue' ? './shim.cjs' : undefined) },
      }),
    ],
  });
  try {
    const stats = await new Promise<webpack.Stats>((resolve, reject) => {
      compiler.run((error, value) => (error || !value ? reject(error) : resolve(value)));
    });
    expect(stats.hasErrors(), stats.toString({ all: false, errors: true })).toBe(false);
    expect(require(join(dist, 'entry.cjs'))).toBe('from-importer');
  } finally {
    await new Promise<void>((resolve, reject) =>
      compiler.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(root, { recursive: true, force: true });
  }
});

it.each([false, true])(
  'updates watch output and retains unrelated caches: legacy hooks=%s',
  async (legacyHooks) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'deps-webpack-watch-')));
    json(root, {
      name: 'host',
      dependencies: { legacy: '1.0.0', vue: '3.0.0', vue2: 'npm:vue@2.7.16' },
    });
    for (const [alias, version] of [
      ['vue', '3.0.0'],
      ['vue2', '2.7.16'],
    ]) {
      const directory = join(root, 'node_modules', alias!);
      json(directory, { name: 'vue', version, main: './index.js' });
      writeFileSync(join(directory, 'index.js'), `exports.version = "${version}";`);
    }
    const legacy = join(root, 'node_modules/legacy');
    const peer = (range: string) =>
      json(legacy, {
        name: 'legacy',
        version: '1.0.0',
        main: './index.js',
        peerDependencies: { vue: range },
      });
    peer('^2');
    writeFileSync(join(legacy, 'index.js'), 'exports.version = require("vue").version;');
    writeFileSync(join(root, 'query.cjs'), 'exports.version = require("vue").version;');
    writeFileSync(join(root, 'unrelated.cjs'), 'module.exports = "unchanged";');
    const entry = `module.exports = {
      version: require("legacy").version,
      matchedVersion: require("./node_modules/legacy/matched.cjs!=!./query.cjs?vue&type=script").version,
      unrelated: require("./unrelated.cjs"),
    };`;
    writeFileSync(join(root, 'entry.cjs'), entry);
    const output = join(root, 'dist/entry.cjs');
    let runtimeRequests = 0;
    let factoryRequests = 0;
    const plugin = new DepsConflictResolverWebpackPlugin({
      projectRoot: root,
      dependencies: ['legacy'],
      offline: true,
      strict: true,
      hooks: {
        beforeResolve(request, importer) {
          if (request === 'vue' && importer?.includes('/legacy/')) runtimeRequests++;
          return undefined;
        },
      },
    });
    const compiler = webpack({
      context: root,
      mode: 'development',
      target: 'node',
      entry: './entry.cjs',
      output: { path: join(root, 'dist'), filename: 'entry.cjs', library: { type: 'commonjs2' } },
      plugins: [plugin],
    });
    // Keep the early Webpack 5 capability path covered by the installed engine.
    if (legacyHooks) Object.defineProperty(compiler, 'webpack', { value: undefined });
    compiler.hooks.normalModuleFactory.tap('ObserveRuntimeRequests', (factory) => {
      factory.hooks.beforeResolve.tap(
        { name: 'ObserveRuntimeRequests', stage: Number.NEGATIVE_INFINITY },
        (data) => {
          if (data.request === 'vue' && data.contextInfo.issuer?.includes('/legacy/'))
            factoryRequests++;
        },
      );
    });
    let watcher: webpack.Watching | undefined;
    let change: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const analyses = observeAnalyses();
    try {
      await new Promise<void>((resolve, reject) => {
        let phase = 0;
        let verifiedPhase = -1;
        let buildingPhase = 0;
        let previousAnalyses = 0;
        const compilationPhases = new WeakMap<webpack.Compilation, number>();
        compiler.hooks.watchRun.tap(
          { name: 'RecordInputPhase', stage: Number.NEGATIVE_INFINITY },
          () => {
            buildingPhase = phase;
          },
        );
        compiler.hooks.thisCompilation.tap('RecordCompilationPhase', (compilation) => {
          compilationPhases.set(compilation, buildingPhase);
        });
        deadline = setTimeout(
          () => reject(new Error('Watch did not react to changed analysis inputs')),
          5000,
        );
        watcher = compiler.watch({ aggregateTimeout: 20, poll: 30 }, (error, stats) => {
          if (error || !stats) return reject(error ?? new Error('Missing compilation stats'));
          try {
            if (stats.hasErrors()) throw new Error(stats.toString({ all: false, errors: true }));
            // A watch already in flight may finish after the next edit. Only
            // judge compilations that started with the inputs for this phase.
            if (compilationPhases.get(stats.compilation) !== phase || phase === verifiedPhase)
              return;
            delete require.cache[output];
            expect(require(output)).toEqual({
              version: phase === 1 ? '3.0.0' : '2.7.16',
              matchedVersion: phase === 1 ? '3.0.0' : '2.7.16',
              unrelated: 'unchanged',
            });
            const modules = stats.toJson({ all: false, modules: true }).modules ?? [];
            if (phase > 0)
              expect(modules.find((module) => module.name === './unrelated.cjs')?.built).not.toBe(
                true,
              );
            if (phase === 1 || phase === 2)
              expect(
                modules.find((module) => module.name?.endsWith('/legacy/index.js'))?.built,
              ).toBe(true);
            if (phase === 3) {
              expect(analyses.count()).toBe(previousAnalyses);
              expect(factoryRequests).toBeGreaterThanOrEqual(3);
              expect(runtimeRequests).toBe(factoryRequests);
              expect(
                modules.find((module) => module.name?.endsWith('/legacy/index.js'))?.built,
              ).not.toBe(true);
              resolve();
              return;
            }
            expect(analyses.count()).toBeGreaterThan(previousAnalyses);
            previousAnalyses = analyses.count();
            verifiedPhase = phase;
            const next = phase + 1;
            change = setTimeout(() => {
              phase = next;
              if (next === 1) {
                peer('^3');
                writeFileSync(join(root, 'entry.cjs'), entry + '\n// trigger watch');
              } else if (next === 2) {
                peer('^2'); // This change alone must trigger watch.
              } else {
                writeFileSync(join(root, 'entry.cjs'), entry + '\n// same resolver rules');
              }
            }, 100);
          } catch (failure) {
            reject(failure);
          }
        });
      });
    } finally {
      clearTimeout(change);
      clearTimeout(deadline);
      if (watcher)
        await new Promise<void>((resolve, reject) =>
          watcher!.close((error) => (error ? reject(error) : resolve())),
        );
      await new Promise<void>((resolve, reject) =>
        compiler.close((error) => (error ? reject(error) : resolve())),
      );
      analyses.restore();
      rmSync(root, { recursive: true, force: true });
      clearPackageJsonCache();
    }
  },
  10000,
);

it('rechecks ignored package links, missing lookup paths and the lockfile on source updates', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'deps-webpack-watch-inputs-')));
  const entry = join(root, 'entry.cjs');
  const lockfile = join(root, 'package-lock.json');
  const modules = join(root, 'node_modules');
  const first = join(modules, 'provider-a');
  const second = join(modules, 'provider-b');
  const alias = join(modules, 'vue2');
  const providerLink = join(modules, 'provider');
  const legacy = join(modules, 'legacy');
  const bridge = join(legacy, 'node_modules/bridge');
  const hostSource = join(root, 'src');
  const sourceLink = join(root, 'source-link');
  const importer = join(sourceLink, 'index.cjs');
  json(root, {
    name: 'host',
    dependencies: { legacy: '1.0.0', vue: '3.0.0', vue2: 'npm:vue@^2' },
  });
  json(legacy, {
    name: 'legacy',
    version: '1.0.0',
    peerDependencies: { vue: '^2' },
    optionalDependencies: { bridge: '1.0.0' },
  });
  json(join(modules, 'vue'), { name: 'vue', version: '3.0.0' });
  json(first, { name: 'vue', version: '2.7.16' });
  json(second, { name: 'vue', version: '2.7.17' });
  symlinkSync(first, alias, 'junction');
  mkdirSync(hostSource);
  writeFileSync(join(hostSource, 'index.cjs'), 'module.exports = 1;');
  writeFileSync(join(legacy, 'index.cjs'), 'module.exports = 1;');
  symlinkSync(hostSource, sourceLink, 'junction');
  writeFileSync(entry, 'module.exports = 1;');
  writeFileSync(lockfile, '{}');

  const plugin = new DepsConflictResolverWebpackPlugin({
    dependencies: ['legacy'],
    offline: true,
    strict: true,
  });
  const compiler = webpack({
    context: root,
    mode: 'development',
    entry,
    plugins: [plugin],
    watchOptions: { ignored: /[\\/]node_modules[\\/]/ },
  });
  const refresh = () => compiler.hooks.watchRun.promise(compiler);
  const analyses = observeAnalyses();
  const analysis = analyses.count;
  try {
    await refresh();
    expect(plugin.getAliasConfig().vue2).toBe(first);
    compiler.modifiedFiles = new Set([entry]);
    compiler.removedFiles = new Set();
    const initial = analysis();
    expect(plugin.getResolver()?.resolveModule('vue', importer)).toBeNull();
    unlinkSync(sourceLink);
    symlinkSync(legacy, sourceLink, 'junction');
    await refresh();
    expect(analysis()).toBe(initial);
    expect(plugin.getResolver()?.resolveModule('vue', importer)).toBe('vue2');

    compiler.modifiedFiles = new Set();
    compiler.removedFiles = new Set([join(root, 'unrelated.cjs')]);
    await refresh();
    expect(analysis()).toBe(initial);
    compiler.modifiedFiles = undefined;
    compiler.removedFiles = undefined;
    await refresh();
    expect(analysis()).toBe(initial);
    compiler.modifiedFiles = new Set([entry]);
    compiler.removedFiles = new Set();

    unlinkSync(alias);
    symlinkSync(second, alias, 'junction');
    await refresh();
    expect(plugin.getAliasConfig().vue2).toBe(second);
    expect(analysis()).not.toBe(initial);

    symlinkSync(second, providerLink, 'junction');
    unlinkSync(alias);
    symlinkSync(providerLink, alias, 'junction');
    compiler.modifiedFiles = new Set([alias]);
    await refresh();
    compiler.modifiedFiles = new Set([entry]);
    unlinkSync(providerLink);
    symlinkSync(first, providerLink, 'junction');
    await refresh();
    expect(plugin.getAliasConfig().vue2).toBe(first);

    const beforeBridge = analysis();
    json(bridge, { name: 'bridge', version: '1.0.0' });
    await refresh();
    expect(analysis()).not.toBe(beforeBridge);
    expect(plugin.getResolver()?.resolveModule('vue', join(bridge, 'index.cjs'))).toBe('vue2');

    const beforeLockfile = analysis();
    writeFileSync(lockfile, '{"lockfileVersion":3}');
    await refresh();
    expect(analysis()).not.toBe(beforeLockfile);
  } finally {
    await new Promise<void>((resolve, reject) =>
      compiler.close((error) => (error ? reject(error) : resolve())),
    );
    analyses.restore();
    rmSync(root, { recursive: true, force: true });
    clearPackageJsonCache();
  }
});

it('loads the new provider through a retargeted alias and retains unrelated modules', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'deps-webpack-watch-provider-')));
  const modules = join(root, 'node_modules');
  const providerLink = join(modules, 'provider');
  const output = join(root, 'dist/entry.cjs');
  json(root, {
    name: 'host',
    dependencies: { legacy: '1.0.0', vue: '3.0.0', vue2: 'npm:vue@2.7.16' },
  });
  json(join(modules, 'legacy'), {
    name: 'legacy',
    version: '1.0.0',
    peerDependencies: { vue: '^2' },
  });
  writeFileSync(join(modules, 'legacy/index.js'), 'module.exports = require("vue");');
  writeFileSync(join(modules, 'legacy/esm.mjs'), 'export {default} from "vue";');
  json(join(modules, 'vue'), { name: 'vue', version: '3.0.0' });
  writeFileSync(join(modules, 'vue/index.js'), 'module.exports = "host";');
  for (const provider of ['first', 'second']) {
    const directory = join(modules, provider);
    json(directory, {
      name: 'vue',
      version: '2.7.16',
      exports: { require: './index.cjs', import: './index.mjs' },
    });
    writeFileSync(join(directory, 'index.cjs'), `module.exports = '${provider}';`);
    writeFileSync(join(directory, 'index.mjs'), `export default '${provider}-esm';`);
  }
  symlinkSync(join(modules, 'first'), providerLink, 'junction');
  symlinkSync(providerLink, join(modules, 'vue2'), 'junction');
  writeFileSync(
    join(root, 'entry.cjs'),
    'module.exports = [require("legacy"), require("legacy/esm.mjs").default, require("./other.cjs")];',
  );
  writeFileSync(join(root, 'other.cjs'), 'module.exports = "unrelated";');
  const compiler = webpack({
    context: root,
    mode: 'development',
    target: 'node',
    entry: './entry.cjs',
    output: { path: join(root, 'dist'), filename: 'entry.cjs', library: { type: 'commonjs2' } },
    resolve: { byDependency: { commonjs: { unsafeCache: {} }, esm: { unsafeCache: {} } } },
    plugins: [
      new DepsConflictResolverWebpackPlugin({
        dependencies: ['legacy'],
        offline: true,
        strict: true,
      }),
    ],
  });
  let watch: webpack.Watching | undefined;
  let latest: webpack.Stats | undefined;
  function readBundle() {
    expect(latest?.hasErrors(), latest?.toString({ all: false, errors: true })).toBe(false);
    delete require.cache[output];
    return require(output);
  }
  try {
    await new Promise<void>((resolve, reject) => {
      watch = compiler.watch({ poll: 30, ignored: /[\\/]node_modules[\\/]/ }, (error, stats) => {
        latest = stats;
        if (error) reject(error);
        else resolve();
      });
    });
    expect(readBundle()).toEqual(['first', 'first-esm', 'unrelated']);
    for (const provider of ['second', 'first']) {
      // Let Watchpack establish its timestamp baseline before invalidating.
      await new Promise((resolve) => setTimeout(resolve, 100));
      unlinkSync(providerLink);
      symlinkSync(join(modules, provider), providerLink, 'junction');
      await new Promise<void>((resolve, reject) =>
        watch!.invalidate((error) => (error ? reject(error) : resolve())),
      );
      expect(readBundle()).toEqual([provider, provider + '-esm', 'unrelated']);
      expect(
        latest
          ?.toJson({ all: false, modules: true })
          .modules?.find(({ name }) => name === './other.cjs')?.built,
      ).not.toBe(true);
    }
  } finally {
    if (watch)
      await new Promise<void>((resolve, reject) =>
        watch!.close((error) => (error ? reject(error) : resolve())),
      );
    await new Promise<void>((resolve, reject) =>
      compiler.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(root, { recursive: true, force: true });
    clearPackageJsonCache();
  }
});

it('subscribes to existing and missing lockfiles with an analysis hook', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'deps-webpack-watch-lockfiles-')));
  json(root, { name: 'host' });
  writeFileSync(join(root, 'entry.cjs'), 'module.exports = 1;');
  const existing = join(root, 'package-lock.json');
  const missing = join(root, 'pnpm-lock.yaml');
  writeFileSync(existing, '{}');
  const compiler = webpack({
    context: root,
    mode: 'development',
    entry: './entry.cjs',
    output: { path: join(root, 'dist') },
    plugins: [
      new DepsConflictResolverWebpackPlugin({
        dependencies: [],
        offline: true,
        strict: true,
        hooks: { onAnalysisComplete() {} },
      }),
    ],
  });
  try {
    await compiler.hooks.watchRun.promise(compiler);
    const compilation = await new Promise<webpack.Compilation>((resolve, reject) => {
      compiler.compile((error, value) => {
        if (error || !value) reject(error ?? new Error('Missing compilation'));
        else resolve(value);
      });
    });
    expect(compilation.fileDependencies.has(existing)).toBe(true);
    expect(compilation.missingDependencies.has(missing)).toBe(true);
  } finally {
    await new Promise<void>((resolve, reject) =>
      compiler.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(['initial exception', 'refresh exception', 'refresh diagnostic'] as const)(
  'retries on an input repair after a permissive watch failure: %s',
  async (failureMode) => {
    const initialFailure = failureMode === 'initial exception';
    const diagnosticFailure = failureMode === 'refresh diagnostic';
    const { root, consumer, manifest, entry, dist } = linkedConsumerFixture();
    // The compiler never imports the consumer. Its manifest is watched by the plugin.
    writeFileSync(entry, 'module.exports = 1;');
    const consumerManifest = join(consumer, 'package.json');
    const existing = join(root, 'package-lock.json');
    const missing = join(root, 'pnpm-lock.yaml');
    writeFileSync(existing, '{}');
    const plugin = new DepsConflictResolverWebpackPlugin({
      dependencies: ['legacy'],
      offline: true,
      hooks: diagnosticFailure
        ? undefined
        : {
            onAnalysisComplete() {
              if (
                (initialFailure && !existsSync(missing)) ||
                readFileSync(consumerManifest, 'utf8').includes('transient')
              )
                throw new Error('Temporary preparation failure');
            },
          },
    });
    const compiler = webpack({
      context: root,
      mode: 'development',
      entry,
      output: { path: dist },
      plugins: [plugin],
    });
    let watcher: webpack.Watching | undefined;
    let action: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        let phase = initialFailure ? 1 : 0;
        let builtPhase = -1;
        let verified = -1;
        compiler.hooks.watchRun.tap('RecordRepairPhase', () => {
          builtPhase = phase;
        });
        deadline = setTimeout(() => reject(new Error('Watch did not react to the repair')), 5000);
        watcher = compiler.watch({ aggregateTimeout: 20, poll: 30 }, (error, stats) => {
          if (error || !stats) return reject(error ?? new Error('Missing compilation stats'));
          if (builtPhase !== phase || verified === phase) return;
          verified = phase;
          try {
            expect(stats.hasErrors(), stats.toString({ all: false, errors: true })).toBe(false);
            const missingManifest = phase === 1 && diagnosticFailure;
            expect(stats.compilation.fileDependencies.has(consumerManifest)).toBe(!missingManifest);
            expect(stats.compilation.missingDependencies.has(consumerManifest)).toBe(
              missingManifest,
            );
            expect(stats.compilation.fileDependencies.has(existing)).toBe(true);
            expect(plugin.isInitialized()).toBe(phase !== 1 || diagnosticFailure);
            if (missingManifest) {
              expect(plugin.getResolver()?.getDiagnostics()).toEqual(
                expect.arrayContaining([expect.objectContaining({ code: 'DEPENDENCY_NOT_FOUND' })]),
              );
            }
            if (phase !== 1) expect(plugin.getAliasConfig()).toHaveProperty('vue2');
            if (phase === 2) return resolve();
            if (phase === 1) expect(plugin.getAliasConfig()).toEqual({});
            expect(stats.compilation.missingDependencies.has(missing)).toBe(true);
            const interrupted = phase === 1;
            action = setTimeout(() => {
              phase++;
              if (initialFailure) writeFileSync(missing, 'lockfileVersion: "9.0"\n');
              else if (diagnosticFailure && !interrupted) unlinkSync(consumerManifest);
              else json(consumer, interrupted ? manifest : { ...manifest, transient: true });
            }, 60);
          } catch (failure) {
            reject(failure);
          }
        });
      });
    } finally {
      clearTimeout(action);
      clearTimeout(deadline);
      if (watcher) {
        await new Promise<void>((resolve, reject) =>
          watcher!.close((error) => (error ? reject(error) : resolve())),
        );
      }
      await new Promise<void>((resolve, reject) =>
        compiler.close((error) => (error ? reject(error) : resolve())),
      );
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it.each(['initialization', 'installation', 'rejected installation'] as const)(
  'waits for an in-flight %s before refreshing watch rules',
  async (operation) => {
    const { root, entry, dist } = linkedConsumerFixture();
    writeFileSync(entry, 'module.exports = require("legacy");');
    const output = join(dist, 'entry.cjs');
    let notifyStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => (notifyStarted = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const isInitialization = operation === 'initialization';
    const expectedStatus = operation === 'rejected installation' ? 'rejected' : 'fulfilled';
    let paused = false;
    const pause = async () => {
      if (!paused) return;
      notifyStarted();
      await gate;
      if (expectedStatus === 'rejected')
        throw new Error('Previous installation notification failed');
    };
    const plugin = new DepsConflictResolverWebpackPlugin({
      dependencies: ['legacy'],
      autoInstall: false,
      strict: true,
      hooks: {
        onAnalysisComplete: isInitialization ? pause : undefined,
        onInstallComplete: isInitialization ? undefined : pause,
      },
    });
    const compiler = webpack({
      context: root,
      mode: 'development',
      target: 'node',
      entry,
      output: { path: dist, filename: 'entry.cjs', library: { type: 'commonjs2' } },
      plugins: [plugin],
    });
    try {
      await compiler.hooks.watchRun.promise(compiler);
      const resolver = plugin.getResolver()!;
      if (isInitialization) resolver.invalidate();
      paused = true;
      const preparation = Promise.allSettled([
        isInitialization ? resolver.initialize() : resolver.installDependencies(),
      ]);
      await started;
      const refresh = compiler.hooks.watchRun.promise(compiler);
      const finishedEarly = await Promise.race([
        refresh.then(
          () => true,
          () => true,
        ),
        new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
      ]);
      release();
      expect((await preparation)[0]?.status).toBe(expectedStatus);
      await refresh;
      expect(finishedEarly).toBe(false);
      const stats = await new Promise<webpack.Stats>((resolve, reject) => {
        compiler.run((error, value) => (error || !value ? reject(error) : resolve(value)));
      });
      expect(stats.hasErrors(), stats.toString({ all: false, errors: true })).toBe(false);
      expect(require(output)).toBe('2.7.16');
    } finally {
      release();
      delete require.cache[output];
      await new Promise<void>((resolve, reject) =>
        compiler.close((error) => (error ? reject(error) : resolve())),
      );
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it.each(['analysis', 'installation'] as const)(
  'rejects a watch refresh awaited by its own %s notification',
  async (notification) => {
    const { root, entry, dist } = linkedConsumerFixture();
    writeFileSync(entry, 'module.exports = require("legacy");');
    const callback = vi.fn(async () => {
      await expect(compiler.hooks.watchRun.promise(compiler)).rejects.toThrow(
        'active preparation hook on the same resolver',
      );
    });
    const plugin = new DepsConflictResolverWebpackPlugin({
      dependencies: ['legacy'],
      autoInstall: false,
      strict: true,
      hooks:
        notification === 'analysis'
          ? { onAnalysisComplete: callback }
          : { onInstallComplete: callback },
    });
    const compiler = webpack({
      context: root,
      mode: 'development',
      entry,
      output: { path: dist },
      plugins: [plugin],
    });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        compiler.hooks.watchRun.promise(compiler),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error('Watch preparation waited on its own hook')),
            750,
          );
        }),
      ]);
      if (notification === 'installation') {
        await plugin.getResolver()!.installDependencies();
        await compiler.hooks.watchRun.promise(compiler);
      }
      expect(callback).toHaveBeenCalledTimes(1);
      expect(plugin.getAliasConfig()).toHaveProperty('vue2');
    } finally {
      clearTimeout(deadline);
      await new Promise<void>((resolve, reject) =>
        compiler.close((error) => (error ? reject(error) : resolve())),
      );
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it('compiles from the current graph after a concurrent preparation replaces a watch analysis', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'deps-webpack-watch-revision-')));
  const entry = join(root, 'entry.cjs');
  const output = join(root, 'dist/entry.cjs');
  const legacy = join(root, 'node_modules/legacy');
  const peer = (range: string) =>
    json(legacy, { name: 'legacy', version: '1.0.0', peerDependencies: { vue: range } });
  json(root, {
    name: 'host',
    dependencies: { legacy: '1.0.0', vue: '3.0.0', vue2: 'npm:vue@2.7.16' },
  });
  for (const [name, version] of [
    ['vue', '3.0.0'],
    ['vue2', '2.7.16'],
  ] as const) {
    const directory = join(root, 'node_modules', name);
    json(directory, { name: 'vue', version });
    writeFileSync(join(directory, 'index.js'), `module.exports = '${version}';`);
  }
  peer('^2');
  writeFileSync(join(legacy, 'index.js'), 'module.exports = require("vue");');
  const source = 'module.exports = require("legacy");';
  writeFileSync(entry, source);

  const preparation = getProjectPreparation(root);
  const outsideReader = new AsyncResource('queued dependency preparation');
  const unlink = fs.unlink;
  let writer: Promise<void> | undefined;
  const barrier = vi.spyOn(fs, 'unlink').mockImplementation((path) => {
    // Queue the writer at the point where the read analysis releases its lock.
    if (!writer && typeof path === 'string' && path.includes('.queue') && path.endsWith('.json')) {
      writer = outsideReader.runInAsyncScope(() =>
        withProjectPreparation(preparation, async (markChanged) => {
          markChanged();
          peer('^3');
        }),
      );
    }
    return unlink(path);
  });
  const compiler = webpack({
    context: root,
    mode: 'development',
    target: 'node',
    entry,
    output: { path: join(root, 'dist'), filename: 'entry.cjs', library: { type: 'commonjs2' } },
    plugins: [
      new DepsConflictResolverWebpackPlugin({
        dependencies: ['legacy'],
        offline: true,
        strict: true,
      }),
    ],
  });
  async function compile() {
    const stats = await new Promise<webpack.Stats>((resolve, reject) => {
      compiler.run((error, value) => (error || !value ? reject(error) : resolve(value)));
    });
    expect(stats.hasErrors(), stats.toString({ all: false, errors: true })).toBe(false);
    delete require.cache[output];
    return require(output);
  }

  try {
    await compiler.hooks.watchRun.promise(compiler);
    expect(writer).toBeDefined();
    await writer;
    expect(await compile()).toBe('3.0.0');

    peer('^2');
    writeFileSync(entry, source + '\n// source-only change');
    compiler.modifiedFiles = new Set([entry]);
    compiler.removedFiles = new Set();
    await compiler.hooks.watchRun.promise(compiler);
    expect(await compile()).toBe('2.7.16');
  } finally {
    barrier.mockRestore();
    outsideReader.emitDestroy();
    await new Promise<void>((resolve, reject) =>
      compiler.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(root, { recursive: true, force: true });
    clearPackageJsonCache();
  }
});
