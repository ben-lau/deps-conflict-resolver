import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import webpack from 'webpack';
import { build } from 'vite';
import vitePlugin from '../../src/plugins/vite';
import { DepsConflictResolverWebpackPlugin } from '../../src/plugins/webpack';
import { clearPackageJsonCache } from '../../src/utils/fs';

const roots: string[] = [];
const require = createRequire(import.meta.url);

function json(directory: string, value: object): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify(value));
}

function fixture(commonjs: boolean, subpath: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'deps-linked-resolution-')));
  roots.push(root);
  const app = join(root, 'app');
  const linked = join(root, 'packages/legacy');
  json(app, {
    name: 'app',
    dependencies: { legacy: '1.0.0', vue: '3.0.0', vue2: 'npm:vue@2.7.16' },
  });
  for (const [alias, version] of [
    ['vue', '3.0.0'],
    ['vue2', '2.7.16'],
  ]) {
    const directory = join(app, 'node_modules', alias!);
    json(directory, {
      name: 'vue',
      version,
      exports: {
        '.': { import: './import.mjs', require: './require.cjs' },
        './feature': { import: './import.mjs', require: './require.cjs' },
      },
    });
    writeFileSync(join(directory, 'import.mjs'), `export const version = "${version}-import";`);
    writeFileSync(join(directory, 'require.cjs'), `exports.version = "${version}-require";`);
    writeFileSync(join(directory, 'private.js'), 'throw new Error("exports was bypassed");');
  }
  json(linked, {
    name: 'legacy',
    version: '1.0.0',
    type: commonjs ? 'commonjs' : 'module',
    main: './index.js',
    peerDependencies: { vue: '^2' },
  });
  mkdirSync(join(linked, 'node_modules'), { recursive: true });
  symlinkSync(join(app, 'node_modules/vue'), join(linked, 'node_modules/vue'), 'junction');
  symlinkSync(linked, join(app, 'node_modules/legacy'), 'junction');
  writeFileSync(
    join(linked, 'index.js'),
    commonjs
      ? `exports.version = require("vue${subpath}").version;`
      : `export { version } from "vue${subpath}";`,
  );
  writeFileSync(join(app, 'entry.cjs'), 'module.exports = require("legacy").version;');
  writeFileSync(join(app, 'entry.mjs'), 'export { version } from "legacy";');
  return app;
}

async function bundle(app: string, tool: 'webpack' | 'vite'): Promise<string> {
  const options = { projectRoot: app, dependencies: ['legacy'], offline: true, strict: true };
  const outDir = join(app, 'dist');
  if (tool === 'vite') {
    await build({
      root: app,
      configFile: false,
      logLevel: 'silent',
      plugins: [vitePlugin(options)],
      build: {
        lib: { entry: join(app, 'entry.mjs'), formats: ['cjs'], fileName: () => 'entry.cjs' },
        commonjsOptions: { include: [/node_modules/, /packages/] },
        outDir,
      },
    });
    return require(join(outDir, 'entry.cjs')).version;
  }
  const compiler = webpack({
    context: app,
    mode: 'development',
    target: 'node',
    entry: './entry.cjs',
    output: { path: outDir, filename: 'entry.cjs', library: { type: 'commonjs2' } },
    plugins: [new DepsConflictResolverWebpackPlugin(options)],
  });
  try {
    const stats = await new Promise<webpack.Stats>((resolve, reject) => {
      compiler.run((error, result) =>
        error
          ? reject(error)
          : result
            ? resolve(result)
            : reject(new Error('Missing compilation stats')),
      );
    });
    if (stats.hasErrors()) throw new Error(stats.toString({ all: false, errors: true }));
    return require(join(outDir, 'entry.cjs'));
  } finally {
    await new Promise<void>((resolve, reject) =>
      compiler.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  clearPackageJsonCache();
});

describe.each(['webpack', 'vite'] as const)('linked aliases in %s', (tool) => {
  it.each([false, true])(
    'resolves root and exported subpaths from the host: commonjs=%s',
    async (commonjs) => {
      for (const subpath of ['', '/feature']) {
        expect(await bundle(fixture(commonjs, subpath), tool)).toBe(
          `2.7.16-${commonjs ? 'require' : 'import'}`,
        );
      }
    },
  );

  it('continues to reject unexported subpaths', async () => {
    await expect(bundle(fixture(false, '/private.js'), tool)).rejects.toThrow();
  });
});
