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
import type { PreparationMetrics } from '../utils/preparation-metrics';
import { createWorkspaceDetector, WorkspaceDetector } from './workspace-detector';
import {
  compare,
  satisfies,
  isValidRange,
  isValidVersion,
  rangesIntersect,
  findIntersection,
  findBestVersion,
  generateAliasName,
  createAliasInstallSpec,
} from '../utils/semver';
import {
  getRuntimeDependencySpec,
  matchesProvider,
  parseNpmAlias,
  resolveDependencyRequirement,
  type DependencyRequirement,
} from '../utils/version-spec';
import {
  findInvalidPeerOverrideKeys,
  getEffectivePeerDependencies,
  type EffectivePeerEntry,
} from '../utils/peer-overrides';
import { NpmRegistryClient, type RegistryClient } from './registry-client';
import {
  buildInstalledDependencyGraph,
  collectWorkspaceEntryNames,
  getInstalledDependencyRequirements,
  type InstalledDependencyGraph,
  type InstalledPackageNode,
} from './dependency-graph';

import {
  createConsumerPeerLookup,
  peerConsumerDirectory,
  planAliasPeerLinks,
  samePeerConsumer,
  type AliasPeerLinks,
  type ConsumerPeerLookup,
  type PlannedAlias,
} from './alias-peer-resolver';
import { validateSharedPeerContexts } from './shared-peer-contexts';
import { validateInstalledPeerProviders } from './installed-peer-providers';
import { createDirectoryScopeMatcher } from './scope-paths';

const logger = createLogger('dependency-analyzer');
const MAX_PEER_PLAN_ATTEMPTS = 64;
const MAX_PEER_REGISTRY_LOOKUPS = 8;

function peerPlanKey(plans: PlannedAlias[]): string {
  return JSON.stringify(plans.map(({ mapping }) => [mapping.aliasName, mapping.resolvedVersion]));
}

/**
 * 已存在的别名信息（从 package.json 的 npm: 协议解析得到）
 */

interface ExistingAliasMatch {
  name: string;
  version: string;
  isWorkspaceAlias?: boolean;
  /** 已安装 alias 的实际包目录；同名 alias 可能来自不同 scope */
  installedPath?: string;
  /** 无法取得路径时保留声明来源，避免 local/workspace alias 被错误合并 */
  scope: 'local' | 'workspace';
}

interface AliasInventory {
  observed: ExistingAliasMatch[];
  visible: ExistingAliasMatch[];
}

interface ReusedAliasGroup {
  alias: ExistingAliasMatch;
  requests: DependencyPath[];
}

interface AliasGroup {
  aliasName: string;
  version: string;
  installSpec: string;
  requests: readonly DependencyPath[];
}

type PeerRedirects = (peerName: string) => readonly AliasMapping[];

type PeerCompatibility = 'compatible' | 'unresolved' | 'consumer-mismatch';

interface PlannedPeerRequests {
  all: readonly DependencyPath[];
  redirected: readonly DependencyPath[];
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
  /**
   * 已存在的别名映射：真实包名 -> 别名信息列表
   * 从 package.json 的 npm:package@version 格式解析得到
   * 这是最准确的别名识别方式
   */
  private existingAliasesMap: Map<string, string[]> = new Map();
  private aliasInventory = new Map<string, AliasInventory>();
  /** Workspace 检测器（用于 catalog 协议解析和 workspace 别名查找） */
  private workspaceDetector: WorkspaceDetector;
  /** Workspace 级别的别名缓存 */
  private workspaceAliasesCache: Map<string, WorkspaceAliasInfo[]> = new Map();
  /** workspace 根目录 package.json 声明的依赖（dependencies/devDependencies），用于“声明判断”合并 */
  private workspaceRootDeclaredDeps: Record<string, string> = {};
  /** 是否已加载 workspaceRootDeclaredDeps */
  private workspaceRootDeclaredLoaded = false;
  /** 当前 analyze 使用的按安装路径区分的依赖图 */
  private dependencyGraph: InstalledDependencyGraph | null = null;
  private readonly inheritedMismatchesByAlias = new Map<string, readonly string[]>();
  private readonly peerAliasRequests = new Map<string, PlannedPeerRequests>();
  /** 注册表访问适配器（可注入以支持离线分析和确定性测试） */
  private registryClient: RegistryClient;
  private diagnostics: ResolverDiagnostic[] = [];
  private watchFiles = new Set<string>();

  constructor(
    options: ResolvedOptions,
    mainPackageJson: PackageJson,
    /** 可选：注册表访问适配器（主要用于离线分析和测试） */
    registryClient: RegistryClient = new NpmRegistryClient(undefined, options),
  ) {
    this.options = options;
    this.registryClient = registryClient;
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

        const existing = this.existingAliasesMap.get(targetPackage) ?? [];
        existing.push(aliasName);
        this.existingAliasesMap.set(targetPackage, existing);

        logger.debug(`Found npm alias: ${aliasName} -> ${targetPackage}@${version}`);
      }
    }

    if (this.existingAliasesMap.size > 0) {
      logger.debug(`Found ${this.existingAliasesMap.size} npm: protocol aliases`);
    }
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
  async analyze(options?: {
    clearCache?: boolean;
    metrics?: PreparationMetrics;
  }): Promise<AnalysisResult> {
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
      const buildGraph = () =>
        buildInstalledDependencyGraph(
          this.options.dependencies,
          this.options.projectRoot,
          workspaceRoot,
          this.watchFiles,
          this.options.peerOverrides,
        );
      this.dependencyGraph = options?.metrics
        ? options.metrics.measure('graph', buildGraph)
        : buildGraph();
      this.populateAnalyzedDependenciesFromGraph();
      for (const depName of this.options.dependencies) {
        if (!this.dependencyGraph.rootRequests.has(depName)) {
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
      validateInstalledPeerProviders(
        this.dependencyGraph,
        peerConflicts,
        aliasMappings,
        this.options,
        this.workspaceDetector,
        this.diagnostics,
      );
      validateSharedPeerContexts(
        this.dependencyGraph,
        aliasMappings,
        this.options,
        this.diagnostics,
        this.watchFiles,
        this.workspaceDetector,
        this.inheritedMismatchesByAlias,
      );

      const conflictsNeedingAlias = peerConflicts.filter((c) => c.needsAlias).length;
      logger.info(
        `Analysis complete. Found ${conflictsNeedingAlias} first-level peer conflicts needing alias, ` +
          `${missingFirstLevelPeers.length} missing peers (not auto-installing). ` +
          `Analyzed ${this.analyzedDependencies.size} packages, visited ${this.dependencyGraph.nodes.size} packages total.`,
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
      // The caller may reuse filesystem lookups while publishing alias rules.
      if (options?.clearCache !== false) clearPackageJsonCache();

      // 清理仅在分析期间使用的内部状态，允许 GC 回收
      // 注意：不能清理 analyzedDependencies，它被返回值直接引用
      this.existingAliasesMap.clear();
      this.aliasInventory.clear();
      this.workspaceAliasesCache.clear();
      this.workspaceRootDeclaredDeps = {};
      this.rawDeclaredDeps = {};
      this.declaredDeps = {};
      this.inheritedMismatchesByAlias.clear();
      this.peerAliasRequests.clear();
      this.dependencyGraph = null;
    }
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
    const graph = this.dependencyGraph!;
    const projectRoot = this.options.projectRoot;
    const hostName = readPackageJsonCached(projectRoot)?.name;

    const rootVisibleNodeIds = new Map<string, string | undefined>();
    for (const { name } of graph.nodes.values()) {
      if (rootVisibleNodeIds.has(name)) continue;
      const direct = join(projectRoot, 'node_modules', name);
      // The graph already proved directly installed physical paths. Self
      // references and alternative layouts still use Node's lookup order.
      if (!process.versions.pnp && name !== hostName && graph.nodes.has(direct)) {
        rootVisibleNodeIds.set(name, direct);
        continue;
      }
      const path = findPackagePath(name, projectRoot);
      const node = path ? graph.nodes.get(canonicalPath(path)) : undefined;
      rootVisibleNodeIds.set(name, node?.id);
    }

    const orderedNodes: InstalledPackageNode[] = [];
    const selectedNodeIds = new Set<string>();
    for (const nodeId of rootVisibleNodeIds.values()) {
      if (!nodeId) continue;
      const node = graph.nodes.get(nodeId);
      if (node && !selectedNodeIds.has(node.id)) {
        selectedNodeIds.add(node.id);
        orderedNodes.push(node);
      }
    }
    for (const node of graph.nodes.values()) {
      if (!selectedNodeIds.has(node.id)) {
        orderedNodes.push(node);
      }
    }

    for (const node of orderedNodes) {
      if (this.analyzedDependencies.has(node.name)) continue;

      const packageJson = node.manifest;

      this.analyzedDependencies.set(node.name, {
        name: node.name,
        version: node.version,
        dependencyPath: this.getDependencyPathForGraphNode(node),
        dependencies: { ...packageJson.dependencies, ...packageJson.optionalDependencies },
        peerDependencies: packageJson.peerDependencies ?? {},
        peerDependenciesMeta: packageJson.peerDependenciesMeta,
      });
    }

    for (const name of graph.rootRequests.keys()) {
      const node = this.findGraphRoot(name);
      if (!node || node.name === name) continue;
      const packageJson = node.manifest;
      this.analyzedDependencies.set(name, {
        name,
        version: node.version,
        dependencyPath: [],
        dependencies: { ...packageJson.dependencies, ...packageJson.optionalDependencies },
        peerDependencies: packageJson.peerDependencies ?? {},
        peerDependenciesMeta: packageJson.peerDependenciesMeta,
      });
    }
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

    for (const [name, instances] of this.dependencyGraph!.rootRequests) {
      for (const [packagePath, requests] of instances) {
        const peers =
          this.dependencyGraph!.nodes.get(packagePath)?.peerDependenciesByName.get(name);
        if (!peers) continue;
        for (const { path } of requests) collectPeers(peers, path, packagePath);
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

      let conflictingRanges: DependencyPath[] = [];
      const undeclaredRequests: DependencyPath[] = [];

      for (const request of requestedBy) {
        const { range: resolvedRange } = resolveDependencyRequirement(
          packageName,
          request.requiredRange,
          this.workspaceDetector,
        );

        if (mainVersion && satisfies(mainVersion, resolvedRange)) continue;
        if (!isDeclared && this.isSatisfiedByOwningWorkspace(packageName, request, resolvedRange))
          continue;
        conflictingRanges.push({ ...request, requiredRange: resolvedRange });
        if (!isDeclared) undeclaredRequests.push(request);
      }
      if (mainVersion && conflictingRanges.length > 0) {
        conflictingRanges = this.excludeClosedPeerContexts(packageName, conflictingRanges);
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

  private excludeClosedPeerContexts(
    packageName: string,
    conflicts: DependencyPath[],
  ): DependencyPath[] {
    const graph = this.dependencyGraph;
    // Explicit scopes still need an alias. They can include consumers outside
    // the entry's installed subtree or override the natural provider.
    if (
      !graph ||
      this.options.includeRedirects[packageName]?.length ||
      this.options.excludeRedirects[packageName]?.length
    )
      return conflicts;

    const providersByRange = new Map<string, string | null>();
    for (const request of conflicts) {
      const { requiredRange } = request;
      const provider = this.getCompatibleInstalledPeerProvider(graph, packageName, request);
      const previous = providersByRange.get(requiredRange);
      providersByRange.set(
        requiredRange,
        previous === undefined || previous === provider ? provider : null,
      );
    }

    // Consumers that could share an alias can keep their native resolution
    // only when they already share the same physical provider.
    const closed = new Set<string>();
    const contexts = [...providersByRange];
    for (const [range, provider] of contexts) {
      if (
        provider &&
        contexts.every(
          ([otherRange, otherProvider]) =>
            provider === otherProvider || !rangesIntersect(range, otherRange),
        )
      )
        closed.add(range);
    }
    return conflicts.filter(({ requiredRange }) => !closed.has(requiredRange));
  }

  private getCompatibleInstalledPeerProvider(
    graph: InstalledDependencyGraph,
    packageName: string,
    request: DependencyPath,
  ): string | null {
    if (!request.packagePath) return null;
    const entry = graph.nodes.get(request.packagePath);
    const provider = entry && this.findGraphChildNode(entry, packageName);
    if (
      !provider ||
      provider.manifest.name !== packageName ||
      !satisfies(provider.version, request.requiredRange)
    )
      return null;

    const scope = this.collectGraphRelatedPackageInstances([entry.id], [packageName], {
      packageName,
      aliasVersion: provider.version,
    });
    if (!scope || scope.inheritedMismatches.length > 0) return null;

    const closed = scope.collected.every(({ path }) => {
      if (path === entry.id) return true;
      const node = graph.nodes.get(path)!;
      const requirements = getInstalledDependencyRequirements(
        node,
        packageName,
        this.workspaceDetector,
      );
      if (requirements.length === 0) {
        // Descendants can import an inherited peer without declaring it.
        const visible = findPackagePath(packageName, node.packagePath);
        return visible !== null && canonicalPath(visible) === provider.id;
      }
      const required = requirements.filter(
        ({ optional, range }) => !optional && isValidRange(range),
      );
      if (required.length === 0) return true;
      const local = this.findGraphChildNode(node, packageName);
      if (
        !local ||
        required.some(
          ({ name, range: requiredRange }) =>
            local.manifest.name !== name || !satisfies(local.version, requiredRange),
        )
      )
        return false;
      const sharesPeer = [...node.peerDependenciesByName.values()].some((peers) => {
        const peer = peers.get(packageName);
        return peer && !peer.optional;
      });
      return !sharesPeer || local.id === provider.id;
    });
    return closed ? provider.id : null;
  }

  /**
   * 获取已安装的包版本（从 node_modules 读取实际版本）
   * 返回 null 表示包未安装
   */
  private getMainProjectVersion(packageName: string): string | null {
    const { pkgJson } = this.resolvePackageJson(packageName, this.options.projectRoot);
    return pkgJson?.version?.length ? pkgJson.version : null;
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
    const plans: PlannedAlias[] = [];
    const usedAliasNames = new Set<string>();
    const versionsByPackage = new Map<string, string[]>();

    // 按包名分组需要别名的冲突
    const aliasNeeded = conflicts.filter((c) => c.needsAlias);

    // 收集所有冲突包的名称
    const allConflictPackageNames = aliasNeeded.map((c) => c.packageName);
    for (const { packageName, conflictingRanges } of aliasNeeded) {
      this.peerAliasRequests.set(packageName, {
        all: conflictingRanges,
        redirected: this.getRedirectedPeerRequests(packageName, conflictingRanges),
      });
    }

    // 对于每个需要别名的包
    for (const conflict of aliasNeeded) {
      const mappings = await this.createAliasMappingsForConflict(
        conflict,
        allConflictPackageNames,
        usedAliasNames,
        versionsByPackage,
      );
      plans.push(...mappings);
    }
    if (plans.length === 0) return [];

    const link = (candidate: PlannedAlias[]) =>
      planAliasPeerLinks(
        candidate,
        this.options,
        this.registryClient,
        createConsumerPeerLookup(candidate, this.options, conflicts),
        this.watchFiles,
      );
    let links = await link(plans);
    let resolved = await this.reselectAliasPlans(
      plans,
      links.consumerMismatches,
      createConsumerPeerLookup(plans, this.options, conflicts),
      versionsByPackage,
      allConflictPackageNames,
      usedAliasNames,
    );
    if (resolved !== plans) links = await link(resolved);
    if (links.conflictingAliases.size > 0) {
      const replacement = await this.searchPeerPlans(
        resolved,
        links,
        versionsByPackage,
        allConflictPackageNames,
        link,
      );
      if (replacement) ({ plans: resolved, links } = replacement);
    }
    for (const { mapping, inheritedMismatches } of resolved) {
      if (inheritedMismatches?.length) {
        this.inheritedMismatchesByAlias.set(mapping.aliasName, inheritedMismatches);
      }
    }
    links.publish();
    this.diagnostics.push(...links.diagnostics);
    return resolved.map(({ mapping }) => mapping);
  }

  private async reselectAliasPlans(
    plans: PlannedAlias[],
    mismatches: ReadonlySet<PlannedAlias>,
    lookupConsumers: ConsumerPeerLookup,
    versionsByPackage: Map<string, string[]>,
    allConflictPackageNames: string[],
    usedAliasNames: Set<string>,
  ): Promise<PlannedAlias[]> {
    if (mismatches.size === 0) return plans;
    const replacements = new Map<PlannedAlias, AliasGroup>();

    // Reconsider only the aliases rejected by the consumer's selected provider.
    // Keep that provider fixed during selection, then verify the complete plan.
    for (const plan of mismatches) {
      const { originalName, aliasName } = plan.mapping;
      const ranges = [...new Set(plan.consumers.map(({ requiredRange }) => requiredRange))];
      const peerRedirects = (peer: string) =>
        lookupConsumers(plan, peer).flatMap(({ redirects }) => redirects);
      const availableNames = new Set(usedAliasNames);
      availableNames.delete(aliasName);
      const declaredNames = this.getExistingAliasNames(originalName);
      const select = (versions: string[]) =>
        this.planAliasMappingForGroup(
          originalName,
          plan.consumers,
          ranges,
          versions,
          declaredNames,
          availableNames,
          peerRedirects,
        );
      let replacement = select(versionsByPackage.get(originalName) ?? []);
      if (
        !replacement &&
        this.options.autoInstall &&
        !this.options.offline &&
        !versionsByPackage.has(originalName)
      ) {
        let versions: string[] = [];
        try {
          versions = await this.registryClient.fetchAllVersions(
            originalName,
            this.options.registry,
          );
        } catch {
          // Preserve the original mismatch when replacement metadata is unavailable.
        }
        versionsByPackage.set(originalName, versions);
        replacement = select(versions);
      }
      if (!replacement) continue;
      usedAliasNames.add(replacement.aliasName);
      replacements.set(plan, replacement);
    }

    return this.rebuildAliasPlans(plans, replacements, allConflictPackageNames);
  }

  private rebuildAliasPlans(
    plans: PlannedAlias[],
    replacements: ReadonlyMap<PlannedAlias, AliasGroup>,
    allConflictPackageNames: string[],
  ): PlannedAlias[] {
    if (replacements.size === 0) return plans;
    const rebuiltPlans = new Map<PlannedAlias, PlannedAlias>();
    const affectedPackages = new Set(
      [...replacements.keys()].map(({ mapping }) => mapping.originalName),
    );
    for (const packageName of affectedPackages) {
      const packagePlans = plans.filter(({ mapping }) => mapping.originalName === packageName);
      const groups = packagePlans.map((plan) => {
        const { aliasName, resolvedVersion, installSpec } = plan.mapping;
        return (
          replacements.get(plan) ?? {
            aliasName,
            version: resolvedVersion,
            installSpec,
            requests: plan.consumers,
          }
        );
      });
      const rebuilt = this.buildAliasPlans(packageName, groups, allConflictPackageNames);
      for (const [index, plan] of packagePlans.entries()) rebuiltPlans.set(plan, rebuilt[index]!);
    }
    return plans.map((plan) => rebuiltPlans.get(plan) ?? plan);
  }

  /** Revisit the consumer and its selected provider when changing just the consumer failed. */
  private async searchPeerPlans(
    start: PlannedAlias[],
    initialLinks: AliasPeerLinks,
    versionsByPackage: Map<string, string[]>,
    allConflictPackageNames: string[],
    link: (plans: PlannedAlias[]) => Promise<AliasPeerLinks>,
  ): Promise<{ plans: PlannedAlias[]; links: AliasPeerLinks } | undefined> {
    const seen = new Set([peerPlanKey(start)]);
    const originalErrors = new Set(
      initialLinks.diagnostics
        .filter(({ severity }) => severity === 'error')
        .map(({ message }) => message),
    );
    type SearchState = { plans: PlannedAlias[]; links: AliasPeerLinks };
    const pending: SearchState[] = [{ plans: start, links: initialLinks }];
    const needsVersions = new Map<string, Set<SearchState>>();
    const unavailableVersions = new Set<string>();
    const uncheckedVersions = new Set<string>();
    const canFetch = this.options.autoInstall && !this.options.offline;
    let registryLookups = 0;
    while (pending.length > 0 || needsVersions.size > 0) {
      const state = pending.shift();
      if (!state) {
        // Exhaust installed and already-fetched candidates before asking for
        // additional versions. Revisit only the states waiting on this peer.
        const [name, waiting] = needsVersions.entries().next().value!;
        needsVersions.delete(name);
        if (registryLookups >= MAX_PEER_REGISTRY_LOOKUPS) {
          this.reportPeerSearchLimit(name, 'registry lookup');
          return undefined;
        }
        registryLookups++;
        let versions: string[] = [];
        try {
          versions = await this.registryClient.fetchAllVersions(name, this.options.registry);
        } catch {
          unavailableVersions.add(name);
        }
        versionsByPackage.set(name, versions);
        if (versions.length > 0) pending.push(...waiting);
        continue;
      }
      const { plans, links } = state;
      const conflicts = plans.filter(({ mapping }) =>
        links.conflictingAliases.has(mapping.aliasName),
      );
      for (const plan of conflicts) {
        const name = plan.mapping.originalName;
        if (!versionsByPackage.has(name)) {
          if (canFetch) {
            const waiting = needsVersions.get(name) ?? new Set<SearchState>();
            waiting.add(state);
            needsVersions.set(name, waiting);
          } else {
            uncheckedVersions.add(name);
          }
        }
        for (const alternative of this.peerPlanAlternatives(plan, plans, versionsByPackage)) {
          const next = this.rebuildAliasPlans(
            plans,
            new Map([[plan, alternative]]),
            allConflictPackageNames,
          );
          const key = peerPlanKey(next);
          if (seen.has(key)) continue;
          if (seen.size > MAX_PEER_PLAN_ATTEMPTS) {
            this.reportPeerSearchLimit(name, 'candidate');
            return undefined;
          }
          seen.add(key);
          const linked = await link(next);
          if (linked.conflictingAliases.size === 0) {
            if (
              !linked.diagnostics.some(
                ({ severity, message }) => severity === 'error' && !originalErrors.has(message),
              )
            ) {
              return { plans: next, links: linked };
            }
          } else {
            pending.push({ plans: next, links: linked });
          }
        }
      }
    }
    for (const packageName of unavailableVersions) {
      this.diagnostics.push({
        code: 'ALIAS_METADATA_UNAVAILABLE',
        severity: 'warning',
        packageName,
        message: 'Could not retrieve alternative peer alias versions for ' + packageName,
      });
    }
    if (uncheckedVersions.size > 0) {
      const packageName = [...uncheckedVersions].sort().join(', ');
      this.diagnostics.push({
        code: 'ALIAS_PEER_CANDIDATES_UNCHECKED',
        severity: 'warning',
        packageName,
        message: 'Alternative registry versions remain unchecked for ' + packageName,
      });
    }
    return undefined;
  }

  private reportPeerSearchLimit(packageName: string, limit: 'candidate' | 'registry lookup'): void {
    this.diagnostics.push({
      code: 'ALIAS_SEARCH_LIMIT',
      severity: 'warning',
      packageName,
      message:
        'Peer alias search reached its ' +
        limit +
        ' limit; narrow the peer ranges with peerOverrides or prepare an explicit provider.',
    });
  }

  private *peerPlanAlternatives(
    plan: PlannedAlias,
    plans: PlannedAlias[],
    versionsByPackage: ReadonlyMap<string, string[]>,
  ): Iterable<AliasGroup> {
    const { originalName, aliasName, resolvedVersion } = plan.mapping;
    const requests = plan.consumers;
    const ranges = [...new Set(requests.map(({ requiredRange }) => requiredRange))];
    const used = new Set(plans.map(({ mapping }) => mapping.aliasName));
    for (const { name, version } of this.getAliasInventory(originalName).visible) {
      if (!used.has(name) && ranges.every((range) => satisfies(version, range))) {
        yield { aliasName: name, version, installSpec: '', requests };
      }
    }
    const versions = versionsByPackage.get(originalName);
    if (!versions || this.options.offline) return;
    if (plan.mapping.installSpec) used.delete(aliasName);
    const reserved = new Set([
      ...used,
      ...this.getExistingAliasNames(originalName),
      ...this.getReservedDependencyNames(),
    ]);
    for (const version of findIntersection(versions, ranges).sort((a, b) => compare(b, a))) {
      if (version === resolvedVersion) continue;
      // An absent manifest would require a new request for each speculative version.
      if (!this.registryClient.getCachedManifest?.(originalName, version, this.options.registry))
        continue;
      const name = this.generateUniqueAliasName(originalName, version, reserved);
      yield {
        aliasName: name,
        version,
        installSpec: createAliasInstallSpec(name, originalName, version),
        requests,
      };
    }
  }

  private getRedirectedPeerRequests(
    packageName: string,
    requests: DependencyPath[],
  ): DependencyPath[] {
    if (!this.options.excludeRedirects[packageName]?.length) return requests;
    // All conflicting roots are potential scopes before their versions have
    // been selected. Only explicit exclusions can rule out a root this early.
    const paths = requests.flatMap(({ packagePath }) => (packagePath ? [packagePath] : []));
    const matchDirectory = createDirectoryScopeMatcher(
      [
        {
          originalName: packageName,
          aliasName: packageName,
          resolvedVersion: '',
          installSpec: '',
          usedBy: [],
          allDependents: requests.flatMap(({ path }) => path.slice(-1)),
          ...(paths.length > 0 && { importerPaths: paths }),
        },
      ],
      this.options,
    );
    return requests.filter((request) => {
      const directory = peerConsumerDirectory(request, this.options.projectRoot);
      return !directory || matchDirectory(packageName, directory).reason !== 'excluded';
    });
  }

  /**
   * 为单个冲突创建别名映射
   */
  private async createAliasMappingsForConflict(
    conflict: PeerConflict,
    allConflictPackageNames: string[],
    usedAliasNames: Set<string>,
    versionsByPackage: Map<string, string[]>,
  ): Promise<PlannedAlias[]> {
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
      for (const name of localAliases) {
        logger.info(`    - ${name}: ${this.rawDeclaredDeps[name]}`);
      }
    }

    // 获取已存在的别名（用于复用和避免命名冲突）
    const existingAliasNames = this.getExistingAliasNames(packageName);
    // Names are reserved across all conflicts in this analysis generation.

    // 先收集所有真实已安装的别名身份，再按范围筛选候选。否则当同名
    // alias 只有一个满足当前范围时，另一条物理路径会被过滤掉，运行时
    // 仍可能按项目根目录解析到错误的包。
    const installedAliasMatches = this.getAliasInventory(packageName).observed;
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

    // All names for one physical importer have to use the same provider.
    const rangesByPath = new Map<string, Set<string>>();
    for (const { packagePath, requiredRange } of conflict.requestedBy) {
      if (!packagePath) continue;
      const ranges = rangesByPath.get(packagePath) ?? new Set<string>();
      ranges.add(
        resolveDependencyRequirement(packageName, requiredRange, this.workspaceDetector).range,
      );
      rangesByPath.set(packagePath, ranges);
    }
    const sharedAliases = new Map<string, ExistingAliasMatch | null>();
    for (const request of conflictingRanges) {
      const { packagePath } = request;
      const ranges = packagePath ? rangesByPath.get(packagePath) : undefined;
      if (packagePath && ranges && ranges.size > 1 && !sharedAliases.has(packagePath)) {
        sharedAliases.set(
          packagePath,
          this.findExistingAliasForRanges(packageName, [...ranges], new Set(), [request]),
        );
      }
      const existingAlias =
        (packagePath ? sharedAliases.get(packagePath) : undefined) ??
        this.findExistingAliasForRanges(packageName, [request.requiredRange], new Set(), [request]);

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

    const plannedGroups: AliasGroup[] = [];

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

    const finalizeMappings = () =>
      this.buildAliasPlans(packageName, plannedGroups, allConflictPackageNames);

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
      versionsByPackage.set(packageName, versions);
    } catch (error) {
      versionsByPackage.set(packageName, []);
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

  private buildAliasPlans(
    packageName: string,
    groups: AliasGroup[],
    allConflictPackageNames: string[],
  ): PlannedAlias[] {
    const buildMapping = (entry: AliasGroup, pruneIncompatibleBranch?: PruneIncompatibleBranch) =>
      this.buildAliasMapping(
        packageName,
        entry.aliasName,
        entry.version,
        entry.installSpec,
        entry.requests,
        allConflictPackageNames,
        pruneIncompatibleBranch,
      );

    // Infer a substitute only from a verified alias's independently compatible scope.
    const verified = groups.filter(({ installSpec }) => !installSpec);
    let findScopedProvider: PruneIncompatibleBranch | undefined;
    const pruneIncompatibleBranch: PruneIncompatibleBranch | undefined =
      this.dependencyGraph && groups.length > 1 && verified.length > 0
        ? (path, requirements) => {
            findScopedProvider ??= this.createScopedProviderLookup(
              packageName,
              verified.map((entry) => buildMapping(entry, () => true).mapping),
            );
            return findScopedProvider(path, requirements);
          }
        : undefined;
    return groups.map((entry) => buildMapping(entry, pruneIncompatibleBranch));
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
    group: readonly DependencyPath[],
    groupRanges: string[],
    versions: string[],
    existingAliasNames: Set<string>,
    usedAliasNames: Set<string>,
    peerRedirects?: PeerRedirects,
  ): AliasGroup | null {
    // 1. 先检查是否有现有别名可复用（包括 workspace 级别）
    const existingAlias = this.findExistingAliasForRanges(
      packageName,
      groupRanges,
      usedAliasNames,
      group,
      peerRedirects,
    );

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
    if (versions.length === 0) return null;
    const matchingVersions = findIntersection(versions, groupRanges);
    let bestVersion = findBestVersion(matchingVersions, []);

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
    const cachedManifest = (version: string) =>
      this.registryClient.getCachedManifest?.(packageName, version, this.options.registry);
    const compatiblePeers = (version: string, manifest: PackageJson) =>
      this.checkPeerCompatibility(
        manifest,
        this.generateUniqueAliasName(packageName, version, combinedExisting),
        this.options.projectRoot,
        group,
        peerRedirects,
      ) === 'compatible';
    const preferred = cachedManifest(bestVersion);
    if (peerRedirects || (preferred && !compatiblePeers(bestVersion, preferred))) {
      const compatible = matchingVersions.filter((version) => {
        const manifest = cachedManifest(version);
        return manifest && compatiblePeers(version, manifest);
      });
      const alternative = findBestVersion(compatible, []);
      if (peerRedirects && !alternative) return null;
      bestVersion = alternative ?? bestVersion;
    }
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
    group: readonly DependencyPath[],
    allConflictPackageNames: string[],
    pruneIncompatibleBranch?: PruneIncompatibleBranch,
  ): PlannedAlias {
    // usedBy 包含声明 peerDependency 的包路径
    const usedBy = group.map((r) => r.path.join('>'));
    const workspaceEntryNames = collectWorkspaceEntryNames(this.dependencyGraph!, group);

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
    const allDependents = [...new Set(graphResult.collected.map(({ name }) => name))];
    const importerPaths = [...new Set(graphResult.collected.map(({ path }) => path))];
    const importerPathSet = new Set(importerPaths);
    const excludedImporterPaths = [...new Set(graphResult.excludedPaths)].filter(
      (path) => !importerPathSet.has(path),
    );

    return {
      consumers: group,
      inheritedMismatches: graphResult.inheritedMismatches,
      mapping: {
        originalName: packageName,
        aliasName,
        installSpec,
        resolvedVersion: version,
        usedBy,
        ...(workspaceEntryNames.length > 0 ? { workspaceEntryNames } : {}),
        allDependents,
        importerPaths,
        ...(excludedImporterPaths.length > 0 ? { excludedImporterPaths } : {}),
      },
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
    let matchDirectory: ReturnType<typeof createDirectoryScopeMatcher> | undefined;
    return (path, requirements) => {
      if (!coveredPaths.has(path)) return false;
      matchDirectory ??= createDirectoryScopeMatcher(mappings, this.options);
      const { reason, aliases } = matchDirectory(packageName, path);
      if (reason !== 'redirected' && reason !== 'ambiguous') return false;
      // A tie still shows which compatible aliases can reach this path.
      return aliases.some((alias) => {
        const scope = scopes.get(alias);
        if (!scope?.paths.has(path)) return false;
        return requirements.every(
          (requirement) =>
            !this.isRequirementIncompatibleWithAlias(requirement, {
              packageName,
              aliasVersion: scope.version,
            }),
        );
      });
    };
  }

  /**
   * Keep identities observed in both declaration scopes for ambiguity checks.
   * Only the installation visible from the host can be reused for redirects.
   */
  private getAliasInventory(packageName: string): AliasInventory {
    const cached = this.aliasInventory.get(packageName);
    if (cached) return cached;
    const observed: ExistingAliasMatch[] = [];
    const visible: ExistingAliasMatch[] = [];

    for (const aliasName of this.existingAliasesMap.get(packageName) ?? []) {
      const { packagePath, pkgJson } = this.resolvePackageJson(aliasName, this.options.projectRoot);
      if (!packagePath || pkgJson?.name !== packageName || !pkgJson.version) continue;
      const match: ExistingAliasMatch = {
        name: aliasName,
        version: pkgJson.version,
        installedPath: packagePath,
        scope: 'local',
      };
      observed.push(match);
      visible.push(match);
    }

    const localNames = new Set(visible.map(({ name }) => name));
    const host = this.options.projectRoot;
    const workspaceRoot = this.workspaceDetector.getWorkspaceRoot();
    for (const { aliasName } of this.findWorkspaceAliasesForPackage(packageName)) {
      const workspaceAssignment = workspaceRoot
        ? this.resolvePackageJson(aliasName, workspaceRoot)
        : null;
      const hostAssignment =
        workspaceRoot === host ? workspaceAssignment! : this.resolvePackageJson(aliasName, host);
      const asMatch = ({
        packagePath,
        pkgJson,
      }: typeof hostAssignment): ExistingAliasMatch | null =>
        packagePath && pkgJson?.name === packageName && pkgJson.version
          ? {
              name: aliasName,
              version: pkgJson.version,
              installedPath: packagePath,
              isWorkspaceAlias: true,
              scope: 'workspace',
            }
          : null;
      const declared = asMatch(
        workspaceAssignment?.packagePath ? workspaceAssignment : hostAssignment,
      );
      if (declared) observed.push(declared);
      const reusable = asMatch(hostAssignment);
      if (reusable && !localNames.has(aliasName)) visible.push(reusable);
    }

    visible.sort((a, b) =>
      a.scope === b.scope
        ? compare(b.version, a.version) || a.name.localeCompare(b.name)
        : a.scope.localeCompare(b.scope),
    );
    const inventory = { observed, visible };
    this.aliasInventory.set(packageName, inventory);
    return inventory;
  }

  private findExistingAliasForRanges(
    packageName: string,
    ranges: string[],
    excludeAliases: Set<string>,
    consumers: readonly DependencyPath[],
    peerRedirects?: PeerRedirects,
  ): ExistingAliasMatch | null {
    let fallback: ExistingAliasMatch | null = null;
    const canPrepareReplacement = this.options.autoInstall && !this.options.offline;
    for (const candidate of this.getAliasInventory(packageName).visible) {
      if (
        excludeAliases.has(candidate.name) ||
        !ranges.every((range) => satisfies(candidate.version, range))
      )
        continue;
      const compatibility = this.checkInstalledAliasPeers(candidate, consumers, peerRedirects);
      if (compatibility === 'compatible') return candidate;
      // Keep installed matches for diagnostics unless preparation can look
      // for a replacement for a known consumer mismatch.
      if (!peerRedirects && (compatibility !== 'consumer-mismatch' || !canPrepareReplacement)) {
        fallback ??= candidate;
      }
    }
    return fallback;
  }

  private checkInstalledAliasPeers(
    candidate: ExistingAliasMatch,
    consumers: readonly DependencyPath[],
    peerRedirects?: PeerRedirects,
  ): PeerCompatibility {
    if (!candidate.installedPath) return 'unresolved';
    const manifest = readPackageJsonCached(candidate.installedPath);
    return manifest
      ? this.checkPeerCompatibility(
          manifest,
          candidate.name,
          candidate.installedPath,
          consumers,
          peerRedirects,
        )
      : 'unresolved';
  }

  private checkPeerCompatibility(
    manifest: PackageJson,
    requestName: string,
    baseDir: string,
    consumers: readonly DependencyPath[],
    peerRedirects?: PeerRedirects,
  ): PeerCompatibility {
    let compatibility: PeerCompatibility = 'compatible';
    const ownPlan = manifest.name ? this.peerAliasRequests.get(manifest.name) : undefined;
    const redirectedConsumers =
      ownPlan && ownPlan.all !== ownPlan.redirected
        ? consumers.filter((consumer) =>
            ownPlan.redirected.some((request) => samePeerConsumer(consumer, request)),
          )
        : consumers;
    const peers = getEffectivePeerDependencies(manifest, requestName, this.options.peerOverrides);
    for (const [peerName, peer] of peers) {
      if (peer.optional) continue;
      const { name, range } = resolveDependencyRequirement(
        peerName,
        peer.range,
        this.workspaceDetector,
      );
      const planned = this.peerAliasRequests.get(peerName);
      const redirectAllowed = !this.options.excludeRedirects[peerName]?.includes(requestName);
      const selected = redirectAllowed ? peerRedirects?.(peerName) : undefined;
      if (selected?.length) {
        if (
          selected.some(
            (provider) =>
              provider.originalName !== name || !satisfies(provider.resolvedVersion, range),
          )
        ) {
          return 'consumer-mismatch';
        }
        continue;
      }
      const shared =
        redirectAllowed && !peerRedirects
          ? (planned?.redirected.filter((request) =>
              redirectedConsumers.some((consumer) => samePeerConsumer(consumer, request)),
            ) ?? [])
          : [];
      if (shared.length === 0) {
        const { pkgJson } = this.resolvePackageJson(peerName, baseDir);
        if (matchesProvider(pkgJson, name, range)) continue;
      } else if (
        name !== peerName ||
        shared.some(({ requiredRange }) => !rangesIntersect(requiredRange, range))
      ) {
        return 'consumer-mismatch';
      }
      if (!redirectAllowed || !planned || name !== peerName) {
        compatibility = 'unresolved';
        continue;
      }
      const installed = this.getAliasInventory(peerName).visible.filter(({ version }) =>
        shared.length > 0
          ? shared.every(({ requiredRange }) => satisfies(version, requiredRange))
          : planned.all.some(({ requiredRange }) => satisfies(version, requiredRange)),
      );
      if (installed.some(({ version }) => satisfies(version, range))) continue;
      if (
        this.options.offline ||
        (shared.length > 0 && installed.length > 0) ||
        !planned.all.some(({ requiredRange }) => rangesIntersect(requiredRange, range))
      )
        compatibility = 'unresolved';
    }
    return compatibility;
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
    for (const aliasName of this.existingAliasesMap.get(packageName) ?? []) names.add(aliasName);

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

  /**
   * 收集图中指定根实例的所有后代实例，同时记录被剪枝节点的物理路径，
   * 以便在嵌套 node_modules 布局下阻止祖先规则向被剪枝目录穿透。
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
  } {
    const graph = this.dependencyGraph!;
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

      const node = graph.nodes.get(nodeId);
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
}

/**
 * 创建依赖分析器实例
 */
export function createDependencyAnalyzer(
  options: ResolvedOptions,
  preparedAliases: readonly AliasMapping[] = [],
  registryClient?: RegistryClient,
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
  return new DependencyAnalyzer(
    options,
    { ...mainPackageJson, devDependencies: { ...additional, ...mainPackageJson.devDependencies } },
    registryClient,
  );
}
