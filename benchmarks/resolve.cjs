const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { performance } = require('node:perf_hooks');
const { createResolver } = require('../dist/index.cjs');

const root = fs.mkdtempSync(path.join(tmpdir(), 'deps-resolve-bench-'));
const info = console.info;
console.info = () => {};
function pkg(name, manifest) {
  const directory = path.join(root, 'node_modules', name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', ...manifest }),
  );
  fs.writeFileSync(path.join(directory, 'index.js'), 'export {};');
  return directory;
}
(async () => {
  try {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'benchmark',
        dependencies: { legacy: '1.0.0', vue: '3.5.0', vue2: 'npm:vue@2.7.16' },
      }),
    );
    const children = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => ['child-' + index, '1.0.0']),
    );
    pkg('legacy', { peerDependencies: { vue: '^2.0.0' }, dependencies: children });
    pkg('vue', { version: '3.5.0' });
    pkg('vue2', { name: 'vue', version: '2.7.16' });
    for (const name of Object.keys(children)) pkg(name, {});
    const start = performance.now();
    const resolver = await createResolver({
      projectRoot: root,
      dependencies: ['legacy'],
      offline: true,
      strict: true,
    });
    const initializationMs = performance.now() - start;
    const importer = path.join(root, 'node_modules/child-99/index.js');
    assert.equal(resolver.resolveModule('vue', importer), 'vue2');
    let realpathCalls = 0;
    const originalRealpath = fs.realpathSync;
    fs.realpathSync = (...args) => {
      realpathCalls++;
      return originalRealpath(...args);
    };
    const iterations = 100_000;
    const warmStart = performance.now();
    let result;
    try {
      for (let index = 0; index < iterations; index++)
        result = resolver.resolveModule('vue', importer);
    } finally {
      fs.realpathSync = originalRealpath;
    }
    const elapsedMs = performance.now() - warmStart;
    assert.equal(result, 'vue2');
    assert.equal(realpathCalls, 0, 'Warm resolution must not access realpathSync');
    process.stdout.write(
      JSON.stringify(
        {
          importerPaths: resolver.getAnalysisResult().aliasMappings[0].importerPaths.length,
          initializationMs: Number(initializationMs.toFixed(2)),
          iterations,
          warmMs: Number(elapsedMs.toFixed(2)),
          microsecondsPerResolution: Number(((elapsedMs * 1000) / iterations).toFixed(3)),
          warmRealpathCalls: realpathCalls,
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
