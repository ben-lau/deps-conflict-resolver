import type {
  DepsConflictResolverOptions,
  ResolvedOptions,
  AnalysisResult,
  PluginHooks,
  AliasPathMapping,
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
  private aliasManager!: AliasManager;
  private installer!: PackageInstaller;

  private analysisResult: AnalysisResult | null = null;
  private initialized = false;

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

    // 检测包管理器
    let packageManager: 'npm' | 'yarn' | 'pnpm';
    if (!userOptions.packageManager || userOptions.packageManager === 'auto') {
      const detected = await this.environmentDetector.getDetectionResult();
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
    };
  }

  /**
   * 初始化解析器
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

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

    // 初始化别名管理器
    this.aliasManager.initFromAnalysisResult(this.analysisResult);

    // 调用钩子
    if (this.hooks.onAnalysisComplete) {
      await this.hooks.onAnalysisComplete(this.analysisResult);
    }

    // 自动安装
    if (this.options.autoInstall) {
      await this.installDependencies();
    }

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
    if (!this.analysisResult) {
      throw new Error('Resolver not initialized. Call initialize() first.');
    }

    const { aliasMappings } = this.analysisResult;

    // 只安装与主工程版本冲突的别名依赖（用于编译时重定向）
    // aliasMappings 只包含 needsAlias=true 的情况，即主工程已声明且版本冲突
    const aliasResult = await this.installer.installAliases(aliasMappings);

    if (!aliasResult.success) {
      logger.warn(`Some alias installations failed: ${aliasResult.errors.join(', ')}`);
    }

    // 调用钩子
    if (this.hooks.onInstallComplete) {
      await this.hooks.onInstallComplete(aliasMappings);
    }
  }

  /**
   * 解析模块请求
   * @returns 解析后的模块名，如果不需要重定向则返回 null
   */
  resolveModule(request: string, importer?: string): string | null {
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
