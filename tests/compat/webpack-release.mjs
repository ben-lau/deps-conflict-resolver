import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const prefix = process.argv[2];
if (!prefix) throw new Error('Pass the consumer installation directory');
const require = createRequire(join(prefix, 'package.json'));
const webpack = require('webpack');
const { DepsConflictResolverWebpackPlugin } = require('deps-conflict-resolver/webpack');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'deps-release-webpack-')));

function json(directory, value) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify(value));
}

json(root, {
  name: 'watch-consumer',
  dependencies: { legacy: '1.0.0', vue: '3.0.0', vue2: 'npm:vue@2.7.16' },
});
for (const [name, version] of [
  ['vue', '3.0.0'],
  ['vue2', '2.7.16'],
]) {
  const directory = join(root, 'node_modules', name);
  json(directory, { name: 'vue', version, main: './index.js' });
  writeFileSync(join(directory, 'index.js'), `exports.version = "${version}";`);
}
const legacy = join(root, 'node_modules/legacy');
function peer(range) {
  json(legacy, {
    name: 'legacy',
    version: '1.0.0',
    main: './index.js',
    peerDependencies: { vue: range },
  });
}
peer('^2');
writeFileSync(join(legacy, 'index.js'), 'exports.version = require("vue").version;');
writeFileSync(join(root, 'unrelated.cjs'), 'module.exports = "unchanged";');
writeFileSync(
  join(root, 'entry.cjs'),
  'module.exports = { version: require("legacy").version, unrelated: require("./unrelated.cjs") };',
);
const output = join(root, 'dist/entry.cjs');
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
    }),
  ],
});
let watcher;
let change;
let deadline;
try {
  await new Promise((resolve, reject) => {
    let phase = 0;
    let buildingPhase = 0;
    const compilationPhases = new WeakMap();
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
      () => reject(new Error('Webpack watch did not react to the manifest change')),
      20000,
    );
    watcher = compiler.watch({ aggregateTimeout: 20, poll: 30 }, (error, stats) => {
      if (error || !stats) return reject(error ?? new Error('Missing compilation stats'));
      try {
        if (stats.hasErrors()) throw new Error(stats.toString({ all: false, errors: true }));
        if (compilationPhases.get(stats.compilation) !== phase) return;
        delete require.cache[output];
        assert.deepEqual(require(output), {
          version: phase === 0 ? '2.7.16' : '3.0.0',
          unrelated: 'unchanged',
        });
        if (phase === 1) {
          const modules = stats.toJson({ all: false, modules: true }).modules ?? [];
          assert.notEqual(modules.find((entry) => entry.name === './unrelated.cjs')?.built, true);
          resolve();
          return;
        }
        change = setTimeout(() => {
          phase = 1;
          peer('^3');
        }, 150);
      } catch (failure) {
        reject(failure);
      }
    });
  });
  console.log('Packaged Webpack plugin updated watch output after a manifest-only change.');
} finally {
  clearTimeout(change);
  clearTimeout(deadline);
  if (watcher)
    await new Promise((resolve, reject) =>
      watcher.close((error) => (error ? reject(error) : resolve())),
    );
  await new Promise((resolve, reject) =>
    compiler.close((error) => (error ? reject(error) : resolve())),
  );
  rmSync(root, { recursive: true, force: true });
}
