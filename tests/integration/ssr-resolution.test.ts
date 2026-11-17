import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync } from 'node:fs';
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
  it.each(['await', 'throw', 'then'] as const)(
    'keeps native external evaluation semantics: %s',
    async (kind) => {
      const { root } = fixture();
      const legacy = join(root, 'node_modules/legacy');
      const provider = join(legacy, 'node_modules/evaluated-native');
      mkdirSync(provider, { recursive: true });
      writeFileSync(
        join(provider, 'package.json'),
        JSON.stringify({
          name: 'evaluated-native',
          version: '1.0.0',
          type: 'module',
          exports: './index.mjs',
        }),
      );
      writeFileSync(
        join(provider, 'index.mjs'),
        kind === 'throw'
          ? 'throw new Error("native evaluation failed");'
          : kind === 'await'
            ? 'await Promise.resolve(); export const value="ready"; export const marker={};'
            : 'import * as self from "./index.mjs"; export const marker={}; export function then(resolve){resolve({value:"ready",own:this===self,marker});}',
      );
      const original = JSON.parse(readFileSync(join(legacy, 'package.json'), 'utf8'));
      writeFileSync(
        join(legacy, 'package.json'),
        JSON.stringify({ ...original, dependencies: { 'evaluated-native': '1.0.0' } }),
      );
      writeFileSync(
        join(legacy, 'index.js'),
        readFileSync(join(legacy, 'index.js'), 'utf8') +
          '\nimport * as native from "evaluated-native"; export const nativeValue=native.value; export const own=native.own; export const marker=native.marker;',
      );
      writeFileSync(
        join(root, 'entry.js'),
        readFileSync(join(root, 'entry.js'), 'utf8') +
          '\nexport {nativeValue,own,marker} from "legacy";',
      );
      const server = await createServer({
        root,
        configFile: false,
        logLevel: 'silent',
        server: { middlewareMode: true, hmr: false },
        ssr: { external: true, noExternal: ['legacy', 'vue', 'vue2'] },
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
        if (kind === 'throw') {
          await expect(server.ssrLoadModule('/entry.js')).rejects.toThrow(
            'native evaluation failed',
          );
        } else {
          const url = pathToFileURL(join(provider, 'index.mjs')).href;
          const native = (
            await import(
              'data:text/javascript,' +
                encodeURIComponent('export default await import(' + JSON.stringify(url) + ');')
            )
          ).default;
          const result = await server.ssrLoadModule('/entry.js');
          expect(result.nativeValue).toBe(native.value);
          expect(result.marker).toBe(native.marker);
          if (kind === 'then') expect(result.own).toBe(true);
          expect(result.runtimeVersion).toBe('2.7.16');
        }
      } finally {
        await server.close();
      }
    },
  );

  it('preserves nested native ESM namespace identity, live bindings and warm-cache identity', async () => {
    const { root } = fixture();
    const legacy = join(root, 'node_modules/legacy');
    const provider = join(legacy, 'node_modules/namespace-provider');
    mkdirSync(provider, { recursive: true });
    writeFileSync(
      join(provider, 'package.json'),
      JSON.stringify({
        name: 'namespace-provider',
        version: '1.0.0',
        type: 'module',
        exports: './index.mjs',
      }),
    );
    writeFileSync(
      join(provider, 'index.mjs'),
      'import * as self from "./index.mjs"; export {self}; export const token = {}; export let value = 0; export function increment(){value++;}',
    );
    const original = JSON.parse(readFileSync(join(legacy, 'package.json'), 'utf8'));
    writeFileSync(
      join(legacy, 'package.json'),
      JSON.stringify({ ...original, dependencies: { 'namespace-provider': '1.0.0' } }),
    );
    writeFileSync(
      join(legacy, 'index.js'),
      readFileSync(join(legacy, 'index.js'), 'utf8') +
        '\nimport * as native from "namespace-provider"; export const namespaceStable = native === native.self; export const nativeToken = native.token; export function readNative(){return native.value;} export const increment = native.increment;',
    );
    writeFileSync(
      join(root, 'entry.js'),
      readFileSync(join(root, 'entry.js'), 'utf8') +
        '\nexport {namespaceStable,nativeToken,readNative,increment} from "legacy";',
    );
    const nativeUrl = pathToFileURL(join(provider, 'index.mjs')).href;
    // The test runner transforms file imports too. Load the reference through
    // a native data module so this compares with Node's actual module cache.
    const native = (
      await import(
        'data:text/javascript,' +
          encodeURIComponent(
            'import * as native from ' + JSON.stringify(nativeUrl) + '; export {native};',
          )
      )
    ).native;
    let metadata: string | undefined;
    for (let pass = 0; pass < 2; pass++) {
      const server = await createServer({
        root,
        configFile: false,
        logLevel: 'silent',
        server: { middlewareMode: true, hmr: false },
        ssr: { external: true, noExternal: ['legacy', 'vue', 'vue2'] },
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
        expect(result.namespaceStable).toBe(true);
        expect(result.nativeToken).toBe(native.token);
        result.increment();
        expect(result.readNative()).toBe(native.value);
        expect(native.value).toBe(pass + 1);
        const current = readFileSync(
          join(server.config.cacheDir, 'deps_ssr/_metadata.json'),
          'utf8',
        );
        if (metadata) expect(current).toBe(metadata);
        metadata = current;
      } finally {
        await server.close();
      }
    }
  });

  it.for([
    { commonjs: false, location: 'root', pattern: false },
    { commonjs: true, location: 'root', pattern: false },
    { commonjs: false, location: 'nested', pattern: false },
    { commonjs: true, location: 'nested', pattern: false },
    { commonjs: false, location: 'subpath', pattern: true },
    { commonjs: true, location: 'subpath', pattern: true },
    { commonjs: false, location: 'esm-only', pattern: true },
    { commonjs: false, location: 'named-only', pattern: true },
    { commonjs: false, location: 'named-only-js', pattern: true },
    { commonjs: false, location: 'typeless-named-only-js', pattern: true },
    { commonjs: false, location: 'nested-cjs-return', pattern: false },
    { commonjs: false, location: 'nested-dual-main', pattern: false },
  ])(
    'applies external=true to nested SSR requests: $commonjs, $location, pattern=$pattern',
    async ({ commonjs, location, pattern }, context) => {
      if (
        location === 'typeless-named-only-js' &&
        Number(process.versions.node.split('.')[0]) < 22
      ) {
        context.skip('Requires native Node syntax detection');
      }
      const { root } = fixture(commonjs);
      nativeDependency(root);
      const legacy = join(root, 'node_modules/legacy');
      let native = join(root, 'node_modules/native-addon');
      const namedOnly = location.includes('named-only');
      if (
        [
          'nested',
          'esm-only',
          'named-only',
          'named-only-js',
          'typeless-named-only-js',
          'nested-cjs-return',
          'nested-dual-main',
        ].includes(location)
      ) {
        const directory = join(legacy, 'node_modules/native-addon');
        mkdirSync(join(legacy, 'node_modules'), { recursive: true });
        renameSync(native, directory);
        native = directory;
      }
      if (location === 'esm-only' || namedOnly) {
        const esmEntry = location.endsWith('-js') ? './index.js' : './index.mjs';
        writeFileSync(
          join(native, 'package.json'),
          JSON.stringify({
            name: 'native-addon',
            version: '1.0.0',
            ...(location === 'typeless-named-only-js' ? {} : { type: 'module' }),
            exports: { '.': { import: esmEntry } },
          }),
        );
        writeFileSync(
          join(native, esmEntry),
          (namedOnly ? 'export const ready = true;' : 'export default { ready: true };') +
            'export const load = () => import("./binding.node");',
        );
      }
      if (location === 'nested-cjs-return') {
        writeFileSync(join(native, 'index.js'), 'exports.ready = true; return;');
      }
      if (location === 'nested-dual-main') {
        writeFileSync(
          join(native, 'package.json'),
          JSON.stringify({
            name: 'native-addon',
            version: '1.0.0',
            main: './index.js',
            module: './wrong.js',
          }),
        );
        writeFileSync(join(native, 'wrong.js'), 'throw new Error("Wrong Node entry");');
      }
      const allowed = join(legacy, 'node_modules/allowed-helper');
      mkdirSync(allowed, { recursive: true });
      writeFileSync(
        join(allowed, 'package.json'),
        JSON.stringify({ name: 'allowed-helper', version: '1.0.0', main: './index.ts' }),
      );
      writeFileSync(join(allowed, 'index.ts'), 'export const allowed: boolean = true;');
      const source = 'native-addon' + (location === 'subpath' ? '/feature.js' : '');
      const file = join(legacy, 'index.js');
      writeFileSync(
        file,
        readFileSync(file, 'utf8') +
          (commonjs
            ? `\nexports.nativeReady = require(${JSON.stringify(source)}).ready; exports.allowed = require("allowed-helper").allowed;`
            : `\nimport ${namedOnly ? '* as native' : 'native'} from ${JSON.stringify(source)}; export const nativeReady = native.ready; export const hasDefault = "default" in native; export { allowed } from "allowed-helper";`),
      );
      const entry = join(root, 'entry.js');
      writeFileSync(
        entry,
        readFileSync(entry, 'utf8') +
          '\nexport { nativeReady, allowed } from "legacy";' +
          (namedOnly ? '\nexport { hasDefault } from "legacy";' : ''),
      );
      let metadata: string | undefined;
      for (let pass = 0; pass < (location === 'esm-only' ? 2 : 1); pass++) {
        const server = await createServer({
          root,
          configFile: false,
          logLevel: 'silent',
          server: { middlewareMode: true, hmr: false },
          ssr: {
            external: true,
            noExternal: pattern
              ? /^(legacy|vue2?|allowed-helper)$/
              : ['legacy', 'vue2', 'vue', 'allowed-helper'],
            optimizeDeps: { include: ['vue'] },
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
          expect(result.nativeReady).toBe(true);
          expect(result.allowed).toBe(true);
          if (namedOnly) expect(result.hasDefault).toBe(false);
          expect(result.runtimeVersion).toBe('2.7.16');
          expect(result.hostVersion).toBe('3.0.0');
          expect(result.shared).toBe(true);
          expect(result.isolated).toBe(true);
          if (location === 'esm-only') {
            const current = readFileSync(
              join(server.config.cacheDir, 'deps_ssr/_metadata.json'),
              'utf8',
            );
            if (metadata) expect(current).toBe(metadata);
            metadata = current;
          }
        } finally {
          await server.close();
        }
      }
    },
  );

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
