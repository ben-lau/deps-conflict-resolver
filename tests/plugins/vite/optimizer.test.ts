import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OnResolveArgs, OnResolveOptions, OnResolveResult, PluginBuild } from 'esbuild';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResolver } from '../../../src/core/resolver';
import { createOptimizerOptions } from '../../../src/plugins/vite/optimizer';

const roots: string[] = [];

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'deps-optimizer-'));
  roots.push(root);
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ dependencies: { legacy: '1.0.0', vue: '3.5.0', vue2: 'npm:vue@2.7.16' } }),
  );
  for (const [name, manifest] of Object.entries({
    legacy: { name: 'legacy', version: '1.0.0', peerDependencies: { vue: '^2.0.0' } },
    vue: { name: 'vue', version: '3.5.0' },
    vue2: { name: 'vue', version: '2.7.16' },
  })) {
    const directory = join(root, 'node_modules', name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest));
    writeFileSync(join(directory, 'index.js'), 'export {};');
  }
  const resolver = await createResolver({
    dependencies: ['legacy'],
    projectRoot: root,
    offline: true,
    strict: true,
  });
  return { root, resolver, importer: join(root, 'node_modules/legacy/index.js') };
}

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

describe('optimizer adapters', () => {
  it('keeps SSR external resolution when no Rolldown redirections are active', async () => {
    const { root, resolver } = await fixture();
    vi.spyOn(resolver, 'getAliasPathMappings').mockReturnValue([]);
    const policy = { isExternal: () => true, resolve: async () => undefined };
    const options = createOptimizerOptions(resolver, root, '8.3.8', {
      filterRequests: true,
      ssrExternal: policy,
    });
    expect(options.rolldownOptions!.plugins.map(({ name }) => name)).toEqual([
      'deps-conflict-resolver-ssr-external',
    ]);
    const unfiltered = createOptimizerOptions(resolver, root, '8.3.8', {
      filterRequests: false,
      ssrExternal: policy,
    });
    expect(unfiltered.rolldownOptions!.plugins).toHaveLength(2);
  });

  it('applies SSR externals to nested esbuild requests while preserving whitelist and entry points', async () => {
    const { root, resolver, importer } = await fixture();
    const resolve = vi.fn(async (_source: string, _importer: string, isRequire: boolean) =>
      isRequire ? '/nested/native.cjs' : 'data:text/javascript,export{}',
    );
    const isExternal = vi.fn((name: string) => name !== '@scope/allowed');
    const options = createOptimizerOptions(resolver, root, '7.3.5', {
      filterRequests: true,
      ssrExternal: { isExternal, resolve },
    });
    let callback!: (args: OnResolveArgs) => Promise<OnResolveResult | null>;
    await options.esbuildOptions!.plugins[1]!.setup({
      onResolve(_options: unknown, handler: typeof callback) {
        callback = handler;
      },
    } as unknown as PluginBuild);
    const args = {
      path: '@scope/native/subpath',
      importer,
      kind: 'require-call',
      namespace: 'file',
      resolveDir: root,
      pluginData: undefined,
      with: {},
    } as OnResolveArgs;
    expect(await callback(args)).toEqual({ path: '/nested/native.cjs', external: true });
    expect(isExternal).toHaveBeenCalledWith('@scope/native');
    expect(resolve).toHaveBeenCalledWith(args.path, importer, true);
    expect(await callback({ ...args, kind: 'import-statement' })).toEqual({
      path: 'data:text/javascript,export{}',
      external: true,
    });
    const calls = resolve.mock.calls.length;
    for (const path of [
      '@scope/allowed/subpath',
      './relative.js',
      '/absolute.js',
      '\0virtual',
      'virtual:module',
      'node:fs',
      '#private',
    ]) {
      expect(await callback({ ...args, path })).toBeNull();
    }
    expect(await callback({ ...args, importer: '', kind: 'entry-point' })).toBeNull();
    expect(resolve).toHaveBeenCalledTimes(calls);
    expect(createOptimizerOptions(resolver, root, '7.3.5').esbuildOptions!.plugins).toHaveLength(1);
  });

  it('preserves require/import kinds for native Rolldown SSR externals', async () => {
    const { root, resolver, importer } = await fixture();
    const resolve = vi.fn(async (_source: string, _importer: string, isRequire: boolean) =>
      isRequire ? '/nested/native.cjs' : 'data:text/javascript,export{}',
    );
    const options = createOptimizerOptions(resolver, root, '8.3.8', {
      filterRequests: true,
      ssrExternal: { isExternal: (name) => name !== 'allowed', resolve },
    });
    const hook = options.rolldownOptions!.plugins[1]!.resolveId;
    if (typeof hook !== 'function') throw new Error('Expected resolveId function');
    const context = {} as ThisParameterType<typeof hook>;
    const request = { isEntry: false, attributes: {}, custom: undefined, kind: 'require-call' };
    expect(await hook.call(context, 'native-addon', importer, request)).toEqual({
      id: '/nested/native.cjs',
      external: true,
    });
    expect(resolve).toHaveBeenCalledWith('native-addon', importer, true);
    expect(
      await hook.call(context, 'native-addon', importer, { ...request, kind: 'import-statement' }),
    ).toEqual({ id: 'data:text/javascript,export{}', external: true });
    expect(resolve).toHaveBeenLastCalledWith('native-addon', importer, false);
    expect(await hook.call(context, 'allowed/subpath', importer, request)).toBeNull();
    expect(
      await hook.call(context, 'native-addon', undefined, { ...request, isEntry: true }),
    ).toBeNull();
  });

  it('preserves esbuild resolution metadata for a redirected request', async () => {
    const { root, resolver, importer } = await fixture();
    let callback:
      | ((args: OnResolveArgs) => OnResolveResult | null | Promise<OnResolveResult | null>)
      | undefined;
    const result = {
      path: '/external/vue.js',
      external: true,
      namespace: 'custom',
      suffix: '?x',
      sideEffects: false,
      errors: [],
      warnings: [],
    };
    const resolve = vi.fn().mockResolvedValue(result);
    const onResolve = (_options: OnResolveOptions, handler: NonNullable<typeof callback>) => {
      callback = handler;
    };
    await createOptimizerOptions(resolver, root, '7.3.5').esbuildOptions!.plugins[0]!.setup({
      onResolve,
      resolve,
    } as unknown as PluginBuild);
    const args = {
      path: 'vue',
      importer,
      kind: 'require-call',
      namespace: 'file',
      resolveDir: root,
      pluginData: undefined,
      with: {},
    } satisfies OnResolveArgs;
    expect(callback!({ ...args, importer: join(root, 'entry.js') })).toBeNull();
    const actual = await callback!(args);
    expect(actual).toEqual(result);
    expect(resolve).toHaveBeenCalledWith(
      'vue2',
      expect.objectContaining({ kind: 'require-call', resolveDir: root, importer }),
    );
  });

  it('uses native Rolldown hooks and resolves aliases from the project for Vite 8', async () => {
    const { root, resolver, importer } = await fixture();
    const options = createOptimizerOptions(resolver, root, '8.3.8');
    expect(options.esbuildOptions).toBeUndefined();
    const plugin = options.rolldownOptions!.plugins[0]!;
    const resolveId = plugin.resolveId;
    if (!resolveId || typeof resolveId === 'function') throw new Error('Expected a filtered hook');
    const hook = resolveId.handler;
    expect(resolveId.filter).toEqual({ id: expect.any(RegExp) });
    const result = { id: '/external/vue.js', external: true };
    const resolve = vi.fn().mockResolvedValue(result);
    const context = { resolve } as unknown as ThisParameterType<typeof hook>;
    const optionsForImport = { isEntry: false, attributes: {}, custom: undefined };
    expect(hook.call(context, 'vue-extra', importer, optionsForImport)).toBeNull();
    expect(hook.call(context, 'vue', join(root, 'entry.js'), optionsForImport)).toBeNull();
    const resolved = await hook.call(context, 'vue', importer, optionsForImport);
    expect(resolved).toEqual(result);
    expect(resolve).toHaveBeenCalledWith(
      'vue2',
      join(root, 'package.json'),
      expect.objectContaining({ skipSelf: true }),
    );
  });
});
