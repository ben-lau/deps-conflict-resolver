import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import webpack from 'webpack';
import { build, optimizeDeps, resolveConfig } from 'vite';
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

function workspaceFixture(): string {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'deps-workspace-resolution-')));
  roots.push(workspace);
  json(workspace, { name: 'workspace', private: true });
  writeFileSync(join(workspace, 'pnpm-workspace.yaml'), 'packages: [apps/*, packages/*]\n');
  const app = join(workspace, 'apps/host');
  json(app, {
    name: 'app',
    dependencies: {
      legacy: '1.0.0',
      'shared-ui': 'workspace:*',
      'modern-ui': 'workspace:*',
      vue: '3.5.0',
      vue2: 'npm:vue@2.7.16',
      'vue-router': '4.5.0',
      router3: 'npm:vue-router@3.6.5',
    },
  });

  function entry(directory: string, manifest: object, code: string): void {
    json(directory, { type: 'module', main: './index.js', ...manifest });
    writeFileSync(join(directory, 'index.js'), code);
  }

  const appModules = join(app, 'node_modules');
  for (const [key, name, version] of [
    ['vue', 'vue', '3.5.0'],
    ['vue2', 'vue', '2.7.16'],
    ['vue-router', 'vue-router', '4.5.0'],
    ['router3', 'vue-router', '3.6.5'],
  ]) {
    entry(join(appModules, key!), { name, version }, `export const version = '${version}';`);
  }
  for (const owner of ['app', 'shared-ui', 'modern-ui']) {
    const modern = owner === 'modern-ui';
    const version = modern ? '2.0.0' : '1.0.0';
    const modules = join(
      workspace,
      'node_modules/.pnpm',
      `legacy@${version}_${owner}`,
      'node_modules',
    );
    entry(
      join(modules, 'legacy'),
      {
        name: 'legacy',
        version,
        dependencies: { 'legacy-core': '1.0.0' },
        peerDependencies: { vue: modern ? '^3' : '^2', 'vue-router': modern ? '^4' : '^3' },
      },
      'export { versions } from "legacy-core";',
    );
    // pnpm links dependencies into the virtual store, beside their consumer.
    const core = join(
      workspace,
      'node_modules/.pnpm',
      `legacy-core@1.0.0_${owner}`,
      'node_modules',
    );
    entry(
      join(core, 'legacy-core'),
      { name: 'legacy-core', version: '1.0.0' },
      'import { version as vue } from "vue"; import { version as router } from "vue-router"; export const versions = [vue, router];',
    );
    symlinkSync(join(core, 'legacy-core'), join(modules, 'legacy-core'), 'junction');
    for (const peer of ['vue', 'vue-router']) {
      symlinkSync(join(appModules, peer), join(modules, peer), 'junction');
      symlinkSync(join(appModules, peer), join(core, peer), 'junction');
    }

    let ownerModules = appModules;
    if (owner !== 'app') {
      const ownerPath = join(workspace, 'packages', owner);
      entry(
        ownerPath,
        { name: owner, dependencies: { legacy: version } },
        'export { versions } from "legacy";',
      );
      ownerModules = join(ownerPath, 'node_modules');
      mkdirSync(ownerModules);
      symlinkSync(ownerPath, join(appModules, owner), 'junction');
    }
    symlinkSync(join(modules, 'legacy'), join(ownerModules, 'legacy'), 'junction');
  }
  writeFileSync(
    join(app, 'entry.mjs'),
    [
      'import { versions as direct } from "legacy";',
      'import { versions as shared } from "shared-ui";',
      'import { versions as modern } from "modern-ui";',
      'import { version as host } from "vue";',
      'export const version = { direct, shared, modern, host };',
    ].join('\n'),
  );
  writeFileSync(join(app, 'entry.cjs'), 'module.exports = require("./entry.mjs").version;');
  return app;
}

async function bundle(
  app: string,
  tool: 'webpack' | 'vite',
  extraOptions: Partial<{ peerOverrides: Record<string, Record<string, string>> }> = {},
): Promise<unknown> {
  const options = {
    projectRoot: app,
    dependencies: ['legacy'],
    offline: true,
    strict: true,
    ...extraOptions,
  };
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

  it('redirects each configured instance used by the host and its workspace packages', async () => {
    expect(await bundle(workspaceFixture(), tool)).toEqual({
      direct: ['2.7.16', '3.6.5'],
      shared: ['2.7.16', '3.6.5'],
      modern: ['3.5.0', '4.5.0'],
      host: '3.5.0',
    });
  });

  it.each(['peerDependencies', 'optionalDependencies'] as const)(
    'keeps host-compatible descendants with %s on the host runtime',
    async (declaration) => {
      const app = realpathSync(mkdtempSync(join(tmpdir(), 'deps-host-descendant-')));
      roots.push(app);
      json(app, {
        name: 'app',
        dependencies: { legacy: '1.0.0', vue: '3.5.0', vue2: 'npm:vue@2.6.14' },
      });
      const modules = join(app, 'node_modules');
      const writePkg = (directory: string, manifest: object, code: string) => {
        json(directory, { type: 'module', main: './index.js', ...manifest });
        writeFileSync(join(directory, 'index.js'), code);
      };
      writePkg(
        join(modules, 'vue'),
        { name: 'vue', version: '3.5.0' },
        'export const v = "3.5.0";',
      );
      writePkg(
        join(modules, 'vue2'),
        { name: 'vue', version: '2.6.14' },
        'export const v = "2.6.14";',
      );
      writePkg(
        join(modules, 'modern-helper'),
        { name: 'modern-helper', version: '1.0.0' },
        'import { v } from "vue"; export const helper = v;',
      );
      writePkg(
        join(modules, 'modern-icons'),
        {
          name: 'modern-icons',
          version: '1.0.0',
          dependencies: { 'modern-helper': '1.0.0' },
          [declaration]: { vue: '3.x' },
        },
        'import { v } from "vue"; import { helper } from "modern-helper"; export const icons = [v, helper];',
      );
      writePkg(
        join(modules, 'legacy'),
        {
          name: 'legacy',
          version: '1.0.0',
          dependencies: { 'modern-icons': '1.0.0' },
          peerDependencies: { vue: '^2.0.0' },
        },
        'import { v } from "vue"; import { icons } from "modern-icons"; export const result = { legacy: v, icons };',
      );
      writeFileSync(
        join(app, 'entry.mjs'),
        'import { result } from "legacy"; import { v as host } from "vue"; export const version = { ...result, host };',
      );
      writeFileSync(join(app, 'entry.cjs'), 'module.exports = require("./entry.mjs").version;');

      expect(await bundle(app, tool)).toEqual({
        legacy: '2.6.14',
        icons: ['3.5.0', '3.5.0'],
        host: '3.5.0',
      });
    },
  );

  it('bundles a broad-peer package and its full physical subtree via peerOverrides', async () => {
    const app = realpathSync(mkdtempSync(join(tmpdir(), 'deps-peer-override-')));
    roots.push(app);
    json(app, {
      name: 'app',
      dependencies: { legacy: '1.0.0', vue: '3.5.0', vue2: 'npm:vue@2.6.14' },
    });
    const modules = join(app, 'node_modules');
    const writePkg = (directory: string, manifest: object, code: string) => {
      json(directory, { type: 'module', main: './index.js', ...manifest });
      writeFileSync(join(directory, 'index.js'), code);
    };
    writePkg(join(modules, 'vue'), { name: 'vue', version: '3.5.0' }, 'export const v = "3.5.0";');
    writePkg(
      join(modules, 'vue2'),
      { name: 'vue', version: '2.6.14' },
      'export const v = "2.6.14";',
    );
    writePkg(
      join(modules, 'broad-child'),
      { name: 'broad-child', version: '1.0.0', peerDependencies: { vue: '>=2.5.0' } },
      'import { v } from "vue"; export const child = v;',
    );
    writePkg(
      join(modules, 'legacy'),
      {
        name: 'legacy',
        version: '1.0.0',
        dependencies: { 'broad-child': '1.0.0' },
        peerDependencies: { vue: '>=2.5.17' },
      },
      'import { v } from "vue"; import { child } from "broad-child"; export const result = { root: v, child };',
    );
    writeFileSync(
      join(app, 'entry.mjs'),
      'import { result } from "legacy"; import { v as host } from "vue"; export const version = { ...result, host };',
    );
    writeFileSync(join(app, 'entry.cjs'), 'module.exports = require("./entry.mjs").version;');

    expect(await bundle(app, tool, { peerOverrides: { legacy: { vue: '>=2.5.17 <3' } } })).toEqual({
      root: '2.6.14',
      child: '2.6.14',
      host: '3.5.0',
    });
  });

  it('bundles only the version matched by name@range peerOverrides when multiple majors coexist', async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'deps-versioned-peer-override-')));
    roots.push(workspace);
    json(workspace, { name: 'ws', private: true, workspaces: ['packages/*'] });
    const app = join(workspace, 'packages', 'app');
    const legacyShell = join(workspace, 'packages', 'legacy-shell');
    json(app, {
      name: 'app',
      dependencies: {
        legacy: '2.0.0',
        'legacy-shell': 'workspace:*',
        vue: '3.5.0',
        vue2: 'npm:vue@2.6.14',
      },
    });
    json(legacyShell, {
      name: 'legacy-shell',
      version: '1.0.0',
      type: 'module',
      main: './index.js',
      dependencies: { legacy: '1.2.0-beta.1' },
    });
    writeFileSync(
      join(legacyShell, 'index.js'),
      'import { version as v1 } from "legacy"; export const shellLegacy = v1;',
    );
    mkdirSync(join(app, 'node_modules'), { recursive: true });
    symlinkSync(legacyShell, join(app, 'node_modules', 'legacy-shell'), 'dir');

    const writePkg = (directory: string, manifest: object, code: string) => {
      json(directory, { type: 'module', main: './index.js', ...manifest });
      writeFileSync(join(directory, 'index.js'), code);
    };
    writePkg(
      join(app, 'node_modules', 'vue'),
      { name: 'vue', version: '3.5.0' },
      'export const v = "3.5.0";',
    );
    writePkg(
      join(app, 'node_modules', 'vue2'),
      { name: 'vue', version: '2.6.14' },
      'export const v = "2.6.14";',
    );
    writePkg(
      join(app, 'node_modules', 'legacy'),
      { name: 'legacy', version: '2.0.0', peerDependencies: { vue: '>=2.5.17' } },
      'import { v } from "vue"; export const version = v;',
    );
    writePkg(
      join(legacyShell, 'node_modules', 'legacy'),
      { name: 'legacy', version: '1.2.0-beta.1', peerDependencies: { vue: '>=2.5.17' } },
      'import { v } from "vue"; export const version = v;',
    );
    writeFileSync(
      join(app, 'entry.mjs'),
      'import { version as modern } from "legacy"; import { shellLegacy as old } from "legacy-shell"; import { v as host } from "vue"; export const version = { modern, old, host };',
    );
    writeFileSync(join(app, 'entry.cjs'), 'module.exports = require("./entry.mjs").version;');

    expect(
      await bundle(app, tool, {
        peerOverrides: { 'legacy@1.x': { vue: '>=2.5.17 <3' } },
      }),
    ).toEqual({
      modern: '3.5.0',
      old: '2.6.14',
      host: '3.5.0',
    });
  });
});

it('prebundles separate workspace instances with their matching peer providers', async () => {
  const app = workspaceFixture();
  const config = await resolveConfig(
    {
      root: app,
      configFile: false,
      logLevel: 'silent',
      plugins: [vitePlugin({ dependencies: ['legacy'], offline: true, strict: true })],
      optimizeDeps: {
        noDiscovery: true,
        include: ['legacy', 'shared-ui > legacy', 'modern-ui > legacy', 'vue'],
      },
    },
    'serve',
  );
  const { optimized } = await optimizeDeps(config, true);
  for (const [name, expected] of [
    ['legacy', ['2.7.16', '3.6.5']],
    ['shared-ui > legacy', ['2.7.16', '3.6.5']],
    ['modern-ui > legacy', ['3.5.0', '4.5.0']],
  ] as const) {
    const module = await import(pathToFileURL(optimized[name]!.file).href);
    expect(module.versions).toEqual(expected);
  }
  const host = await import(pathToFileURL(optimized.vue!.file).href);
  expect(host.version).toBe('3.5.0');
});

it('formats workspace entry paths cleanly for Vite SSR auto configuration', async () => {
  const app = workspaceFixture();
  const config = await resolveConfig(
    {
      root: app,
      configFile: false,
      logLevel: 'silent',
      plugins: [vitePlugin({ dependencies: ['legacy'], ssr: 'auto', offline: true, strict: true })],
    },
    'serve',
  );
  expect(config.ssr.noExternal).toEqual(expect.arrayContaining(['legacy', 'shared-ui']));
  expect(config.ssr.optimizeDeps?.include).toEqual(
    expect.arrayContaining(['legacy', 'shared-ui > legacy']),
  );
  expect(config.ssr.optimizeDeps?.include).not.toContain('shared-ui');
});

it('bundles every SSR entry through an injected shared workspace package', async () => {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'deps-ssr-workspace-')));
  roots.push(workspace);
  writeFileSync(join(workspace, 'pnpm-workspace.yaml'), 'packages: [apps/*, packages/*]\n');
  const app = join(workspace, 'apps/host');
  const packages = new Map<string, string>();
  const entries = [
    ['left', { shared: 'workspace:*' }, 'export { default } from "shared";'],
    ['right', { shared: 'workspace:*' }, 'export { default } from "shared";'],
    ['shared', { legacy: '1.0.0' }, 'export { default } from "legacy";'],
  ] as const;
  for (const [name, dependencies, code] of entries) {
    const directory = join(workspace, 'node_modules/.pnpm', name, 'node_modules', name);
    json(directory, { name, version: '1.0.0', type: 'module', main: 'index.js', dependencies });
    writeFileSync(join(directory, 'index.js'), code);
    packages.set(name, directory);
  }
  const legacy = join(workspace, 'node_modules/.pnpm/legacy/node_modules/legacy');
  json(legacy, {
    name: 'legacy',
    version: '1.0.0',
    type: 'module',
    main: 'index.js',
    peerDependencies: { vue: '^2' },
  });
  writeFileSync(join(legacy, 'index.js'), 'export { version as default } from "vue";');
  packages.set('legacy', legacy);
  function link(owner: string, name: string): void {
    const modules = join(owner, 'node_modules');
    mkdirSync(modules, { recursive: true });
    symlinkSync(packages.get(name)!, join(modules, name), 'junction');
  }
  link(app, 'left');
  link(app, 'right');
  link(packages.get('left')!, 'shared');
  link(packages.get('right')!, 'shared');
  link(packages.get('shared')!, 'legacy');
  json(app, {
    name: 'host',
    dependencies: {
      left: 'workspace:*',
      right: 'workspace:*',
      vue: '3.5.0',
      vue2: 'npm:vue@2.7.16',
    },
  });
  for (const [name, version] of [
    ['vue', '3.5.0'],
    ['vue2', '2.7.16'],
  ] as const) {
    const directory = join(workspace, 'node_modules', name);
    json(directory, { name: 'vue', version, type: 'module', main: 'index.js' });
    writeFileSync(
      join(directory, 'index.js'),
      `export const version = ${JSON.stringify(version)};`,
    );
  }
  const entry = join(app, 'entry.mjs');
  writeFileSync(
    entry,
    'import left from "left"; import right from "right"; export const versions = [left, right];',
  );

  await build({
    root: app,
    configFile: false,
    logLevel: 'silent',
    plugins: [vitePlugin({ dependencies: ['legacy'], ssr: 'auto', offline: true, strict: true })],
    build: { ssr: entry, rollupOptions: { output: { entryFileNames: 'entry.mjs' } } },
  });
  const result = await import(pathToFileURL(join(app, 'dist/entry.mjs')).href);
  expect(result.versions).toEqual(['2.7.16', '2.7.16']);
});
