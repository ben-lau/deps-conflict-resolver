import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DepsConflictResolver, createResolver } from '../../src/core/resolver';
import { findProjectRoot } from '../../src/utils/fs';

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
