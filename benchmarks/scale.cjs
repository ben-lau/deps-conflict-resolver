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

function componentImporters(parent, directoryCount, filesPerDirectory) {
  fs.mkdirSync(parent);
  const files = [];
  for (let index = 0; index < directoryCount; index++) {
    const directory = path.join(parent, 'component-' + index);
    fs.mkdirSync(directory);
    for (let fileIndex = 0; fileIndex < filesPerDirectory; fileIndex++) {
      const file = path.join(directory, `file-${fileIndex}.js`);
      fs.writeFileSync(file, 'export {};');
      files.push(file);
    }
  }
  return files;
}

function measureResolutions(resolver, files, requests) {
  const realpath = fs.realpathSync;
  const lstat = fs.lstatSync;
  const readdir = fs.readdirSync;
  let realpaths = 0;
  let lstats = 0;
  let readdirs = 0;
  fs.realpathSync = (...args) => {
    realpaths++;
    return realpath(...args);
  };
  fs.realpathSync.native = (...args) => {
    realpaths++;
    return realpath.native(...args);
  };
  fs.lstatSync = (...args) => {
    lstats++;
    return lstat(...args);
  };
  fs.readdirSync = (...args) => {
    readdirs++;
    return readdir(...args);
  };
  const measure = (rounds) => {
    realpaths = lstats = readdirs = 0;
    const start = performance.now();
    for (let round = 0; round < rounds; round++) {
      for (const importer of files) {
        for (const [request, expected] of requests) {
          assert.equal(resolver.resolveModule(request, importer), expected);
        }
      }
    }
    return { milliseconds: performance.now() - start, realpaths, lstats, readdirs };
  };
  try {
    const cold = measure(1);
    const heapBefore = process.memoryUsage().heapUsed;
    const warm = measure(2);
    const calls = files.length * requests.length * 2;
    return {
      importers: files.length,
      packageNames: requests.length,
      calls,
      coldRealpathCalls: cold.realpaths,
      coldLstatCalls: cold.lstats,
      coldReaddirCalls: cold.readdirs,
      coldMs: +cold.milliseconds.toFixed(2),
      realpathCalls: warm.realpaths,
      lstatCalls: warm.lstats,
      readdirCalls: warm.readdirs,
      milliseconds: +warm.milliseconds.toFixed(2),
      microsecondsPerCall: +((warm.milliseconds * 1000) / calls).toFixed(3),
      heapDeltaKiB: +((process.memoryUsage().heapUsed - heapBefore) / 1024).toFixed(1),
    };
  } finally {
    fs.realpathSync = realpath;
    fs.lstatSync = lstat;
    fs.readdirSync = readdir;
  }
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
    const requests = [
      ['vue', 'vue2'],
      ['renderer', 'renderer1'],
    ];
    const workingSets = [];
    for (const names of [1, 2]) {
      for (const count of [1000, 2500, 2501, 5000, 5001, 6000, 20_000]) {
        const resolver = await createResolver(options);
        const result = measureResolutions(
          resolver,
          files.slice(0, count),
          requests.slice(0, names),
        );
        if (!process.argv[2]) {
          assert.ok(
            result.coldRealpathCalls <= 4,
            'Regular siblings should share directory resolution',
          );
          assert.equal(result.coldReaddirCalls, 0);
          assert.equal(result.realpathCalls + result.lstatCalls + result.readdirCalls, 0);
        }
        workingSets.push(result);
      }
    }
    const distributed = componentImporters(path.join(consumer, 'distributed'), 2_000, 2);
    const components = componentImporters(path.join(consumer, 'components'), 1_500, 4);
    const sparse = measureResolutions(await createResolver(options), files.slice(0, 2), requests);
    const spread = measureResolutions(await createResolver(options), distributed, requests);
    const grouped = measureResolutions(await createResolver(options), components, requests);
    if (!process.argv[2]) {
      assert.equal(sparse.coldLstatCalls + sparse.coldReaddirCalls, 0);
      assert.equal(spread.realpathCalls + spread.lstatCalls + spread.readdirCalls, 0);
      assert.equal(grouped.realpathCalls + grouped.lstatCalls + grouped.readdirCalls, 0);
    }
    const versions = Array.from(
      { length: 600 },
      (_, i) => '2.' + Math.floor(i / 100) + '.' + (i % 100),
    );
    const grouping = [];
    for (const count of [10, 50, 100, 200]) {
      const analyzer = new DependencyAnalyzer(options, { name: 'benchmark' });
      const rangeRequests = Array.from({ length: count }, (_, i) => ({
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
        groups = analyzer.groupRangesByCompatibility(rangeRequests, versions);
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
      JSON.stringify(
        {
          node: process.version,
          sourceRoot,
          workingSets,
          layouts: { sparse, distributed: spread, components: grouped },
          peakRssKiB: process.resourceUsage().maxRSS,
          grouping,
        },
        null,
        2,
      ) + '\n',
    );
  } finally {
    console.info = info;
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
