import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, createServer, resolveConfig } from 'vite';
import { depsConflictResolverVitePlugin } from '../../src/plugins/vite';

const roots: string[] = [];

function fixture(commonjs = false) {
  const root = mkdtempSync(join(tmpdir(), 'deps-ssr-'));
  roots.push(root);
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'host',
      type: 'module',
      dependencies: { legacy: '1.0.0', vue: '3.0.0', vue2: 'npm:vue@2.7.16' },
    }),
  );
  for (const [alias, name, version, code, peers] of [
    ['vue', 'vue', '3.0.0', 'export const version = "3.0.0"; export const token = {};', {}],
    ['vue2', 'vue', '2.7.16', 'export const version = "2.7.16"; export const token = {};', {}],
    [
      'legacy',
      'legacy',
      '1.0.0',
      'import { version, token } from "vue"; export { token }; export const runtimeVersion = version;',
      { vue: '^2.0.0' },
    ],
  ] as const) {
    const directory = join(root, 'node_modules', alias);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({
        name,
        version,
        type: commonjs ? 'commonjs' : 'module',
        exports: './index.js',
        peerDependencies: peers,
      }),
    );
    const cjs =
      alias === 'legacy'
        ? 'const runtime = require("vue"); exports.runtimeVersion = runtime.version; exports.token = runtime.token;'
        : `exports.version = ${JSON.stringify(version)}; exports.token = {};`;
    writeFileSync(join(directory, 'index.js'), commonjs ? cjs : code);
  }
  const entry = join(root, 'entry.js');
  writeFileSync(
    entry,
    commonjs
      ? 'import legacy from "legacy"; import host from "vue"; import alias from "vue2"; export const runtimeVersion = legacy.runtimeVersion; export const hostVersion = host.version; export const shared = legacy.token === alias.token; export const isolated = legacy.token !== host.token;'
      : 'import { token } from "legacy"; import { token as aliasToken } from "vue2"; import { token as hostToken } from "vue"; export { runtimeVersion } from "legacy"; export { version as hostVersion } from "vue"; export const shared = token === aliasToken; export const isolated = token !== hostToken;',
  );
  return { root, entry };
}

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

function nativeDependency(root: string, imported = false, subpath = false): void {
  const legacy = join(root, 'node_modules/legacy');
  const manifest = JSON.parse(readFileSync(join(legacy, 'package.json'), 'utf8'));
  manifest.dependencies = { 'native-addon': '1.0.0' };
  writeFileSync(join(legacy, 'package.json'), JSON.stringify(manifest));
  const native = join(root, 'node_modules/native-addon');
  mkdirSync(native, { recursive: true });
  writeFileSync(
    join(native, 'package.json'),
    JSON.stringify({ name: 'native-addon', version: '1.0.0', main: './index.js' }),
  );
  const code = 'exports.ready = true; exports.load = () => require("./binding.node");';
  writeFileSync(join(native, 'index.js'), code);
  writeFileSync(join(native, 'feature.js'), code);
  writeFileSync(join(native, 'binding.node'), '');
  if (imported) {
    const entry = join(legacy, 'index.js');
    writeFileSync(
      entry,
      readFileSync(entry, 'utf8') +
        `\nimport native from "native-addon${subpath ? '/feature.js' : ''}"; export const nativeReady = native.ready;`,
    );
    const host = join(root, 'entry.js');
    writeFileSync(host, readFileSync(host, 'utf8') + '\nexport { nativeReady } from "legacy";');
  }
}

describe('SSR alias resolution', () => {
  it.each(['unused', 'external', 'exclude'])(
    'avoids forcing an unused native dependency into SSR pre-bundling: %s',
    async (mode) => {
      const { root } = fixture();
      nativeDependency(root);
      const server = await createServer({
        root,
        configFile: false,
        logLevel: 'silent',
        server: { middlewareMode: true, hmr: false },
        ssr:
          mode === 'external'
            ? { external: ['native-addon'] }
            : mode === 'exclude'
              ? { optimizeDeps: { exclude: ['native-addon'] } }
              : {},
        plugins: [
          depsConflictResolverVitePlugin({
            dependencies: ['legacy'],
            offline: true,
            strict: true,
            ssr: 'auto',
          }),
        ],
      });
      try {
        expect(server.config.ssr.optimizeDeps.include).not.toContain('native-addon');
        const result = await server.ssrLoadModule('/entry.js');
        expect(result.runtimeVersion).toBe('2.7.16');
        expect(result.shared).toBe(true);
      } finally {
        await server.close();
      }
    },
  );

  it.each([
    'external',
    'exclude',
    'environment-external',
    'environment-exclude',
    'external-subpath',
    'mixed-external',
  ])('keeps imported native packages outside SSR optimization: %s', async (mode) => {
    const { root } = fixture();
    nativeDependency(root, true, mode === 'external-subpath');
    const external = ['native-addon'];
    const server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      server: { middlewareMode: true, hmr: false },
      ssr:
        mode === 'exclude'
          ? { optimizeDeps: { exclude: external } }
          : mode.startsWith('environment')
            ? {}
            : { external },
      environments:
        mode === 'mixed-external'
          ? { ssr: { resolve: { external: ['other-external'] } } }
          : mode === 'environment-external'
            ? { ssr: { resolve: { external } } }
            : mode === 'environment-exclude'
              ? { ssr: { optimizeDeps: { exclude: external } } }
              : {},
      plugins: [
        depsConflictResolverVitePlugin({
          dependencies: ['legacy'],
          offline: true,
          strict: true,
          ssr: 'auto',
        }),
      ],
    });
    try {
      const result = await server.ssrLoadModule('/entry.js');
      expect(result.nativeReady).toBe(true);
      expect(result.runtimeVersion).toBe('2.7.16');
      expect(result.shared).toBe(true);
    } finally {
      await server.close();
    }
  });

  it.each([false, true])(
    'loads the correct runtime in SSR dev with CommonJS=%s',
    async (commonjs) => {
      const { root } = fixture(commonjs);
      const server = await createServer({
        root,
        configFile: false,
        logLevel: 'silent',
        server: { middlewareMode: true, hmr: false },
        plugins: [
          depsConflictResolverVitePlugin({
            dependencies: ['legacy'],
            offline: true,
            strict: true,
            ssr: 'auto',
          }),
        ],
      });
      try {
        const result = await server.ssrLoadModule('/entry.js');
        expect(result.runtimeVersion).toBe('2.7.16');
        expect(result.hostVersion).toBe('3.0.0');
        expect(result.shared).toBe(true);
        expect(result.isolated).toBe(true);
      } finally {
        await server.close();
      }
    },
  );

  it('bundles the affected dependencies when SSR auto mode is enabled', async () => {
    const { root, entry } = fixture();
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [
        depsConflictResolverVitePlugin({
          dependencies: ['legacy'],
          autoInstall: false,
          offline: true,
          strict: true,
          ssr: 'auto',
        }),
      ],
      build: { ssr: entry, outDir: join(root, 'dist'), minify: false },
    });
    const result = (await import(pathToFileURL(join(root, 'dist/entry.js')).href)) as {
      runtimeVersion: string;
    };
    expect(result.runtimeVersion).toBe('2.7.16');
  });

  it('preserves an existing noExternal=true configuration', async () => {
    const { root } = fixture();
    const config = await resolveConfig(
      {
        root,
        configFile: false,
        logLevel: 'silent',
        ssr: { noExternal: true },
        plugins: [
          depsConflictResolverVitePlugin({
            dependencies: ['legacy'],
            autoInstall: false,
            offline: true,
            ssr: 'auto',
          }),
        ],
      },
      'build',
    );
    expect(config.ssr.noExternal).toBe(true);
  });

  it('merges existing SSR optimizer settings and plugins', async () => {
    const { root } = fixture();
    const config = await resolveConfig(
      {
        root,
        configFile: false,
        logLevel: 'silent',
        ssr: {
          optimizeDeps: {
            include: ['custom'],
            esbuildOptions: {
              define: { CUSTOM_FLAG: 'true' },
              plugins: [{ name: 'custom-ssr-plugin', setup() {} }],
            },
          },
        },
        plugins: [
          depsConflictResolverVitePlugin({
            dependencies: ['legacy'],
            offline: true,
            ssr: 'auto',
          }),
        ],
      },
      'serve',
    );
    expect(config.ssr.optimizeDeps.include).toEqual(
      expect.arrayContaining(['custom', 'legacy', 'vue2']),
    );
    expect(config.ssr.optimizeDeps.esbuildOptions?.define).toEqual({ CUSTOM_FLAG: 'true' });
    expect(config.ssr.optimizeDeps.esbuildOptions?.plugins?.map((plugin) => plugin.name)).toEqual([
      'custom-ssr-plugin',
      'deps-conflict-resolver-esbuild',
    ]);
  });

  it.each(['none', 'array', 'pattern'])(
    'respects external=true and explicit noExternal overrides: %s',
    async (mode) => {
      const { root } = fixture();
      const config = await resolveConfig(
        {
          root,
          configFile: false,
          logLevel: 'silent',
          ssr: {
            external: true,
            noExternal:
              mode === 'array' ? ['legacy', 'vue2'] : mode === 'pattern' ? /^(legacy|vue2)$/ : [],
          },
          plugins: [
            depsConflictResolverVitePlugin({
              dependencies: ['legacy'],
              offline: true,
              strict: true,
              ssr: 'auto',
            }),
          ],
        },
        'serve',
      );
      expect(config.ssr.optimizeDeps.include).toEqual(
        mode === 'none' ? [] : expect.arrayContaining(['legacy', 'vue2']),
      );
    },
  );

  it.each(['top-array', 'top-pattern', 'top-true', 'environment-true'])(
    'merges top-level and environment noExternal for CommonJS SSR: %s',
    async (mode) => {
      const { root } = fixture(true);
      const server = await createServer({
        root,
        configFile: false,
        logLevel: 'silent',
        server: { middlewareMode: true, hmr: false },
        ssr: {
          external: true,
          noExternal:
            mode === 'top-true'
              ? true
              : mode === 'top-pattern'
                ? [/^(legacy|vue2)$/]
                : ['legacy', 'vue2'],
          optimizeDeps: { include: ['vue'] },
        },
        environments: {
          ssr: { resolve: { noExternal: mode === 'environment-true' ? true : ['other-internal'] } },
        },
        plugins: [
          depsConflictResolverVitePlugin({
            dependencies: ['legacy'],
            offline: true,
            strict: true,
            ssr: 'auto',
          }),
        ],
      });
      try {
        const result = await server.ssrLoadModule('/entry.js');
        expect(result.runtimeVersion).toBe('2.7.16');
        expect(result.hostVersion).toBe('3.0.0');
        expect(result.shared).toBe(true);
        expect(result.isolated).toBe(true);
      } finally {
        await server.close();
      }
    },
  );
});
