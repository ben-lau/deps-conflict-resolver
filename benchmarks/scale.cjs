const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { createRequire } = require('node:module');
const { performance } = require('node:perf_hooks');
const esbuild = require('esbuild');

// An optional checkout path permits the same workload to compare revisions.
const sourceRoot = path.resolve(process.argv[2] ?? path.join(__dirname, '..'));
const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'deps-scale-bench-')));
const info = console.info;
console.info = () => {};
function pkg(directory, value) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify(value));
  fs.writeFileSync(path.join(directory, 'index.js'), 'export {};');
}

(async () => {
  try {
    const entry = path.join(root, 'core.cjs');
    esbuild.buildSync({
      stdin: {
        contents:
          "export {createResolver} from './src/core/resolver'; export {DependencyAnalyzer} from './src/core/dependency-analyzer';",
        resolveDir: sourceRoot,
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['semver', 'yaml'],
      outfile: entry,
    });
    fs.symlinkSync(
      path.join(sourceRoot, 'node_modules'),
      path.join(root, 'node_modules'),
      'junction',
    );
    const { createResolver, DependencyAnalyzer } = require(entry);
    const semver = createRequire(path.join(sourceRoot, 'package.json'))('semver');
    const app = path.join(root, 'app');
    const consumer = path.join(app, 'node_modules/legacy');
    pkg(app, {
      name: 'benchmark',
      dependencies: {
        legacy: '1',
        vue: '3',
        vue2: 'npm:vue@2.7.16',
        renderer: '2',
        renderer1: 'npm:renderer@1.0.0',
      },
    });
    pkg(consumer, {
      name: 'legacy',
      version: '1.0.0',
      peerDependencies: { vue: '^2', renderer: '^1' },
    });
    for (const [request, name, version] of [
      ['vue', 'vue', '3.0.0'],
      ['vue2', 'vue', '2.7.16'],
      ['renderer', 'renderer', '2.0.0'],
      ['renderer1', 'renderer', '1.0.0'],
    ]) {
      pkg(path.join(app, 'node_modules', request), { name, version });
    }
    const options = {
      projectRoot: app,
      dependencies: ['legacy'],
      offline: true,
      strict: true,
      autoInstall: false,
      packageManager: 'npm',
      registry: 'https://unused.invalid',
      debug: false,
      aliasPrefix: 'aliased-',
      includeRedirects: {},
      excludeRedirects: {},
    };
    const files = Array.from({ length: 20_000 }, (_, i) =>
      path.join(consumer, 'file-' + i + '.js'),
    );
    for (const file of files) fs.writeFileSync(file, 'export {};');
    const workingSets = [];
    for (const names of [1, 2])
      for (const count of [1000, 2500, 2501, 5000, 5001, 6000, 20_000]) {
        const resolver = await createResolver(options);
        const requests =
          names === 1
            ? [['vue', 'vue2']]
            : [
                ['vue', 'vue2'],
                ['renderer', 'renderer1'],
              ];
        for (let i = 0; i < count; i++)
          for (const [request, expected] of requests) {
            assert.equal(resolver.resolveModule(request, files[i]), expected);
          }
        let realpathCalls = 0;
        const realpath = fs.realpathSync;
        fs.realpathSync = (...args) => {
          realpathCalls++;
          return realpath(...args);
        };
        const heapBefore = process.memoryUsage().heapUsed;
        const start = performance.now();
        try {
          for (let round = 0; round < 2; round++)
            for (let i = 0; i < count; i++) {
              for (const [request, expected] of requests)
                assert.equal(resolver.resolveModule(request, files[i]), expected);
            }
        } finally {
          fs.realpathSync = realpath;
        }
        const milliseconds = performance.now() - start;
        const calls = count * names * 2;
        if (names === 1 && count <= 5000) assert.equal(realpathCalls, 0);
        workingSets.push({
          importers: count,
          packageNames: names,
          calls,
          realpathCalls,
          milliseconds: +milliseconds.toFixed(2),
          microsecondsPerCall: +((milliseconds * 1000) / calls).toFixed(3),
          heapDeltaKiB: +((process.memoryUsage().heapUsed - heapBefore) / 1024).toFixed(1),
        });
      }
    const versions = Array.from(
      { length: 600 },
      (_, i) => '2.' + Math.floor(i / 100) + '.' + (i % 100),
    );
    const grouping = [];
    for (const count of [10, 50, 100, 200]) {
      const analyzer = new DependencyAnalyzer(options, { name: 'benchmark' });
      const requests = Array.from({ length: count }, (_, i) => ({
        path: ['consumer-' + i],
        requiredRange: '^2.0.0',
      }));
      let comparisons = 0;
      const satisfies = semver.satisfies;
      semver.satisfies = (...args) => {
        comparisons++;
        return satisfies(...args);
      };
      const start = performance.now();
      let groups;
      try {
        groups = analyzer.groupRangesByCompatibility(requests, versions);
      } finally {
        semver.satisfies = satisfies;
      }
      assert.equal(groups.length, 1);
      assert.equal(groups[0].length, count);
      grouping.push({
        requests: count,
        versions: versions.length,
        uniqueRanges: 1,
        comparisons,
        milliseconds: +(performance.now() - start).toFixed(2),
      });
    }
    process.stdout.write(
      JSON.stringify({ node: process.version, sourceRoot, workingSets, grouping }, null, 2) + '\n',
    );
  } finally {
    console.info = info;
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
