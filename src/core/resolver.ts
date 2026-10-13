import type {
  DepsConflictResolverOptions,
  ResolvedOptions,
  AnalysisResult,
  PluginHooks,
  AliasPathMapping,
  AliasMapping,
} from '../types/index';
import { DEFAULT_NPM_REGISTRY } from '../constants';
import { createLogger, LogLevel } from '../utils/logger';
import { findProjectRoot } from '../utils/fs';
import { createEnvironmentDetector, EnvironmentDetector } from './environment-detector';
import { createDependencyAnalyzer, DependencyAnalyzer } from './dependency-analyzer';
import { createAliasManager, AliasManager } from './alias-manager';
import { createPackageInstaller, PackageInstaller } from './package-installer';

const logger = createLogger('resolver');

/**
 * 默认配置（不包含需要自动检测的字段）
 */
const DEFAULT_OPTIONS = {
  autoInstall: true,
  debug: false,
  aliasPrefix: 'aliased-',
} as const;

/**
 * 依赖解析器
 * 整合所有核心模块，提供统一的 API
 */
export class DepsConflictResolver {
  private options!: ResolvedOptions;
  private userOptions: DepsConflictResolverOptions;
  private hooks: PluginHooks;

  private environmentDetector: EnvironmentDetector | null = null;
  private analyzer: DependencyAnalyzer | null = null;
  private aliasManager: AliasManager | null = null;
  private installer: PackageInstaller | null = null;

  private analysisResult: AnalysisResult | null = null;
  private initialized = false;
  private initializationPromise: Promise<void> | null = null;

  constructor(userOptions: DepsConflictResolverOptions, hooks: PluginHooks = {}) {
    this.userOptions = userOptions;
    this.hooks = hooks;

    // 设置日志级别（如果用户已指定）
    if (userOptions.debug) {
      logger.setLevel(LogLevel.DEBUG);
    }
  }

  /**
   * 解析配置，填充默认值（异步，支持自动检测）
   */
  private async resolveOptions(
    userOptions: DepsConflictResolverOptions,
    projectRoot: string,
  ): Promise<ResolvedOptions> {
    // 创建环境检测器
    this.environmentDetector = createEnvironmentDetector(projectRoot);

    let packageManager: 'npm' | 'yarn' | 'pnpm';
    if (!userOptions.packageManager || userOptions.packageManager === 'auto') {
      const detected = this.environmentDetector.getDetectionResult();
      packageManager = detected.packageManager;
      logger.info(
        `Auto-detected package manager: ${packageManager} (from ${detected.detectedFrom})`,
      );
    } else {
      packageManager = userOptions.packageManager;
    }

    // 检测 registry
    let registry: string;
    if (!userOptions.registry) {
      registry = await this.environmentDetector.getRegistryForPackageManager(packageManager);
      if (registry !== DEFAULT_NPM_REGISTRY) {
        logger.info(`Auto-detected registry: ${registry}`);
      }
    } else {
      registry = userOptions.registry;
    }

    return {
      ...DEFAULT_OPTIONS,
      dependencies: userOptions.dependencies,
      projectRoot,
      packageManager,
      registry,
      autoInstall: userOptions.autoInstall ?? DEFAULT_OPTIONS.autoInstall,
      debug: userOptions.debug ?? DEFAULT_OPTIONS.debug,
      aliasPrefix: userOptions.aliasPrefix ?? DEFAULT_OPTIONS.aliasPrefix,
      excludeRedirects: userOptions.excludeRedirects ?? {},
      includeRedirects: userOptions.includeRedirects ?? {},
    };
  }

  /**
   * 初始化解析器
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const initialization = (this.initializationPromise ??= this.initializeGeneration());
    try {
      await initialization;
    } catch (error) {
      // Only clear the promise that failed. A caller may have started a retry
      // after another concurrent caller observed the rejection.
      if (this.initializationPromise === initialization) {
        this.initializationPromise = null;
        this.rollbackGeneration();
      }
      throw error;
    }
  }

  /**
   * 清理已完成的初始化状态，使下一次 initialize 创建新的分析 generation。
   *
   * 初始化尚未完成时不能失效当前 generation，否则并发调用者会观察到
   * 不一致的部分状态。
   */
  invalidate(): void {
    if (this.initializationPromise && !this.initialized) {
      throw new Error('Cannot invalidate while initialization is in progress');
    }

    this.initialized = false;
    this.initializationPromise = null;
    this.rollbackGeneration();
  }

  /**
   * 回滚未完成或已失效的 generation，确保外部不会观察到半成品规则。
   */
  private rollbackGeneration(): void {
    this.initialized = false;
    this.analysisResult = null;
    this.analyzer = null;
    this.aliasManager?.clear?.();
    this.aliasManager = null;
    this.installer = null;
  }

  private async initializeGeneration(): Promise<void> {
    logger.info('Initializing dependencies resolver...');

    // 验证项目根目录
    const projectRoot = this.userOptions.projectRoot ?? process.cwd();
    const validRoot = findProjectRoot(projectRoot);
    if (!validRoot) {
      throw new Error(`Could not find package.json in ${projectRoot} or parent directories`);
    }

    if (validRoot !== projectRoot) {
      logger.debug(`Adjusted project root to: ${validRoot}`);
    }

    // 解析配置（包含自动检测）
    this.options = await this.resolveOptions(this.userOptions, validRoot);

    // 设置日志级别
    if (this.options.debug) {
      logger.setLevel(LogLevel.DEBUG);
    }

    // 初始化子模块
    this.aliasManager = createAliasManager(this.options);
    this.installer = createPackageInstaller(this.options);

    // 创建依赖分析器（同步创建，异步分析）
    this.analyzer = createDependencyAnalyzer(this.options);

    // 执行分析
    this.analysisResult = await this.analyzer.analyze();

    // 输出缺失的 peer 依赖警告（不自动安装，仅提示）
    this.logMissingFirstLevelPeers(this.analysisResult);

    // 调用钩子
    if (this.hooks.onAnalysisComplete) {
      await this.hooks.onAnalysisComplete(this.analysisResult);
    }

    // 自动安装
    if (this.options.autoInstall) {
      await this.installDependencies();
    } else {
      // An empty installSpec identifies an alias that analysis verified as
      // already reusable. Generated aliases still require installation before
      // they may enter runtime rules.
      this.setActiveAliasMappings(
        this.analysisResult.aliasMappings.filter((mapping) => mapping.installSpec === ''),
      );
    }

    // 分析器在初始化完成后不再使用，释放以允许 GC 回收其内部状态
    this.analyzer = null;

    this.initialized = true;
    logger.info('Dependencies resolver initialized');
  }

  /**
   * 输出第一层依赖中缺失的 peer 依赖警告（不自动安装，仅提示）
   *
   * 放在 initialize 阶段统一输出，避免各插件重复打印，且在 autoInstall=false 时也能看到提示。
   */
  private logMissingFirstLevelPeers(result: AnalysisResult): void {
    const missing = result.missingFirstLevelPeers;
    if (!missing || missing.length === 0) {
      return;
    }

    logger.warn(`Found ${missing.length} unsatisfied peer dependencies (not auto-installing):`);

    for (const peer of missing) {
      logger.warn(
        `  - ${peer.packageName}@${peer.requiredRange} (required by ${peer.requestedBy})`,
      );
    }
  }

  /**
   * 安装所需依赖
   *
   * 安装策略（按用户需求）：
   * 1. 只自动安装「主工程已声明的依赖 & peerDeps 要求版本与主工程版本冲突」的别名版本
   * 2. 缺失的 peer 依赖（主工程未声明）：不自动安装，只警告
   * 3. 内部依赖冲突（子依赖之间的版本冲突）：不自动安装，只做编译时重定向
   *
   * 这样可以避免"什么依赖都自动安装"的问题，用户可以根据警告自行决定是否安装缺失的依赖
   */
  async installDependencies(): Promise<void> {
    if (!this.analysisResult || !this.installer) {
      throw new Error('Resolver not initialized. Call initialize() first.');
    }

    const { aliasMappings } = this.analysisResult;

    // 只安装与主工程版本冲突的别名依赖（用于编译时重定向）
    // aliasMappings 只包含 needsAlias=true 的情况，即主工程已声明且版本冲突
    let aliasResult: Awaited<ReturnType<PackageInstaller['installAliases']>>;
    try {
      aliasResult = await this.installer.installAliases(aliasMappings);
    } catch (error) {
      // A thrown installer error cannot identify a safe subset of mappings.
      // Remove all active rules before propagating it to the generation guard.
      this.setActiveAliasMappings([]);
      throw error;
    }

    const completedMappings = this.filterCompletedMappings(aliasMappings, aliasResult, false);
    this.setActiveAliasMappings(completedMappings, aliasResult.failed ?? []);

    if (!aliasResult.success) {
      logger.warn(`Some alias installations failed: ${aliasResult.errors.join(', ')}`);
    }

    // 调用钩子
    if (this.hooks.onInstallComplete) {
      // The hook predates structured installer results and intentionally keeps
      // its AliasMapping[] signature. Filter the analyzed mappings internally
      // so a failed install/collision is never reported as installed while old
      // installer implementations that only expose failed[] remain usable.
      await this.hooks.onInstallComplete(
        this.filterCompletedMappings(aliasMappings, aliasResult, true),
      );
    }
  }

  /**
   * Select only mappings whose installer outcome explicitly proved reuse or
   * installation. Hook callers retain the pre-Task-9 compatibility fallback
   * for old installer results that omitted `reused`.
   */
  private filterCompletedMappings(
    aliasMappings: AliasMapping[],
    aliasResult: {
      success?: boolean;
      installed?: string[];
      reused?: string[];
      failed?: string[];
    },
    allowLegacyReuse: boolean,
  ): AliasMapping[] {
    const failedAliases = new Set(aliasResult.failed ?? []);
    const successfulAliases = new Set([
      ...(aliasResult.installed ?? []),
      ...(aliasResult.reused ?? []),
    ]);

    // Older installer implementations did not expose `reused`. The hook
    // remains compatible with that result shape, but runtime rules do not
    // infer success from installSpec and therefore stay fail-closed.
    if (allowLegacyReuse && aliasResult.success !== false) {
      for (const mapping of aliasMappings) {
        if (mapping.installSpec === '' && !failedAliases.has(mapping.aliasName)) {
          successfulAliases.add(mapping.aliasName);
        }
      }
    }

    return aliasMappings.filter(
      (mapping) =>
        successfulAliases.has(mapping.aliasName) && !failedAliases.has(mapping.aliasName),
    );
  }

  /**
   * Publish a new active mapping set while keeping the complete analysis
   * result available for diagnostics.
   */
  private setActiveAliasMappings(
    mappings: AliasMapping[],
    blockedAliasNames: Iterable<string> = [],
  ): void {
    if (!this.aliasManager || !this.analysisResult) {
      return;
    }

    const activeAliasNames = new Set(mappings.map((mapping) => mapping.aliasName));
    const inactiveAliasNames = new Set(blockedAliasNames);
    for (const mapping of this.analysisResult.aliasMappings) {
      if (!activeAliasNames.has(mapping.aliasName)) {
        inactiveAliasNames.add(mapping.aliasName);
      }
    }

    const activeMappings = mappings.map((mapping) => {
      if (!mapping.importerPaths || inactiveAliasNames.size === 0) {
        return mapping;
      }

      return {
        ...mapping,
        importerPaths: mapping.importerPaths.filter(
          (importerPath) =>
            ![...inactiveAliasNames].some((aliasName) =>
              this.isAliasPackagePath(importerPath, aliasName),
            ),
        ),
      };
    });

    this.aliasManager.initFromAnalysisResult({
      ...this.analysisResult,
      aliasMappings: activeMappings,
    });
  }

  /**
   * Check whether an importer path belongs to an alias package directory.
   * Package paths can be nested under pnpm's virtual store, so matching the
   * `node_modules/<alias>` segment is more reliable than checking a basename.
   */
  private isAliasPackagePath(importerPath: string, aliasName: string): boolean {
    const normalizedPath = importerPath.replace(/\\/g, '/').replace(/\/+$/, '');
    const marker = `node_modules/${aliasName}`;
    return (
      normalizedPath === marker ||
      normalizedPath.startsWith(`${marker}/`) ||
      normalizedPath.endsWith(`/${marker}`) ||
      normalizedPath.includes(`/${marker}/`)
    );
  }

  /**
   * 解析模块请求
   * @returns 解析后的模块名，如果不需要重定向则返回 null
   */
  resolveModule(request: string, importer?: string): string | null {
    if (!this.initialized || !this.aliasManager) {
      return null;
    }

    // 检查钩子
    if (this.hooks.beforeResolve) {
      const hookResult = this.hooks.beforeResolve(request, importer);
      if (hookResult !== undefined) {
        return hookResult;
      }
    }

    return this.aliasManager.resolveModule({ request, importer });
  }

  /**
   * 获取别名路径映射
   * 返回别名名称到实际路径的映射，供构建工具插件转换为各自的格式
   */
  getAliasPathMappings(): AliasPathMapping[] {
    if (!this.initialized || !this.aliasManager) {
      return [];
    }

    return this.aliasManager.getAliasPathMappings();
  }

  /**
   * 获取分析结果
   */
  getAnalysisResult(): AnalysisResult | null {
    return this.analysisResult;
  }

  /**
   * 获取配置
   */
  getOptions(): ResolvedOptions {
    return { ...this.options };
  }
}

/**
 * 创建依赖解析器实例
 */
export async function createResolver(
  options: DepsConflictResolverOptions,
  hooks?: PluginHooks,
): Promise<DepsConflictResolver> {
  const resolver = new DepsConflictResolver(options, hooks);
  await resolver.initialize();
  return resolver;
}
