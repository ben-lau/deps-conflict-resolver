import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DepsConflictResolverWebpackPlugin,
  createWebpackPlugin,
} from '../../../src/plugins/webpack';
import type { Compiler, Stats } from 'webpack';

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

describe('Webpack Plugin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('DepsConflictResolverWebpackPlugin', () => {
    const mockAnalysisResult = {
      aliasMappings: [
        {
          originalName: 'vue',
          aliasName: 'aliased-vue',
          resolvedVersion: '2.7.0',
          usedBy: ['some-package'],
          allDependents: ['some-package'],
          needsAlias: true,
          installSpec: 'aliased-vue@npm:vue@2.7.0',
        },
      ],
      missingFirstLevelPeers: [],
      peerConflicts: [],
      packages: {},
    };

    const mockAliasPathMappings = [
      { aliasName: 'aliased-vue', path: '/test/node_modules/aliased-vue' },
    ];

    it('should create instance with config', () => {
      const plugin = new DepsConflictResolverWebpackPlugin({
        dependencies: ['vue'],
      });

      expect(plugin).toBeInstanceOf(DepsConflictResolverWebpackPlugin);
      expect(plugin.isInitialized()).toBe(false);
    });

    it('should return null resolver before initialization', () => {
      const plugin = new DepsConflictResolverWebpackPlugin({
        dependencies: ['vue'],
      });

      expect(plugin.getResolver()).toBeNull();
    });

    it('should return null analysis result before initialization', () => {
      const plugin = new DepsConflictResolverWebpackPlugin({
        dependencies: ['vue'],
      });

      expect(plugin.getAnalysisResult()).toBeNull();
    });

    it('should return empty alias config before initialization', () => {
      const plugin = new DepsConflictResolverWebpackPlugin({
        dependencies: ['vue'],
      });

      expect(plugin.getAliasConfig()).toEqual({});
    });

    describe('apply', () => {
      it('should register compiler hooks', () => {
        mockResolverInstance.initialize.mockResolvedValue(undefined);
        mockResolverInstance.getAnalysisResult.mockReturnValue(mockAnalysisResult);
        mockResolverInstance.getAliasPathMappings.mockReturnValue(mockAliasPathMappings);
        mockResolverInstance.getOptions.mockReturnValue({
          projectRoot: '/test',
        });
        mockResolverInstance.resolveModule.mockReturnValue(null);

        const plugin = new DepsConflictResolverWebpackPlugin({
          dependencies: ['vue'],
        });

        const mockCompiler = createMockCompiler();

        plugin.apply(mockCompiler as unknown as Compiler);

        expect(mockCompiler.hooks.beforeRun.tapPromise).toHaveBeenCalled();
        expect(mockCompiler.hooks.watchRun.tapPromise).toHaveBeenCalled();
        expect(mockCompiler.hooks.normalModuleFactory.tap).toHaveBeenCalled();
        expect(mockCompiler.hooks.done.tap).toHaveBeenCalled();
      });

      it('should initialize on beforeRun', async () => {
        mockResolverInstance.initialize.mockResolvedValue(undefined);
        mockResolverInstance.getAnalysisResult.mockReturnValue(mockAnalysisResult);
        mockResolverInstance.getAliasPathMappings.mockReturnValue(mockAliasPathMappings);
        mockResolverInstance.getOptions.mockReturnValue({
          projectRoot: '/test',
        });

        const plugin = new DepsConflictResolverWebpackPlugin({
          dependencies: ['vue'],
        });

        const mockCompiler = createMockCompiler();

        plugin.apply(mockCompiler as unknown as Compiler);

        // 获取并执行 beforeRun callback
        const beforeRunCall = mockCompiler.hooks.beforeRun.tapPromise.mock.calls[0]!;
        const beforeRunCallback = beforeRunCall[1];
        await beforeRunCallback();

        expect(plugin.isInitialized()).toBe(true);
        expect(mockResolverInstance.initialize).toHaveBeenCalled();
      });

      it('should initialize on watchRun', async () => {
        mockResolverInstance.initialize.mockResolvedValue(undefined);
        mockResolverInstance.getAnalysisResult.mockReturnValue(mockAnalysisResult);
        mockResolverInstance.getAliasPathMappings.mockReturnValue(mockAliasPathMappings);
        mockResolverInstance.getOptions.mockReturnValue({
          projectRoot: '/test',
        });

        const plugin = new DepsConflictResolverWebpackPlugin({
          dependencies: ['vue'],
        });

        const mockCompiler = createMockCompiler();

        plugin.apply(mockCompiler as unknown as Compiler);

        // 获取并执行 watchRun callback
        const watchRunCall = mockCompiler.hooks.watchRun.tapPromise.mock.calls[0]!;
        const watchRunCallback = watchRunCall[1];
        await watchRunCallback();

        expect(plugin.isInitialized()).toBe(true);
      });

      it('should get alias config after initialization', async () => {
        mockResolverInstance.initialize.mockResolvedValue(undefined);
        mockResolverInstance.getAnalysisResult.mockReturnValue(mockAnalysisResult);
        mockResolverInstance.getAliasPathMappings.mockReturnValue(mockAliasPathMappings);
        mockResolverInstance.getOptions.mockReturnValue({
          projectRoot: '/test',
        });

        const plugin = new DepsConflictResolverWebpackPlugin({
          dependencies: ['vue'],
        });

        const mockCompiler = createMockCompiler();

        plugin.apply(mockCompiler as unknown as Compiler);

        const beforeRunCall = mockCompiler.hooks.beforeRun.tapPromise.mock.calls[0]!;
        await beforeRunCall[1]();

        const aliasConfig = plugin.getAliasConfig();
        expect(aliasConfig['aliased-vue']).toBe('/test/node_modules/aliased-vue');
      });

      it('should handle beforeResolve for module requests', async () => {
        mockResolverInstance.initialize.mockResolvedValue(undefined);
        mockResolverInstance.getAnalysisResult.mockReturnValue(mockAnalysisResult);
        mockResolverInstance.getAliasPathMappings.mockReturnValue(mockAliasPathMappings);
        mockResolverInstance.getOptions.mockReturnValue({
          projectRoot: '/test',
        });
        mockResolverInstance.resolveModule.mockReturnValue('aliased-vue');

        const plugin = new DepsConflictResolverWebpackPlugin({
          dependencies: ['vue'],
        });

        const mockCompiler = createMockCompiler();

        plugin.apply(mockCompiler as unknown as Compiler);

        // 初始化
        const beforeRunCall = mockCompiler.hooks.beforeRun.tapPromise.mock.calls[0]!;
        await beforeRunCall[1]();

        // 获取 normalModuleFactory 的 callback
        const nmfCall = mockCompiler.hooks.normalModuleFactory.tap.mock.calls[0]!;
        const nmfCallback = nmfCall[1];

        const mockNmf = {
          hooks: {
            beforeResolve: {
              tapPromise: vi.fn(),
            },
          },
        };

        nmfCallback(mockNmf);

        expect(mockNmf.hooks.beforeResolve.tapPromise).toHaveBeenCalled();

        const beforeResolveCall = mockNmf.hooks.beforeResolve.tapPromise.mock.calls[0]!;
        const beforeResolveCallback = beforeResolveCall[1] as (data: unknown) => Promise<void>;

        const resolveData = {
          request: 'vue',
          contextInfo: { issuer: '/some/file.js' },
          context: '/some',
        };

        await beforeResolveCallback(resolveData);

        expect(resolveData.request).toBe('aliased-vue');
      });

      it('should skip relative paths', async () => {
        mockResolverInstance.initialize.mockResolvedValue(undefined);
        mockResolverInstance.getAnalysisResult.mockReturnValue(mockAnalysisResult);
        mockResolverInstance.getAliasPathMappings.mockReturnValue(mockAliasPathMappings);
        mockResolverInstance.getOptions.mockReturnValue({
          projectRoot: '/test',
        });
        mockResolverInstance.resolveModule.mockReturnValue(null);

        const plugin = new DepsConflictResolverWebpackPlugin({
          dependencies: ['vue'],
        });

        const mockCompiler = createMockCompiler();

        plugin.apply(mockCompiler as unknown as Compiler);

        const beforeRunCall = mockCompiler.hooks.beforeRun.tapPromise.mock.calls[0]!;
        await beforeRunCall[1]();

        const nmfCall = mockCompiler.hooks.normalModuleFactory.tap.mock.calls[0]!;
        const mockNmf = { hooks: { beforeResolve: { tapPromise: vi.fn() } } };
        nmfCall[1](mockNmf);

        const beforeResolveCallback = mockNmf.hooks.beforeResolve.tapPromise.mock.calls[0]![1] as (
          data: unknown,
        ) => Promise<void>;

        const resolveData = {
          request: './relative',
          contextInfo: { issuer: '/some/file.js' },
          context: '/some',
        };

        await beforeResolveCallback(resolveData);

        expect(resolveData.request).toBe('./relative');
        expect(mockResolverInstance.resolveModule).not.toHaveBeenCalled();
      });

      it('should skip webpack internal requests', async () => {
        mockResolverInstance.initialize.mockResolvedValue(undefined);
        mockResolverInstance.getAnalysisResult.mockReturnValue(mockAnalysisResult);
        mockResolverInstance.getAliasPathMappings.mockReturnValue(mockAliasPathMappings);
        mockResolverInstance.getOptions.mockReturnValue({
          projectRoot: '/test',
        });
        mockResolverInstance.resolveModule.mockReturnValue(null);

        const plugin = new DepsConflictResolverWebpackPlugin({
          dependencies: ['vue'],
        });

        const mockCompiler = createMockCompiler();

        plugin.apply(mockCompiler as unknown as Compiler);

        const beforeRunCall = mockCompiler.hooks.beforeRun.tapPromise.mock.calls[0]!;
        await beforeRunCall[1]();

        const nmfCall = mockCompiler.hooks.normalModuleFactory.tap.mock.calls[0]!;
        const mockNmf = { hooks: { beforeResolve: { tapPromise: vi.fn() } } };
        nmfCall[1](mockNmf);

        const beforeResolveCallback = mockNmf.hooks.beforeResolve.tapPromise.mock.calls[0]![1] as (
          data: unknown,
        ) => Promise<void>;

        const resolveData = {
          request: 'webpack/runtime',
          contextInfo: { issuer: '/some/file.js' },
          context: '/some',
        };

        await beforeResolveCallback(resolveData);

        expect(mockResolverInstance.resolveModule).not.toHaveBeenCalled();
      });

      it('should handle done hook without errors', async () => {
        mockResolverInstance.initialize.mockResolvedValue(undefined);
        mockResolverInstance.getAnalysisResult.mockReturnValue(mockAnalysisResult);
        mockResolverInstance.getAliasPathMappings.mockReturnValue(mockAliasPathMappings);
        mockResolverInstance.getOptions.mockReturnValue({
          projectRoot: '/test',
        });

        const plugin = new DepsConflictResolverWebpackPlugin({
          dependencies: ['vue'],
        });

        const mockCompiler = createMockCompiler();

        plugin.apply(mockCompiler as unknown as Compiler);

        // 初始化
        const beforeRunCall = mockCompiler.hooks.beforeRun.tapPromise.mock.calls[0]!;
        await beforeRunCall[1]();

        // 获取 done hook callback
        const doneCall = mockCompiler.hooks.done.tap.mock.calls[0]!;
        const doneCallback = doneCall[1];

        const mockStats = {
          hasErrors: vi.fn().mockReturnValue(false),
        };

        // 应该不抛出错误
        expect(() => doneCallback(mockStats as unknown as Stats)).not.toThrow();
      });

      it('should skip done hook when has errors', async () => {
        mockResolverInstance.initialize.mockResolvedValue(undefined);
        mockResolverInstance.getAnalysisResult.mockReturnValue(mockAnalysisResult);
        mockResolverInstance.getAliasPathMappings.mockReturnValue(mockAliasPathMappings);
        mockResolverInstance.getOptions.mockReturnValue({
          projectRoot: '/test',
        });

        const plugin = new DepsConflictResolverWebpackPlugin({
          dependencies: ['vue'],
        });

        const mockCompiler = createMockCompiler();

        plugin.apply(mockCompiler as unknown as Compiler);

        const beforeRunCall = mockCompiler.hooks.beforeRun.tapPromise.mock.calls[0]!;
        await beforeRunCall[1]();

        const doneCall = mockCompiler.hooks.done.tap.mock.calls[0]!;
        const doneCallback = doneCall[1];

        const mockStats = {
          hasErrors: vi.fn().mockReturnValue(true),
        };

        expect(() => doneCallback(mockStats as unknown as Stats)).not.toThrow();
      });
    });
  });

  describe('createWebpackPlugin', () => {
    it('should create plugin instance', () => {
      const plugin = createWebpackPlugin({
        dependencies: ['vue'],
      });

      expect(plugin).toBeInstanceOf(DepsConflictResolverWebpackPlugin);
    });

    it('should create plugin with hooks', () => {
      const mockHook = vi.fn();
      const plugin = createWebpackPlugin({
        dependencies: ['vue'],
        hooks: {
          onAnalysisComplete: mockHook,
        },
      });

      expect(plugin).toBeInstanceOf(DepsConflictResolverWebpackPlugin);
    });
  });
});

// Helper function to create mock compiler
function createMockCompiler() {
  return {
    hooks: {
      beforeRun: {
        tapPromise: vi.fn(),
      },
      watchRun: {
        tapPromise: vi.fn(),
      },
      normalModuleFactory: {
        tap: vi.fn(),
      },
      done: {
        tap: vi.fn(),
      },
    },
  };
}
