import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DependencyAnalyzer } from '../../src/core/dependency-analyzer';
import type { ResolvedOptions, PackageJson } from '../../src/types';
import type { InstalledPackageInfo } from '../../src/types';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('DependencyAnalyzer', () => {
  let mockOptions: ResolvedOptions;
  let mockMainPackageJson: PackageJson;
  let mockInstalledDeps: Map<string, InstalledPackageInfo>;

  beforeEach(() => {
    mockOptions = {
      dependencies: ['package-a'],
      projectRoot: '/test/project',
      autoInstall: true,
      packageManager: 'npm',
      registry: 'https://registry.npmjs.org',
      debug: false,
      aliasPrefix: 'aliased-',
      excludeRedirects: {},
    };

    mockMainPackageJson = {
      name: 'main-project',
      version: '1.0.0',
      dependencies: {
        vue: '^3.0.0',
        'vue-router': '^4.0.0',
        'package-a': '^1.0.0',
      },
    };

    mockInstalledDeps = new Map([
      [
        'vue',
        {
          name: 'vue',
          version: '3.2.0',
          path: '/test/project/node_modules/vue',
        },
      ],
      [
        'vue-router',
        {
          name: 'vue-router',
          version: '4.1.0',
          path: '/test/project/node_modules/vue-router',
        },
      ],
      [
        'package-a',
        {
          name: 'package-a',
          version: '1.0.0',
          path: '/test/project/node_modules/package-a',
        },
      ],
    ]);
  });

  describe('constructor', () => {
    it('should create analyzer with correct options', () => {
      const analyzer = new DependencyAnalyzer(mockOptions, mockMainPackageJson, mockInstalledDeps);

      expect(analyzer).toBeDefined();
    });
  });

  describe('analyze', () => {
    it('should analyze dependencies and return result structure', async () => {
      // This test verifies the structure of analysis result
      // In real scenario, it would need mocked file system and npm registry

      const analyzer = new DependencyAnalyzer(mockOptions, mockMainPackageJson, mockInstalledDeps);

      // Mock the internal methods for unit testing
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(analyzer as any, 'analyzeDependencyRecursive').mockReturnValue(null);

      const result = await analyzer.analyze();

      expect(result).toHaveProperty('analyzedDependencies');
      expect(result).toHaveProperty('peerConflicts');
      expect(result).toHaveProperty('aliasMappings');
      expect(result).toHaveProperty('missingFirstLevelPeers');
      expect(result.analyzedDependencies).toBeInstanceOf(Map);
      expect(Array.isArray(result.peerConflicts)).toBe(true);
      expect(Array.isArray(result.aliasMappings)).toBe(true);
    });
  });
});

describe('DependencyAnalyzer declared-only peer conflict gating', () => {
  it('should NOT mark needsAlias for peer deps that are not declared in main package.json, but should report missingFirstLevelPeers', async () => {
    const options: ResolvedOptions = {
      dependencies: ['package-a'],
      projectRoot: '/test/project',
      autoInstall: true,
      packageManager: 'npm',
      registry: 'https://registry.npmjs.org',
      debug: false,
      aliasPrefix: 'aliased-',
      excludeRedirects: {},
    };

    // 主工程只声明了 package-a（未声明 peer-x）
    const mainPkg: PackageJson = {
      name: 'main-project',
      version: '1.0.0',
      dependencies: {
        'package-a': '^1.0.0',
      },
    };

    // 即使 peer-x 在 node_modules 里可见（例如 pnpm peer/hoist），也不应触发 needsAlias
    const installedDeps: Map<string, InstalledPackageInfo> = new Map([
      [
        'peer-x',
        {
          name: 'peer-x',
          version: '2.0.0',
          path: '/test/project/node_modules/peer-x',
        },
      ],
      [
        'package-a',
        {
          name: 'package-a',
          version: '1.0.0',
          path: '/test/project/node_modules/package-a',
        },
      ],
    ]);

    const analyzer = new DependencyAnalyzer(options, mainPkg, installedDeps);

    // 让 analyzedDependencies 中的 package-a 存在 peerDependencies：peer-x@^1.0.0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (analyzer as any).analyzeDependencyRecursive = vi.fn(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (analyzer as any).analyzedDependencies.set('package-a', {
        name: 'package-a',
        version: '1.0.0',
        dependencyPath: [],
        dependencies: {},
        peerDependencies: { 'peer-x': '^1.0.0' },
        peerDependenciesMeta: {},
      });
      return null;
    });

    const result = await analyzer.analyze();

    // peer-x 未声明：needsAlias 必须为 false
    const peerX = result.peerConflicts.find(c => c.packageName === 'peer-x');
    expect(peerX).toBeDefined();
    expect(peerX?.needsAlias).toBe(false);

    // 同时应进入 missingFirstLevelPeers
    expect(result.missingFirstLevelPeers).toEqual([
      {
        packageName: 'peer-x',
        requiredRange: '^1.0.0',
        requestedBy: 'package-a',
      },
    ]);

    // 不应生成任何别名安装映射
    expect(result.aliasMappings).toHaveLength(0);
  });
});

describe('DependencyAnalyzer workspace declared merging', () => {
  it('should treat dependencies declared in workspace root package.json as declared (no missing peers) when running in a workspace package', async () => {
    const rootDir = await fs.mkdtemp(join(tmpdir(), 'deps-conflict-resolver-ws-'));

    try {
      // pnpm workspace 标识文件（workspace-detector 会以此判断 workspaceRoot）
      await fs.writeFile(
        join(rootDir, 'pnpm-workspace.yaml'),
        "packages:\n  - 'packages/*'\n",
        'utf-8',
      );

      // workspace root package.json：声明 peer-x
      await fs.writeFile(
        join(rootDir, 'package.json'),
        JSON.stringify(
          {
            name: 'root',
            version: '1.0.0',
            private: true,
            dependencies: {
              'peer-x': '^2.0.0',
            },
          },
          null,
          2,
        ),
        'utf-8',
      );

      const pkgDir = join(rootDir, 'packages', 'app');
      await fs.mkdir(pkgDir, { recursive: true });

      // 子包 package.json：只声明 package-a（不声明 peer-x）
      const pkgJson: PackageJson = {
        name: 'app',
        version: '1.0.0',
        dependencies: {
          'package-a': '^1.0.0',
        },
      };

      await fs.writeFile(join(pkgDir, 'package.json'), JSON.stringify(pkgJson, null, 2), 'utf-8');

      const options: ResolvedOptions = {
        dependencies: ['package-a'],
        projectRoot: pkgDir,
        autoInstall: true,
        packageManager: 'pnpm',
        registry: 'https://registry.npmjs.org',
        debug: false,
        aliasPrefix: 'aliased-',
        excludeRedirects: {},
      };

      // 预填充已安装版本（避免真实 node_modules 查找）
      const installedDeps: Map<string, InstalledPackageInfo> = new Map([
        [
          'peer-x',
          {
            name: 'peer-x',
            version: '2.0.0',
            path: join(rootDir, 'node_modules', 'peer-x'),
          },
        ],
        [
          'package-a',
          {
            name: 'package-a',
            version: '1.0.0',
            path: join(rootDir, 'node_modules', 'package-a'),
          },
        ],
      ]);

      const analyzer = new DependencyAnalyzer(options, pkgJson, installedDeps);

      // 让 analyzedDependencies 中的 package-a 存在 peerDependencies：peer-x@^2.0.0（满足，不触发 alias 安装）
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (analyzer as any).analyzeDependencyRecursive = vi.fn(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (analyzer as any).analyzedDependencies.set('package-a', {
          name: 'package-a',
          version: '1.0.0',
          dependencyPath: [],
          dependencies: {},
          peerDependencies: { 'peer-x': '^2.0.0' },
          peerDependenciesMeta: {},
        });
        return null;
      });

      const result = await analyzer.analyze();

      // peer-x 虽然没在子包声明，但在 workspace root 声明：不应被标记为 missing
      expect(result.missingFirstLevelPeers).toHaveLength(0);

      const peerX = result.peerConflicts.find(c => c.packageName === 'peer-x');
      expect(peerX).toBeDefined();
      expect(peerX?.needsAlias).toBe(false);
      expect(peerX?.mainProjectVersion).toBe('2.0.0');
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });
});

describe('DependencyAnalyzer Edge Cases', () => {
  it('should handle empty dependencies list', async () => {
    const mockOptions: ResolvedOptions = {
      dependencies: [],
      projectRoot: '/test/project',
      autoInstall: true,
      packageManager: 'npm',
      registry: 'https://registry.npmjs.org',
      debug: false,
      aliasPrefix: 'aliased-',
      excludeRedirects: {},
    };

    const analyzer = new DependencyAnalyzer(
      mockOptions,
      { name: 'test', version: '1.0.0' },
      new Map(),
    );

    const result = await analyzer.analyze();

    expect(result.analyzedDependencies.size).toBe(0);
    expect(result.peerConflicts).toHaveLength(0);
    expect(result.aliasMappings).toHaveLength(0);
  });
});

describe('DependencyAnalyzer Alias Detection', () => {
  const baseOptions: ResolvedOptions = {
    dependencies: [],
    projectRoot: '/test/project',
    autoInstall: true,
    packageManager: 'npm',
    registry: 'https://registry.npmjs.org',
    debug: false,
    aliasPrefix: 'aliased-',
    excludeRedirects: {},
  };

  describe('findExistingAlias via npm alias (realName)', () => {
    it('should detect and reuse existing npm alias with correct version', async () => {
      // 模拟已安装的 npm 别名：vue2 -> vue@2.6.14
      const mockInstalledDeps: Map<string, InstalledPackageInfo> = new Map([
        [
          'vue',
          {
            name: 'vue',
            version: '3.2.0',
            path: '/test/project/node_modules/vue',
          },
        ],
        [
          'vue2',
          {
            name: 'vue2',
            version: '2.6.14',
            path: '/test/project/node_modules/vue2',
            realName: 'vue', // npm 别名安装后，realName 是原始包名
            isAlias: true,
          },
        ],
      ]);

      const analyzer = new DependencyAnalyzer(
        baseOptions,
        {
          name: 'test',
          version: '1.0.0',
          dependencies: {
            vue: '^3.0.0',
            vue2: 'npm:vue@2.6.14',
          },
        },
        mockInstalledDeps,
      );

      // 使用反射访问私有方法进行测试
      const findExistingAliasForRanges = (
        analyzer as unknown as {
          findExistingAliasForRanges: (
            packageName: string,
            ranges: string[],
            excludeAliases: Set<string>,
          ) => Promise<{ name: string; version: string } | null>;
        }
      ).findExistingAliasForRanges.bind(analyzer);

      // 查找 vue 包的别名，要求版本范围 ^2.6.0
      const result = await findExistingAliasForRanges('vue', ['^2.6.0'], new Set());

      expect(result).not.toBeNull();
      expect(result?.name).toBe('vue2');
      expect(result?.version).toBe('2.6.14');
    });

    it('should return null when version does not satisfy requirements (no override)', async () => {
      // 模拟已安装的 npm 别名：aliased-vue2 指向 vue@3.0.0（错误版本）
      // 新逻辑：版本不匹配时返回 null，不会覆盖已有依赖
      const mockInstalledDeps: Map<string, InstalledPackageInfo> = new Map([
        [
          'aliased-vue2',
          {
            name: 'aliased-vue2',
            version: '3.0.0', // 实际安装的是 vue 3.0.0
            path: '/test/project/node_modules/aliased-vue2',
            realName: 'vue',
            isAlias: true,
          },
        ],
      ]);

      const analyzer = new DependencyAnalyzer(
        baseOptions,
        {
          name: 'test',
          version: '1.0.0',
          dependencies: {
            'aliased-vue2': 'npm:vue@3.0.0',
          },
        },
        mockInstalledDeps,
      );

      const findExistingAliasForRanges = (
        analyzer as unknown as {
          findExistingAliasForRanges: (
            packageName: string,
            ranges: string[],
            excludeAliases: Set<string>,
          ) => Promise<{ name: string; version: string } | null>;
        }
      ).findExistingAliasForRanges.bind(analyzer);

      // 查找 vue 包的别名，要求版本范围 ^2.6.0（不满足 3.0.0）
      // 新行为：返回 null，不会覆盖 aliased-vue2
      const result = await findExistingAliasForRanges('vue', ['^2.6.0'], new Set());

      expect(result).toBeNull();
    });

    it('should collect existing alias names via getExistingAliasNames', async () => {
      // 测试 getExistingAliasNames 能正确收集已存在的别名名称
      // 注意：getExistingAliasNames 只从 package.json 的 npm: 协议声明中获取
      const mockInstalledDeps: Map<string, InstalledPackageInfo> = new Map([
        [
          'aliased-vue2',
          {
            name: 'aliased-vue2',
            version: '3.0.0',
            path: '/test/project/node_modules/aliased-vue2',
            realName: 'vue',
            isAlias: true,
          },
        ],
        [
          'vue2',
          {
            name: 'vue2',
            version: '2.6.14',
            path: '/test/project/node_modules/vue2',
            realName: 'vue',
            isAlias: true,
          },
        ],
      ]);

      const analyzer = new DependencyAnalyzer(
        baseOptions,
        {
          name: 'test',
          version: '1.0.0',
          dependencies: {
            'aliased-vue2': 'npm:vue@3.0.0',
            vue2: 'npm:vue@2.6.14',
          },
        },
        mockInstalledDeps,
      );

      const getExistingAliasNames = (
        analyzer as unknown as {
          getExistingAliasNames: (packageName: string) => Promise<Set<string>>;
        }
      ).getExistingAliasNames.bind(analyzer);

      const names = await getExistingAliasNames('vue');

      expect(names.size).toBe(2);
      expect(names.has('aliased-vue2')).toBe(true);
      expect(names.has('vue2')).toBe(true);
    });
  });

  describe('findExistingAliasForRanges via naming pattern', () => {
    it('should detect alias by simple naming pattern (vue2)', async () => {
      // 模拟通过 npm: 协议声明的别名
      const mockInstalledDeps: Map<string, InstalledPackageInfo> = new Map([
        [
          'vue2',
          {
            name: 'vue2',
            version: '2.6.14',
            path: '/test/project/node_modules/vue2',
            realName: 'vue',
            isAlias: true,
          },
        ],
      ]);

      const analyzer = new DependencyAnalyzer(
        baseOptions,
        {
          name: 'test',
          version: '1.0.0',
          dependencies: {
            vue2: 'npm:vue@2.6.14',
          },
        },
        mockInstalledDeps,
      );

      const findExistingAliasForRanges = (
        analyzer as unknown as {
          findExistingAliasForRanges: (
            packageName: string,
            ranges: string[],
            excludeAliases: Set<string>,
          ) => Promise<{ name: string; version: string } | null>;
        }
      ).findExistingAliasForRanges.bind(analyzer);

      const result = await findExistingAliasForRanges('vue', ['^2.0.0'], new Set());

      expect(result).not.toBeNull();
      expect(result?.name).toBe('vue2');
    });

    it('should detect alias by prefixed naming pattern (aliased-vue2)', async () => {
      const mockInstalledDeps: Map<string, InstalledPackageInfo> = new Map([
        [
          'aliased-vue2',
          {
            name: 'aliased-vue2',
            version: '2.7.0',
            path: '/test/project/node_modules/aliased-vue2',
            realName: 'vue',
            isAlias: true,
          },
        ],
      ]);

      const analyzer = new DependencyAnalyzer(
        baseOptions,
        {
          name: 'test',
          version: '1.0.0',
          dependencies: {
            'aliased-vue2': 'npm:vue@2.7.0',
          },
        },
        mockInstalledDeps,
      );

      const findExistingAliasForRanges = (
        analyzer as unknown as {
          findExistingAliasForRanges: (
            packageName: string,
            ranges: string[],
            excludeAliases: Set<string>,
          ) => Promise<{ name: string; version: string } | null>;
        }
      ).findExistingAliasForRanges.bind(analyzer);

      const result = await findExistingAliasForRanges('vue', ['^2.7.0'], new Set());

      expect(result).not.toBeNull();
      expect(result?.name).toBe('aliased-vue2');
      expect(result?.version).toBe('2.7.0');
    });

    it('should return null when no suitable alias exists', async () => {
      const mockInstalledDeps: Map<string, InstalledPackageInfo> = new Map([
        [
          'vue',
          {
            name: 'vue',
            version: '3.2.0',
            path: '/test/project/node_modules/vue',
          },
        ],
      ]);

      const analyzer = new DependencyAnalyzer(
        baseOptions,
        { name: 'test', version: '1.0.0' },
        mockInstalledDeps,
      );

      const findExistingAliasForRanges = (
        analyzer as unknown as {
          findExistingAliasForRanges: (
            packageName: string,
            ranges: string[],
            excludeAliases: Set<string>,
          ) => Promise<{ name: string; version: string } | null>;
        }
      ).findExistingAliasForRanges.bind(analyzer);

      // 没有 vue2 别名，应该返回 null
      const result = await findExistingAliasForRanges('vue', ['^2.6.0'], new Set());

      expect(result).toBeNull();
    });
  });

  describe('multiple version ranges', () => {
    it('should find alias satisfying all version ranges', async () => {
      const mockInstalledDeps: Map<string, InstalledPackageInfo> = new Map([
        [
          'vue2',
          {
            name: 'vue2',
            version: '2.6.14',
            path: '/test/project/node_modules/vue2',
            realName: 'vue',
            isAlias: true,
          },
        ],
      ]);

      const analyzer = new DependencyAnalyzer(
        baseOptions,
        {
          name: 'test',
          version: '1.0.0',
          dependencies: {
            vue2: 'npm:vue@2.6.14',
          },
        },
        mockInstalledDeps,
      );

      const findExistingAliasForRanges = (
        analyzer as unknown as {
          findExistingAliasForRanges: (
            packageName: string,
            ranges: string[],
            excludeAliases: Set<string>,
          ) => Promise<{ name: string; version: string } | null>;
        }
      ).findExistingAliasForRanges.bind(analyzer);

      // 多个版本范围：^2.6.0 和 >=2.6.10
      const result = await findExistingAliasForRanges('vue', ['^2.6.0', '>=2.6.10'], new Set());

      expect(result).not.toBeNull();
      expect(result?.name).toBe('vue2');
      expect(result?.version).toBe('2.6.14');
    });

    it('should return null when not all ranges are satisfied (no override)', async () => {
      // 新逻辑：当版本不满足所有范围时，返回 null，不覆盖已有依赖
      const mockInstalledDeps: Map<string, InstalledPackageInfo> = new Map([
        [
          'vue2',
          {
            name: 'vue2',
            version: '2.6.5', // 满足 ^2.6.0 但不满足 >=2.6.10
            path: '/test/project/node_modules/vue2',
            realName: 'vue',
            isAlias: true,
          },
        ],
      ]);

      const analyzer = new DependencyAnalyzer(
        baseOptions,
        {
          name: 'test',
          version: '1.0.0',
          dependencies: {
            vue2: 'npm:vue@2.6.5',
          },
        },
        mockInstalledDeps,
      );

      const findExistingAliasForRanges = (
        analyzer as unknown as {
          findExistingAliasForRanges: (
            packageName: string,
            ranges: string[],
            excludeAliases: Set<string>,
          ) => Promise<{ name: string; version: string } | null>;
        }
      ).findExistingAliasForRanges.bind(analyzer);

      // 多个版本范围：^2.6.0 和 >=2.6.10
      // 新行为：返回 null，系统将生成新的别名名称
      const result = await findExistingAliasForRanges('vue', ['^2.6.0', '>=2.6.10'], new Set());

      expect(result).toBeNull();
    });
  });

  describe('scoped packages', () => {
    it('should handle scoped package aliases', async () => {
      const mockInstalledDeps: Map<string, InstalledPackageInfo> = new Map([
        [
          'aliased-scope-pkg1',
          {
            name: 'aliased-scope-pkg1',
            version: '1.0.0',
            path: '/test/project/node_modules/aliased-scope-pkg1',
            realName: '@scope/pkg',
            isAlias: true,
          },
        ],
      ]);

      const analyzer = new DependencyAnalyzer(
        baseOptions,
        {
          name: 'test',
          version: '1.0.0',
          dependencies: {
            'aliased-scope-pkg1': 'npm:@scope/pkg@1.0.0',
          },
        },
        mockInstalledDeps,
      );

      const findExistingAliasForRanges = (
        analyzer as unknown as {
          findExistingAliasForRanges: (
            packageName: string,
            ranges: string[],
            excludeAliases: Set<string>,
          ) => Promise<{ name: string; version: string } | null>;
        }
      ).findExistingAliasForRanges.bind(analyzer);

      const result = await findExistingAliasForRanges('@scope/pkg', ['^1.0.0'], new Set());

      expect(result).not.toBeNull();
      expect(result?.name).toBe('aliased-scope-pkg1');
    });
  });

  describe('generateUniqueAliasName', () => {
    it('should generate unique alias name avoiding conflicts', () => {
      const mockInstalledDeps: Map<string, InstalledPackageInfo> = new Map();

      const analyzer = new DependencyAnalyzer(
        baseOptions,
        { name: 'test', version: '1.0.0' },
        mockInstalledDeps,
      );

      const generateUniqueAliasName = (
        analyzer as unknown as {
          generateUniqueAliasName: (
            packageName: string,
            version: string,
            existingNames: Set<string>,
          ) => string;
        }
      ).generateUniqueAliasName.bind(analyzer);

      // 无冲突时，使用基础名称
      const name1 = generateUniqueAliasName('vue', '2.6.14', new Set());
      expect(name1).toBe('aliased-vue2');

      // 存在同名时，使用完整版本号后缀
      const name2 = generateUniqueAliasName('vue', '2.6.14', new Set(['aliased-vue2']));
      expect(name2).toBe('aliased-vue-2-6-14');

      // 完整版本号也冲突时，使用数字后缀
      const name3 = generateUniqueAliasName(
        'vue',
        '2.6.14',
        new Set(['aliased-vue2', 'aliased-vue-2-6-14']),
      );
      expect(name3).toBe('aliased-vue2-2');
    });
  });

  describe('analyzePeerConflicts with conflictingRanges', () => {
    it('should separate conflicting ranges from satisfied ranges', async () => {
      // 场景：项目有 vue@3.x 和 vue2: npm:vue@2.7.16
      // element-ui 需要 vue@^2.5.0 (冲突)
      // 另一个包需要 vue@^3.0.0 (满足)
      // 应该只用冲突的范围来查找别名
      const mockInstalledDeps: Map<string, InstalledPackageInfo> = new Map([
        [
          'vue',
          {
            name: 'vue',
            version: '3.2.0',
            path: '/test/project/node_modules/vue',
          },
        ],
        [
          'vue2',
          {
            name: 'vue2',
            version: '2.7.16',
            path: '/test/project/node_modules/vue2',
            realName: 'vue',
            isAlias: true,
          },
        ],
      ]);

      const analyzer = new DependencyAnalyzer(
        baseOptions,
        {
          name: 'test',
          version: '1.0.0',
          dependencies: {
            vue: '^3.0.0',
            vue2: 'npm:vue@2.7.16',
          },
        },
        mockInstalledDeps,
      );

      // 模拟 analyzePeerConflicts 的行为
      const analyzePeerConflicts = (
        analyzer as unknown as {
          analyzePeerConflicts: (
            peerDepsMap: Map<string, { path: string[]; requiredRange: string }[]>,
          ) => Promise<
            Array<{
              packageName: string;
              mainProjectVersion: string | null;
              conflictingRanges: { path: string[]; requiredRange: string }[];
              hasConflict: boolean;
              needsAlias: boolean;
            }>
          >;
        }
      ).analyzePeerConflicts.bind(analyzer);

      // peerDepsMap 模拟：vue 被两个包请求
      // - element-ui 请求 ^2.5.0 (与主工程 3.2.0 冲突)
      // - vue-router 请求 ^3.0.0 (满足)
      const peerDepsMap = new Map([
        [
          'vue',
          [
            { path: ['element-ui'], requiredRange: '^2.5.0' },
            { path: ['vue-router'], requiredRange: '^3.0.0' },
          ],
        ],
      ]);

      const conflicts = await analyzePeerConflicts(peerDepsMap);

      expect(conflicts).toHaveLength(1);
      const vueConflict = conflicts[0];
      expect(vueConflict?.packageName).toBe('vue');
      expect(vueConflict?.hasConflict).toBe(true);
      expect(vueConflict?.needsAlias).toBe(true);

      // 关键：conflictingRanges 应该只包含冲突的范围 (^2.5.0)，不包含满足的范围 (^3.0.0)
      expect(vueConflict?.conflictingRanges).toHaveLength(1);
      expect(vueConflict?.conflictingRanges[0]?.requiredRange).toBe('^2.5.0');
    });

    it('should reuse existing alias when only checking conflicting ranges', async () => {
      // 这个测试验证：当使用 conflictingRanges 而不是全部 requestedBy 时，
      // 能正确复用已存在的别名
      const mockInstalledDeps: Map<string, InstalledPackageInfo> = new Map([
        [
          'vue',
          {
            name: 'vue',
            version: '3.2.0',
            path: '/test/project/node_modules/vue',
          },
        ],
        [
          'vue2',
          {
            name: 'vue2',
            version: '2.7.16',
            path: '/test/project/node_modules/vue2',
            realName: 'vue',
            isAlias: true,
          },
        ],
      ]);

      const analyzer = new DependencyAnalyzer(
        baseOptions,
        {
          name: 'test',
          version: '1.0.0',
          dependencies: {
            vue: '^3.0.0',
            vue2: 'npm:vue@2.7.16',
          },
        },
        mockInstalledDeps,
      );

      const findExistingAliasForRanges = (
        analyzer as unknown as {
          findExistingAliasForRanges: (
            packageName: string,
            ranges: string[],
            excludeAliases: Set<string>,
          ) => Promise<{ name: string; version: string } | null>;
        }
      ).findExistingAliasForRanges.bind(analyzer);

      // 如果使用全部范围 ['^2.5.0', '^3.0.0']：
      // - vue2@2.7.16 满足 ^2.5.0 但不满足 ^3.0.0
      // - 旧逻辑会返回 null，导致创建新别名
      const oldResult = await findExistingAliasForRanges('vue', ['^2.5.0', '^3.0.0'], new Set());
      expect(oldResult).toBeNull(); // 全部范围无法满足

      // 如果只使用冲突的范围 ['^2.5.0']：
      // - vue2@2.7.16 满足 ^2.5.0
      // - 新逻辑应该返回 vue2
      const newResult = await findExistingAliasForRanges('vue', ['^2.5.0'], new Set());
      expect(newResult).not.toBeNull();
      expect(newResult?.name).toBe('vue2');
      expect(newResult?.version).toBe('2.7.16');
    });
  });
});
