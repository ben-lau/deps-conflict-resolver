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
import { DEFAULT_NPM_REGISTRY, LOCK_FILE_MAP } from '../constants';
import { createLogger, LogLevel } from '../utils/logger';
import {
  canonicalPath,
  clearPackageJsonCache,
  createFileSystemCache,
  fileExists,
  findProjectRoot,
  getCachedRealPath,
  iterateParentDirs,
  readPackageJsonCached,
  withFileSystemCache,
} from '../utils/fs';
import {
  currentDependencyInputs,
  DependencyInputs,
  observedRealpath,
  observeLockfile,
  withoutDependencyInputs,
} from '../utils/dependency-inputs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { createEnvironmentDetector, EnvironmentDetector } from './environment-detector';
import { createDependencyAnalyzer, DependencyAnalyzer } from './dependency-analyzer';
import { createAliasManager, AliasManager } from './alias-manager';
import { createPackageInstaller, PackageInstaller } from './package-installer';
import { NpmRegistryClient, type RegistryClient } from './registry-client';
import { ResolutionError } from './resolution-error';
import {
  getProjectPreparation,
  withProjectPreparation,
  waitForProjectPreparation,
  type ProjectPreparation,
  type PreparationObserver,
} from './project-preparation';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import { PreparationMetrics, type PreparationTimings } from '../utils/preparation-metrics';
import { preparedPlanLocation, readPreparedPlan, writePreparedPlan } from './prepared-plan';

const logger = createLogger('resolver');

/**
 * 默认配置（不包含需要自动检测的字段）
 */
const DEFAULT_OPTIONS = {
  autoInstall: true,
  debug: false,
  aliasPrefix: 'aliased-',
} as const;

interface WatchChanges {
  modifiedFiles?: ReadonlySet<string>;
  removedFiles?: ReadonlySet<string>;
}

interface WatchedFiles {
  existing: Set<string>;
  missing: Set<string>;
}

interface WatchCapture {
  key?: string;
  inputs?: DependencyInputs;
  recoveryFiles?: readonly string[];
  savePlan?: boolean;
  planFile?: string;
}

interface AnalysisSnapshot {
  result: AnalysisResult;
  revision: number;
  key: string;
  inputs: DependencyInputs;
}

export interface ModuleRedirect {
  target: string;
  source: 'alias' | 'hook';
}

interface ResolverBuild {
  redirect(request: string, importer?: string): ModuleRedirect | null;
  guardGeneration(): () => void;
  savePreparedPlan(): Promise<string>;
  assertWatchCanWait(): void;
  refreshForWatch(changes: WatchChanges): Promise<boolean>;
  closeWatch(): void;
  snapshot(): {
    analysis: AnalysisResult | null;
    providers: ReadonlyMap<string, string>;
    watchFiles: WatchedFiles | undefined;
  };
}

const builds = new WeakMap<DepsConflictResolver, ResolverBuild>();

/** Internal interface for bundler adapters. */
export function getResolverBuild(resolver: DepsConflictResolver): ResolverBuild {
  return builds.get(resolver)!;
}

function importerAmbiguityKey({ packageName, aliases, importerPaths }: ResolverDiagnostic): string {
  return JSON.stringify([
    packageName,
    aliases,
    importerPaths?.map((path) => path.replace(/\\/g, '/')),
  ]);
}

function inputKey(options: DepsConflictResolverOptions): string | undefined {
  if (process.versions.pnp) return undefined;
  const {
    HOME,
    USERPROFILE,
    NODE_PATH,
    NPM_CONFIG_REGISTRY,
    npm_config_registry,
    YARN_NPM_REGISTRY_SERVER,
  } = process.env;
  try {
    const data = JSON.stringify([
      options,
      process.cwd(),
      HOME,
      USERPROFILE,
      NODE_PATH,
      NPM_CONFIG_REGISTRY,
      npm_config_registry,
      YARN_NPM_REGISTRY_SERVER,
    ]);
    return createHash('sha256').update(data).digest('hex');
  } catch {
    return undefined;
  }
}

/**
 * 依赖解析器
 * 整合所有核心模块，提供统一的 API
 */
export class DepsConflictResolver {
  private options!: ResolvedOptions;
  private userOptions: DepsConflictResolverOptions;
  private hooks: PluginHooks;

  private environmentDetector: EnvironmentDetector | null = null;
  private readonly metrics = new PreparationMetrics();
  private readonly fileSystemCache = createFileSystemCache(this.metrics);
  private readonly trackLockWait = (milliseconds: number) => {
    this.metrics.milliseconds.lockWait += milliseconds;
  };
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
  private notificationScope?: AsyncLocalStorage<{ running: boolean }>;
  private snapshotRevision = 0;
  private snapshotError: ResolutionError | null = null;
  private snapshotGeneration = 0;
  private snapshotSignature = '';
  private snapshotInvalidated = false;
  private initialReplanNeeded = false;
  private providerVersions = new Map<string, string>();
  private watchSnapshot?: AnalysisSnapshot;
  private watchedFiles?: WatchedFiles;
  private activeMappings: AliasMapping[] = [];
  private snapshotObserver: WeakRef<PreparationObserver> | null = null;
  private readonly observer: PreparationObserver = {
    refresh: () => this.withPreparationCache(() => this.refreshSnapshot()),
  };

  constructor(userOptions: DepsConflictResolverOptions, hooks: PluginHooks = {}) {
    this.userOptions = userOptions;
    this.hooks = hooks;
    builds.set(this, {
      redirect: (request, importer) => this.redirect(request, importer),
      guardGeneration: () => this.guardGeneration(),
      savePreparedPlan: () => this.savePreparedPlan(),
      assertWatchCanWait: () => this.assertWatchCanWait(),
      refreshForWatch: (changes) => this.refreshForWatch(changes),
      closeWatch: () => {
        this.watchSnapshot = undefined;
        this.watchedFiles = undefined;
      },
      snapshot: () => ({
        analysis: this.analysisResult,
        providers: this.providerVersions,
        watchFiles: this.watchedFiles,
      }),
    });

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
    const {
      packageManager: configuredManager,
      registry: configuredRegistry,
      peerOverrides,
    } = userOptions;
    const offline = userOptions.offline === true || userOptions.preparedPlan === true;
    // 创建环境检测器
    this.environmentDetector = createEnvironmentDetector(projectRoot);

    let packageManager: 'npm' | 'yarn' | 'pnpm';
    if (!configuredManager || configuredManager === 'auto') {
      const detected = this.environmentDetector.getDetectionResult();
      packageManager = detected.packageManager;
      logger.info(
        `Auto-detected package manager: ${packageManager} (from ${detected.detectedFrom})`,
      );
    } else {
      packageManager = configuredManager;
    }

    // 检测 registry
    let registry: string;
    if (!configuredRegistry) {
      registry = await this.environmentDetector.getRegistryForPackageManager(packageManager);
      if (registry !== DEFAULT_NPM_REGISTRY) {
        logger.debug('Detected a custom registry for package metadata');
      }
    } else {
      registry = configuredRegistry;
    }

    return {
      ...DEFAULT_OPTIONS,
      dependencies: userOptions.dependencies,
      projectRoot,
      packageManager,
      registry,
      ...(configuredRegistry && { registryOverride: configuredRegistry }),
      autoInstall: offline ? false : (userOptions.autoInstall ?? DEFAULT_OPTIONS.autoInstall),
      offline,
      ...(userOptions.preparedPlan && { preparedPlan: true }),
      strict: userOptions.strict ?? false,
      debug: userOptions.debug ?? DEFAULT_OPTIONS.debug,
      aliasPrefix: userOptions.aliasPrefix ?? DEFAULT_OPTIONS.aliasPrefix,
      excludeRedirects: userOptions.excludeRedirects ?? {},
      includeRedirects: userOptions.includeRedirects ?? {},
      peerOverrides: peerOverrides ? { ...peerOverrides } : {},
    };
  }

  /**
   * 初始化解析器
   */
  initialize(): Promise<void> {
    return this.initializePreparation();
  }

  private async initializePreparation(watch?: WatchCapture): Promise<void> {
    if (this.initialized) {
      if (this.preparation) await waitForProjectPreparation(this.preparation);
      this.snapshotCurrent();
      return;
    }

    const initialization = (this.initializationPromise ??= this.withPreparationCache(() =>
      watch?.inputs
        ? watch.inputs.record(() => this.initializeGeneration(watch))
        : this.initializeGeneration(watch),
    ));
    try {
      await initialization;
    } catch (error) {
      // Only clear the promise that failed. A caller may have started a retry
      // after another concurrent caller observed the rejection.
      if (this.initializationPromise === initialization) {
        if (watch) watch.recoveryFiles = this.analysisResult?.watchFiles;
        this.initializationPromise = null;
        this.rollbackGeneration();
      }
      throw error;
    }
  }

  private watchKey(): string | undefined {
    if (this.hooks.onAnalysisComplete || this.hooks.onInstallComplete) return undefined;
    return inputKey(this.userOptions);
  }

  private assertWatchCanWait(): void {
    if (this.notificationScope?.getStore()?.running) {
      throw new Error(
        'Cannot refresh watch rules from an active preparation hook on the same resolver',
      );
    }
  }

  private async refreshForWatch({ modifiedFiles, removedFiles }: WatchChanges): Promise<boolean> {
    const previous = this.watchSnapshot;
    if (
      previous?.inputs.reusable &&
      previous.key === this.watchKey() &&
      [...(modifiedFiles ?? []), ...(removedFiles ?? [])].every(
        (file) => isAbsolute(file) && !previous.inputs.includes(file),
      )
    ) {
      try {
        if (await this.reuseWatchSnapshot(previous)) return true;
      } catch {
        // A fresh preparation handles errors with the normal resolver policy.
      }
    }

    // Let an earlier caller finish its preparation, including notifications.
    // That caller receives its own error; this watch cycle gets a fresh attempt.
    while (true) {
      const pending =
        (this.initialized ? null : this.initializationPromise) ?? this.installationPromise;
      if (!pending) break;
      this.assertWatchCanWait();
      await pending.catch(() => undefined);
    }
    const previousFiles = this.watchedFiles;
    const key = this.watchKey();
    const capture: WatchCapture = {
      key,
      inputs: key === undefined ? undefined : new DependencyInputs(),
    };
    try {
      if (this.initialized) this.invalidate();
      await this.initializePreparation(capture);
    } catch (error) {
      this.withPreparationCache(() => this.recoverWatchFiles(previousFiles, capture.recoveryFiles));
      throw error;
    }
    return false;
  }

  private async reuseWatchSnapshot(snapshot: AnalysisSnapshot): Promise<boolean> {
    const preparation = this.preparation;
    if (!preparation || !this.initialized) return false;
    const isCurrent = () =>
      this.initialized &&
      !this.installationPromise &&
      this.watchSnapshot === snapshot &&
      this.analysisResult === snapshot.result &&
      snapshot.key === this.watchKey() &&
      preparation.revision === snapshot.revision &&
      !this.snapshotInvalidated &&
      this.snapshotCurrent();
    const reused = await withProjectPreparation(
      preparation,
      async () => {
        if (!isCurrent() || !snapshot.inputs.matches()) return false;
        // Build inputs can change an importer's path or owning manifest even
        // when the dependency analysis and its rules are still current.
        clearPackageJsonCache(this.fileSystemCache);
        this.aliasManager?.clearImporterCache();
        return true;
      },
      undefined,
      'read',
      this.trackLockWait,
    );
    if (!reused) return false;
    await waitForProjectPreparation(preparation);
    return isCurrent();
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
    this.initialReplanNeeded = false;
    this.providerVersions = new Map();
    this.watchSnapshot = undefined;
    clearPackageJsonCache(this.fileSystemCache);
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

  private withPreparationCache<T>(task: () => T): T {
    return withoutDependencyInputs(() => withFileSystemCache(this.fileSystemCache, task));
  }

  private async initializeGeneration(watch?: WatchCapture): Promise<void> {
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
      physicalRoot = observedRealpath(validRoot);
    } catch {
      /* Retain the validated root. */
    }
    this.options = await this.metrics.measureAsync('environment', () =>
      this.resolveOptions(this.userOptions, physicalRoot),
    );

    // 设置日志级别
    if (this.options.debug) {
      logger.setLevel(LogLevel.ALL);
    }

    // 初始化子模块
    this.aliasManager = createAliasManager(this.options, this.fileSystemCache);
    this.installer = createPackageInstaller(this.options);

    this.preparation = getProjectPreparation(this.options.projectRoot);

    const onAnalysisComplete = this.hooks.onAnalysisComplete;
    const candidate = onAnalysisComplete
      ? await this.notifyAnalysisComplete(this.preparation, onAnalysisComplete)
      : undefined;

    const preparation = this.preparation;
    const prepare = async (analysis?: AnalysisSnapshot) => {
      // Keep the lock through installation and publication.
      await withProjectPreparation(
        preparation,
        (markChanged) => this.prepareInitialSnapshot(markChanged, watch, analysis),
        this.observer,
        this.options.autoInstall ? 'write' : 'read',
        this.trackLockWait,
      );
      await waitForProjectPreparation(preparation);
    };
    await prepare(candidate);
    // A writer can introduce an alias that the observer cannot install under
    // the writer's lock. Give the initial preparation one chance to catch up.
    const replanned = this.initialReplanNeeded;
    if (replanned) await prepare();
    await this.notifyInstallComplete();
    if (!replanned && this.initialReplanNeeded) await prepare();
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
    logger.debug('Preparation timings:', this.getTimings());
    logger.info('Dependencies resolver initialized');
  }

  private async notifyAnalysisComplete(
    preparation: ProjectPreparation,
    hook: NonNullable<PluginHooks['onAnalysisComplete']>,
  ): Promise<AnalysisSnapshot | undefined> {
    const { result, candidate } = await withProjectPreparation(
      preparation,
      async () => {
        const key = inputKey(this.options);
        if (key === undefined) return { result: await this.analyzeCurrent() };
        const inputs = new DependencyInputs();
        const analysis = await inputs.record(() => this.analyzeCurrent());
        const reusable =
          inputs.reusable && analysis.aliasMappings.every(({ installSpec }) => !installSpec);
        return {
          result: analysis,
          candidate: reusable
            ? { result: analysis, inputs, key, revision: preparation.revision }
            : undefined,
        };
      },
      undefined,
      'read',
      this.trackLockWait,
    );
    // Keep the reusable candidate separate from user code. Hooks can also
    // prepare the same workspace, so the notification runs outside the lock.
    const observed = structuredClone(result);
    this.analysisResult = observed;
    await this.runPreparationHook(() => hook.call(this.hooks, observed));
    return candidate;
  }

  private async prepareInitialSnapshot(
    markChanged: () => void,
    watch?: WatchCapture,
    candidate?: AnalysisSnapshot,
  ): Promise<void> {
    try {
      const registryClient = new NpmRegistryClient(this.metrics, this.options);
      const cached = this.hooks.onAnalysisComplete ? undefined : this.loadPreparedPlan();
      this.analysisResult =
        cached ??
        (candidate &&
        candidate.revision === this.preparation?.revision &&
        candidate.key === inputKey(this.options) &&
        candidate.inputs.matches()
          ? candidate.result
          : await this.analyzeCurrent({ clearCache: false, registryClient }));
      this.assertResolved();
      if (!this.options.autoInstall) {
        this.publishWithoutInstallation();
      } else {
        const installing = this.installGeneration(markChanged, registryClient);
        this.installationPromise = installing;
        try {
          await installing;
        } finally {
          this.installationPromise = null;
        }
      }
      this.logMissingFirstLevelPeers(this.analysisResult);
      this.observeSnapshot();
      if (watch) {
        this.recordWatchFiles();
        if (watch.savePlan) {
          this.assertResolved();
          const file = preparedPlanLocation(this.options, this.preparation!.owner);
          if (!file || !watch.inputs?.matches())
            throw new Error('Could not record a stable dependency plan for the installed project');
          await writePreparedPlan(file, { analysis: this.analysisResult, inputs: watch.inputs });
          watch.planFile = file;
        }
        if (watch.inputs?.reusable && watch.key !== undefined && watch.key === this.watchKey()) {
          this.watchSnapshot = {
            result: this.analysisResult,
            revision: this.snapshotRevision,
            key: watch.key,
            inputs: watch.inputs,
          };
        }
      }
    } finally {
      clearPackageJsonCache();
    }
  }

  private loadPreparedPlan(): AnalysisResult | undefined {
    if (!this.options.preparedPlan) return undefined;
    const file = preparedPlanLocation(this.options, this.preparation!.owner);
    const plan = file
      ? this.metrics.measure('planValidation', () => readPreparedPlan(file))
      : undefined;
    if (!plan) {
      this.metrics.counts.planMisses++;
      logger.info(
        'No current dependency plan. Running offline analysis. Run prepare --write-plan to refresh it.',
      );
      return undefined;
    }
    this.metrics.counts.planHits++;
    currentDependencyInputs()?.merge(plan.inputs);
    return plan.analysis;
  }

  private async savePreparedPlan(): Promise<string> {
    if (!this.initialized)
      throw new Error('Initialize the resolver before saving a dependency plan');
    const verifier = new DepsConflictResolver({
      ...this.userOptions,
      projectRoot: this.options.projectRoot,
      offline: true,
      autoInstall: false,
      strict: true,
      preparedPlan: false,
    });
    const watch: WatchCapture = { inputs: new DependencyInputs(), savePlan: true };
    try {
      await verifier.initializePreparation(watch);
      return watch.planFile!;
    } finally {
      this.metrics.add(verifier.metrics);
    }
  }

  private collectLockfiles(projectRoot: string, owner: string): WatchedFiles {
    const existing = new Set<string>();
    const missing = new Set<string>();
    let inPreparationOwner = true;
    for (const directory of iterateParentDirs(projectRoot)) {
      for (const name of Object.keys(LOCK_FILE_MAP)) {
        const file = join(directory, name);
        if (observeLockfile(file)) existing.add(file);
        else if (inPreparationOwner) missing.add(file);
      }
      if (directory === owner) inPreparationOwner = false;
    }
    return { existing, missing };
  }

  private recordWatchFiles(): void {
    const watched = this.collectLockfiles(this.options.projectRoot, this.preparation!.owner);
    const analyzed = this.analysisResult?.watchFiles ?? [];
    if (this.snapshotError) {
      this.addRecoveryWatchFiles(watched, this.watchedFiles, analyzed);
    } else {
      for (const file of analyzed) watched.existing.add(file);
    }
    this.watchedFiles = watched;
  }

  private recoverWatchFiles(
    previous: WatchedFiles | undefined,
    partial: readonly string[] = [],
  ): void {
    const requestedRoot = resolvePath(this.userOptions.projectRoot ?? process.cwd());
    const root = canonicalPath(findProjectRoot(requestedRoot) ?? requestedRoot);
    const owner = getProjectPreparation(root).owner;
    const watched = this.collectLockfiles(root, owner);
    // These paths only wake up a later compilation. The failed generation
    // cannot supply a reusable analysis snapshot.
    this.addRecoveryWatchFiles(watched, previous, [
      join(requestedRoot, 'package.json'),
      join(root, 'package.json'),
      join(owner, 'package.json'),
      ...partial,
    ]);
    this.watchedFiles = watched;
  }

  private addRecoveryWatchFiles(
    watched: WatchedFiles,
    previous: WatchedFiles | undefined,
    files: readonly string[],
  ): void {
    for (const file of new Set([
      ...(previous?.existing ?? []),
      ...(previous?.missing ?? []),
      ...files,
    ])) {
      if (watched.existing.has(file) || watched.missing.has(file)) continue;
      (fileExists(file) ? watched.existing : watched.missing).add(file);
    }
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
    return (this.installationPromise ??= this.withPreparationCache(() =>
      this.prepareInstallation(),
    ).finally(() => {
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
            const registryClient = new NpmRegistryClient(this.metrics, this.options);
            this.watchSnapshot = undefined;
            this.analysisResult = await this.analyzeCurrent({ clearCache: false, registryClient });
            this.installDiagnostics = [];
            this.assertResolved();
            if (!this.options.offline) await this.installGeneration(markChanged, registryClient);
            else this.publishWithoutInstallation();
            this.observeSnapshot();
            if (this.watchedFiles) this.recordWatchFiles();
          } finally {
            clearPackageJsonCache();
          }
        },
        this.observer,
        this.options.offline ? 'read' : 'write',
        this.trackLockWait,
      );
    } finally {
      this.preparing = false;
    }
    await waitForProjectPreparation(this.preparation);
    await this.notifyInstallComplete();
    this.assertResolved();
    if (this.initialized) this.logPeerWarnings();
  }

  private async analyzeCurrent({
    offline = this.options.offline,
    preparedAliases = [],
    clearCache = true,
    registryClient,
  }: {
    offline?: boolean;
    preparedAliases?: readonly AliasMapping[];
    clearCache?: boolean;
    registryClient?: RegistryClient;
  } = {}): Promise<AnalysisResult> {
    this.metrics.counts.analysisPasses++;
    clearPackageJsonCache();
    this.analyzer = createDependencyAnalyzer(
      { ...this.options, offline },
      preparedAliases,
      registryClient ?? new NpmRegistryClient(this.metrics, this.options),
    );
    try {
      const analyzer = this.analyzer;
      return await this.metrics.measureAsync('analysis', () =>
        analyzer.analyze({ clearCache, metrics: this.metrics }),
      );
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

  private async installGeneration(
    markChanged: () => void,
    registryClient: RegistryClient,
  ): Promise<void> {
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
      if (planned.some((mapping) => mapping.installSpec)) {
        currentDependencyInputs()?.invalidate();
        markChanged();
      }
      let result: InstallReport;
      try {
        result = await this.metrics.measureAsync('install', () =>
          this.installer!.installAliases(planned),
        );
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

      const verified = this.filterCompletedMappings(planned, result, false);
      const requiresReanalysis =
        (result.installed?.length ?? 0) > 0 ||
        (result.failed?.length ?? 0) > 0 ||
        verified.some(({ installSpec }) => installSpec);
      if (!requiresReanalysis) {
        this.setActiveAliasMappings(verified, blocked);
        return;
      }

      // Installation can reconcile the whole tree. Reusing a planned alias
      // also changes the set of verified providers for scopes and diagnostics.
      this.analysisResult = await this.analyzeCurrent({
        offline: !result.success || this.options.offline,
        preparedAliases: verified,
        clearCache: false,
        registryClient,
      });
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
    this.initialReplanNeeded = false;
    if (!this.snapshotObserver) {
      this.snapshotObserver = new WeakRef(this.observer);
      this.preparation!.observers.add(this.snapshotObserver);
    }
    this.captureSnapshot();
  }

  private async refreshSnapshot(): Promise<void> {
    if (!this.analysisResult || !this.aliasManager) return;
    this.watchSnapshot = undefined;
    if (this.snapshotInvalidated) {
      this.snapshotRevision = this.preparation!.revision;
      return;
    }
    const generation = this.snapshotGeneration;
    const previous = this.snapshotSignature;
    try {
      try {
        const analysis = await this.analyzeCurrent({
          offline: true,
          preparedAliases: this.activeMappings,
          clearCache: false,
        });
        if (generation !== this.snapshotGeneration) return;
        this.initialReplanNeeded = false;
        if (!this.options.offline) {
          for (const diagnostic of analysis.diagnostics ?? []) {
            if (diagnostic.code !== 'OFFLINE_ALIAS_MISSING') continue;
            this.initialReplanNeeded = !this.initialized && this.options.autoInstall;
            diagnostic.code = 'PROJECT_STATE_CHANGED';
            diagnostic.message =
              'Another preparation changed the project and no verified alias for ' +
              diagnostic.packageName +
              ' is installed';
          }
        }
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
        this.initialReplanNeeded = false;
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
      if (this.watchedFiles) this.recordWatchFiles();
    } finally {
      clearPackageJsonCache();
    }
  }

  private describeSnapshot(providers = this.describeProviders()): string {
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
        [...new Set(this.options.includeRedirects[mapping.originalName])].sort(),
        [...new Set(this.options.excludeRedirects[mapping.originalName])].sort(),
      ])
      .sort((a, b) => String(a[1]).localeCompare(String(b[1])));
    return createHash('sha256')
      .update(JSON.stringify([mappings, providers]))
      .digest('hex');
  }

  private describeProviders() {
    return (this.aliasManager?.getAliasPathMappings() ?? [])
      .map((mapping) => {
        const cachedPath = getCachedRealPath(mapping.path);
        let path = cachedPath ?? mapping.path;
        if (cachedPath === undefined) {
          try {
            path = observedRealpath(path);
          } catch {
            /* Missing providers are diagnosed by analysis. */
          }
        }
        return [mapping.aliasName, path, readPackageJsonCached(path)] as const;
      })
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  }

  private captureSnapshot(): void {
    this.snapshotRevision = this.preparation!.revision;
    const providers = this.metrics.measure('verify', () => this.describeProviders());
    this.snapshotSignature = this.describeSnapshot(providers);
    this.providerVersions = new Map(
      providers.map(([name, path, manifest]) => [
        name,
        createHash('sha256')
          .update(JSON.stringify([path, manifest]))
          .digest('hex'),
      ]),
    );
    const errors = this.generationDiagnostics().filter(
      (diagnostic) => diagnostic.severity === 'error',
    );
    this.snapshotError = errors.length ? new ResolutionError(errors) : null;
  }

  private async notifyInstallComplete(): Promise<void> {
    const hook = this.hooks.onInstallComplete;
    if (!this.installResult || !hook) return;
    const completed = this.filterCompletedMappings(
      this.analysisResult!.aliasMappings,
      this.installResult,
      true,
    );
    await this.runPreparationHook(() => hook.call(this.hooks, structuredClone(completed)));
    // A hook can queue more preparation work while the lock is released.
    await waitForProjectPreparation(this.preparation!);
  }

  private async runPreparationHook(hook: () => void | Promise<void>): Promise<void> {
    const scope = (this.notificationScope ??= new AsyncLocalStorage());
    const notification = { running: true };
    try {
      await scope.run(notification, hook);
    } finally {
      notification.running = false;
    }
  }

  private snapshotCurrent(): boolean {
    if (!this.preparation) return true;
    if (
      this.preparation.writing ||
      this.preparing ||
      this.snapshotRevision !== this.preparation.revision
    ) {
      if (this.options.strict) {
        throw this.projectChanged(
          'Dependency preparation is changing this project; wait for preparation to finish before resolving modules',
        );
      }
      return false;
    }
    if (this.options.strict && this.snapshotError) throw this.snapshotError;
    return true;
  }

  private guardGeneration(): () => void {
    this.snapshotCurrent();
    const revision = this.preparation?.revision;
    const generation = this.snapshotGeneration;
    return () => {
      if (revision !== this.preparation?.revision || generation !== this.snapshotGeneration) {
        throw this.projectChanged('Dependencies changed during compilation. Run the build again.');
      }
      this.snapshotCurrent();
    };
  }

  private projectChanged(message: string): ResolutionError {
    return new ResolutionError([
      {
        code: 'PROJECT_STATE_CHANGED',
        severity: 'error',
        packageName: this.options.dependencies.join(', '),
        message,
      },
    ]);
  }

  private logPeerWarnings(): void {
    const warnings = new Set<string>();
    for (const diagnostic of this.getDiagnostics()) {
      if (
        diagnostic.severity === 'warning' &&
        (diagnostic.code === 'SHARED_PEER_CONTEXT' ||
          diagnostic.code === 'ALIAS_PEER_UNSATISFIED' ||
          diagnostic.code === 'TRANSITIVE_PEER_CONFLICT')
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
    return this.redirect(request, importer)?.target ?? null;
  }

  private redirect(request: string, importer?: string): ModuleRedirect | null {
    if (!this.initialized || !this.aliasManager) {
      return null;
    }

    if (!this.snapshotCurrent()) return null;

    // 检查钩子
    if (this.hooks.beforeResolve) {
      const hookResult = this.hooks.beforeResolve(request, importer);
      if (hookResult !== undefined) {
        return hookResult === null ? null : { target: hookResult, source: 'hook' };
      }
    }

    const target = this.aliasManager.resolveModule({ request, importer });
    return target === null ? null : { target, source: 'alias' };
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

  /** Stable identity of the active rules and their installed providers. */
  getResolutionFingerprint(): string {
    return this.initialized && this.snapshotCurrent() ? this.snapshotSignature : '';
  }

  /**
   * 获取分析结果
   */
  getAnalysisResult(): AnalysisResult | null {
    return structuredClone(this.analysisResult);
  }

  private generationDiagnostics(): ResolverDiagnostic[] {
    const analysis = this.analysisResult?.diagnostics ?? [];
    const runtime = this.aliasManager?.getDiagnostics?.() ?? [];
    if (runtime.length === 0) return [...analysis, ...this.installDiagnostics];

    // Keep the initialization diagnostic with its configured requesters when
    // an actual import encounters the same set of rules at the same path.
    const knownAmbiguities = new Set(
      analysis.filter(({ code }) => code === 'AMBIGUOUS_IMPORTER').map(importerAmbiguityKey),
    );
    return [
      ...analysis,
      ...this.installDiagnostics,
      ...runtime.filter(
        (entry) =>
          entry.code !== 'AMBIGUOUS_IMPORTER' || !knownAmbiguities.has(importerAmbiguityKey(entry)),
      ),
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
      if (errors.length > 0)
        throw new ResolutionError(errors, {
          aliases: this.analysisResult?.aliasMappings ?? [],
          diagnostics: this.getDiagnostics(),
          installation: this.getInstallResult(),
        });
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

  /** Cumulative preparation statistics, including repeated analysis during watch. */
  getTimings(): PreparationTimings {
    return this.metrics.snapshot();
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
