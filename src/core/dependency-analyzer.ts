import { join } from 'node:path';
import type {
  DependencyInfo,
  PackageJson,
  PeerConflict,
  DependencyPath,
  ResolvedOptions,
  AnalysisResult,
  AliasMapping,
  WorkspaceAliasInfo,
  ResolverDiagnostic,
} from '../types/index';
import { createLogger } from '../utils/logger';
import {
  canonicalPath,
  readPackageJsonCached,
  findPackagePath,
  clearPackageJsonCache,
  fileExists,
} from '../utils/fs';
import type { InstalledPackageInfo } from '../types';
import { createWorkspaceDetector, WorkspaceDetector } from './workspace-detector';
import {
  satisfies,
  isValidRange,
  isValidVersion,
  rangesIntersect,
  findBestVersion,
  generateAliasName,
  createAliasInstallSpec,
} from '../utils/semver';
import {
  getDependencyRequirement,
  getRuntimeDependencySpec,
  parseNpmAlias,
  resolveDependencyRequirement,
  type DependencyRequirement,
} from '../utils/version-spec';
import {
  findInvalidPeerOverrideKeys,
  getEffectivePeerDependencies,
  type EffectivePeerEntry,
} from '../utils/peer-overrides';
import { clearNpmRegistryCache } from './npm-registry';
import { npmRegistryClient, type RegistryClient } from './registry-client';
import {
  buildInstalledDependencyGraph,
  collectWorkspaceEntryNames,
  getInstalledDependencyRequirements,
  type InstalledDependencyGraph,
  type InstalledPackageNode,
} from './dependency-graph';

import { linkAliasPeers } from './alias-peer-resolver';
import { validateSharedPeerContexts } from './shared-peer-contexts';
import { AliasManager } from './alias-manager';

const logger = createLogger('dependency-analyzer');

/**
 * 已存在的别名信息（从 package.json 的 npm: 协议解析得到）
 */
interface ExistingAliasInfo {
  /** 别名名称（package.json 中的 key） */
  aliasName: string;
  /** 目标包的真实名称（npm: 后面的包名） */
  targetPackage: string;
  /** 版本规格（npm: 后面的版本范围） */
  versionSpec: string;
  /** 已安装的版本（从 node_modules 读取） */
  installedVersion: string | null;
}

interface ExistingAliasMatch {
  name: string;
  version: string;
  isWorkspaceAlias?: boolean;
  /** 已安装 alias 的实际包目录；同名 alias 可能来自不同 scope */
  installedPath?: string;
  /** 无法取得路径时保留声明来源，避免 local/workspace alias 被错误合并 */
  scope: 'local' | 'workspace';
}

interface ReusedAliasGroup {
  alias: ExistingAliasMatch;
  requests: DependencyPath[];
}

interface AliasScopeTarget {
  packageName: string;
  aliasVersion: string;
}

type PruneIncompatibleBranch = (
  path: string,
  requirements: readonly DependencyRequirement[],
) => boolean;

export class DependencyAnalyzer {
  private options: ResolvedOptions;
  /** 主项目声明的依赖（解析后的版本，catalog: 等协议已转换） */
  private declaredDeps: Record<string, string>;
  /** 主项目声明的原始依赖（未解析，保留 catalog: 等协议） */
  private rawDeclaredDeps: Record<string, string>;
  /** 分析结果：存储有 peer 依赖的包信息 */
  private analyzedDependencies: Map<string, DependencyInfo> = new Map();
  /** 已访问的包名（使用包名，同一个包只分析一次） */
  private visitedPackages: Set<string> = new Set();
  /** 已安装包的信息缓存（按需填充，避免扫描整个 node_modules） */
  private installedPackageCache: Map<string, InstalledPackageInfo> = new Map();
  /**
   * 已存在的别名映射：真实包名 -> 别名信息列表
   * 从 package.json 的 npm:package@version 格式解析得到
   * 这是最准确的别名识别方式
   */
  private existingAliasesMap: Map<string, ExistingAliasInfo[]> = new Map();
  /** Workspace 检测器（用于 catalog 协议解析和 workspace 别名查找） */
  private workspaceDetector: WorkspaceDetector;
  /** Workspace 级别的别名缓存 */
  private workspaceAliasesCache: Map<string, WorkspaceAliasInfo[]> = new Map();
  /** workspace 根目录 package.json 声明的依赖（dependencies/devDependencies），用于“声明判断”合并 */
  private workspaceRootDeclaredDeps: Record<string, string> = {};
  /** 是否已加载 workspaceRootDeclaredDeps */
  private workspaceRootDeclaredLoaded = false;
  /** collectAllRelatedPackages 的 memo 缓存（单次 analyze 生命周期内有效） */
  private collectCache = new Map<string, string[]>();
  /** 当前 analyze 使用的按安装路径区分的依赖图 */
  private dependencyGraph: InstalledDependencyGraph | null = null;
  private readonly inheritedMismatches = new Map<string, Set<string>>();
  /** 注册表访问适配器（可注入以支持离线分析和确定性测试） */
  private registryClient: RegistryClient;
  private graphPopulated = false;
  private diagnostics: ResolverDiagnostic[] = [];
  private watchFiles = new Set<string>();
  private injectedInstalledDeps?: Map<string, InstalledPackageInfo>;

  constructor(
    options: ResolvedOptions,
    mainPackageJson: PackageJson,
    /** 可选：预填充的已安装包信息（主要用于测试） */
    installedDeps?: Map<string, InstalledPackageInfo>,
    /** 可选：注册表访问适配器（主要用于离线分析和测试） */
    registryClient: RegistryClient = npmRegistryClient,
  ) {
    this.options = options;
    this.registryClient = registryClient;
    this.injectedInstalledDeps = installedDeps;
    this.rawDeclaredDeps = {
      ...mainPackageJson.dependencies,
      ...mainPackageJson.devDependencies,
      ...mainPackageJson.optionalDependencies,
    };
    // 初始时 declaredDeps 与 rawDeclaredDeps 相同，后续会在 analyze 中解析 catalog 协议
    this.declaredDeps = { ...this.rawDeclaredDeps };

    // 初始化 workspace 检测器
    this.workspaceDetector = createWorkspaceDetector(options.projectRoot);

    // 解析 package.json 中的 npm: 协议别名
    this.parseExistingAliases();

    // 如果提供了 installedDeps，预填充到缓存中
    if (installedDeps) {
      for (const [name, info] of installedDeps) {
        this.installedPackageCache.set(name, info);
      }
    }
  }

  /**
   * 统一封装：在指定 baseDir 下解析包安装路径并读取 package.json
   * - 用于收敛 findPackagePath + readPackageJsonCached 的重复逻辑
   * - 返回 { packagePath: null } 表示无法 resolve 到该包
   * - 返回 { packagePath, pkgJson: null } 表示找到了目录但 package.json 无法读取/解析
   */
  private resolvePackageJson(
    packageName: string,
    baseDir: string,
  ): { packagePath: string | null; pkgJson: PackageJson | null } {
    const packagePath = findPackagePath(packageName, baseDir);
    if (!packagePath) {
      return { packagePath: null, pkgJson: null };
    }

    const pkgJson = readPackageJsonCached(packagePath);
    this.watchFiles.add(join(canonicalPath(packagePath), 'package.json'));
    return { packagePath, pkgJson };
  }

  /**
   * 加载 workspace 根目录 package.json 声明的依赖（dependencies/devDependencies）
   *
   * 目的：在 monorepo/workspace 场景下，“主工程声明”需要合并当前包与 workspace 根的声明，
   * 与 WorkspaceDetector 的 workspaceRoot 判断逻辑保持一致。
   */
  private ensureWorkspaceRootDeclaredDepsLoaded(): void {
    if (this.workspaceRootDeclaredLoaded) {
      return;
    }
    this.workspaceRootDeclaredLoaded = true;

    const workspaceRoot = this.workspaceDetector.getWorkspaceRoot();
    if (!workspaceRoot || workspaceRoot === this.options.projectRoot) {
      return;
    }

    const rootPkgJson = readPackageJsonCached(workspaceRoot);
    if (!rootPkgJson) {
      return;
    }

    this.workspaceRootDeclaredDeps = {
      ...rootPkgJson.dependencies,
      ...rootPkgJson.devDependencies,
      ...rootPkgJson.optionalDependencies,
    };
  }

  /**
   * 判断某个包是否在“主工程”声明（dependencies/devDependencies）
   *
   * 默认行为（与 workspace 判断逻辑一致）：
   * - 非 workspace：只看当前 projectRoot 的 package.json
   * - workspace/monorepo：合并 projectRoot + workspaceRoot 两处 package.json 的声明
   */
  private isDeclaredInMainProject(packageName: string): boolean {
    return (
      Object.prototype.hasOwnProperty.call(this.declaredDeps, packageName) ||
      Object.prototype.hasOwnProperty.call(this.workspaceRootDeclaredDeps, packageName)
    );
  }

  /**
   * 解析 package.json 中的 npm: 协议别名
   * 格式：aliasName: "npm:realPackage@version"
   * 这是识别别名最准确的方式
   */
  private parseExistingAliases(): void {
    for (const [aliasName, versionSpec] of Object.entries(this.declaredDeps)) {
      if (typeof versionSpec !== 'string') continue;

      // 解析 npm:package@version 格式（支持 scoped packages: npm:@scope/package@version）
      const parsed = parseNpmAlias(versionSpec);
      if (parsed) {
        const [targetPackage, version] = parsed;

        const aliasInfo: ExistingAliasInfo = {
          aliasName,
          targetPackage,
          versionSpec: version,
          installedVersion: null, // 稍后在需要时填充
        };

        const existing = this.existingAliasesMap.get(targetPackage) ?? [];
        existing.push(aliasInfo);
        this.existingAliasesMap.set(targetPackage, existing);

        logger.debug(`Found npm alias: ${aliasName} -> ${targetPackage}@${version}`);
      }
    }

    if (this.existingAliasesMap.size > 0) {
      logger.debug(`Found ${this.existingAliasesMap.size} npm: protocol aliases`);
    }
  }

  /**
   * 获取别名的已安装版本（懒加载）
   */
  private getAliasInstalledVersion(aliasName: string): string | null {
    // 先检查缓存
    const cached = this.installedPackageCache.get(aliasName);
    if (cached) {
      return cached.version;
    }

    // 查找并读取 package.json
    const { packagePath, pkgJson } = this.resolvePackageJson(aliasName, this.options.projectRoot);
    if (packagePath && pkgJson?.version) {
      // 缓存信息
      this.installedPackageCache.set(aliasName, {
        name: aliasName,
        version: pkgJson.version,
        path: packagePath,
        isAlias: true,
        realName: pkgJson.name,
      });
      return pkgJson.version;
    }

    return null;
  }

  /**
   * 解析所有 catalog: 协议的依赖版本
   * 将 catalog:xxx 转换为实际的版本范围
   */
  private resolveCatalogDependencies(): void {
    for (const [pkgName, versionSpec] of Object.entries(this.rawDeclaredDeps)) {
      if (typeof versionSpec !== 'string') continue;

      // 检查是否是 catalog 协议
      if (versionSpec.startsWith('catalog:')) {
        const resolved = this.workspaceDetector.resolveVersionSpec(pkgName, versionSpec);
        if (resolved) {
          this.declaredDeps[pkgName] = resolved;
          logger.debug(`Resolved catalog dependency: ${pkgName} "${versionSpec}" -> "${resolved}"`);
        } else {
          logger.warn(`Failed to resolve catalog dependency: ${pkgName}@${versionSpec}`);
        }
      }
      // 检查是否是 workspace 协议
      else if (versionSpec.startsWith('workspace:')) {
        const resolved = this.workspaceDetector.resolveVersionSpec(pkgName, versionSpec);
        if (resolved) {
          this.declaredDeps[pkgName] = resolved;
          logger.debug(
            `Resolved workspace dependency: ${pkgName} "${versionSpec}" -> "${resolved}"`,
          );
        }
      }
    }
  }

  /**
   * 分析依赖并找出冲突
   */
  async analyze(options?: { clearCache?: boolean }): Promise<AnalysisResult> {
    logger.info('Starting dependency analysis...');
    this.watchFiles.clear();
    this.watchFiles.add(join(this.options.projectRoot, 'package.json'));

    for (const invalidKey of findInvalidPeerOverrideKeys(this.options.peerOverrides)) {
      logger.warn(
        `Ignoring invalid peerOverrides selector "${invalidKey}": expected "<packageName>" or "<packageName>@<validSemverRange>"`,
      );
    }

    try {
      // 0. 解析 catalog: 协议的依赖版本
      this.resolveCatalogDependencies();

      // 0.1 预加载 workspaceRoot 的声明依赖（用于后续“已声明”判断合并）
      this.ensureWorkspaceRootDeclaredDepsLoaded();
      const workspaceRoot = this.workspaceDetector.getWorkspaceRoot();
      if (workspaceRoot) {
        this.watchFiles.add(join(workspaceRoot, 'package.json'));
        const workspaceFile = join(workspaceRoot, 'pnpm-workspace.yaml');
        if (fileExists(workspaceFile)) this.watchFiles.add(workspaceFile);
      }

      // 先建立按真实安装路径标识的完整图。后续所有关系判断都从该图
      // 读取；analyzedDependencies 仅保留按名称兼容的首个可见实例。
      this.dependencyGraph = buildInstalledDependencyGraph(
        this.options.dependencies,
        this.options.projectRoot,
        workspaceRoot,
        this.watchFiles,
        this.options.peerOverrides,
      );
      for (const node of this.dependencyGraph.nodes.values()) {
        this.watchFiles.add(join(node.packagePath, 'package.json'));
      }

      // 1. 从用户指定的依赖开始，递归分析所有子依赖（deps + peerDeps）
      //    构建完整依赖树用于后续重定向判断
      for (const depName of this.options.dependencies) {
        this.analyzeDependencyRecursive(depName, []);
        if (!this.findGraphRoot(depName) && !this.injectedInstalledDeps?.has(depName)) {
          this.diagnostics.push({
            code: 'DEPENDENCY_NOT_FOUND',
            severity: 'error',
            packageName: depName,
            message: 'Configured dependency not found: ' + depName,
          });
        }
      }

      // 2. 只收集第一层依赖的 peer 依赖（用于冲突检测）
      //    不分析子依赖的 peerDeps，只有第一层的冲突才需要别名安装
      const peerDepsMap = this.collectFirstLevelPeerDependencies();

      // 3. 分析冲突（只检测与主工程已声明依赖的版本冲突），同时记录缺失的 peer 依赖
      const missingFirstLevelPeers: Array<{
        packageName: string;
        requiredRange: string;
        requestedBy: string;
      }> = [];
      const peerConflicts = this.analyzePeerConflicts(peerDepsMap, missingFirstLevelPeers);

      // 4. 生成别名映射（只为需要安装别名的冲突生成）
      //    会收集完整依赖树用于重定向判断
      const aliasMappings = await this.generateAliasMappings(peerConflicts);
      validateSharedPeerContexts(
        this.dependencyGraph,
        aliasMappings,
        this.options,
        this.diagnostics,
        this.watchFiles,
        this.workspaceDetector,
        this.inheritedMismatches,
      );

      const conflictsNeedingAlias = peerConflicts.filter((c) => c.needsAlias).length;
      logger.info(
        `Analysis complete. Found ${conflictsNeedingAlias} first-level peer conflicts needing alias, ` +
          `${missingFirstLevelPeers.length} missing peers (not auto-installing). ` +
          `Analyzed ${this.analyzedDependencies.size} packages, visited ${this.visitedPackages.size} packages total.`,
      );

      return {
        watchFiles: [...this.watchFiles],
        diagnostics: this.diagnostics,
        analyzedDependencies: this.analyzedDependencies,
        peerConflicts,
        aliasMappings,
        missingFirstLevelPeers,
      };
    } finally {
      // 清理全局 IO 缓存（允许 DepsConflictResolver 在完成 AliasManager 初始化后统一清理，以复用规范化路径缓存）
      if (options?.clearCache !== false) {
        clearPackageJsonCache();
      }
      clearNpmRegistryCache();

      // 清理仅在分析期间使用的内部状态，允许 GC 回收
      // 注意：不能清理 analyzedDependencies，它被返回值直接引用
      this.visitedPackages.clear();
      this.installedPackageCache.clear();
      this.existingAliasesMap.clear();
      this.workspaceAliasesCache.clear();
      this.workspaceRootDeclaredDeps = {};
      this.rawDeclaredDeps = {};
      this.declaredDeps = {};
      this.collectCache.clear();
      this.inheritedMismatches.clear();
      this.dependencyGraph = null;
    }
  }

  /**
   * 递归分析单个依赖及其所有子依赖
   */
  private analyzeDependencyRecursive(
    packageName: string,
    dependencyPath: string[],
  ): DependencyInfo | null {
    const graphRoot = this.findGraphRoot(packageName);
    if (graphRoot) {
      this.populateAnalyzedDependenciesFromGraph();
      return this.analyzedDependencies.get(packageName) ?? null;
    }

    // 使用包名作为 visited 键，同一个包只分析一次
    if (this.visitedPackages.has(packageName)) {
      logger.debug(`Skipping already visited package: ${packageName}`);
      return this.analyzedDependencies.get(packageName) ?? null;
    }

    // 使用显式栈替代递归，避免超大依赖树导致的调用栈溢出
    let rootInfo: DependencyInfo | null = null;
    const stack: Array<{ name: string; path: string[] }> = [
      { name: packageName, path: dependencyPath },
    ];

    while (stack.length > 0) {
      const item = stack.pop();
      if (!item) break;

      const name = item.name;
      const path = item.path;

      if (this.visitedPackages.has(name)) {
        continue;
      }
      this.visitedPackages.add(name);

      const { packagePath, pkgJson } = this.resolvePackageJson(name, this.options.projectRoot);
      if (!packagePath) {
        logger.debug(`Package not found: ${name}`);
        continue;
      }
      if (!pkgJson) {
        logger.debug(`Could not read package.json for: ${name}`);
        continue;
      }

      // 缓存已安装包的信息（按需填充）
      this.cacheInstalledPackageInfo(name, packagePath, pkgJson);

      logger.debug(`Analyzing ${name}@${pkgJson.version}`);

      const depInfo: DependencyInfo = {
        name,
        version: pkgJson.version ?? 'unknown',
        dependencyPath: [...path],
        dependencies: { ...pkgJson.dependencies, ...pkgJson.optionalDependencies },
        peerDependencies: pkgJson.peerDependencies ?? {},
        peerDependenciesMeta: pkgJson.peerDependenciesMeta,
      };

      // 始终存储包信息，以便后续查找普通依赖中的冲突
      this.analyzedDependencies.set(name, depInfo);

      if (name === packageName) {
        rootInfo = depInfo;
      }

      const currentPath = [...path, name];
      const depsToCheck = [
        ...Object.keys({ ...pkgJson.dependencies, ...pkgJson.optionalDependencies }),
        ...getEffectivePeerDependencies(pkgJson, name, this.options.peerOverrides).keys(),
      ];

      for (const depName of depsToCheck) {
        if (this.visitedPackages.has(depName)) {
          continue;
        }
        stack.push({ name: depName, path: currentPath });
      }
    }

    return rootInfo;
  }

  private findGraphRoot(packageName: string): InstalledPackageNode | null {
    if (!this.dependencyGraph) return null;
    const rootId = this.dependencyGraph.rootRequests.get(packageName)?.keys().next().value;
    return rootId ? (this.dependencyGraph.nodes.get(rootId) ?? null) : null;
  }

  private getDependencyPathForGraphNode(node: InstalledPackageNode): string[] {
    if (!this.dependencyGraph) return [];

    const names: string[] = [];
    let current: InstalledPackageNode | undefined = node;
    const visited = new Set<string>();
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      names.unshift(current.name);
      current = current.parentId ? this.dependencyGraph.nodes.get(current.parentId) : undefined;
    }

    return names.slice(0, -1);
  }

  private populateAnalyzedDependenciesFromGraph(): void {
    if (!this.dependencyGraph || this.graphPopulated) return;
    this.graphPopulated = true;

    const rootVisibleNodeIds = new Map<string, string>();
    for (const node of this.dependencyGraph.nodes.values()) {
      const rootVisiblePath = findPackagePath(node.name, this.options.projectRoot);
      if (!rootVisiblePath) continue;

      const rootVisibleNode = this.dependencyGraph.nodes.get(canonicalPath(rootVisiblePath));
      if (rootVisibleNode && !rootVisibleNodeIds.has(node.name)) {
        rootVisibleNodeIds.set(node.name, rootVisibleNode.id);
      }
    }

    const orderedNodes: InstalledPackageNode[] = [];
    const selectedNodeIds = new Set<string>();
    for (const nodeId of rootVisibleNodeIds.values()) {
      const node = this.dependencyGraph.nodes.get(nodeId);
      if (node && !selectedNodeIds.has(node.id)) {
        selectedNodeIds.add(node.id);
        orderedNodes.push(node);
      }
    }
    for (const node of this.dependencyGraph.nodes.values()) {
      if (!selectedNodeIds.has(node.id)) {
        orderedNodes.push(node);
      }
    }

    for (const node of orderedNodes) {
      if (this.analyzedDependencies.has(node.name)) continue;

      const packageJson = readPackageJsonCached(node.packagePath);
      if (!packageJson) continue;

      this.cacheInstalledPackageInfo(node.name, node.packagePath, packageJson);
      this.analyzedDependencies.set(node.name, {
        name: node.name,
        version: node.version,
        dependencyPath: this.getDependencyPathForGraphNode(node),
        dependencies: { ...packageJson.dependencies, ...packageJson.optionalDependencies },
        peerDependencies: packageJson.peerDependencies ?? {},
        peerDependenciesMeta: packageJson.peerDependenciesMeta,
      });
      this.visitedPackages.add(node.name);
    }

    for (const name of this.dependencyGraph.rootRequests.keys()) {
      const node = this.findGraphRoot(name);
      if (!node || node.name === name) continue;
      const packageJson = readPackageJsonCached(node.packagePath);
      if (!packageJson) continue;
      this.cacheInstalledPackageInfo(name, node.packagePath, packageJson);
      this.analyzedDependencies.set(name, {
        name,
        version: node.version,
        dependencyPath: [],
        dependencies: { ...packageJson.dependencies, ...packageJson.optionalDependencies },
        peerDependencies: packageJson.peerDependencies ?? {},
        peerDependenciesMeta: packageJson.peerDependenciesMeta,
      });
      this.visitedPackages.add(name);
    }
  }

  /**
   * 缓存已安装包的信息（用于后续查找别名等）
   */
  private cacheInstalledPackageInfo(
    packageName: string,
    packagePath: string,
    pkgJson: PackageJson,
  ): void {
    if (this.installedPackageCache.has(packageName)) {
      return;
    }

    const info: InstalledPackageInfo = {
      name: packageName,
      version: pkgJson.version ?? 'unknown',
      path: packagePath,
    };

    // 检查是否是别名安装
    if (pkgJson.name && pkgJson.name !== packageName) {
      info.isAlias = true;
      info.realName = pkgJson.name;
    }

    // 检查 package.json 中的声明（npm: 协议）
    const declaredSpec = this.declaredDeps[packageName];
    if (typeof declaredSpec === 'string' && declaredSpec.startsWith('npm:')) {
      info.isAlias = true;
      // The declaration is intent, not proof of the installed package identity.
      info.realName = pkgJson.name;
    }

    this.installedPackageCache.set(packageName, info);
  }

  /**
   * 收集第一层依赖的 peer 依赖
   * 只分析用户指定的 dependencies 的直接 peerDependencies，不分析子依赖的 peerDependencies
   *
   * 注意：虽然只收集第一层的 peer 依赖用于冲突检测和别名安装，
   * 但依赖树仍然会被完整构建，用于后续的重定向判断
   */
  private collectFirstLevelPeerDependencies(): Map<string, DependencyPath[]> {
    const peerDepsMap = new Map<string, DependencyPath[]>();
    const collectPeers = (
      effectivePeers: ReadonlyMap<string, EffectivePeerEntry>,
      path: string[],
      packagePath?: string,
    ) => {
      for (const [peerName, { range: peerRange, optional }] of effectivePeers) {
        if (optional) continue;

        const existing = peerDepsMap.get(peerName) ?? [];
        existing.push({
          path,
          requiredRange: peerRange,
          ...(packagePath ? { packagePath } : {}),
        });
        peerDepsMap.set(peerName, existing);
        logger.debug(
          `Found first-level peer dependency: ${peerName}@${peerRange} required by ${path.join('>')}`,
        );
      }
    };

    if (this.dependencyGraph?.roots.length) {
      for (const [name, instances] of this.dependencyGraph.rootRequests) {
        for (const [packagePath, requests] of instances) {
          const peers = this.dependencyGraph.nodes
            .get(packagePath)
            ?.peerDependenciesByName.get(name);
          if (!peers) continue;
          for (const { path } of requests) {
            collectPeers(peers, path, packagePath);
          }
        }
      }
    } else {
      // Retain the fallback for analyzers with injected package metadata.
      for (const name of this.options.dependencies) {
        const manifest = this.analyzedDependencies.get(name);
        if (manifest) {
          collectPeers(getEffectivePeerDependencies(manifest, name, this.options.peerOverrides), [
            name,
          ]);
        }
      }
    }

    return peerDepsMap;
  }

  /**
   * 检查某个宿主未声明的 peer 请求是否已由其所属的中间 workspace 包自洽封装并满足。
   * 仅当请求链路上的祖先 workspace 包在 dependencies/optionalDependencies 中显式声明了该包，
   * 且从请求包物理路径解析到的满足范围的真实安装包与该声明祖先实际解析到的物理目录一致时返回 true
   * （避免把 pnpm/npm hoist 幽灵依赖误判为祖先 workspace 已提供）。
   */
  private isSatisfiedByOwningWorkspace(
    packageName: string,
    request: DependencyPath,
    resolvedRange: string,
  ): boolean {
    if (request.path.length <= 1 || !request.packagePath) {
      return false;
    }

    let currentDir = this.options.projectRoot;
    const declaringAncestors: string[] = [];
    for (let index = 0; index < request.path.length - 1; index++) {
      const segment = request.path[index]!;
      const ancestorPath = findPackagePath(segment, currentDir);
      if (!ancestorPath) {
        return false;
      }
      const canonicalAncestor = canonicalPath(ancestorPath);
      this.watchFiles.add(join(canonicalAncestor, 'package.json'));
      const ancestorManifest = readPackageJsonCached(canonicalAncestor);
      if (ancestorManifest) {
        const declaredSpec = getRuntimeDependencySpec(ancestorManifest, packageName);
        if (typeof declaredSpec === 'string') {
          const npmAlias = parseNpmAlias(declaredSpec);
          if (!npmAlias || npmAlias[0] === packageName) {
            declaringAncestors.push(canonicalAncestor);
          }
        }
      }
      currentDir = canonicalAncestor;
    }

    if (declaringAncestors.length === 0) {
      return false;
    }

    const { packagePath: installedPath, pkgJson: installedManifest } = this.resolvePackageJson(
      packageName,
      request.packagePath,
    );
    if (!installedPath || !installedManifest?.version) {
      return false;
    }
    if (installedManifest.name && installedManifest.name !== packageName) {
      return false;
    }
    if (!satisfies(installedManifest.version, resolvedRange)) {
      return false;
    }

    const canonicalInstalled = canonicalPath(installedPath);
    return declaringAncestors.some((ancestorDir) => {
      const ancestorResolved = findPackagePath(packageName, ancestorDir);
      return ancestorResolved !== null && canonicalPath(ancestorResolved) === canonicalInstalled;
    });
  }

  /**
   * 分析 peer 依赖冲突
   * 只有当主工程已安装某个依赖，且 peerDeps 要求的版本不兼容时，才需要别名
   */
  private analyzePeerConflicts(
    peerDepsMap: Map<string, DependencyPath[]>,
    missingFirstLevelPeers?: Array<{
      packageName: string;
      requiredRange: string;
      requestedBy: string;
    }>,
  ): PeerConflict[] {
    const conflicts: PeerConflict[] = [];

    for (const [packageName, requestedBy] of peerDepsMap) {
      // 仅当主工程声明了该 peer 包时，才认为“主工程版本”有意义并允许自动安装别名。
      // 否则：即使 node_modules 可 resolve 到该包（例如 pnpm peer/hoist 带来的间接可见），也应当视为“未声明”，只提示 missing，不触发安装。
      const isDeclared = this.isDeclaredInMainProject(packageName);

      // 获取主工程已安装的版本（从 node_modules 读取实际版本）
      // 只有声明过的包才会参与冲突判定
      const mainVersion = isDeclared ? this.getMainProjectVersion(packageName) : null;
      const isInstalled = mainVersion !== null;

      const conflictingRanges: DependencyPath[] = [];
      const satisfiedRanges: DependencyPath[] = [];
      const undeclaredRequests: DependencyPath[] = [];

      for (const request of requestedBy) {
        const { range: resolvedRange } = resolveDependencyRequirement(
          packageName,
          request.requiredRange,
          this.workspaceDetector,
        );

        if (mainVersion && satisfies(mainVersion, resolvedRange)) {
          satisfiedRanges.push(request);
        } else if (
          !isDeclared &&
          this.isSatisfiedByOwningWorkspace(packageName, request, resolvedRange)
        ) {
          satisfiedRanges.push(request);
        } else {
          conflictingRanges.push({
            ...request,
            requiredRange: resolvedRange,
          });
          if (!isDeclared) {
            undeclaredRequests.push(request);
          }
        }
      }

      if (!isDeclared && undeclaredRequests.length > 0) {
        this.diagnostics.push({
          code: 'PEER_NOT_DECLARED',
          severity: 'error',
          packageName,
          requestedBy: undeclaredRequests.map((request) => request.path.join('>')),
          message: packageName + ' is not declared by the host',
        });
        if (missingFirstLevelPeers) {
          for (const request of undeclaredRequests) {
            const requestedByPath = request.path.join('>');
            if (!requestedByPath) continue;
            missingFirstLevelPeers.push({
              packageName,
              requiredRange: request.requiredRange,
              requestedBy: requestedByPath,
            });
          }
        }
      } else if (isDeclared && !isInstalled) {
        this.diagnostics.push({
          code: 'PEER_NOT_INSTALLED',
          severity: 'error',
          packageName,
          requestedBy: requestedBy.map((request) => request.path.join('>')),
          message: packageName + ' is declared but not installed',
        });
      }

      // hasConflict: 纯版本兼容性判断——存在不满足的 peer 范围即为 true
      const hasConflict = conflictingRanges.length > 0;
      // needsAlias: 可操作条件——冲突 + 主工程已声明且已安装该包
      const needsAlias = hasConflict && isDeclared && isInstalled;

      if (needsAlias) {
        logger.info(
          `Peer conflict: ${packageName}@${mainVersion} - ${conflictingRanges.length} incompatible ranges`,
        );
      }

      conflicts.push({
        packageName,
        mainProjectVersion: mainVersion,
        requiredRange: this.mergeRequiredRanges(requestedBy),
        requestedBy,
        conflictingRanges,
        hasConflict,
        needsAlias,
      });
    }

    return conflicts;
  }

  /**
   * 获取已安装的包版本（从 node_modules 读取实际版本）
   * 返回 null 表示包未安装
   */
  private getMainProjectVersion(packageName: string): string | null {
    // 主工程版本必须从 projectRoot 解析，不能被图中更早遇到的嵌套
    // 同名实例覆盖。只有根目录解析不到时才回退到缓存。
    const { packagePath, pkgJson } = this.resolvePackageJson(packageName, this.options.projectRoot);
    if (packagePath && pkgJson?.version) {
      // 缓存主工程可见实例，供后续别名识别复用。
      this.installedPackageCache.set(packageName, {
        name: packageName,
        version: pkgJson.version,
        path: packagePath,
      });
      return pkgJson.version;
    }

    const cached = this.injectedInstalledDeps?.get(packageName);
    if (cached) {
      return cached.version;
    }

    // 包未安装，返回 null
    // 注意：不返回 package.json 中声明的版本范围，因为那不是实际安装的版本
    return null;
  }

  /**
   * 合并多个版本范围为描述字符串
   */
  private mergeRequiredRanges(requests: DependencyPath[]): string {
    const ranges = [...new Set(requests.map((r) => r.requiredRange))];
    return ranges.join(' || ');
  }

  /**
   * 生成别名映射
   */
  private async generateAliasMappings(conflicts: PeerConflict[]): Promise<AliasMapping[]> {
    const aliasMappings: AliasMapping[] = [];
    const usedAliasNames = new Set<string>();

    // 按包名分组需要别名的冲突
    const aliasNeeded = conflicts.filter((c) => c.needsAlias);

    // 收集所有冲突包的名称
    const allConflictPackageNames = aliasNeeded.map((c) => c.packageName);

    // 对于每个需要别名的包
    for (const conflict of aliasNeeded) {
      const mappings = await this.createAliasMappingsForConflict(
        conflict,
        allConflictPackageNames,
        usedAliasNames,
      );
      aliasMappings.push(...mappings);
    }

    await linkAliasPeers(
      aliasMappings,
      this.options,
      this.registryClient,
      this.diagnostics,
      conflicts,
      this.watchFiles,
    );

    return aliasMappings;
  }

  /**
   * 为单个冲突创建别名映射
   */
  private async createAliasMappingsForConflict(
    conflict: PeerConflict,
    allConflictPackageNames: string[],
    usedAliasNames: Set<string>,
  ): Promise<AliasMapping[]> {
    const { packageName, conflictingRanges } = conflict;

    logger.info(`Creating alias for "${packageName}"`);

    // 输出 workspace 检测结果（使用 info 级别以便用户看到）
    const workspaceRoot = this.workspaceDetector.getWorkspaceRoot();
    if (workspaceRoot) {
      logger.info(`  Workspace root detected: ${workspaceRoot}`);
      const wsAliases = this.findWorkspaceAliasesForPackage(packageName);
      if (wsAliases.length > 0) {
        logger.info(`  Found ${wsAliases.length} workspace alias(es) for ${packageName}:`);
        for (const a of wsAliases) {
          logger.info(
            `    - ${a.aliasName}: npm:${packageName}@${a.versionSpec} (defined in: ${a.definedIn})`,
          );
        }
      } else {
        logger.info(
          `  No workspace aliases found for ${packageName} (expected npm:${packageName}@version format in root package.json)`,
        );
      }
    } else {
      logger.info(`  Not in a monorepo workspace`);
    }

    // 输出当前项目已有的本地别名
    const localAliases = this.existingAliasesMap.get(packageName);
    if (localAliases && localAliases.length > 0) {
      logger.info(`  Found ${localAliases.length} local alias(es) for ${packageName}:`);
      for (const a of localAliases) {
        logger.info(
          `    - ${a.aliasName}: npm:${packageName}@${a.versionSpec} (installed: ${a.installedVersion ?? 'not installed'})`,
        );
      }
    }

    // 获取已存在的别名（用于复用和避免命名冲突）
    const existingAliasNames = this.getExistingAliasNames(packageName);
    // Names are reserved across all conflicts in this analysis generation.
    const mappings: AliasMapping[] = [];

    // 先收集所有真实已安装的别名身份，再按范围筛选候选。否则当同名
    // alias 只有一个满足当前范围时，另一条物理路径会被过滤掉，运行时
    // 仍可能按项目根目录解析到错误的包。
    const installedAliasMatches = this.findInstalledAliasMatches(packageName);
    const installedAliasesByName = new Map<string, ExistingAliasMatch[]>();
    for (const installedAlias of installedAliasMatches) {
      const aliases = installedAliasesByName.get(installedAlias.name);
      if (aliases) {
        aliases.push(installedAlias);
      } else {
        installedAliasesByName.set(installedAlias.name, [installedAlias]);
      }
    }

    for (const [aliasName, aliases] of installedAliasesByName) {
      const identities = new Set(
        aliases.map(
          (alias) =>
            `${alias.installedPath ? canonicalPath(alias.installedPath) : alias.scope}\0${alias.version}`,
        ),
      );
      if (identities.size < 2) continue;

      this.diagnostics.push({
        code: 'AMBIGUOUS_ALIAS_SCOPE',
        severity: 'error',
        packageName,
        aliases: [aliasName],
        message: 'Alias resolves to multiple installed identities: ' + aliasName,
      });
      logger.warn(
        `Alias reuse skipped: ${JSON.stringify({
          code: 'AMBIGUOUS_ALIAS_SCOPE',
          packageName,
          aliasName,
          candidates: aliases.map((alias) => ({
            installedPath: alias.installedPath ?? null,
            scope: alias.scope,
            version: alias.version,
          })),
        })}`,
      );
      return [];
    }

    // 先逐个匹配已安装的别名。多个请求匹配到同一个别名时合并为一个映射，
    // 这样完全满足的冲突可以在没有 registry 的环境中完成分析。
    const reusedAliasGroups = new Map<string, ReusedAliasGroup>();
    const unresolvedRequests: DependencyPath[] = [];

    for (const request of conflictingRanges) {
      const existingAlias = this.findExistingAliasForRanges(
        packageName,
        [request.requiredRange],
        new Set(),
      );

      if (!existingAlias) {
        unresolvedRequests.push(request);
        continue;
      }

      usedAliasNames.add(existingAlias.name);
      const aliasIdentity = `${existingAlias.name}\0${existingAlias.installedPath ? canonicalPath(existingAlias.installedPath) : existingAlias.scope}\0${existingAlias.version}`;
      const reusedGroup = reusedAliasGroups.get(aliasIdentity);
      if (reusedGroup) {
        reusedGroup.requests.push(request);
      } else {
        reusedAliasGroups.set(aliasIdentity, {
          alias: existingAlias,
          requests: [request],
        });
      }
    }

    // AliasManager and the bundler plugins address aliases by name only. Never
    // emit duplicate names when the same alias resolves to different paths or
    // versions, because the last rule would silently win at runtime.
    const reusedGroupsByAliasName = new Map<string, ReusedAliasGroup[]>();
    for (const reusedGroup of reusedAliasGroups.values()) {
      const groups = reusedGroupsByAliasName.get(reusedGroup.alias.name);
      if (groups) {
        groups.push(reusedGroup);
      } else {
        reusedGroupsByAliasName.set(reusedGroup.alias.name, [reusedGroup]);
      }
    }

    for (const [aliasName, groups] of reusedGroupsByAliasName) {
      if (groups.length < 2) continue;

      this.diagnostics.push({
        code: 'AMBIGUOUS_ALIAS_SCOPE',
        severity: 'error',
        packageName,
        aliases: [aliasName],
        message: 'Alias resolves to multiple installed identities: ' + aliasName,
      });
      logger.warn(
        `Alias reuse skipped: ${JSON.stringify({
          code: 'AMBIGUOUS_ALIAS_SCOPE',
          packageName,
          aliasName,
          candidates: groups.map(({ alias, requests }) => ({
            installedPath: alias.installedPath ?? null,
            scope: alias.scope,
            version: alias.version,
            requesters: requests.map((request) => request.path.join('>')),
          })),
        })}`,
      );
      return [];
    }

    const plannedGroups: Array<{
      aliasName: string;
      version: string;
      installSpec: string;
      requests: DependencyPath[];
    }> = [];

    for (const reusedGroup of reusedAliasGroups.values()) {
      logger.info(
        `    Reusing ${reusedGroup.alias.scope} alias: ${reusedGroup.alias.name}@${reusedGroup.alias.version}`,
      );
      plannedGroups.push({
        aliasName: reusedGroup.alias.name,
        version: reusedGroup.alias.version,
        installSpec: '', // 不需要安装
        requests: reusedGroup.requests,
      });
    }

    const finalizeMappings = () => {
      const buildMapping = (
        entry: (typeof plannedGroups)[number],
        pruneIncompatibleBranch?: PruneIncompatibleBranch,
      ) =>
        this.buildAliasMapping(
          packageName,
          entry.aliasName,
          entry.version,
          entry.installSpec,
          entry.requests,
          allConflictPackageNames,
          pruneIncompatibleBranch,
        );

      // Infer a substitute only from a verified alias's independently
      // compatible scope. Its reachability cannot rely on an incompatible
      // branch that is itself waiting to decide whether to inherit.
      const verified = plannedGroups.filter(({ installSpec }) => !installSpec);
      let findScopedProvider: PruneIncompatibleBranch | undefined;
      const pruneIncompatibleBranch: PruneIncompatibleBranch | undefined =
        this.dependencyGraph && plannedGroups.length > 1 && verified.length > 0
          ? (path, requirements) => {
              findScopedProvider ??= this.createScopedProviderLookup(
                packageName,
                verified.map((entry) => buildMapping(entry, () => true)),
              );
              return findScopedProvider(path, requirements);
            }
          : undefined;
      for (const entry of plannedGroups) {
        mappings.push(buildMapping(entry, pruneIncompatibleBranch));
      }
      return mappings;
    };

    // 没有未匹配的请求时，不访问 registry。
    if (unresolvedRequests.length === 0) {
      return finalizeMappings();
    }

    if (this.options.offline) {
      this.diagnostics.push({
        code: 'OFFLINE_ALIAS_MISSING',
        severity: 'error',
        packageName,
        requestedBy: unresolvedRequests.map((request) => request.path.join('>')),
        message: 'No installed alias satisfies ' + packageName + ' in offline mode',
      });
      return finalizeMappings();
    }

    // 只为未匹配请求获取远程版本；registry 失败时保留前面已经生成的复用映射。
    let versions: string[];
    try {
      versions = await this.registryClient.fetchAllVersions(packageName, this.options.registry);
    } catch (error) {
      this.diagnostics.push({
        code: 'REGISTRY_ERROR',
        severity: 'error',
        packageName,
        message: 'Failed to fetch versions for ' + packageName + ': ' + String(error),
      });
      logger.warn(`Failed to fetch versions for ${packageName}: ${String(error)}`);
      return finalizeMappings();
    }

    if (versions.length === 0) {
      this.diagnostics.push({
        code: 'NO_MATCHING_VERSION',
        severity: 'error',
        packageName,
        message: 'No versions available for ' + packageName,
      });
      logger.warn(`No versions found for ${packageName}`);
      return finalizeMappings();
    }

    for (const request of unresolvedRequests) {
      if (!versions.some((version) => satisfies(version, request.requiredRange))) {
        this.diagnostics.push({
          code: 'NO_MATCHING_VERSION',
          severity: 'error',
          packageName,
          requestedBy: request.path,
          message: 'No available version satisfies ' + packageName + '@' + request.requiredRange,
        });
      }
    }

    // 仅对未匹配请求按范围兼容性分组
    const rangeGroups = this.groupRangesByCompatibility(unresolvedRequests, versions);
    logger.info(`Creating alias for "${packageName}": ${rangeGroups.length} version groups`);

    // 为每组规划别名映射，待所有版本确定后再统一构建作用域（以便跨版本别名剪枝）
    for (let i = 0; i < rangeGroups.length; i++) {
      const group = rangeGroups[i];
      if (!group || group.length === 0) continue;

      const groupRanges = [...new Set(group.map((r) => r.requiredRange))];

      logger.debug(`  Group ${i + 1}: ${groupRanges.join(', ')}`);

      const planned = this.planAliasMappingForGroup(
        packageName,
        group,
        groupRanges,
        versions,
        existingAliasNames,
        usedAliasNames,
      );

      if (planned) {
        plannedGroups.push(planned);
        // 记录已使用的别名名称
        usedAliasNames.add(planned.aliasName);
      }
    }

    return finalizeMappings();
  }

  /**
   * 按范围兼容性分组
   * 有交集的范围放在一组，互斥的分开
   */
  private groupRangesByCompatibility(
    requests: DependencyPath[],
    availableVersions: string[],
  ): DependencyPath[][] {
    // One semver scan per distinct range, scoped to this version universe.
    // Indices preserve duplicate-version counts and the original tie order.
    const candidates = new Map<string, Set<number>>();
    for (const request of requests) {
      if (candidates.has(request.requiredRange)) continue;
      const matching = new Set<number>();
      availableVersions.forEach((version, index) => {
        if (satisfies(version, request.requiredRange)) matching.add(index);
      });
      candidates.set(request.requiredRange, matching);
    }
    const ordered = requests
      .map((request, index) => ({
        request,
        index,
        matching: candidates.get(request.requiredRange)!,
      }))
      .sort((a, b) => a.matching.size - b.matching.size || a.index - b.index);
    const groups: Array<{ requests: DependencyPath[]; matching: Set<number> }> = [];
    for (const { request, matching } of ordered) {
      if (matching.size === 0) continue;
      let added = false;
      for (const group of groups) {
        const common =
          group.matching === matching
            ? matching
            : new Set([...group.matching].filter((index) => matching.has(index)));
        if (common.size > 0) {
          group.matching = common;
          group.requests.push(request);
          added = true;
          break;
        }
      }
      if (!added) groups.push({ requests: [request], matching });
    }
    return groups.map((group) => group.requests);
  }

  /**
   * 为一个兼容组规划别名名称与目标版本
   */
  private planAliasMappingForGroup(
    packageName: string,
    group: DependencyPath[],
    groupRanges: string[],
    versions: string[],
    existingAliasNames: Set<string>,
    usedAliasNames: Set<string>,
  ): {
    aliasName: string;
    version: string;
    installSpec: string;
    requests: DependencyPath[];
  } | null {
    // 1. 先检查是否有现有别名可复用（包括 workspace 级别）
    const existingAlias = this.findExistingAliasForRanges(packageName, groupRanges, usedAliasNames);

    if (existingAlias) {
      logger.info(
        `    Reusing ${existingAlias.scope} alias: ${existingAlias.name}@${existingAlias.version}`,
      );

      return {
        aliasName: existingAlias.name,
        version: existingAlias.version,
        installSpec: '', // 不需要安装
        requests: group,
      };
    }

    // 2. 找到满足该组所有范围的最佳版本
    const bestVersion = findBestVersion(versions, groupRanges);

    if (!bestVersion) {
      logger.warn(
        `    No version satisfies all ranges [${groupRanges.join(', ')}] for ${packageName}`,
      );
      return null;
    }

    // 3. 生成新的别名名称
    const combinedExisting = new Set([
      ...existingAliasNames,
      ...usedAliasNames,
      ...this.getReservedDependencyNames(),
    ]);
    const aliasName = this.generateUniqueAliasName(packageName, bestVersion, combinedExisting);
    const installSpec = createAliasInstallSpec(aliasName, packageName, bestVersion);

    logger.info(`    New alias: ${aliasName}@${bestVersion}`);

    return {
      aliasName,
      version: bestVersion,
      installSpec,
      requests: group,
    };
  }

  /**
   * 构建 AliasMapping 对象
   */
  private buildAliasMapping(
    packageName: string,
    aliasName: string,
    version: string,
    installSpec: string,
    group: DependencyPath[],
    allConflictPackageNames: string[],
    pruneIncompatibleBranch?: PruneIncompatibleBranch,
  ): AliasMapping {
    // usedBy 包含声明 peerDependency 的包路径
    const usedBy = group.map((r) => r.path.join('>'));
    const workspaceEntryNames = this.dependencyGraph
      ? collectWorkspaceEntryNames(this.dependencyGraph, group)
      : [];

    const rootIds = group.flatMap(({ packagePath }) => (packagePath ? [packagePath] : []));
    const target = {
      packageName,
      aliasVersion: version,
    };
    const graphResult = this.collectGraphRelatedPackageInstances(
      rootIds,
      allConflictPackageNames,
      target,
      pruneIncompatibleBranch,
    );
    if (graphResult?.inheritedMismatches.length) {
      const paths = this.inheritedMismatches.get(packageName) ?? new Set<string>();
      for (const path of graphResult.inheritedMismatches) paths.add(path);
      this.inheritedMismatches.set(packageName, paths);
    }
    const graphInstances = graphResult?.collected ?? null;
    const allDependents = graphInstances
      ? [...new Set(graphInstances.map((instance) => instance.name))]
      : this.collectAllRelatedPackages(
          group.flatMap(({ path }) => (path[0] ? [path[0]] : [])),
          allConflictPackageNames,
          target,
        );
    const importerPaths =
      graphInstances && graphInstances.length > 0
        ? [...new Set(graphInstances.map((instance) => instance.path))]
        : undefined;
    const importerPathSet = new Set(importerPaths ?? []);
    const excludedImporterPaths = graphResult
      ? [...new Set(graphResult.excludedPaths)].filter((path) => !importerPathSet.has(path))
      : [];

    return {
      originalName: packageName,
      aliasName,
      installSpec,
      resolvedVersion: version,
      usedBy,
      ...(workspaceEntryNames.length > 0 ? { workspaceEntryNames } : {}),
      allDependents,
      ...(importerPaths ? { importerPaths } : {}),
      ...(excludedImporterPaths.length > 0 ? { excludedImporterPaths } : {}),
    };
  }

  private createScopedProviderLookup(
    packageName: string,
    mappings: AliasMapping[],
  ): PruneIncompatibleBranch {
    const scopes = new Map(
      mappings.map((mapping) => [
        mapping.aliasName,
        {
          version: mapping.resolvedVersion,
          paths: new Set(mapping.importerPaths),
        },
      ]),
    );
    const coveredPaths = new Set(mappings.flatMap((mapping) => mapping.importerPaths ?? []));
    let resolver: AliasManager | undefined;
    return (path, requirements) => {
      if (!coveredPaths.has(path)) return false;
      if (!resolver) {
        resolver = new AliasManager({ ...this.options, strict: false });
        resolver.initFromAnalysisResult({
          aliasMappings: mappings,
          peerConflicts: [],
          analyzedDependencies: new Map(),
          missingFirstLevelPeers: [],
        });
      }
      const { resolved } = resolver.explainResolution(
        packageName,
        join(path, '__peer_context__.js'),
      );
      const scope = resolved ? scopes.get(resolved) : undefined;
      return Boolean(
        scope?.paths.has(path) &&
        requirements.every(
          (requirement) =>
            !this.isRequirementIncompatibleWithAlias(requirement, {
              packageName,
              aliasVersion: scope.version,
            }),
        ),
      );
    };
  }

  /**
   * 收集所有已安装的现有别名，不按请求版本范围过滤。
   * 用于在范围筛选前识别同名 alias 的多路径/多版本歧义。
   */
  private findInstalledAliasMatches(packageName: string): ExistingAliasMatch[] {
    const matches: ExistingAliasMatch[] = [];

    const npmAliases = this.existingAliasesMap.get(packageName) ?? [];
    for (const alias of npmAliases) {
      alias.installedVersion ??= this.getAliasInstalledVersion(alias.aliasName);
      if (!alias.installedVersion) continue;

      const installedAlias = this.installedPackageCache.get(alias.aliasName);
      if (installedAlias?.realName !== packageName) continue;

      matches.push({
        name: alias.aliasName,
        version: alias.installedVersion,
        installedPath: installedAlias?.path,
        scope: 'local',
      });
    }

    const workspaceAliases = this.findWorkspaceAliasesForPackage(packageName);
    const workspaceRoot = this.workspaceDetector.getWorkspaceRoot();

    for (const wsAlias of workspaceAliases) {
      let installedVersion: string | null = null;
      let installedPath: string | undefined;

      if (workspaceRoot) {
        const { packagePath, pkgJson } = this.resolvePackageJson(wsAlias.aliasName, workspaceRoot);
        if (packagePath) {
          if (pkgJson?.name !== packageName) continue;
          installedVersion = pkgJson?.version ?? null;
          installedPath = packagePath;
        }
      }

      if (!installedVersion) {
        installedVersion = this.getAliasInstalledVersion(wsAlias.aliasName);
        if (installedVersion) {
          const installedAlias = this.installedPackageCache.get(wsAlias.aliasName);
          installedPath = installedAlias?.path;
          if (installedAlias?.realName !== packageName) continue;
        }
      }

      if (installedVersion) {
        matches.push({
          name: wsAlias.aliasName,
          version: installedVersion,
          isWorkspaceAlias: true,
          installedPath,
          scope: 'workspace',
        });
      }
    }

    return matches;
  }

  /**
   * 查找满足指定范围的现有别名（排除已使用的）
   * 优先查找当前项目的别名，然后查找 workspace 级别的别名
   */
  private findExistingAliasForRanges(
    packageName: string,
    ranges: string[],
    excludeAliases: Set<string>,
  ): ExistingAliasMatch | null {
    logger.debug(
      `  Searching for existing alias for ${packageName} satisfying ranges: [${ranges.join(', ')}]`,
    );

    // 1. 先查找当前项目 package.json 中的别名
    const npmAliases = this.existingAliasesMap.get(packageName);

    if (npmAliases && npmAliases.length > 0) {
      logger.debug(`  Checking ${npmAliases.length} local alias(es)...`);
      for (const alias of npmAliases) {
        // 跳过已使用的别名
        if (excludeAliases.has(alias.aliasName)) {
          logger.debug(`    Skip ${alias.aliasName}: already used`);
          continue;
        }

        // 获取或更新已安装版本
        alias.installedVersion ??= this.getAliasInstalledVersion(alias.aliasName);

        if (!alias.installedVersion) {
          logger.debug(`    Skip ${alias.aliasName}: not installed`);
          continue;
        }

        const installedAlias = this.installedPackageCache.get(alias.aliasName);
        if (installedAlias?.realName !== packageName) {
          logger.debug(
            `    Skip ${alias.aliasName}: installed package name ${installedAlias?.realName ?? 'unknown'} does not match ${packageName}`,
          );
          continue;
        }

        // 检查版本是否满足所有范围
        const allSatisfied = ranges.every((range) => satisfies(alias.installedVersion!, range));

        if (allSatisfied) {
          logger.debug(`    Matched local alias: ${alias.aliasName}@${alias.installedVersion}`);
          return {
            name: alias.aliasName,
            version: alias.installedVersion,
            installedPath: installedAlias?.path,
            scope: 'local',
          };
        } else {
          logger.debug(
            `    Skip ${alias.aliasName}@${alias.installedVersion}: version doesn't satisfy all ranges`,
          );
        }
      }
    }

    // 2. 查找 workspace 级别的别名
    const workspaceAliases = this.findWorkspaceAliasesForPackage(packageName);

    if (workspaceAliases.length > 0) {
      logger.debug(`  Checking ${workspaceAliases.length} workspace alias(es)...`);
    }

    for (const wsAlias of workspaceAliases) {
      // 跳过已使用的别名
      if (excludeAliases.has(wsAlias.aliasName)) {
        logger.debug(`    Skip ${wsAlias.aliasName}: already used`);
        continue;
      }

      // Workspace declarations supply candidate names. Verify the installation
      // visible from the same host origin used by runtime alias resolution.
      const { packagePath, pkgJson } = this.resolvePackageJson(
        wsAlias.aliasName,
        this.options.projectRoot,
      );
      if (!packagePath || pkgJson?.name !== packageName || !pkgJson.version) continue;
      const installedVersion = pkgJson.version;
      if (ranges.every((range) => satisfies(installedVersion, range))) {
        logger.debug(`    Matched workspace alias: ${wsAlias.aliasName}@${installedVersion}`);
        return {
          name: wsAlias.aliasName,
          version: installedVersion,
          isWorkspaceAlias: true,
          installedPath: packagePath,
          scope: 'workspace',
        };
      }
    }

    logger.debug(`  No existing alias found for ${packageName}`);
    return null;
  }

  /**
   * 查找 workspace 级别的别名（带缓存）
   */
  private findWorkspaceAliasesForPackage(packageName: string): WorkspaceAliasInfo[] {
    // 检查缓存
    if (this.workspaceAliasesCache.has(packageName)) {
      return this.workspaceAliasesCache.get(packageName)!;
    }

    // 从 workspace 检测器获取别名
    const aliases = this.workspaceDetector.findWorkspaceAliases(packageName);
    this.workspaceAliasesCache.set(packageName, aliases);

    return aliases;
  }

  /**
   * 生成唯一的别名名称，避免与已存在的别名冲突
   */
  private generateUniqueAliasName(
    packageName: string,
    version: string,
    existingNames: Set<string>,
  ): string {
    const baseName = `${this.options.aliasPrefix}${generateAliasName(packageName, version)}`;

    // 如果基础名称不冲突，直接使用
    if (!existingNames.has(baseName)) {
      return baseName;
    }

    // 否则添加后缀直到找到唯一名称
    // 使用更完整的版本号作为后缀
    const versionSuffix = version.replace(/\./g, '-');
    const nameWithVersion = `${this.options.aliasPrefix}${packageName.replace(/^@/, '').replace(/\//g, '-')}-${versionSuffix}`;

    if (!existingNames.has(nameWithVersion)) {
      return nameWithVersion;
    }

    // 最后尝试数字后缀
    let counter = 2;
    while (existingNames.has(`${baseName}-${counter}`)) {
      counter++;
    }

    return `${baseName}-${counter}`;
  }

  /**
   * 获取包的所有已存在的别名名称（不管版本是否符合）
   * 用于生成新别名时避免命名冲突
   *
   * 包含当前项目和 workspace 级别的别名
   */
  private getExistingAliasNames(packageName: string): Set<string> {
    const names = new Set<string>();

    // 1. 从当前项目 package.json 的 npm: 协议解析的别名中获取
    const npmAliases = this.existingAliasesMap.get(packageName);
    if (npmAliases) {
      for (const alias of npmAliases) {
        names.add(alias.aliasName);
      }
    }

    // 2. 从 workspace 级别获取别名名称
    const workspaceAliases = this.findWorkspaceAliasesForPackage(packageName);
    for (const wsAlias of workspaceAliases) {
      names.add(wsAlias.aliasName);
    }

    return names;
  }

  /**
   * Return every dependency key that the host or its workspace root owns.
   *
   * Generated aliases share the package namespace with ordinary dependency
   * keys. Keeping the complete set here prevents a generated alias from
   * silently replacing an unrelated dependency declared by the user.
   */
  private getReservedDependencyNames(): Set<string> {
    this.ensureWorkspaceRootDeclaredDepsLoaded();

    return new Set([
      ...Object.keys(this.rawDeclaredDeps),
      ...Object.keys(this.declaredDeps),
      ...Object.keys(this.workspaceRootDeclaredDeps),
    ]);
  }

  private findGraphChildNode(
    parent: InstalledPackageNode,
    dependencyName: string,
  ): InstalledPackageNode | null {
    if (!this.dependencyGraph) return null;

    const childId = parent.resolvedChildren.get(dependencyName);
    return childId ? (this.dependencyGraph.nodes.get(childId) ?? null) : null;
  }

  private isRequirementIncompatibleWithAlias(
    requirement: DependencyRequirement,
    target: AliasScopeTarget,
  ): boolean {
    if (requirement.name !== target.packageName) return true;
    const { range } = requirement;
    const aliasCompatible = isValidVersion(target.aliasVersion)
      ? satisfies(target.aliasVersion, range)
      : rangesIntersect(target.aliasVersion, range);
    return !aliasCompatible && isValidRange(range);
  }

  private isDescendantIncompatibleWithAlias(
    manifest: PackageJson,
    target: AliasScopeTarget | undefined,
    name: string,
    packagePath?: string,
  ): boolean {
    if (!target) return false;
    const peers = getEffectivePeerDependencies(manifest, name, this.options.peerOverrides);
    const requirement = getDependencyRequirement(
      manifest,
      target.packageName,
      peers.get(target.packageName),
      this.workspaceDetector,
    );
    if (!requirement) return false;
    if (requirement.name !== target.packageName) return true;
    if (!packagePath) return false;
    const { pkgJson: natural } = this.resolvePackageJson(target.packageName, packagePath);
    if (natural?.name && natural.name !== target.packageName) return true;
    return Boolean(
      natural?.version &&
      this.isRequirementIncompatibleWithAlias(requirement, target) &&
      satisfies(natural.version, requirement.range),
    );
  }

  /**
   * 收集图中指定根实例的所有后代实例，同时记录被剪枝节点的物理路径，
   * 以便在嵌套 node_modules 布局下阻止祖先规则向被剪枝目录穿透。
   * 返回 null 表示当前分析没有对应的图根，调用方可回退到名称遍历。
   */
  private collectGraphRelatedPackageInstances(
    rootIds: string[],
    excludePackages: string[] = [],
    target?: AliasScopeTarget,
    pruneIncompatibleBranch?: PruneIncompatibleBranch,
  ): {
    collected: Array<{ name: string; path: string }>;
    excludedPaths: string[];
    inheritedMismatches: string[];
  } | null {
    if (!this.dependencyGraph || rootIds.length === 0) return null;

    const excludeSet = new Set(excludePackages);
    const rootSet = new Set(rootIds);
    const visited = new Set<string>();
    const collected: Array<{ name: string; path: string }> = [];
    const excludedPaths: string[] = [];
    const inheritedMismatches: string[] = [];
    const stack = [...rootSet];

    while (stack.length > 0) {
      const nodeId = stack.pop();
      if (!nodeId || visited.has(nodeId)) continue;
      visited.add(nodeId);

      const node = this.dependencyGraph.nodes.get(nodeId);
      if (!node) continue;

      const isExcludedConflictPackage = excludeSet.has(node.name);
      if (!rootSet.has(node.id) && target) {
        const requirements = getInstalledDependencyRequirements(
          node,
          target.packageName,
          this.workspaceDetector,
        );
        const natural = this.findGraphChildNode(node, target.packageName)?.manifest;
        const differentTarget =
          Boolean(natural?.name && natural.name !== target.packageName) ||
          requirements.some(({ name }) => name !== target.packageName);
        if (requirements.length > 0 && differentTarget) {
          excludedPaths.push(node.packagePath);
          continue;
        }
        if (
          requirements.some((requirement) =>
            this.isRequirementIncompatibleWithAlias(requirement, target),
          )
        ) {
          const version = natural?.version;
          const compatibleNative =
            version &&
            requirements.every(({ range }) => !isValidRange(range) || satisfies(version, range));
          if (compatibleNative || pruneIncompatibleBranch?.(node.packagePath, requirements)) {
            excludedPaths.push(node.packagePath);
            continue;
          }
          // Preserve inheritance when the manifest cannot be satisfied by any
          // provider in this scope. An unrelated alias must not change it.
          inheritedMismatches.push(node.packagePath);
        }
      }

      if (isExcludedConflictPackage) continue;

      collected.push({ name: node.name, path: node.packagePath });
      for (const childId of node.resolvedChildren.values()) {
        if (!visited.has(childId)) stack.push(childId);
      }
    }

    return { collected, excludedPaths, inheritedMismatches };
  }

  /**
   * 递归收集指定包的所有子依赖（dependencies + peerDependencies）
   *
   * 用于构建 allDependents 列表，这些包引用冲突依赖时都需要做重定向解析
   *
   * 逻辑说明：
   * - 冲突检测：只检测第一层依赖的 peerDependencies 与主工程的冲突
   * - 重定向范围：声明冲突 peerDep 的包及其所有子依赖都需要重定向
   *   因为这些子依赖内部引用冲突包时，也需要解析到别名版本
   * - 遇到冲突包（excludeTraversal）时，不加入 collected 也不遍历其子树，
   *   因为 analyzedDependencies 中存储的是主项目安装的版本（而非冲突库实际需要的版本），
   *   遍历它们会引入无关包（如 vue-router@5 的 peerDep pinia）
   *
   * 性能优化：优先从 analyzedDependencies 内存数据中读取，避免重复磁盘 I/O
   */
  private collectAllSubDependenciesRecursive(
    packageName: string,
    visited: Set<string>,
    collected: Set<string>,
    baseDir: string,
    excludeTraversal?: Set<string>,
    target?: AliasScopeTarget,
    rootPackages?: Set<string>,
  ): void {
    const stack: Array<{ name: string; baseDir: string }> = [{ name: packageName, baseDir }];

    while (stack.length > 0) {
      const item = stack.pop();
      if (!item) break;

      const name = item.name;
      const currentBaseDir = item.baseDir;

      if (excludeTraversal?.has(name)) {
        continue;
      }

      // 优先从已分析的内存数据中读取依赖信息，避免重复 resolvePackageJson 磁盘 I/O
      const analyzed = this.analyzedDependencies.get(name);
      if (analyzed) {
        if (visited.has(name)) {
          continue;
        }
        visited.add(name);

        if (
          !rootPackages?.has(name) &&
          this.isDescendantIncompatibleWithAlias(analyzed, target, name)
        ) {
          continue;
        }

        collected.add(name);

        for (const depName of Object.keys(analyzed.dependencies)) {
          stack.push({ name: depName, baseDir: currentBaseDir });
        }
        for (const peerName of getEffectivePeerDependencies(
          analyzed,
          name,
          this.options.peerOverrides,
        ).keys()) {
          stack.push({ name: peerName, baseDir: currentBaseDir });
        }
        continue;
      }

      // 内存中没有：回退到磁盘查找
      const { packagePath, pkgJson } = this.resolvePackageJson(name, currentBaseDir);
      if (!packagePath) {
        logger.debug(
          `Package not found for dependency collection: ${name} (from ${currentBaseDir})`,
        );
        collected.add(name);
        continue;
      }

      if (visited.has(packagePath)) {
        continue;
      }
      visited.add(packagePath);

      if (!pkgJson) {
        collected.add(name);
        continue;
      }

      if (
        !rootPackages?.has(name) &&
        this.isDescendantIncompatibleWithAlias(pkgJson, target, name, packagePath)
      ) {
        continue;
      }

      collected.add(name);

      const deps = { ...pkgJson.dependencies, ...pkgJson.optionalDependencies };

      for (const depName of Object.keys(deps)) {
        stack.push({ name: depName, baseDir: packagePath });
      }
      for (const peerName of getEffectivePeerDependencies(
        pkgJson,
        name,
        this.options.peerOverrides,
      ).keys()) {
        stack.push({ name: peerName, baseDir: packagePath });
      }
    }
  }

  /**
   * 收集多个包的所有子依赖（用于 allDependents）
   * 包括 dependencies 和 peerDependencies 递归下去的所有包
   */
  private collectAllRelatedPackages(
    packageNames: string[],
    excludePackages: string[] = [],
    target?: AliasScopeTarget,
  ): string[] {
    const cacheKey = JSON.stringify([
      packageNames.slice().sort(),
      excludePackages.slice().sort(),
      target ?? null,
    ]);
    const cached = this.collectCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const collected = new Set<string>();
    const visited = new Set<string>();
    const excludeSet = new Set(excludePackages);
    const rootSet = new Set(packageNames);

    for (const pkgName of packageNames) {
      this.collectAllSubDependenciesRecursive(
        pkgName,
        visited,
        collected,
        this.options.projectRoot,
        excludeSet,
        target,
        rootSet,
      );
    }

    // 防御性兜底：即使 excludeTraversal 已在递归中阻止冲突包进入 collected，
    // 仍在此处做最终清理，避免未来重构时意外引入错误重定向
    for (const excludePkg of excludeSet) {
      collected.delete(excludePkg);
    }

    const result = Array.from(collected);
    this.collectCache.set(cacheKey, result);
    return result;
  }
}

/**
 * 创建依赖分析器实例
 */
export function createDependencyAnalyzer(
  options: ResolvedOptions,
  preparedAliases: readonly AliasMapping[] = [],
): DependencyAnalyzer {
  const mainPackageJson = readPackageJsonCached(options.projectRoot);
  if (!mainPackageJson) {
    throw new Error(`Could not read package.json at ${options.projectRoot}`);
  }

  // Package managers may be configured not to save dependencies. Keep aliases
  // verified by this preparation available to the fresh analysis, while still
  // checking their actual installed identity and honoring real declarations.
  const declared = {
    ...mainPackageJson.dependencies,
    ...mainPackageJson.devDependencies,
    ...mainPackageJson.optionalDependencies,
  };
  const additional = Object.fromEntries(
    preparedAliases
      .filter((mapping) => !Object.hasOwn(declared, mapping.aliasName))
      .map((mapping) => [
        mapping.aliasName,
        'npm:' + mapping.originalName + '@' + mapping.resolvedVersion,
      ]),
  );
  return new DependencyAnalyzer(options, {
    ...mainPackageJson,
    devDependencies: { ...additional, ...mainPackageJson.devDependencies },
  });
}
