import type { Plugin, ResolvedConfig, UserConfig, ConfigEnv } from 'vite';
import { createLogger } from 'vite';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { depsConflictResolverVitePlugin, createViteAliases } from '../../../src/plugins/vite';
import type { AliasPathMapping, AnalysisResult } from '../../../src/types';

// Mock resolver - 使用真正的 class 来模拟
const mockResolverInstance = {
  initialize: vi.fn(),
  getAnalysisResult: vi.fn(),
  getAliasPathMappings: vi.fn(),
  getOptions: vi.fn(),
  getResolutionFingerprint: vi.fn().mockReturnValue('fixture'),
  resolveModule: vi.fn(),
  getDiagnostics: vi.fn().mockReturnValue([]),
};

vi.mock('../../../src/core/resolver', () => ({
  getResolverBuild: () => ({
    snapshot: () => ({ analysis: mockResolverInstance.getAnalysisResult() }),
  }),
  DepsConflictResolver: class MockDepsConflictResolver {
    constructor() {
      return mockResolverInstance;
    }
  },
}));

async function configure(
  plugin: Plugin,
  command: 'serve' | 'build' = 'build',
  input: UserConfig = {},
) {
  const config = {
    root: '/test',
    resolve: {},
    optimizeDeps: {},
    ssr: {},
    logger: createLogger('silent'),
    ...input,
    command,
  } as unknown as ResolvedConfig;
  (plugin.config as (c: UserConfig, env: ConfigEnv) => void)(input, { command, mode: 'test' });
  await (plugin.configResolved as (c: ResolvedConfig) => Promise<void>)(config);
  return config;
}

function resolveHook(plugin: Plugin) {
  const hook = plugin.resolveId!;
  return typeof hook === 'function' ? hook : hook.handler;
}

function applyToEnvironment(plugin: Plugin, config: ResolvedConfig) {
  const environment = {
    getTopLevelConfig: () => config,
  } as Parameters<NonNullable<Plugin['applyToEnvironment']>>[0];
  return plugin.applyToEnvironment!(environment);
}

describe('Vite Plugin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createViteAliases', () => {
    it('should create package-root aliases without concatenating subpaths', () => {
      const mappings: AliasPathMapping[] = [
        {
          aliasName: 'aliased-vue',
          originalName: 'vue',
          path: '/node_modules/aliased-vue',
        },
        {
          aliasName: '@scope/pkg',
          originalName: '@scope/pkg',
          path: '/node_modules/@scope/pkg',
        },
      ];

      const aliases = createViteAliases(mappings);

      // Each mapping gets a package-root alias. Subpaths must be resolved by
      // Vite so that package exports and conditional entry points remain active.
      expect(aliases).toHaveLength(2);

      // 精确匹配
      const exactMatch = aliases[0]!.find as RegExp;
      expect(exactMatch.test('aliased-vue')).toBe(true);
      expect(exactMatch.test('aliased-vue/x')).toBe(false);
      expect(aliases[0]!.replacement).toBe('/node_modules/aliased-vue');

      expect(exactMatch.test('aliased-vue/dist/vue.js')).toBe(false);

      // scoped 包的 regex 转义
      const scopedMatch = aliases[1]!.find as RegExp;
      expect(scopedMatch.test('@scope/pkg')).toBe(true);
      expect(scopedMatch.test('@scopeXpkg')).toBe(false);
    });

    it('should return empty array for empty mappings', () => {
      expect(createViteAliases([])).toEqual([]);
    });
  });

  describe('depsConflictResolverVitePlugin', () => {
    const analysis: AnalysisResult = {
      aliasMappings: [
        {
          originalName: 'vue',
          aliasName: 'aliased-vue',
          resolvedVersion: '2.7.16',
          usedBy: ['legacy'],
          allDependents: ['legacy'],
          installSpec: '',
        },
      ],
      missingFirstLevelPeers: [],
      peerConflicts: [],
      analyzedDependencies: new Map(),
    };
    beforeEach(() => {
      mockResolverInstance.initialize.mockResolvedValue(undefined);
      mockResolverInstance.getAnalysisResult.mockReturnValue(analysis);
      mockResolverInstance.getAliasPathMappings.mockReturnValue([
        { originalName: 'vue', aliasName: 'aliased-vue', path: '/test/node_modules/aliased-vue' },
      ]);
      mockResolverInstance.getOptions.mockReturnValue({ projectRoot: '/test' });
      mockResolverInstance.resolveModule.mockReturnValue(null);
    });

    it('keeps pre resolution and waits for final configuration before initializing', async () => {
      const plugin = depsConflictResolverVitePlugin({ dependencies: ['legacy'] });
      expect(plugin.name).toBe('deps-conflict-resolver');
      expect(plugin.enforce).toBe('pre');
      (plugin.config as (c: UserConfig, env: ConfigEnv) => void)(
        {},
        { command: 'build', mode: 'test' },
      );
      expect(mockResolverInstance.initialize).not.toHaveBeenCalled();
      const final = await configure(plugin);
      expect(mockResolverInstance.initialize).toHaveBeenCalledTimes(1);
      expect(final.optimizeDeps.include).toContain('aliased-vue');
    });

    it.each(['before', 'during', 'after'] as const)(
      'preserves a main instance when its Worker callback runs %s initialization',
      async (timing) => {
        const plugin = depsConflictResolverVitePlugin({ dependencies: ['legacy'] });
        const main = {
          root: '/test',
          command: 'build',
          plugins: [plugin],
          logger: createLogger('silent'),
          optimizeDeps: {},
          ssr: {},
        } as unknown as ResolvedConfig;
        const worker = { ...main, isWorker: true, mainConfig: main };
        const configureHook = plugin.config as (config: UserConfig, env: ConfigEnv) => void;
        const ready = plugin.configResolved as (config: ResolvedConfig) => Promise<void>;
        configureHook({}, { command: 'build', mode: 'test' });
        let release!: () => void;
        mockResolverInstance.initialize.mockImplementationOnce(
          () =>
            new Promise<void>((done) => {
              release = done;
            }),
        );
        if (timing === 'before') await ready(worker);
        const preparing = ready(main);
        if (timing === 'during') await ready(worker);
        release();
        await preparing;
        if (timing === 'after') {
          // Later Vite versions can also call config again for a reused
          // instance. That call must not erase the initialized main resolver.
          configureHook({}, { command: 'build', mode: 'test' });
          await ready(worker);
        }
        expect(mockResolverInstance.initialize).toHaveBeenCalledTimes(1);
        const resolve = resolveHook(plugin) as (source: string, importer?: string) => null;
        expect(resolve('vue', '/test/legacy/index.js')).toBeNull();
        expect(mockResolverInstance.resolveModule).toHaveBeenCalledWith(
          'vue',
          '/test/legacy/index.js',
        );
      },
    );

    it('initializes a dedicated Worker without changing inherited optimizer or SSR settings', async () => {
      const plugin = depsConflictResolverVitePlugin({ dependencies: ['legacy'], ssr: 'auto' });
      const main = { plugins: [] };
      const worker = {
        root: '/test',
        command: 'build',
        isWorker: true,
        mainConfig: main,
        optimizeDeps: { include: ['host'] },
        ssr: { noExternal: ['host'] },
      } as unknown as ResolvedConfig;
      await (plugin.configResolved as (config: ResolvedConfig) => Promise<void>)(worker);
      expect(mockResolverInstance.initialize).toHaveBeenCalledTimes(1);
      expect(worker.optimizeDeps).toEqual({ include: ['host'] });
      expect(worker.ssr).toEqual({ noExternal: ['host'] });
    });

    it.each(['serve', 'build'] as const)('honors enable flags in %s', async (command) => {
      const plugin = depsConflictResolverVitePlugin({
        dependencies: ['legacy'],
        enableInDev: false,
        enableInBuild: false,
      });
      const config = await configure(plugin, command, { plugins: [plugin] });
      expect(mockResolverInstance.initialize).not.toHaveBeenCalled();
      expect(config.optimizeDeps.include).toBeUndefined();
      expect(await applyToEnvironment(plugin, config)).toBe(false);
      const worker = { ...config, mainConfig: config, isWorker: true };
      expect(await applyToEnvironment(plugin, worker)).toBe(false);
      const resolveId = resolveHook(plugin) as (source: string, importer?: string) => unknown;
      expect(resolveId('vue', '/test/index.js')).toBeNull();
    });

    it('preserves user configuration and includes only active aliases', async () => {
      mockResolverInstance.getAnalysisResult.mockReturnValue({
        ...analysis,
        aliasMappings: [
          ...analysis.aliasMappings,
          {
            ...analysis.aliasMappings[0],
            aliasName: 'failed-vue',
            installSpec: 'failed-vue@npm:vue@1.0.0',
          },
        ],
      });
      const plugin = depsConflictResolverVitePlugin({ dependencies: ['legacy'] });
      const config = await configure(plugin, 'serve', {
        optimizeDeps: { include: ['manual'] },
        resolve: { alias: { custom: '/custom' } },
      });
      expect(config.optimizeDeps.include).toEqual(['manual', 'aliased-vue']);
      expect(config.resolve.alias).toEqual({ custom: '/custom' });
    });

    it('leaves optimization configuration alone when no mappings are needed', async () => {
      mockResolverInstance.getAnalysisResult.mockReturnValue({ ...analysis, aliasMappings: [] });
      mockResolverInstance.getAliasPathMappings.mockReturnValue([]);
      const plugin = depsConflictResolverVitePlugin({ dependencies: ['legacy'] });
      const config = await configure(plugin);
      expect(config.optimizeDeps.include).toBeUndefined();
      expect(await applyToEnvironment(plugin, config)).toBe(false);
      const resolveId = resolveHook(plugin) as (source: string, importer: string) => unknown;
      expect(resolveId('vue', '/test/index.js')).toBeNull();
      expect(mockResolverInstance.resolveModule).not.toHaveBeenCalled();
    });

    it.each(['./relative', '/absolute', '\0virtual'])(
      'leaves %s to the native resolver',
      async (source) => {
        const plugin = depsConflictResolverVitePlugin({ dependencies: ['legacy'] });
        await configure(plugin);
        const resolveId = resolveHook(plugin) as (source: string, importer?: string) => unknown;
        expect(resolveId(source, '/test/index.js')).toBeNull();
        expect(mockResolverInstance.resolveModule).not.toHaveBeenCalled();
      },
    );

    it('leaves unmatched requests to the native resolver', async () => {
      const plugin = depsConflictResolverVitePlugin({ dependencies: ['legacy'] });
      await configure(plugin);
      const resolveId = resolveHook(plugin) as (source: string, importer?: string) => unknown;
      expect(resolveId('unrelated', '/test/index.js')).toBeNull();
      expect(mockResolverInstance.resolveModule).not.toHaveBeenCalled();
    });

    it('keeps request filtering with a passive analysis hook', async () => {
      const plugin = depsConflictResolverVitePlugin({
        dependencies: ['legacy'],
        hooks: { onAnalysisComplete() {} },
      });
      const config = await configure(plugin);
      const filtered = (await applyToEnvironment(plugin, config)) as Plugin;
      const hook = filtered.resolveId;
      if (!hook || typeof hook === 'function') throw new Error('Expected a filtered hook');
      const filter = hook.filter?.id;
      if (!(filter instanceof RegExp)) throw new Error('Expected a package request filter');
      expect(filter.test('vue')).toBe(true);
      expect(filter.test('unrelated')).toBe(false);
    });

    it('builds a fresh environment filter from the active aliases for each configuration', async () => {
      const plugin = depsConflictResolverVitePlugin({ dependencies: ['legacy'] });
      const filterFor = async (config: ResolvedConfig) => {
        const filtered = (await applyToEnvironment(plugin, config)) as Plugin;
        const hook = filtered.resolveId;
        if (!hook || typeof hook === 'function') throw new Error('Expected a filtered hook');
        const filter = hook.filter?.id;
        if (!(filter instanceof RegExp)) throw new Error('Expected a package request filter');
        return { filtered, filter };
      };
      const initial = await filterFor(await configure(plugin));
      for (const request of ['vue', 'vue/feature', 'vue?raw', 'vue#fragment']) {
        expect(initial.filter.test(request)).toBe(true);
      }
      expect(initial.filter.test('vue-extra')).toBe(false);
      mockResolverInstance.getAliasPathMappings.mockReturnValue([
        {
          originalName: '@scope/runtime',
          aliasName: 'runtime1',
          path: '/test/node_modules/runtime1',
        },
      ]);
      const replacement = await filterFor(await configure(plugin));
      expect(replacement.filtered).not.toBe(initial.filtered);
      expect(replacement.filter.test('@scope/runtime/subpath')).toBe(true);
      expect(replacement.filter.test('vue')).toBe(false);
    });

    it.each([{ hooks: { beforeResolve: () => undefined } }, { strict: true }])(
      'continues forwarding unrelated requests with no active aliases and %j',
      async (options) => {
        mockResolverInstance.getAliasPathMappings.mockReturnValue([]);
        const plugin = depsConflictResolverVitePlugin({ dependencies: ['legacy'], ...options });
        const config = await configure(plugin);
        expect(await applyToEnvironment(plugin, config)).toBe(true);
        const resolveId = resolveHook(plugin) as (source: string, importer: string) => unknown;
        expect(resolveId('unrelated', '/test/index.js')).toBeNull();
        expect(mockResolverInstance.resolveModule).toHaveBeenCalledWith(
          'unrelated',
          '/test/index.js',
        );
      },
    );

    it('delegates redirected requests from the final host context and preserves native results', async () => {
      const plugin = depsConflictResolverVitePlugin({ dependencies: ['legacy'] });
      await configure(plugin);
      mockResolverInstance.resolveModule.mockReturnValue('aliased-vue/feature');
      const result = { id: '/resolved/feature.js', moduleSideEffects: false };
      const context = { resolve: vi.fn().mockResolvedValue(result) };
      const resolveId = resolveHook(plugin) as unknown as (
        this: typeof context,
        source: string,
        importer: string,
        options: object,
      ) => Promise<unknown>;
      expect(await resolveId.call(context, 'vue/feature', '/linked/index.js', { ssr: true })).toBe(
        result,
      );
      expect(context.resolve).toHaveBeenCalledWith('aliased-vue/feature', '/test/package.json', {
        ssr: true,
        skipSelf: true,
      });
    });
  });
});
