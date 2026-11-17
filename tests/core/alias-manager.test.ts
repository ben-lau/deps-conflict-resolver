import { describe, it, expect, beforeEach } from 'vitest';
import { AliasManager } from '../../src/core/alias-manager';
import type { ResolvedOptions, AnalysisResult } from '../../src/types';

describe('AliasManager', () => {
  let aliasManager: AliasManager;
  let mockOptions: ResolvedOptions;

  beforeEach(() => {
    mockOptions = {
      dependencies: ['test-package'],
      projectRoot: '/test/project',
      autoInstall: true,
      packageManager: 'npm',
      registry: 'https://registry.npmjs.org',
      debug: false,
      aliasPrefix: 'aliased-',
      excludeRedirects: {},
      includeRedirects: {},
    };

    aliasManager = new AliasManager(mockOptions);
  });

  describe('initFromAnalysisResult', () => {
    it('should initialize with alias mappings', () => {
      const mockResult: AnalysisResult = {
        analyzedDependencies: new Map(),
        peerConflicts: [],
        aliasMappings: [
          {
            originalName: 'vue',
            aliasName: 'aliased-vue2',
            installSpec: 'aliased-vue2@npm:vue@2.6.14',
            resolvedVersion: '2.6.14',
            usedBy: ['package-a>package-b'],
            allDependents: ['package-a', 'package-b'],
          },
        ],
        missingFirstLevelPeers: [],
      };

      aliasManager.initFromAnalysisResult(mockResult);

      // Test resolveModule instead of getAllMappings (which was removed)
      const result = aliasManager.resolveModule({
        request: 'vue',
        importer: '/test/project/node_modules/package-a/index.js',
      });
      expect(result).toBe('aliased-vue2');
    });
  });

  describe('resolveModule', () => {
    beforeEach(() => {
      const mockResult: AnalysisResult = {
        analyzedDependencies: new Map(),
        peerConflicts: [],
        aliasMappings: [
          {
            originalName: 'vue',
            aliasName: 'aliased-vue2',
            installSpec: 'aliased-vue2@npm:vue@2.6.14',
            resolvedVersion: '2.6.14',
            usedBy: ['package-a'],
            allDependents: ['package-a'],
          },
        ],
        missingFirstLevelPeers: [],
      };

      aliasManager.initFromAnalysisResult(mockResult);
    });

    it('should resolve module to alias when importer matches', () => {
      const result = aliasManager.resolveModule({
        request: 'vue',
        importer: '/test/project/node_modules/package-a/index.js',
      });

      expect(result).toBe('aliased-vue2');
    });

    it('should resolve module subpath to alias when importer matches', () => {
      const result = aliasManager.resolveModule({
        request: 'vue/compiler-sfc',
        importer: '/test/project/node_modules/package-a/index.js',
      });

      expect(result).toBe('aliased-vue2/compiler-sfc');
    });

    it('should return null when no importer', () => {
      const result = aliasManager.resolveModule({
        request: 'vue',
      });

      expect(result).toBe(null);
    });

    it('should return null when importer does not match any rule', () => {
      const result = aliasManager.resolveModule({
        request: 'vue',
        importer: '/test/project/node_modules/unrelated-package/index.js',
      });

      expect(result).toBe(null);
    });
  });

  describe('getAliasPathMappings', () => {
    it('should generate alias path mappings', () => {
      const mockResult: AnalysisResult = {
        analyzedDependencies: new Map(),
        peerConflicts: [],
        aliasMappings: [
          {
            originalName: 'vue',
            aliasName: 'aliased-vue2',
            installSpec: 'aliased-vue2@npm:vue@2.6.14',
            resolvedVersion: '2.6.14',
            usedBy: ['package-a'],
            allDependents: ['package-a'],
          },
        ],
        missingFirstLevelPeers: [],
      };

      aliasManager.initFromAnalysisResult(mockResult);
      const mappings = aliasManager.getAliasPathMappings();

      expect(mappings).toHaveLength(1);
      expect(mappings[0]!.aliasName).toBe('aliased-vue2');
      expect(mappings[0]!.originalName).toBe('vue');
      expect(typeof mappings[0]!.path).toBe('string');
    });
  });

  describe('resolveModule with scoped packages', () => {
    const scopedMockResult: AnalysisResult = {
      analyzedDependencies: new Map(),
      peerConflicts: [],
      aliasMappings: [
        {
          originalName: '@kso/util',
          aliasName: 'aliased-kso-util',
          installSpec: 'aliased-kso-util@npm:@kso/util@1.0.0',
          resolvedVersion: '1.0.0',
          usedBy: ['package-a'],
          allDependents: ['package-a'],
        },
      ],
      missingFirstLevelPeers: [],
    };

    it.each([
      {
        desc: 'Unix-style path',
        importer: '/test/project/node_modules/package-a/index.js',
      },
      {
        desc: 'Windows-style path',
        importer: 'C:\\test\\project\\node_modules\\package-a\\index.js',
      },
    ])('should resolve scoped packages with $desc', ({ importer }) => {
      aliasManager.initFromAnalysisResult(scopedMockResult);
      const result = aliasManager.resolveModule({
        request: '@kso/util',
        importer,
      });
      expect(result).toBe('aliased-kso-util');
    });

    it('should resolve scoped packages with subpaths', () => {
      aliasManager.initFromAnalysisResult(scopedMockResult);
      const result = aliasManager.resolveModule({
        request: '@kso/util/helper',
        importer: '/test/project/node_modules/package-a/index.js',
      });
      expect(result).toBe('aliased-kso-util/helper');
    });

    it.each([
      {
        desc: 'Unix',
        importer: '/test/project/node_modules/@scope/package/index.js',
      },
      {
        desc: 'Windows',
        importer: 'C:\\test\\project\\node_modules\\@scope\\package\\index.js',
      },
    ])('should handle nested scoped packages ($desc)', ({ importer }) => {
      const nestedResult: AnalysisResult = {
        analyzedDependencies: new Map(),
        peerConflicts: [],
        aliasMappings: [
          {
            originalName: '@kso/util',
            aliasName: 'aliased-kso-util',
            installSpec: 'aliased-kso-util@npm:@kso/util@1.0.0',
            resolvedVersion: '1.0.0',
            usedBy: ['@scope/package'],
            allDependents: ['@scope/package'],
          },
        ],
        missingFirstLevelPeers: [],
      };
      aliasManager.initFromAnalysisResult(nestedResult);
      const result = aliasManager.resolveModule({
        request: '@kso/util',
        importer,
      });
      expect(result).toBe('aliased-kso-util');
    });
  });

  describe('excludeRedirects', () => {
    const baseMapping: AnalysisResult = {
      analyzedDependencies: new Map(),
      peerConflicts: [],
      aliasMappings: [
        {
          originalName: 'vue',
          aliasName: 'aliased-vue2',
          installSpec: 'aliased-vue2@npm:vue@2.7.14',
          resolvedVersion: '2.7.14',
          usedBy: ['legacy-lib'],
          allDependents: ['legacy-lib', 'vue-demi', 'pinia'],
        },
      ],
      missingFirstLevelPeers: [],
    };

    it('should redirect packages in allDependents by default', () => {
      aliasManager.initFromAnalysisResult(baseMapping);

      expect(
        aliasManager.resolveModule({
          request: 'vue',
          importer: '/project/node_modules/legacy-lib/index.js',
        }),
      ).toBe('aliased-vue2');
    });

    it('should not redirect excluded packages', () => {
      const manager = new AliasManager({
        ...mockOptions,
        excludeRedirects: { vue: ['pinia', 'vue-demi'] },
      });
      manager.initFromAnalysisResult(baseMapping);

      expect(
        manager.resolveModule({
          request: 'vue',
          importer: '/project/node_modules/pinia/index.js',
        }),
      ).toBeNull();

      expect(
        manager.resolveModule({
          request: 'vue',
          importer: '/project/node_modules/vue-demi/index.js',
        }),
      ).toBeNull();
    });

    it('should still redirect non-excluded packages after exclusion', () => {
      const manager = new AliasManager({
        ...mockOptions,
        excludeRedirects: { vue: ['pinia', 'vue-demi'] },
      });
      manager.initFromAnalysisResult(baseMapping);

      expect(
        manager.resolveModule({
          request: 'vue',
          importer: '/project/node_modules/legacy-lib/index.js',
        }),
      ).toBe('aliased-vue2');
    });
  });

  describe('includeRedirects', () => {
    const baseMappingWithoutExtra: AnalysisResult = {
      analyzedDependencies: new Map(),
      peerConflicts: [],
      aliasMappings: [
        {
          originalName: 'vue',
          aliasName: 'aliased-vue2',
          installSpec: 'aliased-vue2@npm:vue@2.7.14',
          resolvedVersion: '2.7.14',
          usedBy: ['legacy-lib'],
          allDependents: ['legacy-lib'],
        },
      ],
      missingFirstLevelPeers: [],
    };

    it('should redirect explicitly included packages not in allDependents', () => {
      const manager = new AliasManager({
        ...mockOptions,
        includeRedirects: { vue: ['loose-semver-pkg', '@kmt/meeting-setting'] },
      });
      manager.initFromAnalysisResult(baseMappingWithoutExtra);

      expect(
        manager.resolveModule({
          request: 'vue',
          importer: '/project/node_modules/loose-semver-pkg/index.js',
        }),
      ).toBe('aliased-vue2');

      expect(
        manager.resolveModule({
          request: 'vue',
          importer: '/project/node_modules/@kmt/meeting-setting/index.js',
        }),
      ).toBe('aliased-vue2');
    });

    it('should not affect packages not in includeRedirects', () => {
      const manager = new AliasManager({
        ...mockOptions,
        includeRedirects: { vue: ['loose-semver-pkg'] },
      });
      manager.initFromAnalysisResult(baseMappingWithoutExtra);

      expect(
        manager.resolveModule({
          request: 'vue',
          importer: '/project/node_modules/unrelated-pkg/index.js',
        }),
      ).toBeNull();
    });

    it('should apply include before exclude (exclude wins when both specify same package)', () => {
      const manager = new AliasManager({
        ...mockOptions,
        includeRedirects: { vue: ['shared-pkg'] },
        excludeRedirects: { vue: ['shared-pkg'] },
      });
      manager.initFromAnalysisResult(baseMappingWithoutExtra);

      expect(
        manager.resolveModule({
          request: 'vue',
          importer: '/project/node_modules/shared-pkg/index.js',
        }),
      ).toBeNull();
    });
  });

  describe('path-scoped mappings', () => {
    it('selects the mapping by importer instance regardless of mapping order', () => {
      const mappings: AnalysisResult = {
        analyzedDependencies: new Map(),
        peerConflicts: [],
        aliasMappings: [
          {
            originalName: 'vue',
            aliasName: 'aliased-vue3',
            installSpec: '',
            resolvedVersion: '3.5.0',
            usedBy: ['modern-widget'],
            allDependents: ['shared-core'],
            importerPaths: [
              '/project/node_modules/modern-widget',
              '/project/node_modules/modern-widget/node_modules/shared-core',
            ],
          },
          {
            originalName: 'vue',
            aliasName: 'aliased-vue2',
            installSpec: '',
            resolvedVersion: '2.7.16',
            usedBy: ['legacy-widget'],
            allDependents: ['shared-core'],
            importerPaths: [
              '/project/node_modules/legacy-widget',
              '/project/node_modules/legacy-widget/node_modules/shared-core',
            ],
          },
        ],
        missingFirstLevelPeers: [],
      };

      aliasManager.initFromAnalysisResult(mappings);

      expect(
        aliasManager.resolveModule({
          request: 'vue',
          importer: '/project/node_modules/legacy-widget/node_modules/shared-core/index.js',
        }),
      ).toBe('aliased-vue2');
      expect(
        aliasManager.resolveModule({
          request: 'vue',
          importer: '/project/node_modules/modern-widget/node_modules/shared-core/index.js',
        }),
      ).toBe('aliased-vue3');
    });

    it('does not let a nested excluded importer fall back to an ancestor package rule', () => {
      const manager = new AliasManager({
        ...mockOptions,
        excludeRedirects: { vue: ['pinia'] },
      });
      manager.initFromAnalysisResult({
        analyzedDependencies: new Map(),
        peerConflicts: [],
        aliasMappings: [
          {
            originalName: 'vue',
            aliasName: 'aliased-vue2',
            installSpec: '',
            resolvedVersion: '2.7.16',
            usedBy: ['legacy-widget'],
            allDependents: ['legacy-widget', 'pinia'],
            importerPaths: [
              '/project/node_modules/legacy-widget',
              '/project/node_modules/legacy-widget/node_modules/pinia',
            ],
          },
        ],
        missingFirstLevelPeers: [],
      });

      expect(
        manager.resolveModule({
          request: 'vue',
          importer: '/project/node_modules/legacy-widget/node_modules/pinia/index.js',
        }),
      ).toBeNull();
      expect(
        manager.resolveModule({
          request: 'vue',
          importer: '/project/node_modules/legacy-widget/index.js',
        }),
      ).toBe('aliased-vue2');
    });

    it('applies included names to path-scoped mappings while exclusion still wins', () => {
      const mapping: AnalysisResult = {
        analyzedDependencies: new Map(),
        peerConflicts: [],
        aliasMappings: [
          {
            originalName: 'vue',
            aliasName: 'aliased-vue2',
            installSpec: '',
            resolvedVersion: '2.7.16',
            usedBy: ['legacy-widget'],
            allDependents: ['legacy-widget'],
            importerPaths: ['/project/node_modules/legacy-widget'],
          },
        ],
        missingFirstLevelPeers: [],
      };

      const includedManager = new AliasManager({
        ...mockOptions,
        includeRedirects: { vue: ['forced-pkg'] },
      });
      includedManager.initFromAnalysisResult(mapping);
      expect(
        includedManager.resolveModule({
          request: 'vue',
          importer: '/project/node_modules/forced-pkg/index.js',
        }),
      ).toBe('aliased-vue2');

      const excludedManager = new AliasManager({
        ...mockOptions,
        includeRedirects: { vue: ['forced-pkg'] },
        excludeRedirects: { vue: ['forced-pkg'] },
      });
      excludedManager.initFromAnalysisResult(mapping);
      expect(
        excludedManager.resolveModule({
          request: 'vue',
          importer: '/project/node_modules/forced-pkg/index.js',
        }),
      ).toBeNull();
    });

    it('keeps descendants of an excluded package out of the path-scoped redirect', () => {
      const manager = new AliasManager({
        ...mockOptions,
        excludeRedirects: { vue: ['pinia'] },
      });
      manager.initFromAnalysisResult({
        analyzedDependencies: new Map(),
        peerConflicts: [],
        aliasMappings: [
          {
            originalName: 'vue',
            aliasName: 'aliased-vue2',
            installSpec: '',
            resolvedVersion: '2.7.16',
            usedBy: ['legacy-widget'],
            allDependents: ['legacy-widget', 'pinia', 'pinia-child'],
            importerPaths: [
              '/project/node_modules/legacy-widget',
              '/project/node_modules/legacy-widget/node_modules/pinia',
              '/project/node_modules/legacy-widget/node_modules/pinia/node_modules/pinia-child',
            ],
          },
        ],
        missingFirstLevelPeers: [],
      });

      expect(
        manager.resolveModule({
          request: 'vue',
          importer:
            '/project/node_modules/legacy-widget/node_modules/pinia/node_modules/pinia-child/index.js',
        }),
      ).toBeNull();
    });

    it('does not use legacy name matching when importerPaths is present', () => {
      aliasManager.initFromAnalysisResult({
        analyzedDependencies: new Map(),
        peerConflicts: [],
        aliasMappings: [
          {
            originalName: 'vue',
            aliasName: 'aliased-vue2',
            installSpec: '',
            resolvedVersion: '2.7.16',
            usedBy: ['legacy-widget'],
            allDependents: ['shared-core'],
            importerPaths: ['/project/node_modules/legacy-widget'],
          },
        ],
        missingFirstLevelPeers: [],
      });

      expect(
        aliasManager.resolveModule({
          request: 'vue',
          importer: '/project/node_modules/modern-widget/node_modules/shared-core/index.js',
        }),
      ).toBeNull();
    });
  });
});
