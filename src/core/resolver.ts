import type {
  DepsConflictResolverOptions,
  ResolvedOptions,
  AnalysisResult,
  PluginHooks,
  AliasPathMapping,
  AliasMapping,
  ResolverDiagnostic,
  ResolutionExplanation,
  InstallReport,
} from '../types/index';
import { DEFAULT_NPM_REGISTRY } from '../constants';
import { createLogger, LogLevel } from '../utils/logger';
import {
  clearPackageJsonCache,
  findProjectRoot,
  getCachedRealPath,
  readPackageJsonCached,
} from '../utils/fs';
import { realpathSync } from 'node:fs';
import { createEnvironmentDetector, EnvironmentDetector } from './environment-detector';
import { createDependencyAnalyzer, DependencyAnalyzer } from './dependency-analyzer';
import { createAliasManager, AliasManager } from './alias-manager';
import { createPackageInstaller, PackageInstaller } from './package-installer';
import { ResolutionError } from './resolution-error';
import {
  getProjectPreparation,
  withProjectPreparation,
  waitForProjectPreparation,
  type ProjectPreparation,
  type PreparationObserver,
} from './project-preparation';
import { resolve as resolvePath } from 'node:path';

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
  private installationPromise: Promise<void> | null = null;
  private preparing = false;
  private installResult: InstallReport | null = null;
  private installDiagnostics: ResolverDiagnostic[] = [];
  private preparation: ProjectPreparation | null = null;
  private snapshotRevision = 0;
  private snapshotError: ResolutionError | null = null;
  private snapshotGeneration = 0;
  private snapshotSignature = '';
  private snapshotInvalidated = false;
  private activeMappings: AliasMapping[] = [];
  private snapshotObserver: WeakRef<PreparationObserver> | null = null;
  private readonly observer: PreparationObserver = { refresh: () => this.refreshSnapshot() };

  constructor(userOptions: DepsConflictResolverOptions, hooks: PluginHooks = {}) {
    this.userOptions = userOptions;
    this.hooks = hooks;

    // 设置日志级别（如果用户已指定）
    if (userOptions.debug) {
      logger.setLevel(LogLevel.ALL);
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
      autoInstall: userOptions.offline
        ? false
        : (userOptions.autoInstall ?? DEFAULT_OPTIONS.autoInstall),
      offline: userOptions.offline ?? false,
      strict: userOptions.strict ?? false,
      debug: userOptions.debug ?? DEFAULT_OPTIONS.debug,
      aliasPrefix: userOptions.aliasPrefix ?? DEFAULT_OPTIONS.aliasPrefix,
      excludeRedirects: userOptions.excludeRedirects ?? {},
      includeRedirects: userOptions.includeRedirects ?? {},
      peerOverrides: userOptions.peerOverrides ? { ...userOptions.peerOverrides } : {},
    };
  }

  /**
   * 初始化解析器
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      if (this.preparation) await waitForProjectPreparation(this.preparation);
      this.snapshotCurrent();
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
    if (this.installationPromise) {
      throw new Error('Cannot invalidate while installation is in progress');
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
    if (this.snapshotObserver) this.preparation?.observers.delete(this.snapshotObserver);
    this.snapshotObserver = null;
    this.snapshotError = null;
    this.snapshotSignature = '';
    this.snapshotInvalidated = false;
    this.snapshotGeneration++;
    this.activeMappings = [];
    this.analysisResult = null;
    this.analyzer = null;
    this.aliasManager?.clear?.();
    this.aliasManager = null;
    this.installer = null;
    this.installResult = null;
    this.installDiagnostics = [];
  }

  private async initializeGeneration(): Promise<void> {
    // A previous generation may repopulate IO caches during peer linkage or
    // adapter setup. Refresh before environment detection and the first read.
    clearPackageJsonCache();
    logger.info('Initializing dependencies resolver...');

    // 验证项目根目录
    const projectRoot = resolvePath(this.userOptions.projectRoot ?? process.cwd());
    const validRoot = findProjectRoot(projectRoot);
    if (!validRoot) {
      throw new Error(`Could not find package.json in ${projectRoot} or parent directories`);
    }

    if (validRoot !== projectRoot) {
      logger.debug(`Adjusted project root to: ${validRoot}`);
    }

    // 解析配置（包含自动检测）
    let physicalRoot = validRoot;
    try {
      physicalRoot = realpathSync(validRoot);
    } catch {
      /* Retain the validated root. */
    }
    this.options = await this.resolveOptions(this.userOptions, physicalRoot);

    // 设置日志级别
    if (this.options.debug) {
      logger.setLevel(LogLevel.ALL);
    }

    // 初始化子模块
    this.aliasManager = createAliasManager(this.options);
    this.installer = createPackageInstaller(this.options);

    this.preparation = getProjectPreparation(this.options.projectRoot);

    // Notifications may initialize another resolver. Never await user code
    // while owning the project lock; read its inputs again afterwards.
    if (this.hooks.onAnalysisComplete) {
      this.analysisResult = await withProjectPreparation(this.preparation, () =>
        this.analyzeCurrent(),
      );
      await this.hooks.onAnalysisComplete(this.analysisResult);
    }

    await withProjectPreparation(
      this.preparation,
      async (markChanged) => {
        try {
          this.analysisResult = await this.analyzeCurrent(this.options.offline, [], false);
          this.logMissingFirstLevelPeers(this.analysisResult);
          this.assertResolved();
          if (this.options.autoInstall) {
            const installing = this.installGeneration(markChanged);
            this.installationPromise = installing;
            try {
              await installing;
            } finally {
              this.installationPromise = null;
            }
          } else {
            this.publishWithoutInstallation();
          }
          this.observeSnapshot();
        } finally {
          clearPackageJsonCache();
        }
      },
      this.observer,
    );

    await waitForProjectPreparation(this.preparation);
    await this.notifyInstallComplete();
    this.assertResolved();

    const unresolved = this.getDiagnostics().filter(
      (diagnostic) => diagnostic.severity === 'error',
    );
    if (unresolved.length > 0) {
      logger.warn(
        'Resolver has ' +
          unresolved.length +
          ' unresolved conditions: ' +
          [...new Set(unresolved.map((diagnostic) => diagnostic.code))].join(', ') +
          '. Inspect getDiagnostics() or run doctor for details.',
      );
    }
    this.logPeerWarnings();

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
  installDependencies(): Promise<void> {
    return (this.installationPromise ??= this.prepareInstallation().finally(() => {
      this.installationPromise = null;
    }));
  }

  private async prepareInstallation(): Promise<void> {
    if (!this.analysisResult || !this.installer || !this.preparation) {
      throw new Error('Resolver not initialized. Call initialize() first.');
    }
    this.preparing = true;
    try {
      await withProjectPreparation(
        this.preparation,
        async (markChanged) => {
          try {
            this.analysisResult = await this.analyzeCurrent(this.options.offline, [], false);
            this.installDiagnostics = [];
            this.assertResolved();
            if (!this.options.offline) await this.installGeneration(markChanged);
            else this.publishWithoutInstallation();
            this.observeSnapshot();
          } finally {
            clearPackageJsonCache();
          }
        },
        this.observer,
      );
    } finally {
      this.preparing = false;
    }
    await waitForProjectPreparation(this.preparation);
    await this.notifyInstallComplete();
    this.assertResolved();
    if (this.initialized) this.logPeerWarnings();
  }

  private async analyzeCurrent(
    offline = this.options.offline,
    preparedAliases: readonly AliasMapping[] = [],
    clearCache = true,
  ): Promise<AnalysisResult> {
    clearPackageJsonCache();
    this.analyzer = createDependencyAnalyzer({ ...this.options, offline }, preparedAliases);
    try {
      return await this.analyzer.analyze({ clearCache });
    } finally {
      this.analyzer = null;
    }
  }

  private publishWithoutInstallation(): void {
    const mappings = this.analysisResult!.aliasMappings;
    this.setActiveAliasMappings(mappings.filter((mapping) => mapping.installSpec === ''));
    for (const mapping of mappings) {
      if (mapping.installSpec)
        this.installDiagnostics.push({
          code: 'ALIAS_NOT_INSTALLED',
          severity: 'error',
          packageName: mapping.originalName,
          aliases: [mapping.aliasName],
          message: 'Alias is not active because installation is disabled: ' + mapping.aliasName,
        });
    }
  }

  private async installGeneration(markChanged: () => void): Promise<void> {
    const report: InstallReport = {
      success: true,
      installed: [],
      reused: [],
      failed: [],
      errors: [],
    };
    this.installResult = report;
    this.installDiagnostics = [];
    const blocked = new Set<string>();
    for (let attempt = 0; attempt < 2; attempt++) {
      const planned = this.analysisResult!.aliasMappings;
      if (planned.some((mapping) => mapping.installSpec)) markChanged();
      let result: InstallReport;
      try {
        result = await this.installer!.installAliases(planned);
      } catch (error) {
        this.setActiveAliasMappings([]);
        throw error;
      }
      report.success &&= result.success;
      for (const key of ['installed', 'reused', 'failed', 'errors'] as const) {
        report[key] = [...new Set([...report[key], ...(result[key] ?? [])])];
      }
      for (const aliasName of result.failed ?? []) {
        blocked.add(aliasName);
        this.installDiagnostics.push({
          code: 'ALIAS_INSTALL_FAILED',
          severity: 'error',
          packageName:
            planned.find((mapping) => mapping.aliasName === aliasName)?.originalName ?? aliasName,
          aliases: [aliasName],
          message: 'Alias installation failed: ' + aliasName + '. ' + result.errors.join('; '),
        });
      }

      const changed = (result.installed?.length ?? 0) > 0 || (result.failed?.length ?? 0) > 0;
      if (!changed) {
        this.setActiveAliasMappings(this.filterCompletedMappings(planned, result, false), blocked);
        return;
      }

      // A package manager reifies the whole tree, including file: consumers,
      // host packages and aliases that were reused before this install.
      // Rebuild every derived scope from current inputs, not the old mappings.
      this.analysisResult = await this.analyzeCurrent(
        result.success ? this.options.offline : true,
        this.filterCompletedMappings(planned, result, false),
        false,
      );
      const fresh = this.analysisResult.aliasMappings;
      const pending = fresh.filter(
        (mapping) => mapping.installSpec && !blocked.has(mapping.aliasName),
      );
      if (result.success && pending.length > 0 && attempt === 0) continue;
      if (result.success && pending.length > 0) {
        report.success = false;
        const message =
          'Dependency inputs changed during preparation; refusing to publish an unstable installation plan';
        report.errors.push(message);
        this.installDiagnostics.push({
          code: 'PROJECT_STATE_CHANGED',
          severity: 'error',
          packageName: this.options.dependencies.join(', '),
          message,
        });
      }
      // Preserve failed candidates for doctor/prepare reports, while keeping
      // them out of runtime rules even if a failed install left files behind.
      for (const mapping of planned) {
        if (
          blocked.has(mapping.aliasName) &&
          !fresh.some((entry) => entry.aliasName === mapping.aliasName)
        )
          fresh.push(mapping);
      }
      this.setActiveAliasMappings(
        fresh.filter((mapping) => !mapping.installSpec && !blocked.has(mapping.aliasName)),
        blocked,
      );
      if (!report.success || pending.length === 0) return;
    }
  }

  private observeSnapshot(): void {
    this.snapshotInvalidated = false;
    if (!this.snapshotObserver) {
      this.snapshotObserver = new WeakRef(this.observer);
      this.preparation!.observers.add(this.snapshotObserver);
    }
    this.captureSnapshot();
  }

  private async refreshSnapshot(): Promise<void> {
    if (!this.analysisResult || !this.aliasManager) return;
    if (this.snapshotInvalidated) {
      this.snapshotRevision = this.preparation!.revision;
      return;
    }
    const generation = this.snapshotGeneration;
    const previous = this.snapshotSignature;
    try {
      try {
        const analysis = await this.analyzeCurrent(true, this.activeMappings, false);
        if (generation !== this.snapshotGeneration) return;
        this.analysisResult = analysis;
        this.setActiveAliasMappings(
          analysis.aliasMappings.filter((mapping) => !mapping.installSpec),
        );
        const changed = previous !== this.describeSnapshot();
        if (this.initialized && changed) {
          this.snapshotInvalidated = true;
          this.setActiveAliasMappings([]);
          this.installDiagnostics.push({
            code: 'PROJECT_STATE_CHANGED',
            severity: 'error',
            packageName: this.options.dependencies.join(', '),
            message:
              'Another preparation changed active dependency rules. Call invalidate() and initialize() before building again.',
          });
        }
      } catch (error) {
        if (generation !== this.snapshotGeneration) return;
        this.snapshotInvalidated = true;
        this.setActiveAliasMappings([]);
        this.installDiagnostics.push({
          code: 'PROJECT_STATE_CHANGED',
          severity: 'error',
          packageName: this.options.dependencies.join(', '),
          message: 'Cannot refresh dependency rules after another installation: ' + String(error),
        });
      }
      this.captureSnapshot();
    } finally {
      clearPackageJsonCache();
    }
  }

  private describeSnapshot(): string {
    const mappings = this.activeMappings
      .map((mapping) => [
        mapping.originalName,
        mapping.aliasName,
        mapping.resolvedVersion,
        [...mapping.usedBy].sort(),
        mapping.workspaceEntryNames ? [...mapping.workspaceEntryNames].sort() : null,
        [...mapping.allDependents].sort(),
        mapping.importerPaths ? [...mapping.importerPaths].sort() : null,
        mapping.excludedImporterPaths ? [...mapping.excludedImporterPaths].sort() : null,
      ])
      .sort((a, b) => String(a[1]).localeCompare(String(b[1])));
    const providers = (this.aliasManager?.getAliasPathMappings() ?? [])
      .map((mapping) => {
        const cachedPath = getCachedRealPath(mapping.path);
        let path = cachedPath ?? mapping.path;
        if (cachedPath === undefined) {
          try {
            path = realpathSync(path);
          } catch {
            /* Missing providers are diagnosed by analysis. */
          }
        }
        return [mapping.aliasName, path, readPackageJsonCached(path)] as const;
      })
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    return JSON.stringify([mappings, providers]);
  }

  private captureSnapshot(): void {
    this.snapshotRevision = this.preparation!.revision;
    this.snapshotSignature = this.describeSnapshot();
    const errors = this.generationDiagnostics().filter(
      (diagnostic) => diagnostic.severity === 'error',
    );
    this.snapshotError = errors.length ? new ResolutionError(errors) : null;
  }

  private async notifyInstallComplete(): Promise<void> {
    if (!this.installResult || !this.hooks.onInstallComplete) return;
    await this.hooks.onInstallComplete(
      this.filterCompletedMappings(this.analysisResult!.aliasMappings, this.installResult, true),
    );
  }

  private snapshotCurrent(): boolean {
    if (!this.preparation) return true;
    if (
      this.preparation.writing ||
      this.preparing ||
      this.snapshotRevision !== this.preparation.revision
    ) {
      const diagnostic: ResolverDiagnostic = {
        code: 'PROJECT_STATE_CHANGED',
        severity: 'error',
        packageName: this.options.dependencies.join(', '),
        message:
          'Dependency preparation is changing this project; wait for preparation to finish before resolving modules',
      };
      if (this.options.strict) throw new ResolutionError([diagnostic]);
      return false;
    }
    if (this.options.strict && this.snapshotError) throw this.snapshotError;
    return true;
  }

  private logPeerWarnings(): void {
    const warnings = new Set<string>();
    for (const diagnostic of this.getDiagnostics()) {
      if (
        diagnostic.severity === 'warning' &&
        (diagnostic.code === 'SHARED_PEER_CONTEXT' || diagnostic.code === 'ALIAS_PEER_UNSATISFIED')
      ) {
        warnings.add(`[${diagnostic.code}] ${diagnostic.message}`);
      }
    }
    for (const warning of warnings) logger.warn(warning);
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

      const blockedPaths = new Set(
        Object.entries(mapping.peerImporterPaths ?? {})
          .filter(([aliasName]) => inactiveAliasNames.has(aliasName))
          .flatMap(([, paths]) => paths),
      );
      return {
        ...mapping,
        peerImporterPaths: Object.fromEntries(
          Object.entries(mapping.peerImporterPaths ?? {}).filter(
            ([aliasName]) => !inactiveAliasNames.has(aliasName),
          ),
        ),
        importerPaths: mapping.importerPaths.filter(
          (importerPath) =>
            !blockedPaths.has(importerPath) &&
            ![...inactiveAliasNames].some((aliasName) =>
              this.isAliasPackagePath(importerPath, aliasName),
            ),
        ),
      };
    });

    this.activeMappings = activeMappings;
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

    if (!this.snapshotCurrent()) return null;

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

    if (!this.snapshotCurrent()) return [];
    return this.aliasManager.getAliasPathMappings();
  }

  /**
   * 获取分析结果
   */
  getAnalysisResult(): AnalysisResult | null {
    return this.analysisResult;
  }

  private generationDiagnostics(): ResolverDiagnostic[] {
    return [
      ...(this.analysisResult?.diagnostics ?? []),
      ...this.installDiagnostics,
      ...(this.aliasManager?.getDiagnostics?.() ?? []),
    ];
  }

  /** Inspect unresolved conditions without parsing logs. */
  getDiagnostics(): ResolverDiagnostic[] {
    return [
      ...(this.initialized && this.preparation && (this.preparation.writing || this.preparing)
        ? [
            {
              code: 'PROJECT_STATE_CHANGED' as const,
              severity: 'error' as const,
              packageName: this.options.dependencies.join(', '),
              message: 'Dependency preparation is in progress; wait before resolving modules',
            },
          ]
        : []),
      ...this.generationDiagnostics(),
    ].map((diagnostic) =>
      Object.assign({}, diagnostic, {
        ...(diagnostic.aliases && { aliases: [...diagnostic.aliases] }),
        ...(diagnostic.requestedBy && { requestedBy: [...diagnostic.requestedBy] }),
        ...(diagnostic.importerPaths && { importerPaths: [...diagnostic.importerPaths] }),
      }),
    );
  }

  private assertResolved(): void {
    if (this.options.strict) {
      const errors = this.generationDiagnostics().filter(
        (diagnostic) => diagnostic.severity === 'error',
      );
      if (errors.length > 0) throw new ResolutionError(errors);
    }
  }

  /** Explain a request; skipHook permits side-effect-free cache validation. */
  explainResolution(
    request: string,
    importer?: string,
    options: { skipHook?: boolean } = {},
  ): ResolutionExplanation {
    if (!this.initialized || !this.aliasManager) {
      return {
        request,
        importer,
        resolved: null,
        reason: 'inactive',
        aliases: [],
        matchedPaths: [],
      };
    }
    if (!this.snapshotCurrent())
      return {
        request,
        importer,
        resolved: null,
        reason: 'inactive',
        aliases: [],
        matchedPaths: [],
      };
    if (!options.skipHook && this.hooks.beforeResolve) {
      const resolved = this.hooks.beforeResolve(request, importer);
      if (resolved !== undefined) {
        return { request, importer, resolved, reason: 'hook', aliases: [], matchedPaths: [] };
      }
    }
    return this.aliasManager.explainResolution(request, importer);
  }

  getInstallResult(): InstallReport | null {
    return (
      this.installResult && {
        ...this.installResult,
        installed: [...this.installResult.installed],
        reused: [...this.installResult.reused],
        failed: [...this.installResult.failed],
        errors: [...this.installResult.errors],
      }
    );
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
