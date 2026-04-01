import type {
  DependencyInfo,
  PackageJson,
  PeerConflict,
  DependencyPath,
  ResolvedOptions,
  AnalysisResult,
  AliasMapping,
  WorkspaceAliasInfo,
} from '../types/index';
import { createLogger } from '../utils/logger';
import { readPackageJsonCached, findPackagePath, clearPackageJsonCache } from '../utils/fs';
import type { InstalledPackageInfo } from '../types';
import { createWorkspaceDetector, WorkspaceDetector } from './workspace-detector';
import {
  satisfies,
  findBestVersion,
  generateAliasName,
  createAliasInstallSpec,
  rangesIntersect,
} from '../utils/semver';
import { parseNpmAlias } from '../utils/version-spec';
import { fetchAllVersions, clearNpmRegistryCache } from './npm-registry';

const logger = createLogger('dependency-analyzer');

/**
 * 依赖分析器
 * 负责分析依赖树、找出 peer 依赖冲突
 */
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

  constructor(
    options: ResolvedOptions,
    mainPackageJson: PackageJson,
    /** 可选：预填充的已安装包信息（主要用于测试） */
    installedDeps?: Map<string, InstalledPackageInfo>,
  ) {
    this.options = options;
    this.rawDeclaredDeps = {
      ...mainPackageJson.dependencies,
      ...mainPackageJson.devDependencies,
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
    return { packagePath, pkgJson };
  }

  /**
   * 加载 workspace 根目录 package.json 声明的依赖（dependencies/devDependencies）
   *
   * 目的：在 monorepo/workspace 场景下，“主工程声明”需要合并当前包与 workspace 根的声明，
   * 与 WorkspaceDetector 的 workspaceRoot 判断逻辑保持一致。
   */
  private async ensureWorkspaceRootDeclaredDepsLoaded(): Promise<void> {
    if (this.workspaceRootDeclaredLoaded) {
      return;
    }
    this.workspaceRootDeclaredLoaded = true;

    const workspaceRoot = await this.workspaceDetector.getWorkspaceRoot();
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
  private async resolveCatalogDependencies(): Promise<void> {
    for (const [pkgName, versionSpec] of Object.entries(this.rawDeclaredDeps)) {
      if (typeof versionSpec !== 'string') continue;

      // 检查是否是 catalog 协议
      if (versionSpec.startsWith('catalog:')) {
        const resolved = await this.workspaceDetector.resolveVersionSpec(pkgName, versionSpec);
        if (resolved) {
          this.declaredDeps[pkgName] = resolved;
          logger.debug(`Resolved catalog dependency: ${pkgName} "${versionSpec}" -> "${resolved}"`);
        } else {
          logger.warn(`Failed to resolve catalog dependency: ${pkgName}@${versionSpec}`);
        }
      }
      // 检查是否是 workspace 协议
      else if (versionSpec.startsWith('workspace:')) {
        const resolved = await this.workspaceDetector.resolveVersionSpec(pkgName, versionSpec);
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
  async analyze(): Promise<AnalysisResult> {
    logger.info('Starting dependency analysis...');

    try {
      // 0. 解析 catalog: 协议的依赖版本
      await this.resolveCatalogDependencies();

      // 0.1 预加载 workspaceRoot 的声明依赖（用于后续“已声明”判断合并）
      await this.ensureWorkspaceRootDeclaredDepsLoaded();

      // 1. 从用户指定的依赖开始，递归分析所有子依赖（deps + peerDeps）
      //    构建完整依赖树用于后续重定向判断
      for (const depName of this.options.dependencies) {
        this.analyzeDependencyRecursive(depName, []);
      }

      // 2. 只收集第一层依赖的 peer 依赖（用于冲突检测）
      //    不分析子依赖的 peerDeps，只有第一层的冲突才需要别名安装
      const peerDepsMap = this.collectFirstLevelPeerDependencies();

      // 3. 分析冲突（只检测与主工程已声明依赖的版本冲突）
      const peerConflicts = await this.analyzePeerConflicts(peerDepsMap);

      // 4. 生成别名映射（只为需要安装别名的冲突生成）
      //    会收集完整依赖树用于重定向判断
      const aliasMappings = await this.generateAliasMappings(peerConflicts);

      // 5. 找出缺失的 peer 依赖（仅记录，不自动安装）
      const missingFirstLevelPeers = this.findMissingFirstLevelPeers(peerDepsMap);

      const conflictsNeedingAlias = peerConflicts.filter(c => c.needsAlias).length;
      logger.info(
        `Analysis complete. Found ${conflictsNeedingAlias} first-level peer conflicts needing alias, ` +
          `${missingFirstLevelPeers.length} missing peers (not auto-installing). ` +
          `Analyzed ${this.analyzedDependencies.size} packages, visited ${this.visitedPackages.size} packages total.`,
      );

      return {
        analyzedDependencies: this.analyzedDependencies,
        peerConflicts,
        aliasMappings,
        missingFirstLevelPeers,
      };
    } finally {
      // 清理缓存，释放内存
      clearPackageJsonCache();
      clearNpmRegistryCache();
    }
  }

  /**
   * 递归分析单个依赖及其所有子依赖
   */
  private analyzeDependencyRecursive(
    packageName: string,
    dependencyPath: string[],
  ): DependencyInfo | null {
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
        dependencies: pkgJson.dependencies ?? {},
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
        ...Object.keys(pkgJson.dependencies ?? {}),
        ...Object.keys(pkgJson.peerDependencies ?? {}),
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
      const parsed = parseNpmAlias(declaredSpec);
      if (parsed) {
        info.realName = parsed[0];
      }
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

    // 只遍历第一层依赖（用户指定的 dependencies）
    for (const depName of this.options.dependencies) {
      const depInfo = this.analyzedDependencies.get(depName);
      if (!depInfo) continue;

      const peerDeps = depInfo.peerDependencies;
      const peerMeta = depInfo.peerDependenciesMeta ?? {};

      for (const [peerName, peerRange] of Object.entries(peerDeps)) {
        const isOptional = peerMeta[peerName]?.optional === true;

        const existing = peerDepsMap.get(peerName) ?? [];
        existing.push({
          path: [depName],
          requiredRange: peerRange,
        });
        peerDepsMap.set(peerName, existing);

        logger.debug(
          `Found first-level peer dependency: ${peerName}@${peerRange} required by ${depName}${isOptional ? ' (optional)' : ''}`,
        );
      }
    }

    return peerDepsMap;
  }

  /**
   * 分析 peer 依赖冲突
   * 只有当主工程已安装某个依赖，且 peerDeps 要求的版本不兼容时，才需要别名
   */
  private async analyzePeerConflicts(
    peerDepsMap: Map<string, DependencyPath[]>,
  ): Promise<PeerConflict[]> {
    const conflicts: PeerConflict[] = [];

    for (const [packageName, requestedBy] of peerDepsMap) {
      // 仅当主工程声明了该 peer 包时，才认为“主工程版本”有意义并允许自动安装别名。
      // 否则：即使 node_modules 可 resolve 到该包（例如 pnpm peer/hoist 带来的间接可见），也应当视为“未声明”，只提示 missing，不触发安装。
      const isDeclared = this.isDeclaredInMainProject(packageName);

      // 获取主工程已安装的版本（从 node_modules 读取实际版本）
      // 只有声明过的包才会参与冲突判定
      const mainVersion = isDeclared ? this.getMainProjectVersion(packageName) : null;
      const isInstalled = mainVersion !== null;

      // 检查每个请求是否与已安装版本冲突
      let hasConflict = false;
      const conflictingRanges: DependencyPath[] = [];
      const satisfiedRanges: DependencyPath[] = [];

      for (const request of requestedBy) {
        // 解析 peerDep 的版本范围（支持 catalog: 等协议）
        const resolvedRange =
          (await this.workspaceDetector.resolveVersionSpec(packageName, request.requiredRange)) ??
          request.requiredRange;

        if (mainVersion && satisfies(mainVersion, resolvedRange)) {
          satisfiedRanges.push(request);
        } else {
          conflictingRanges.push({
            ...request,
            requiredRange: resolvedRange, // 使用解析后的版本范围
          });
          // 只有当包在主工程中“已声明且已安装”时，才标记为冲突
          // 未声明：不算冲突，交由 missing peers 提示
          // 未安装：不算冲突，属于缺失
          if (isDeclared && isInstalled) {
            hasConflict = true;
          }
        }
      }

      // needsAlias 的条件：
      // 1. 主工程已声明该包（isDeclared = true）
      // 2. 包实际已安装（isInstalled = true）
      // 2. 存在与已安装版本不兼容的 peerDep 请求（conflictingRanges.length > 0）
      const needsAlias = isDeclared && isInstalled && hasConflict && conflictingRanges.length > 0;

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
        conflictingRanges, // 只记录冲突的范围
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
    // 先检查已缓存的安装信息
    const cached = this.installedPackageCache.get(packageName);
    if (cached) {
      return cached.version;
    }

    // 尝试按需查找包（从 node_modules 读取实际安装的版本）
    const { packagePath, pkgJson } = this.resolvePackageJson(packageName, this.options.projectRoot);
    if (packagePath && pkgJson?.version) {
      // 缓存安装信息
      this.installedPackageCache.set(packageName, {
        name: packageName,
        version: pkgJson.version,
        path: packagePath,
      });
      return pkgJson.version;
    }

    // 包未安装，返回 null
    // 注意：不返回 package.json 中声明的版本范围，因为那不是实际安装的版本
    return null;
  }

  /**
   * 合并多个版本范围为描述字符串
   */
  private mergeRequiredRanges(requests: DependencyPath[]): string {
    const ranges = [...new Set(requests.map(r => r.requiredRange))];
    return ranges.join(' || ');
  }

  /**
   * 生成别名映射
   */
  private async generateAliasMappings(conflicts: PeerConflict[]): Promise<AliasMapping[]> {
    const aliasMappings: AliasMapping[] = [];

    // 按包名分组需要别名的冲突
    const aliasNeeded = conflicts.filter(c => c.needsAlias);

    // 收集所有冲突包的名称
    const allConflictPackageNames = aliasNeeded.map(c => c.packageName);

    // 对于每个需要别名的包
    for (const conflict of aliasNeeded) {
      const mappings = await this.createAliasMappingsForConflict(conflict, allConflictPackageNames);
      aliasMappings.push(...mappings);
    }

    return aliasMappings;
  }

  /**
   * 为单个冲突创建别名映射
   */
  private async createAliasMappingsForConflict(
    conflict: PeerConflict,
    allConflictPackageNames: string[],
  ): Promise<AliasMapping[]> {
    const { packageName, conflictingRanges } = conflict;

    // 1. 按范围兼容性分组
    const rangeGroups = this.groupRangesByCompatibility(conflictingRanges);

    logger.info(`Creating alias for "${packageName}": ${rangeGroups.length} version groups`);

    // 输出 workspace 检测结果（使用 info 级别以便用户看到）
    const workspaceRoot = await this.workspaceDetector.getWorkspaceRoot();
    if (workspaceRoot) {
      logger.info(`  Workspace root detected: ${workspaceRoot}`);
      const wsAliases = await this.findWorkspaceAliasesForPackage(packageName);
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

    // 2. 获取远程版本列表（只获取一次）
    const versions = await fetchAllVersions(packageName, this.options.registry);
    if (versions.length === 0) {
      logger.warn(`No versions found for ${packageName}`);
      return [];
    }

    // 3. 获取已存在的别名（用于复用和避免命名冲突）
    const existingAliasNames = await this.getExistingAliasNames(packageName);
    // 记录这次已使用的别名，避免重复使用
    const usedAliasNames = new Set<string>();

    const mappings: AliasMapping[] = [];

    // 4. 为每组创建别名映射
    for (let i = 0; i < rangeGroups.length; i++) {
      const group = rangeGroups[i];
      if (!group || group.length === 0) continue;

      const groupRanges = [...new Set(group.map(r => r.requiredRange))];

      logger.debug(`  Group ${i + 1}: ${groupRanges.join(', ')}`);

      const mapping = await this.createAliasMappingForGroup(
        packageName,
        group,
        groupRanges,
        versions,
        existingAliasNames,
        usedAliasNames,
        allConflictPackageNames,
      );

      if (mapping) {
        mappings.push(mapping);
        // 记录已使用的别名名称
        usedAliasNames.add(mapping.aliasName);
      }
    }

    return mappings;
  }

  /**
   * 按范围兼容性分组
   * 有交集的范围放在一组，互斥的分开
   */
  private groupRangesByCompatibility(requests: DependencyPath[]): DependencyPath[][] {
    const groups: DependencyPath[][] = [];

    for (const request of requests) {
      let added = false;

      // 尝试加入现有组
      for (const group of groups) {
        // 检查是否与组内所有范围都有交集
        const canJoin = group.every(existing =>
          rangesIntersect(existing.requiredRange, request.requiredRange),
        );

        if (canJoin) {
          group.push(request);
          added = true;
          break;
        }
      }

      // 没有合适的组，创建新组
      if (!added) {
        groups.push([request]);
      }
    }

    return groups;
  }

  /**
   * 为一个兼容组创建别名映射
   */
  private async createAliasMappingForGroup(
    packageName: string,
    group: DependencyPath[],
    groupRanges: string[],
    versions: string[],
    existingAliasNames: Set<string>,
    usedAliasNames: Set<string>,
    allConflictPackageNames: string[],
  ): Promise<AliasMapping | null> {
    // 1. 先检查是否有现有别名可复用（包括 workspace 级别）
    const existingAlias = await this.findExistingAliasForRanges(
      packageName,
      groupRanges,
      usedAliasNames,
    );

    if (existingAlias) {
      logger.debug(
        `    Reusing: ${existingAlias.name}@${existingAlias.version}${existingAlias.isWorkspaceAlias ? ' (workspace)' : ''}`,
      );

      return this.buildAliasMapping(
        packageName,
        existingAlias.name,
        existingAlias.version,
        '', // 不需要安装
        group,
        allConflictPackageNames,
      );
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
    const combinedExisting = new Set([...existingAliasNames, ...usedAliasNames]);
    const aliasName = this.generateUniqueAliasName(packageName, bestVersion, combinedExisting);
    const installSpec = createAliasInstallSpec(aliasName, packageName, bestVersion);

    logger.info(`    New alias: ${aliasName}@${bestVersion}`);

    return this.buildAliasMapping(
      packageName,
      aliasName,
      bestVersion,
      installSpec,
      group,
      allConflictPackageNames,
    );
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
  ): AliasMapping {
    // usedBy 包含声明 peerDependency 的包路径
    const usedBy = group.map(r => r.path.join('>'));

    // 收集 usedBy 中第一层包作为起点
    const usedByRoots = [
      ...new Set(group.map(r => r.path[0]).filter((p): p is string => p !== undefined)),
    ];

    // 只收集 peerDependencies 链路上的包用于重定向
    // dependencies 中的引用不需要重定向，由包管理器的正常解析处理
    // 排除所有冲突包，防止主工程的这些包引用被错误重定向
    const allDependents = this.collectAllRelatedPackages(usedByRoots, allConflictPackageNames);

    return {
      originalName: packageName,
      aliasName,
      installSpec,
      resolvedVersion: version,
      usedBy,
      allDependents,
    };
  }

  /**
   * 查找满足指定范围的现有别名（排除已使用的）
   * 优先查找当前项目的别名，然后查找 workspace 级别的别名
   */
  private async findExistingAliasForRanges(
    packageName: string,
    ranges: string[],
    excludeAliases: Set<string>,
  ): Promise<{
    name: string;
    version: string;
    isWorkspaceAlias?: boolean;
  } | null> {
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
        if (alias.installedVersion === null) {
          alias.installedVersion = this.getAliasInstalledVersion(alias.aliasName);
        }

        if (!alias.installedVersion) {
          logger.debug(`    Skip ${alias.aliasName}: not installed`);
          continue;
        }

        // 检查版本是否满足所有范围
        const allSatisfied = ranges.every(range => satisfies(alias.installedVersion!, range));

        if (allSatisfied) {
          logger.info(`    Reusing local alias: ${alias.aliasName}@${alias.installedVersion}`);
          return { name: alias.aliasName, version: alias.installedVersion };
        } else {
          logger.debug(
            `    Skip ${alias.aliasName}@${alias.installedVersion}: version doesn't satisfy all ranges`,
          );
        }
      }
    }

    // 2. 查找 workspace 级别的别名
    const workspaceAliases = await this.findWorkspaceAliasesForPackage(packageName);
    const workspaceRoot = await this.workspaceDetector.getWorkspaceRoot();

    if (workspaceAliases.length > 0) {
      logger.debug(`  Checking ${workspaceAliases.length} workspace alias(es)...`);
    }

    for (const wsAlias of workspaceAliases) {
      // 跳过已使用的别名
      if (excludeAliases.has(wsAlias.aliasName)) {
        logger.debug(`    Skip ${wsAlias.aliasName}: already used`);
        continue;
      }

      // 尝试从 workspace 根目录获取已安装版本（pnpm 模式下依赖安装在根目录）
      let installedVersion: string | null = null;

      if (workspaceRoot) {
        const { packagePath, pkgJson } = this.resolvePackageJson(wsAlias.aliasName, workspaceRoot);
        if (packagePath) {
          installedVersion = pkgJson?.version ?? null;
          logger.debug(
            `    Found ${wsAlias.aliasName} installed at workspace root: ${installedVersion}`,
          );
        }
      }

      // 如果找不到，尝试从当前项目查找（可能是 hoisted 或软链接）
      if (!installedVersion) {
        installedVersion = this.getAliasInstalledVersion(wsAlias.aliasName);
        if (installedVersion) {
          logger.debug(`    Found ${wsAlias.aliasName} installed at project: ${installedVersion}`);
        }
      }

      // 如果已安装，用实际版本检查
      if (installedVersion) {
        const allSatisfied = ranges.every(range => satisfies(installedVersion, range));
        if (allSatisfied) {
          logger.info(`    Reusing workspace alias: ${wsAlias.aliasName}@${installedVersion}`);
          return {
            name: wsAlias.aliasName,
            version: installedVersion,
            isWorkspaceAlias: true,
          };
        } else {
          logger.debug(
            `    Skip ${wsAlias.aliasName}@${installedVersion}: version doesn't satisfy all ranges`,
          );
        }
        continue;
      }

      // 如果未安装，用声明的版本范围检查是否有交集
      // 这适用于别名尚未安装但声明了的情况
      const declaredSpec = wsAlias.versionSpec;
      if (declaredSpec) {
        logger.debug(
          `    Checking ${wsAlias.aliasName} (declared: ${declaredSpec}) - not installed yet`,
        );
        // 检查声明的版本范围与需求范围是否有交集
        const hasIntersection = ranges.every(range => rangesIntersect(declaredSpec, range));
        if (hasIntersection) {
          logger.info(
            `    Can reuse workspace alias: ${wsAlias.aliasName} (declared: ${declaredSpec})`,
          );
          return {
            name: wsAlias.aliasName,
            version: declaredSpec,
            isWorkspaceAlias: true,
          };
        } else {
          logger.debug(
            `    Skip ${wsAlias.aliasName}: declared range ${declaredSpec} doesn't intersect with [${ranges.join(', ')}]`,
          );
        }
      }
    }

    logger.debug(`  No existing alias found for ${packageName}`);
    return null;
  }

  /**
   * 查找 workspace 级别的别名（带缓存）
   */
  private async findWorkspaceAliasesForPackage(packageName: string): Promise<WorkspaceAliasInfo[]> {
    // 检查缓存
    if (this.workspaceAliasesCache.has(packageName)) {
      return this.workspaceAliasesCache.get(packageName)!;
    }

    // 从 workspace 检测器获取别名
    const aliases = await this.workspaceDetector.findWorkspaceAliases(packageName);
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
  private async getExistingAliasNames(packageName: string): Promise<Set<string>> {
    const names = new Set<string>();

    // 1. 从当前项目 package.json 的 npm: 协议解析的别名中获取
    const npmAliases = this.existingAliasesMap.get(packageName);
    if (npmAliases) {
      for (const alias of npmAliases) {
        names.add(alias.aliasName);
      }
    }

    // 2. 从 workspace 级别获取别名名称
    const workspaceAliases = await this.findWorkspaceAliasesForPackage(packageName);
    for (const wsAlias of workspaceAliases) {
      names.add(wsAlias.aliasName);
    }

    return names;
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
   *
   * 性能优化：优先从 analyzedDependencies 内存数据中读取，避免重复磁盘 I/O
   */
  private collectAllSubDependenciesRecursive(
    packageName: string,
    visited: Set<string>,
    collected: Set<string>,
    baseDir: string,
  ): void {
    const stack: Array<{ name: string; baseDir: string }> = [{ name: packageName, baseDir }];

    while (stack.length > 0) {
      const item = stack.pop();
      if (!item) break;

      const name = item.name;
      const currentBaseDir = item.baseDir;

      collected.add(name);

      // 优先从已分析的内存数据中读取依赖信息，避免重复 resolvePackageJson 磁盘 I/O
      const analyzed = this.analyzedDependencies.get(name);
      if (analyzed) {
        if (visited.has(name)) {
          continue;
        }
        visited.add(name);

        for (const depName of Object.keys(analyzed.dependencies)) {
          stack.push({ name: depName, baseDir: currentBaseDir });
        }
        for (const peerName of Object.keys(analyzed.peerDependencies)) {
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
        continue;
      }

      if (visited.has(packagePath)) {
        continue;
      }
      visited.add(packagePath);

      if (!pkgJson) {
        continue;
      }

      const deps = pkgJson.dependencies ?? {};
      const peerDeps = pkgJson.peerDependencies ?? {};

      for (const depName of Object.keys(deps)) {
        stack.push({ name: depName, baseDir: packagePath });
      }
      for (const peerName of Object.keys(peerDeps)) {
        stack.push({ name: peerName, baseDir: packagePath });
      }
    }
  }

  /**
   * 收集多个包的所有子依赖（用于 allDependents）
   * 包括 dependencies 和 peerDependencies 递归下去的所有包
   */
  collectAllRelatedPackages(packageNames: string[], excludePackages: string[] = []): string[] {
    const collected = new Set<string>();
    const visited = new Set<string>();
    const excludeSet = new Set(excludePackages);

    for (const pkgName of packageNames) {
      this.collectAllSubDependenciesRecursive(
        pkgName,
        visited,
        collected,
        this.options.projectRoot,
      );
    }

    // 从结果中移除需要排除的包
    // 这是必要的，因为 peerDependencies 中会包含冲突的目标包名（如 "vue"）
    // 如果不排除，会导致主工程的 vue 引用也被错误重定向
    for (const excludePkg of excludeSet) {
      collected.delete(excludePkg);
    }

    return Array.from(collected);
  }

  /**
   * 找出第一层依赖中缺失的 peer 依赖（无冲突）
   * 复用 collectFirstLevelPeerDependencies 已收集的 peerDepsMap，避免重复遍历
   */
  private findMissingFirstLevelPeers(peerDepsMap: Map<string, DependencyPath[]>): Array<{
    packageName: string;
    requiredRange: string;
    requestedBy: string;
  }> {
    const missing: Array<{
      packageName: string;
      requiredRange: string;
      requestedBy: string;
    }> = [];

    for (const [peerName, requests] of peerDepsMap) {
      // missing 的定义：主工程未声明该 peer 依赖
      // 注意：node_modules 可 resolve 到 ≠ 已声明（pnpm 的 peer/hoist 场景会误导）
      if (this.isDeclaredInMainProject(peerName)) {
        continue;
      }

      // 过滤掉 optional 的请求
      for (const request of requests) {
        const requestedBy = request.path[0];
        if (!requestedBy) continue;

        const depInfo = this.analyzedDependencies.get(requestedBy);
        const isOptional = depInfo?.peerDependenciesMeta?.[peerName]?.optional === true;
        if (isOptional) {
          continue;
        }

        // 未声明：缺失（不自动安装，只提示）
        missing.push({
          packageName: peerName,
          requiredRange: request.requiredRange,
          requestedBy,
        });
      }
    }

    return missing;
  }
}

/**
 * 创建依赖分析器实例
 */
export function createDependencyAnalyzer(options: ResolvedOptions): DependencyAnalyzer {
  const mainPackageJson = readPackageJsonCached(options.projectRoot);
  if (!mainPackageJson) {
    throw new Error(`Could not read package.json at ${options.projectRoot}`);
  }

  // 不预先扫描 node_modules，按需查找包
  return new DependencyAnalyzer(options, mainPackageJson);
}
