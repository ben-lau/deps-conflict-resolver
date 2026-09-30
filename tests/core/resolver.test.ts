import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DepsConflictResolver, createResolver } from '../../src/core/resolver';
import { findProjectRoot } from '../../src/utils/fs';
import type { AliasMapping, AnalysisResult } from '../../src/types';

// Mock 依赖模块
vi.mock('../../src/utils/fs', () => ({
  findProjectRoot: vi.fn(),
}));

// 创建 mock EnvironmentDetector 实例
const mockEnvironmentDetector = {
  getDetectionResult: vi.fn(),
  getRegistry: vi.fn(),
  getRegistryForPackageManager: vi.fn(),
  getPackageManager: vi.fn(),
  reset: vi.fn(),
  setProjectRoot: vi.fn(),
};

vi.mock('../../src/core/environment-detector', () => ({
  createEnvironmentDetector: vi.fn(() => mockEnvironmentDetector),
}));

vi.mock('../../src/core/dependency-analyzer', () => ({
  createDependencyAnalyzer: vi.fn(() => ({
    analyze: vi.fn().mockResolvedValue({
      aliasMappings: [],
      missingFirstLevelPeers: [],
      conflicts: [],
      packages: {},
    }),
  })),
}));

vi.mock('../../src/core/alias-manager', () => ({
  createAliasManager: vi.fn(() => ({
    initFromAnalysisResult: vi.fn(),
    clear: vi.fn(),
    resolveModule: vi.fn(),
    getAliasPathMappings: vi.fn().mockReturnValue([]),
  })),
}));

vi.mock('../../src/core/package-installer', () => ({
  createPackageInstaller: vi.fn(() => ({
    installAliases: vi.fn().mockResolvedValue({
      success: true,
      installed: [],
      failed: [],
      errors: [],
    }),
  })),
}));

describe('DepsConflictResolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(findProjectRoot).mockReturnValue('/test/project');
    mockEnvironmentDetector.getDetectionResult.mockResolvedValue({
      packageManager: 'npm',
      detectedFrom: 'lockfile',
      rootDir: '/test/project',
    });
    mockEnvironmentDetector.getRegistry.mockResolvedValue('https://registry.npmjs.org');
    mockEnvironmentDetector.getRegistryForPackageManager.mockResolvedValue(
      'https://registry.npmjs.org',
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create uninitialized instance with options', () => {
      const resolver = new DepsConflictResolver({
        dependencies: ['lodash'],
        projectRoot: '/test/project',
      });

      expect(resolver).toBeInstanceOf(DepsConflictResolver);
      expect(resolver.getAnalysisResult()).toBeNull();
    });
  });

  describe('initialize', () => {
    it('shares concurrent initialization work', async () => {
      const analysisResult = {
        aliasMappings: [],
        missingFirstLevelPeers: [],
        conflicts: [],
        packages: {},
      };
      let releaseAnalysis!: () => void;
      const analysisGate = new Promise<void>((resolve) => {
        releaseAnalysis = resolve;
      });
      let analysisStarted!: () => void;
      const analysisStartedGate = new Promise<void>((resolve) => {
        analysisStarted = resolve;
      });
      const analyze = vi.fn(() => {
        analysisStarted();
        return analysisGate.then(() => analysisResult);
      });
      const initFromAnalysisResult = vi.fn();
      const installAliases = vi.fn().mockResolvedValue({
        success: true,
        installed: [],
        failed: [],
        errors: [],
      });
      const onAnalysisComplete = vi.fn();

      const { createDependencyAnalyzer } = await import('../../src/core/dependency-analyzer');
      const { createAliasManager } = await import('../../src/core/alias-manager');
      const { createPackageInstaller } = await import('../../src/core/package-installer');
      vi.mocked(createDependencyAnalyzer).mockReturnValue({ analyze } as never);
      vi.mocked(createAliasManager).mockReturnValue({
        initFromAnalysisResult,
        resolveModule: vi.fn(),
        getAliasPathMappings: vi.fn().mockReturnValue([]),
      } as never);
      vi.mocked(createPackageInstaller).mockReturnValue({ installAliases } as never);

      const resolver = new DepsConflictResolver(
        { dependencies: ['lodash'] },
        { onAnalysisComplete },
      );

      const first = resolver.initialize();
      const second = resolver.initialize();
      await analysisStartedGate;
      expect(analyze).toHaveBeenCalledTimes(1);
      releaseAnalysis();

      await Promise.all([first, second]);

      expect(createDependencyAnalyzer).toHaveBeenCalledTimes(1);
      expect(analyze).toHaveBeenCalledTimes(1);
      expect(initFromAnalysisResult).toHaveBeenCalledTimes(1);
      expect(onAnalysisComplete).toHaveBeenCalledTimes(1);
      expect(installAliases).toHaveBeenCalledTimes(1);
    });

    it('retries a failed generation on a later initialize call', async () => {
      const error = new Error('analysis failed');
      const analysisResult = {
        aliasMappings: [],
        missingFirstLevelPeers: [],
        conflicts: [],
        packages: {},
      };
      const analyze = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(analysisResult);
      const initFromAnalysisResult = vi.fn();
      const installAliases = vi.fn().mockResolvedValue({
        success: true,
        installed: [],
        failed: [],
        errors: [],
      });

      const { createDependencyAnalyzer } = await import('../../src/core/dependency-analyzer');
      const { createAliasManager } = await import('../../src/core/alias-manager');
      const { createPackageInstaller } = await import('../../src/core/package-installer');
      vi.mocked(createDependencyAnalyzer).mockReturnValue({ analyze } as never);
      vi.mocked(createAliasManager).mockReturnValue({
        initFromAnalysisResult,
        resolveModule: vi.fn(),
        getAliasPathMappings: vi.fn().mockReturnValue([]),
      } as never);
      vi.mocked(createPackageInstaller).mockReturnValue({ installAliases } as never);

      const resolver = new DepsConflictResolver({ dependencies: ['lodash'] });
      const first = resolver.initialize();
      const second = resolver.initialize();

      await expect(first).rejects.toBe(error);
      await expect(second).rejects.toBe(error);
      await resolver.initialize();

      expect(analyze).toHaveBeenCalledTimes(2);
      expect(resolver.getAnalysisResult()).toBe(analysisResult);
    });

    it('refreshes redirect rules after invalidation', async () => {
      const firstResult = {
        analyzedDependencies: new Map(),
        peerConflicts: [],
        aliasMappings: [
          {
            originalName: 'vue',
            aliasName: 'aliased-vue2',
            installSpec: 'aliased-vue2@npm:vue@2.7.0',
            resolvedVersion: '2.7.0',
            usedBy: ['legacy-package'],
            allDependents: ['legacy-package'],
          },
        ],
        missingFirstLevelPeers: [],
      };
      const secondResult = {
        ...firstResult,
        aliasMappings: [
          {
            ...firstResult.aliasMappings[0],
            aliasName: 'aliased-vue3',
            installSpec: 'aliased-vue3@npm:vue@3.4.0',
            resolvedVersion: '3.4.0',
          },
        ],
      };
      const analyze = vi
        .fn()
        .mockResolvedValueOnce(firstResult)
        .mockResolvedValueOnce(secondResult);
      const createAliasManager = (await import('../../src/core/alias-manager')).createAliasManager;
      const createDependencyAnalyzer = (await import('../../src/core/dependency-analyzer'))
        .createDependencyAnalyzer;
      const createPackageInstaller = (await import('../../src/core/package-installer'))
        .createPackageInstaller;
      vi.mocked(createDependencyAnalyzer).mockReturnValue({ analyze } as never);
      vi.mocked(createPackageInstaller).mockReturnValue({
        installAliases: vi.fn().mockResolvedValue({
          success: true,
          installed: [],
          failed: [],
          errors: [],
        }),
      } as never);

      let managerGeneration = 0;
      const clear = vi.fn();
      vi.mocked(createAliasManager).mockImplementation(() => {
        const aliasName = managerGeneration++ === 0 ? 'aliased-vue2' : 'aliased-vue3';
        const resolveModule = vi.fn().mockReturnValue(aliasName);
        clear.mockImplementationOnce(() => resolveModule.mockReturnValue(null));
        return {
          initFromAnalysisResult: vi.fn(),
          clear,
          resolveModule,
          getAliasPathMappings: vi.fn().mockReturnValue([]),
        } as never;
      });

      const resolver = new DepsConflictResolver({ dependencies: ['vue'] });
      await resolver.initialize();
      expect(
        resolver.resolveModule('vue', '/test/project/node_modules/legacy-package/index.js'),
      ).toBe('aliased-vue2');

      resolver.invalidate();
      expect(resolver.getAnalysisResult()).toBeNull();
      expect(clear).toHaveBeenCalledTimes(1);
      expect(
        resolver.resolveModule('vue', '/test/project/node_modules/legacy-package/index.js'),
      ).toBeNull();
      await resolver.initialize();

      expect(analyze).toHaveBeenCalledTimes(2);
      expect(
        resolver.resolveModule('vue', '/test/project/node_modules/legacy-package/index.js'),
      ).toBe('aliased-vue3');
    });

    it('rejects invalidation while initialization is running', async () => {
      let releaseAnalysis!: () => void;
      const analysisGate = new Promise<void>((resolve) => {
        releaseAnalysis = resolve;
      });
      const analyze = vi.fn(() =>
        analysisGate.then(() => ({
          aliasMappings: [],
          missingFirstLevelPeers: [],
          conflicts: [],
          packages: {},
        })),
      );
      const { createDependencyAnalyzer } = await import('../../src/core/dependency-analyzer');
      vi.mocked(createDependencyAnalyzer).mockReturnValue({ analyze } as never);

      const resolver = new DepsConflictResolver({ dependencies: ['lodash'] });
      const initialization = resolver.initialize();

      expect(() => resolver.invalidate()).toThrow('initialization is in progress');

      releaseAnalysis();
      await initialization;
    });

    it('rolls back analysis and redirect rules when the analysis hook fails', async () => {
      const error = new Error('analysis hook failed');
      const analysisResult = {
        analyzedDependencies: new Map(),
        peerConflicts: [],
        aliasMappings: [
          {
            originalName: 'vue',
            aliasName: 'aliased-vue2',
            installSpec: 'aliased-vue2@npm:vue@2.7.0',
            resolvedVersion: '2.7.0',
            usedBy: ['legacy-package'],
            allDependents: ['legacy-package'],
          },
        ],
        missingFirstLevelPeers: [],
      };
      const resolveModule = vi.fn().mockReturnValue('aliased-vue2');
      const clear = vi.fn(() => resolveModule.mockReturnValue(null));
      const analyze = vi.fn().mockResolvedValue(analysisResult);
      const { createDependencyAnalyzer } = await import('../../src/core/dependency-analyzer');
      const { createAliasManager } = await import('../../src/core/alias-manager');
      vi.mocked(createDependencyAnalyzer).mockReturnValue({ analyze } as never);
      vi.mocked(createAliasManager).mockReturnValue({
        initFromAnalysisResult: vi.fn(),
        clear,
        resolveModule,
        getAliasPathMappings: vi.fn().mockReturnValue([]),
      } as never);

      const resolver = new DepsConflictResolver(
        { dependencies: ['vue'], autoInstall: false },
        { onAnalysisComplete: vi.fn().mockRejectedValue(error) },
      );

      await expect(resolver.initialize()).rejects.toBe(error);

      expect(resolver.getAnalysisResult()).toBeNull();
      expect(clear).toHaveBeenCalledTimes(1);
      expect(
        resolver.resolveModule('vue', '/test/project/node_modules/legacy-package/index.js'),
      ).toBeNull();
    });

    it('rolls back analysis and redirect rules when installation fails', async () => {
      const error = new Error('installation failed');
      const analysisResult = {
        analyzedDependencies: new Map(),
        peerConflicts: [],
        aliasMappings: [
          {
            originalName: 'vue',
            aliasName: 'aliased-vue2',
            installSpec: 'aliased-vue2@npm:vue@2.7.0',
            resolvedVersion: '2.7.0',
            usedBy: ['legacy-package'],
            allDependents: ['legacy-package'],
          },
        ],
        missingFirstLevelPeers: [],
      };
      const resolveModule = vi.fn().mockReturnValue('aliased-vue2');
      const clear = vi.fn(() => resolveModule.mockReturnValue(null));
      const analyze = vi.fn().mockResolvedValueOnce(analysisResult).mockResolvedValue({
        aliasMappings: [],
        missingFirstLevelPeers: [],
        conflicts: [],
        packages: {},
      });
      const installAliases = vi.fn().mockRejectedValueOnce(error).mockResolvedValue({
        success: true,
        installed: [],
        failed: [],
        errors: [],
      });
      const { createDependencyAnalyzer } = await import('../../src/core/dependency-analyzer');
      const { createAliasManager } = await import('../../src/core/alias-manager');
      const { createPackageInstaller } = await import('../../src/core/package-installer');
      vi.mocked(createDependencyAnalyzer).mockReturnValue({ analyze } as never);
      vi.mocked(createAliasManager).mockReturnValue({
        initFromAnalysisResult: vi.fn(),
        clear,
        resolveModule,
        getAliasPathMappings: vi.fn().mockReturnValue([]),
      } as never);
      vi.mocked(createPackageInstaller).mockReturnValue({ installAliases } as never);

      const resolver = new DepsConflictResolver({ dependencies: ['vue'] });

      await expect(resolver.initialize()).rejects.toBe(error);

      expect(resolver.getAnalysisResult()).toBeNull();
      expect(clear).toHaveBeenCalledTimes(1);
      expect(
        resolver.resolveModule('vue', '/test/project/node_modules/legacy-package/index.js'),
      ).toBeNull();
    });

    it('should initialize resolver successfully', async () => {
      const resolver = new DepsConflictResolver({
        dependencies: ['lodash'],
        projectRoot: '/test/project',
      });

      await resolver.initialize();

      expect(resolver.getAnalysisResult()).not.toBeNull();
    });

    it('should not reinitialize if already initialized', async () => {
      const resolver = new DepsConflictResolver({
        dependencies: ['lodash'],
        projectRoot: '/test/project',
      });

      await resolver.initialize();
      await resolver.initialize();

      expect(vi.mocked(findProjectRoot)).toHaveBeenCalledTimes(1);
    });

    it('should throw error when project root not found', async () => {
      vi.mocked(findProjectRoot).mockReturnValue(null);

      const resolver = new DepsConflictResolver({
        dependencies: ['lodash'],
        projectRoot: '/invalid/path',
      });

      await expect(resolver.initialize()).rejects.toThrow('Could not find package.json');
      expect(resolver.getAliasPathMappings()).toEqual([]);
    });

    it('should use process.cwd when projectRoot not specified', async () => {
      const resolver = new DepsConflictResolver({
        dependencies: ['lodash'],
      });

      await resolver.initialize();

      expect(vi.mocked(findProjectRoot)).toHaveBeenCalledWith(process.cwd());
    });

    it('should auto-detect package manager when set to auto', async () => {
      const resolver = new DepsConflictResolver({
        dependencies: ['lodash'],
        packageManager: 'auto',
      });

      await resolver.initialize();

      expect(mockEnvironmentDetector.getDetectionResult).toHaveBeenCalled();
    });

    it('should use specified package manager', async () => {
      const resolver = new DepsConflictResolver({
        dependencies: ['lodash'],
        packageManager: 'pnpm',
      });

      await resolver.initialize();

      const options = resolver.getOptions();
      expect(options.packageManager).toBe('pnpm');
    });

    it('should use specified registry', async () => {
      const resolver = new DepsConflictResolver({
        dependencies: ['lodash'],
        registry: 'https://custom.registry.com',
      });

      await resolver.initialize();

      const options = resolver.getOptions();
      expect(options.registry).toBe('https://custom.registry.com');
    });

    it('should call onAnalysisComplete hook', async () => {
      const onAnalysisComplete = vi.fn();

      const resolver = new DepsConflictResolver(
        { dependencies: ['lodash'] },
        { onAnalysisComplete },
      );

      await resolver.initialize();

      expect(onAnalysisComplete).toHaveBeenCalled();
    });

    it('should skip auto-install when autoInstall is false', async () => {
      const { createPackageInstaller } = await import('../../src/core/package-installer');

      const resolver = new DepsConflictResolver({
        dependencies: ['lodash'],
        autoInstall: false,
      });

      await resolver.initialize();

      const mockInstaller = vi.mocked(createPackageInstaller).mock.results[0]?.value;
      expect(mockInstaller?.installAliases).not.toHaveBeenCalled();
    });
  });

  describe('resolveModule', () => {
    it('should delegate to alias manager', async () => {
      const { createAliasManager } = await import('../../src/core/alias-manager');
      vi.mocked(createAliasManager).mockReturnValue({
        initFromAnalysisResult: vi.fn(),
        resolveModule: vi.fn().mockReturnValue('aliased-vue'),
        getAliasPathMappings: vi.fn().mockReturnValue([]),
      } as never);

      const resolver = new DepsConflictResolver({
        dependencies: ['vue'],
      });

      await resolver.initialize();

      const result = resolver.resolveModule('vue', '/some/importer.js');

      expect(result).toBe('aliased-vue');
    });

    it('should call beforeResolve hook', async () => {
      const beforeResolve = vi.fn().mockReturnValue('hooked-module');

      const resolver = new DepsConflictResolver({ dependencies: ['lodash'] }, { beforeResolve });

      await resolver.initialize();

      const result = resolver.resolveModule('lodash', '/importer.js');

      expect(beforeResolve).toHaveBeenCalledWith('lodash', '/importer.js');
      expect(result).toBe('hooked-module');
    });

    it('should continue normal resolution when hook returns undefined', async () => {
      const { createAliasManager } = await import('../../src/core/alias-manager');
      vi.mocked(createAliasManager).mockReturnValue({
        initFromAnalysisResult: vi.fn(),
        resolveModule: vi.fn().mockReturnValue('aliased-vue'),
        getAliasPathMappings: vi.fn().mockReturnValue([]),
      } as never);

      const beforeResolve = vi.fn().mockReturnValue(undefined);

      const resolver = new DepsConflictResolver({ dependencies: ['vue'] }, { beforeResolve });

      await resolver.initialize();

      const result = resolver.resolveModule('vue', '/importer.js');

      expect(result).toBe('aliased-vue');
    });
  });

  describe('getAliasPathMappings', () => {
    it('should return alias path mappings', async () => {
      const mappings = [{ aliasName: 'aliased-vue', path: '/path/to/vue' }];
      const { createAliasManager } = await import('../../src/core/alias-manager');
      vi.mocked(createAliasManager).mockReturnValue({
        initFromAnalysisResult: vi.fn(),
        resolveModule: vi.fn(),
        getAliasPathMappings: vi.fn().mockReturnValue(mappings),
      } as never);

      const resolver = new DepsConflictResolver({
        dependencies: ['vue'],
      });

      await resolver.initialize();

      expect(resolver.getAliasPathMappings()).toEqual(mappings);
    });
  });

  describe('getAnalysisResult', () => {
    it('should return analysis result after initialization', async () => {
      const resolver = new DepsConflictResolver({
        dependencies: ['lodash'],
      });

      await resolver.initialize();

      const result = resolver.getAnalysisResult();
      expect(result).toBeDefined();
      expect(result?.aliasMappings).toEqual([]);
    });
  });

  describe('getOptions', () => {
    it('should return a copy of options', async () => {
      const resolver = new DepsConflictResolver({
        dependencies: ['lodash'],
        aliasPrefix: 'custom-',
      });

      await resolver.initialize();

      const options = resolver.getOptions();
      expect(options.aliasPrefix).toBe('custom-');
    });

    it('should include empty includeRedirects by default', async () => {
      const resolver = new DepsConflictResolver({
        dependencies: ['lodash'],
      });

      await resolver.initialize();

      const options = resolver.getOptions();
      expect(options.includeRedirects).toEqual({});
    });

    it('should pass through user-provided includeRedirects', async () => {
      const resolver = new DepsConflictResolver({
        dependencies: ['vue'],
        includeRedirects: { vue: ['@kmt/meeting-setting', '@rili/ui'] },
      });

      await resolver.initialize();

      const options = resolver.getOptions();
      expect(options.includeRedirects).toEqual({
        vue: ['@kmt/meeting-setting', '@rili/ui'],
      });
    });

    it('should include empty excludeRedirects by default', async () => {
      const resolver = new DepsConflictResolver({
        dependencies: ['lodash'],
      });

      await resolver.initialize();

      const options = resolver.getOptions();
      expect(options.excludeRedirects).toEqual({});
    });
  });

  describe('installDependencies', () => {
    it('should throw error if not initialized', async () => {
      const resolver = new DepsConflictResolver({
        dependencies: ['lodash'],
      });

      await expect(resolver.installDependencies()).rejects.toThrow('Resolver not initialized');
    });

    it('should call onInstallComplete hook', async () => {
      const onInstallComplete = vi.fn();

      const resolver = new DepsConflictResolver(
        { dependencies: ['lodash'], autoInstall: false },
        { onInstallComplete },
      );

      await resolver.initialize();
      await resolver.installDependencies();

      expect(onInstallComplete).toHaveBeenCalled();
    });

    it('should pass only reused or installed mappings to onInstallComplete', async () => {
      const successfulMapping: AliasMapping = {
        originalName: 'vue',
        aliasName: 'aliased-vue2',
        installSpec: '',
        resolvedVersion: '2.7.16',
        usedBy: ['legacy-package'],
        allDependents: ['legacy-package'],
      };
      const failedMapping: AliasMapping = {
        originalName: 'vue',
        aliasName: 'aliased-vue1',
        installSpec: 'aliased-vue1@npm:vue@1.7.0',
        resolvedVersion: '1.7.0',
        usedBy: ['very-legacy-package'],
        allDependents: ['very-legacy-package'],
      };
      const analysisResult: AnalysisResult = {
        analyzedDependencies: new Map(),
        peerConflicts: [],
        aliasMappings: [successfulMapping, failedMapping],
        missingFirstLevelPeers: [],
      };
      const { createDependencyAnalyzer } = await import('../../src/core/dependency-analyzer');
      const { createPackageInstaller } = await import('../../src/core/package-installer');
      vi.mocked(createDependencyAnalyzer).mockReturnValue({
        analyze: vi.fn().mockResolvedValue(analysisResult),
      } as never);
      vi.mocked(createPackageInstaller).mockReturnValue({
        installAliases: vi.fn().mockResolvedValue({
          success: false,
          installed: [],
          reused: ['aliased-vue2'],
          failed: ['aliased-vue1'],
          errors: ['install failed'],
        }),
      } as never);
      const onInstallComplete = vi.fn();
      const resolver = new DepsConflictResolver(
        { dependencies: ['vue'], autoInstall: true },
        { onInstallComplete },
      );

      await expect(resolver.initialize()).resolves.toBeUndefined();

      expect(onInstallComplete).toHaveBeenCalledWith([successfulMapping]);
    });

    it('should not infer unknown mappings as successful from an incomplete failed result', async () => {
      const knownMapping: AliasMapping = {
        originalName: 'vue',
        aliasName: 'aliased-vue2',
        installSpec: 'aliased-vue2@npm:vue@2.7.16',
        resolvedVersion: '2.7.16',
        usedBy: ['legacy-package'],
        allDependents: ['legacy-package'],
      };
      const failedMapping: AliasMapping = {
        originalName: 'vue',
        aliasName: 'aliased-vue1',
        installSpec: 'aliased-vue1@npm:vue@1.7.0',
        resolvedVersion: '1.7.0',
        usedBy: ['very-legacy-package'],
        allDependents: ['very-legacy-package'],
      };
      const analysisResult: AnalysisResult = {
        analyzedDependencies: new Map(),
        peerConflicts: [],
        aliasMappings: [knownMapping, failedMapping],
        missingFirstLevelPeers: [],
      };
      const { createDependencyAnalyzer } = await import('../../src/core/dependency-analyzer');
      const { createPackageInstaller } = await import('../../src/core/package-installer');
      vi.mocked(createDependencyAnalyzer).mockReturnValue({
        analyze: vi.fn().mockResolvedValue(analysisResult),
      } as never);
      vi.mocked(createPackageInstaller).mockReturnValue({
        installAliases: vi.fn().mockResolvedValue({
          success: false,
          installed: [],
          failed: ['aliased-vue1'],
          errors: ['install failed'],
        }),
      } as never);
      const onInstallComplete = vi.fn();
      const resolver = new DepsConflictResolver(
        { dependencies: ['vue'], autoInstall: true },
        { onInstallComplete },
      );

      await expect(resolver.initialize()).resolves.toBeUndefined();

      expect(onInstallComplete).toHaveBeenCalledWith([]);
    });

    it('should keep failed mappings out of active alias rules while retaining diagnostics', async () => {
      const successfulMapping: AliasMapping = {
        originalName: 'vue',
        aliasName: 'aliased-vue2',
        installSpec: 'aliased-vue2@npm:vue@2.7.16',
        resolvedVersion: '2.7.16',
        usedBy: ['legacy-package'],
        allDependents: ['legacy-package'],
      };
      const failedMapping: AliasMapping = {
        originalName: 'vue',
        aliasName: 'aliased-vue1',
        installSpec: 'aliased-vue1@npm:vue@1.7.0',
        resolvedVersion: '1.7.0',
        usedBy: ['very-legacy-package'],
        allDependents: ['very-legacy-package'],
      };
      const analysisResult: AnalysisResult = {
        analyzedDependencies: new Map(),
        peerConflicts: [],
        aliasMappings: [successfulMapping, failedMapping],
        missingFirstLevelPeers: [],
      };
      const initFromAnalysisResult = vi.fn();
      const { createDependencyAnalyzer } = await import('../../src/core/dependency-analyzer');
      const { createAliasManager } = await import('../../src/core/alias-manager');
      const { createPackageInstaller } = await import('../../src/core/package-installer');
      vi.mocked(createDependencyAnalyzer).mockReturnValue({
        analyze: vi.fn().mockResolvedValue(analysisResult),
      } as never);
      vi.mocked(createAliasManager).mockReturnValue({
        initFromAnalysisResult,
        resolveModule: vi.fn(),
        getAliasPathMappings: vi.fn().mockReturnValue([]),
      } as never);
      vi.mocked(createPackageInstaller).mockReturnValue({
        installAliases: vi.fn().mockResolvedValue({
          success: false,
          installed: ['aliased-vue2'],
          reused: [],
          failed: ['aliased-vue1'],
          errors: ['Alias collision'],
        }),
      } as never);

      const resolver = new DepsConflictResolver({ dependencies: ['vue'] });

      await expect(resolver.initialize()).resolves.toBeUndefined();

      expect(initFromAnalysisResult).toHaveBeenCalledWith(
        expect.objectContaining({ aliasMappings: [successfulMapping] }),
      );
      expect(resolver.getAnalysisResult()?.aliasMappings).toEqual([
        successfulMapping,
        failedMapping,
      ]);
    });

    it('should infer reused mappings for an old installer result without reused', async () => {
      const reusedMapping: AliasMapping = {
        originalName: 'vue',
        aliasName: 'aliased-vue2',
        installSpec: '',
        resolvedVersion: '2.7.16',
        usedBy: ['legacy-package'],
        allDependents: ['legacy-package'],
      };
      const installedMapping: AliasMapping = {
        originalName: 'vue',
        aliasName: 'aliased-vue3',
        installSpec: 'aliased-vue3@npm:vue@3.7.0',
        resolvedVersion: '3.7.0',
        usedBy: ['modern-package'],
        allDependents: ['modern-package'],
      };
      const analysisResult: AnalysisResult = {
        analyzedDependencies: new Map(),
        peerConflicts: [],
        aliasMappings: [reusedMapping, installedMapping],
        missingFirstLevelPeers: [],
      };
      const { createDependencyAnalyzer } = await import('../../src/core/dependency-analyzer');
      const { createPackageInstaller } = await import('../../src/core/package-installer');
      vi.mocked(createDependencyAnalyzer).mockReturnValue({
        analyze: vi.fn().mockResolvedValue(analysisResult),
      } as never);
      vi.mocked(createPackageInstaller).mockReturnValue({
        installAliases: vi.fn().mockResolvedValue({
          installed: ['aliased-vue3'],
          failed: [],
          errors: [],
        }),
      } as never);
      const onInstallComplete = vi.fn();
      const resolver = new DepsConflictResolver(
        { dependencies: ['vue'], autoInstall: true },
        { onInstallComplete },
      );

      await expect(resolver.initialize()).resolves.toBeUndefined();

      expect(onInstallComplete).toHaveBeenCalledWith([reusedMapping, installedMapping]);
    });
  });
});

describe('createResolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(findProjectRoot).mockReturnValue('/test/project');
    mockEnvironmentDetector.getDetectionResult.mockResolvedValue({
      packageManager: 'npm',
      detectedFrom: 'lockfile',
      rootDir: '/test/project',
    });
    mockEnvironmentDetector.getRegistry.mockResolvedValue('https://registry.npmjs.org');
    mockEnvironmentDetector.getRegistryForPackageManager.mockResolvedValue(
      'https://registry.npmjs.org',
    );
  });

  it('should create initialized resolver and call hooks', async () => {
    const hooks = { onAnalysisComplete: vi.fn() };

    const resolver = await createResolver({ dependencies: ['lodash'] }, hooks);

    expect(resolver).toBeInstanceOf(DepsConflictResolver);
    expect(resolver.getAnalysisResult()).not.toBeNull();
    expect(hooks.onAnalysisComplete).toHaveBeenCalled();
  });
});
