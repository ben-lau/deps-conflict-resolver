import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import webpack from 'webpack';
import { DepsConflictResolverWebpackPlugin } from '../../src/plugins/webpack';
import { clearPackageJsonCache } from '../../src/utils/fs';

const require = createRequire(import.meta.url);

function json(directory: string, value: object): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify(value));
}

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
    writeFileSync(join(root, 'unrelated.cjs'), 'module.exports = "unchanged";');
    const entry =
      'module.exports = { version: require("legacy").version, unrelated: require("./unrelated.cjs") };';
    writeFileSync(join(root, 'entry.cjs'), entry);
    const output = join(root, 'dist/entry.cjs');
    let runtimeRequests = 0;
    let factoryRequests = 0;
    const compiler = webpack({
      context: root,
      mode: 'development',
      target: 'node',
      entry: './entry.cjs',
      output: { path: join(root, 'dist'), filename: 'entry.cjs', library: { type: 'commonjs2' } },
      plugins: [
        new DepsConflictResolverWebpackPlugin({
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
        }),
      ],
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
    try {
      await new Promise<void>((resolve, reject) => {
        let phase = 0;
        let verifiedPhase = -1;
        let buildingPhase = 0;
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
              expect(factoryRequests).toBeGreaterThanOrEqual(3);
              expect(runtimeRequests).toBe(factoryRequests);
              expect(
                modules.find((module) => module.name?.endsWith('/legacy/index.js'))?.built,
              ).not.toBe(true);
              resolve();
              return;
            }
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
      rmSync(root, { recursive: true, force: true });
      clearPackageJsonCache();
    }
  },
  10000,
);
