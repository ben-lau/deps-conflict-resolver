import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { depsConflictResolverVitePlugin, createViteAliases } from '../../../src/plugins/vite';
import type { AliasPathMapping, AnalysisResult } from '../../../src/types';

// Mock resolver - 使用真正的 class 来模拟
const mockResolverInstance = {
  initialize: vi.fn(),
  getAnalysisResult: vi.fn(),
  getAliasPathMappings: vi.fn(),
  getOptions: vi.fn(),
  resolveModule: vi.fn(),
};

vi.mock('../../../src/core/resolver', () => ({
  DepsConflictResolver: class MockDepsConflictResolver {
    constructor() {
      return mockResolverInstance;
    }
  },
}));

describe('Vite Plugin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createViteAliases', () => {
    it('should create exact and subpath aliases with proper regex escaping', () => {
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

      // 每个 mapping 生成 2 个 alias（精确匹配 + 子路径）
      expect(aliases).toHaveLength(4);

      // 精确匹配
      const exactMatch = aliases[0]!.find as RegExp;
      expect(exactMatch.test('aliased-vue')).toBe(true);
      expect(exactMatch.test('aliased-vue/x')).toBe(false);
      expect(aliases[0]!.replacement).toBe('/node_modules/aliased-vue');

      // 子路径匹配
      const subpathMatch = aliases[1]!.find as RegExp;
      expect(subpathMatch.test('aliased-vue/dist/vue.js')).toBe(true);
      expect(subpathMatch.test('aliased-vue')).toBe(false);

      // scoped 包的 regex 转义
      const scopedMatch = aliases[2]!.find as RegExp;
      expect(scopedMatch.test('@scope/pkg')).toBe(true);
      expect(scopedMatch.test('@scopeXpkg')).toBe(false);
    });

    it('should return empty array for empty mappings', () => {
      expect(createViteAliases([])).toEqual([]);
    });
  });

  describe('depsConflictResolverVitePlugin', () => {
    const mockAnalysisResult: AnalysisResult = {
      aliasMappings: [
        {
          originalName: 'vue',
          aliasName: 'aliased-vue',
          resolvedVersion: '2.7.0',
          usedBy: ['some-package'],
          allDependents: ['some-package'],
          installSpec: 'aliased-vue@npm:vue@2.7.0',
        },
      ],
      missingFirstLevelPeers: [],
      peerConflicts: [],
      analyzedDependencies: new Map(),
    };

    const mockAliasPathMappings: AliasPathMapping[] = [
      {
        aliasName: 'aliased-vue',
        originalName: 'vue',
        path: '/test/node_modules/aliased-vue',
      },
    ];

    it('should create plugin with correct name', () => {
      const plugin = depsConflictResolverVitePlugin({
        dependencies: ['vue'],
      });

      expect(plugin.name).toBe('deps-conflict-resolver');
    });

    it('should enforce pre', () => {
      const plugin = depsConflictResolverVitePlugin({
        dependencies: ['vue'],
      });

      expect(plugin.enforce).toBe('pre');
    });

    it('should disable plugin when enableInDev is false in dev mode', async () => {
      mockResolverInstance.initialize.mockResolvedValue(undefined);
      mockResolverInstance.getAnalysisResult.mockReturnValue(mockAnalysisResult);
      mockResolverInstance.getAliasPathMappings.mockReturnValue(mockAliasPathMappings);
      mockResolverInstance.getOptions.mockReturnValue({ projectRoot: '/test' });

      const plugin = depsConflictResolverVitePlugin({
        dependencies: ['vue'],
        enableInDev: false,
      });

      const config = plugin.config as (
        config: unknown,
        env: { command: string },
      ) => Promise<unknown>;
      const result = await config({}, { command: 'serve' });

      expect(result).toBeUndefined();
    });

    it('should disable plugin when enableInBuild is false in build mode', async () => {
      mockResolverInstance.initialize.mockResolvedValue(undefined);
      mockResolverInstance.getAnalysisResult.mockReturnValue(mockAnalysisResult);
      mockResolverInstance.getAliasPathMappings.mockReturnValue(mockAliasPathMappings);
      mockResolverInstance.getOptions.mockReturnValue({ projectRoot: '/test' });

      const plugin = depsConflictResolverVitePlugin({
        dependencies: ['vue'],
        enableInBuild: false,
      });

      const config = plugin.config as (
        config: unknown,
        env: { command: string },
      ) => Promise<unknown>;
      const result = await config({}, { command: 'build' });

      expect(result).toBeUndefined();
    });

    it('should return null when no aliases needed', async () => {
      mockResolverInstance.initialize.mockResolvedValue(undefined);
      mockResolverInstance.getAnalysisResult.mockReturnValue({
        aliasMappings: [],
        missingFirstLevelPeers: [],
        peerConflicts: [],
        packages: {},
      });
      mockResolverInstance.getAliasPathMappings.mockReturnValue([]);
      mockResolverInstance.getOptions.mockReturnValue({ projectRoot: '/test' });

      const plugin = depsConflictResolverVitePlugin({
        dependencies: ['vue'],
      });

      const config = plugin.config as (
        config: unknown,
        env: { command: string },
      ) => Promise<unknown>;
      const result = await config({}, { command: 'build' });

      expect(result).toBeUndefined();
    });

    it('should configure aliases and optimizeDeps when aliases exist', async () => {
      mockResolverInstance.initialize.mockResolvedValue(undefined);
      mockResolverInstance.getAnalysisResult.mockReturnValue(mockAnalysisResult);
      mockResolverInstance.getAliasPathMappings.mockReturnValue(mockAliasPathMappings);
      mockResolverInstance.getOptions.mockReturnValue({ projectRoot: '/test' });

      const plugin = depsConflictResolverVitePlugin({
        dependencies: ['vue'],
      });

      const config = plugin.config as (
        config: unknown,
        env: { command: string },
      ) => Promise<unknown>;
      const result = (await config({}, { command: 'build' })) as {
        resolve?: { alias?: unknown[] };
        optimizeDeps?: { include?: string[] };
      };

      expect(result).toBeDefined();
      expect(result?.resolve?.alias).toBeDefined();
      expect(result?.optimizeDeps?.include).toContain('aliased-vue');
    });

    describe('resolveId', () => {
      it.each([
        { desc: 'relative paths', source: './relative/path' },
        { desc: 'absolute paths', source: '/absolute/path' },
        { desc: 'virtual modules', source: '\0virtual:module' },
      ])('should skip $desc', async ({ source }) => {
        mockResolverInstance.initialize.mockResolvedValue(undefined);
        mockResolverInstance.getAnalysisResult.mockReturnValue(mockAnalysisResult);
        mockResolverInstance.getAliasPathMappings.mockReturnValue(mockAliasPathMappings);
        mockResolverInstance.getOptions.mockReturnValue({
          projectRoot: '/test',
        });
        mockResolverInstance.resolveModule.mockReturnValue(null);

        const plugin = depsConflictResolverVitePlugin({
          dependencies: ['vue'],
        });
        const config = plugin.config as (
          config: unknown,
          env: { command: string },
        ) => Promise<unknown>;
        await config({}, { command: 'build' });

        const resolveId = plugin.resolveId as (source: string, importer?: string) => unknown;
        expect(resolveId(source, '/some/file.js')).toBeNull();
      });

      it('should return null when resolver returns null', async () => {
        mockResolverInstance.initialize.mockResolvedValue(undefined);
        mockResolverInstance.getAnalysisResult.mockReturnValue(mockAnalysisResult);
        mockResolverInstance.getAliasPathMappings.mockReturnValue(mockAliasPathMappings);
        mockResolverInstance.getOptions.mockReturnValue({
          projectRoot: '/test',
        });
        mockResolverInstance.resolveModule.mockReturnValue(null);

        const plugin = depsConflictResolverVitePlugin({
          dependencies: ['vue'],
        });
        const config = plugin.config as (
          config: unknown,
          env: { command: string },
        ) => Promise<unknown>;
        await config({}, { command: 'build' });

        const resolveId = plugin.resolveId as (source: string, importer?: string) => unknown;
        expect(resolveId('lodash', '/some/file.js')).toBeNull();
      });

      it('should resolve module when resolver returns result', async () => {
        mockResolverInstance.initialize.mockResolvedValue(undefined);
        mockResolverInstance.getAnalysisResult.mockReturnValue(mockAnalysisResult);
        mockResolverInstance.getAliasPathMappings.mockReturnValue(mockAliasPathMappings);
        mockResolverInstance.getOptions.mockReturnValue({
          projectRoot: '/test',
        });
        mockResolverInstance.resolveModule.mockReturnValue('aliased-vue');

        const plugin = depsConflictResolverVitePlugin({
          dependencies: ['vue'],
        });

        const config = plugin.config as (
          config: unknown,
          env: { command: string },
        ) => Promise<unknown>;
        await config({}, { command: 'build' });

        // Mock this.resolve
        const mockThis = {
          resolve: vi.fn().mockResolvedValue({ id: '/resolved/aliased-vue' }),
        };

        const resolveId = (
          plugin.resolveId as unknown as (
            this: typeof mockThis,
            source: string,
            importer?: string,
          ) => unknown
        ).bind(mockThis);
        await resolveId('vue', '/test/node_modules/some-lib/index.js');

        expect(mockResolverInstance.resolveModule).toHaveBeenCalledWith(
          'vue',
          '/test/node_modules/some-lib/index.js',
        );
        expect(mockThis.resolve).toHaveBeenCalled();
      });

      it('should return null when plugin is not enabled', async () => {
        mockResolverInstance.initialize.mockResolvedValue(undefined);
        mockResolverInstance.getAnalysisResult.mockReturnValue(mockAnalysisResult);
        mockResolverInstance.getAliasPathMappings.mockReturnValue(mockAliasPathMappings);
        mockResolverInstance.getOptions.mockReturnValue({
          projectRoot: '/test',
        });

        const plugin = depsConflictResolverVitePlugin({
          dependencies: ['vue'],
          enableInDev: false,
        });

        // Initialize in dev mode where plugin is disabled
        const config = plugin.config as (
          config: unknown,
          env: { command: string },
        ) => Promise<unknown>;
        await config({}, { command: 'serve' });

        const resolveId = plugin.resolveId as (source: string, importer?: string) => unknown;
        const result = resolveId('vue', '/some/file.js');

        expect(result).toBeNull();
      });

      it('should return null when no importer is provided', async () => {
        mockResolverInstance.initialize.mockResolvedValue(undefined);
        mockResolverInstance.getAnalysisResult.mockReturnValue(mockAnalysisResult);
        mockResolverInstance.getAliasPathMappings.mockReturnValue(mockAliasPathMappings);
        mockResolverInstance.getOptions.mockReturnValue({
          projectRoot: '/test',
        });
        mockResolverInstance.resolveModule.mockReturnValue(null);

        const plugin = depsConflictResolverVitePlugin({
          dependencies: ['vue'],
        });

        const config = plugin.config as (
          config: unknown,
          env: { command: string },
        ) => Promise<unknown>;
        await config({}, { command: 'build' });

        const resolveId = plugin.resolveId as (source: string, importer?: string) => unknown;
        const result = resolveId('vue');

        expect(result).toBeNull();
      });
    });

    it('should enable debug logging when debug option is true', async () => {
      mockResolverInstance.initialize.mockResolvedValue(undefined);
      mockResolverInstance.getAnalysisResult.mockReturnValue({
        aliasMappings: [],
      });
      mockResolverInstance.getAliasPathMappings.mockReturnValue([]);
      mockResolverInstance.getOptions.mockReturnValue({ projectRoot: '/test' });

      const plugin = depsConflictResolverVitePlugin({
        dependencies: ['vue'],
        debug: true,
      });

      const config = plugin.config as (
        config: unknown,
        env: { command: string },
      ) => Promise<unknown>;
      await config({}, { command: 'build' });

      // Should still work with debug enabled
      expect(plugin.name).toBe('deps-conflict-resolver');
    });
  });
});
