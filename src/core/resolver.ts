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
  createFileSystemCache,
  findProjectRoot,
  getCachedRealPath,
  readPackageJsonCached,
  withFileSystemCache,
} from '../utils/fs';
import {
  currentDependencyInputs,
  DependencyInputs,
  observedRealpath,
  withoutDependencyInputs,
} from '../utils/dependency-inputs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { createEnvironmentDetector } from './environment-detector';
import { createDependencyAnalyzer } from './dependency-analyzer';
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
import { resolve as resolvePath } from 'node:path';
import { PreparationMetrics, type PreparationTimings } from '../utils/preparation-metrics';
import {
  preparePlanDirectory,
  preparedPlanLocation,
  readPreparedPlan,
  writePreparedPlan,
  type PlanWriteResult,
} from './prepared-plan';
import {
  DependencyWatch,
  observeProjectLockfiles,
  type AnalysisSnapshot,
  type WatchChanges,
  type WatchedFiles,
} from './dependency-watch';

const logger = createLogger('resolver');

/**
 * 默认配置（不包含需要自动检测的字段）
 */
const DEFAULT_OPTIONS = {
  autoInstall: true,
  debug: false,
  aliasPrefix: 'aliased-',
} as const;

interface WatchCapture {
  key?: string;
  inputs?: DependencyInputs;
  recoveryFiles?: readonly string[];
}

interface PlanCapture {
  inputs: DependencyInputs;
  result?: PlanWriteResult;
}

interface ResolutionDraft {
  analysis: AnalysisResult | null;
  matcher: AliasManager | null;
  activeMappings: AliasMapping[];
  installation: InstallReport | null;
  installDiagnostics: ResolverDiagnostic[];
}

interface PublishedGeneration {
  readonly rules: Readonly<ResolutionDraft>;
  readonly revision: number;
  readonly signature: string;
  readonly providers: ReadonlyMap<string, string>;
  readonly error: ResolutionError | null;
  readonly invalidated: boolean;
}

function emptyDraft(): ResolutionDraft {
  return {
    analysis: null,
    matcher: null,
    activeMappings: [],
    installation: null,
    installDiagnostics: [],
  };
}

export interface ModuleRedirect {
  target: string;
  source: 'alias' | 'hook';
}

interface ResolverBuild {
  redirect(request: string, importer?: string): ModuleRedirect | null;
  guardGeneration(): () => void;
  initializeAndSavePreparedPlan(): Promise<PlanWriteResult | undefined>;
  savePreparedPlan(): Promise<PlanWriteResult | undefined>;
  assertWatchCanWait(): void;
  refreshForWatch(changes: WatchChanges): Promise<boolean>;
  closeWatch(): void;
  snapshot(): {
    analysis: AnalysisResult | null;
    providers: ReadonlyMap<string, string>;
    watchFiles: WatchedFiles | undefined;
  };
}

const buildAccess = Symbol();

/** Internal interface for bundler adapters. */
export function getResolverBuild(resolver: DepsConflictResolver): ResolverBuild {
  return resolver[buildAccess];
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

  private readonly metrics = new PreparationMetrics();
  private readonly fileSystemCache = createFileSystemCache(this.metrics);
  private readonly trackLockWait = (milliseconds: number) => {
    this.metrics.milliseconds.lockWait += milliseconds;
  };
  private installer: PackageInstaller | null = null;

  private draft = emptyDraft();
  private published: PublishedGeneration | null = null;
  private initialized = false;
  private initializationPromise: Promise<void> | null = null;
  private installationPromise: Promise<void> | null = null;
  private preparing = false;
  private preparation: ProjectPreparation | null = null;
  private notificationScope?: AsyncLocalStorage<{ running: boolean }>;
  private snapshotGeneration = 0;
  private initialReplanNeeded = false;
  private readonly watch = new DependencyWatch();
  private snapshotObserver: WeakRef<PreparationObserver> | null = null;
  private readonly observer: PreparationObserver = {
    refresh: () => this.withPreparationCache(() => this.refreshSnapshot()),
  };

  readonly [buildAccess]: ResolverBuild = {
    redirect: (request, importer) => this.redirect(request, importer),
    guardGeneration: () => this.guardGeneration(),
    initializeAndSavePreparedPlan: () => this.initializeAndSavePreparedPlan(),
    savePreparedPlan: () => this.savePreparedPlan(),
    assertWatchCanWait: () => this.assertWatchCanWait(),
    refreshForWatch: (changes) => this.refreshForWatch(changes),
    closeWatch: () => this.watch.close(),
    snapshot: () => ({
      analysis: this.visibleRules().analysis,
      providers: this.published?.providers ?? new Map(),
      watchFiles: this.watch.files,
    }),
  };

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
    const {
      packageManager: configuredManager,
      registry: configuredRegistry,
      peerOverrides,
    } = userOptions;
    const offline = userOptions.offline === true || userOptions.preparedPlan === true;
    // 创建环境检测器
    const environment = createEnvironmentDetector(projectRoot);

    let packageManager: 'npm' | 'yarn' | 'pnpm';
    if (!configuredManager || configuredManager === 'auto') {
      const detected = environment.getDetectionResult();
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
      registry = await environment.getRegistryForPackageManager(packageManager);
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

  private async initializePreparation(watch?: WatchCapture, plan?: PlanCapture): Promise<void> {
    if (this.initialized) {
      if (this.preparation) await waitForProjectPreparation(this.preparation);
      this.snapshotCurrent();
      return;
    }

    const inputs = plan?.inputs ?? watch?.inputs;
    const initialize = () => this.initializeGeneration(watch, plan);
    const initialization = (this.initializationPromise ??= this.withPreparationCache(() =>
      inputs ? inputs.record(initialize) : initialize(),
    ));
    try {
      await initialization;
    } catch (error) {
      // Only clear the promise that failed. A caller may have started a retry
      // after another concurrent caller observed the rejection.
      if (this.initializationPromise === initialization) {
        if (watch) watch.recoveryFiles = this.draft.analysis?.watchFiles;
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

  private async refreshForWatch(changes: WatchChanges): Promise<boolean> {
    const previous = this.watch.candidate(this.watchKey(), changes);
    if (previous) {
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
    const previousFiles = this.watch.files;
    const key = this.watchKey();
    const capture: WatchCapture = {
      key,
      inputs: key === undefined ? undefined : new DependencyInputs(),
    };
    try {
      if (this.initialized) this.invalidate();
      await this.initializePreparation(capture);
    } catch (error) {
      const requestedRoot = resolvePath(this.userOptions.projectRoot ?? process.cwd());
      this.withPreparationCache(() =>
        this.watch.recover(requestedRoot, previousFiles, capture.recoveryFiles),
      );
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
      this.watch.snapshot === snapshot &&
      this.published?.rules.analysis === snapshot.result &&
      snapshot.key === this.watchKey() &&
      preparation.revision === snapshot.revision &&
      !this.published.invalidated &&
      this.snapshotCurrent();
    const reused = await withProjectPreparation(
      preparation,
      async () => {
        if (!isCurrent() || !this.metrics.measure('verify', () => snapshot.inputs.matches()))
          return false;
        // Build inputs can change an importer's path or owning manifest even
        // when the dependency analysis and its rules are still current.
        clearPackageJsonCache(this.fileSystemCache);
        this.published?.rules.matcher?.clearImporterCache();
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
    this.published = null;
    this.initialReplanNeeded = false;
    this.watch.snapshot = undefined;
    clearPackageJsonCache(this.fileSystemCache);
    this.snapshotGeneration++;
    this.draft.matcher?.clear?.();
    this.draft = emptyDraft();
    this.installer = null;
  }

  private withPreparationCache<T>(task: () => T): T {
    return withoutDependencyInputs(() => withFileSystemCache(this.fileSystemCache, task));
  }

  private async initializeGeneration(watch?: WatchCapture, plan?: PlanCapture): Promise<void> {
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
    this.draft.matcher = createAliasManager(this.options, this.fileSystemCache);
    this.installer = createPackageInstaller(this.options, () => {
      this.metrics.counts.packageManagerRuns++;
    });

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
        (markChanged) => this.prepareInitialSnapshot(markChanged, analysis, watch, plan),
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
    this.draft.analysis = observed;
    await this.runPreparationHook(() => hook.call(this.hooks, observed));
    return candidate;
  }

  private async prepareInitialSnapshot(
    markChanged: () => void,
    candidate?: AnalysisSnapshot,
    watch?: WatchCapture,
    plan?: PlanCapture,
  ): Promise<void> {
    try {
      const planFile = plan && (await this.beginPreparedPlan(plan));
      const registryClient = new NpmRegistryClient(this.metrics, this.options);
      const cached = this.hooks.onAnalysisComplete ? undefined : this.loadPreparedPlan();
      this.draft.analysis =
        cached ??
        (candidate &&
        candidate.revision === this.preparation?.revision &&
        candidate.key === inputKey(this.options) &&
        candidate.inputs.matches()
          ? candidate.result
          : await this.analyzeCurrent({ clearCache: false, registryClient }));
      this.assertResolved(null);
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
      this.logMissingFirstLevelPeers(this.draft.analysis);
      this.observeSnapshot();
      if (watch) this.recordWatchFiles();
      if (planFile && !this.generationDiagnostics().some(({ severity }) => severity === 'error')) {
        observeProjectLockfiles(this.options.projectRoot, this.preparation!.owner);
        plan.result = await this.persistPreparedPlan(planFile, plan.inputs, this.draft.analysis);
      }
      if (watch) {
        if (watch.inputs?.reusable && watch.key !== undefined && watch.key === this.watchKey()) {
          this.watch.snapshot = {
            result: this.draft.analysis,
            revision: this.published!.revision,
            key: watch.key,
            inputs: watch.inputs,
          };
        }
      }
    } finally {
      clearPackageJsonCache();
    }
  }

  private async beginPreparedPlan(plan: PlanCapture): Promise<string | undefined> {
    // Creating node_modules for a hoisted project changes Node's lookup
    // observations. Make the output directory before capturing the graph.
    const file = preparedPlanLocation(this.options, this.preparation!.owner);
    if (!file) {
      plan.result = {
        failure: {
          code: 'PLAN_UNSUPPORTED',
          message: 'Dependency plans require standard node_modules package lookup',
        },
      };
      return undefined;
    }
    try {
      await preparePlanDirectory(file);
      return file;
    } catch (error) {
      plan.result = { failure: { code: 'PLAN_WRITE_FAILED', message: String(error) } };
      return undefined;
    }
  }

  private async persistPreparedPlan(
    file: string,
    inputs: DependencyInputs,
    analysis: AnalysisResult,
  ): Promise<PlanWriteResult> {
    const observations = inputs.observationCount;
    this.metrics.counts.planObservations += observations;
    if (inputs.atCapacity) {
      return {
        failure: {
          code: 'PLAN_INPUT_LIMIT',
          observations,
          observationLimit: inputs.limit,
          message:
            'Dependency plan exceeded its input limit. This project can use ordinary offline analysis.',
        },
      };
    }
    if (!this.metrics.measure('planValidation', () => inputs.matches())) {
      return {
        failure: {
          code: 'PLAN_INPUT_CHANGED',
          observations,
          message:
            'Could not verify a stable installed dependency tree. Retry after dependency changes finish.',
        },
      };
    }
    try {
      await this.metrics.measureAsync('planWrite', () =>
        writePreparedPlan(file, { analysis, inputs }),
      );
      return { file };
    } catch (error) {
      return { failure: { code: 'PLAN_WRITE_FAILED', observations, message: String(error) } };
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
    this.metrics.counts.planObservations += plan.inputs.observationCount;
    currentDependencyInputs()?.merge(plan.inputs);
    return plan.analysis;
  }

  private async initializeAndSavePreparedPlan(): Promise<PlanWriteResult | undefined> {
    if (!this.userOptions.offline || this.initializationPromise)
      throw new Error('Write a plan during fresh offline preparation');
    const plan: PlanCapture = { inputs: new DependencyInputs('plan') };
    await this.initializePreparation(undefined, plan);
    return plan.result;
  }

  private async savePreparedPlan(): Promise<PlanWriteResult | undefined> {
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
    try {
      return await verifier.initializeAndSavePreparedPlan();
    } finally {
      this.metrics.add(verifier.metrics);
    }
  }

  private recordWatchFiles(): void {
    this.watch.recordFiles(
      this.options.projectRoot,
      this.preparation!.owner,
      this.draft.analysis,
      this.options.dependencies,
      this.draft.activeMappings,
      !!this.published?.error,
    );
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
    if ((!this.initialized && !this.draft.analysis) || !this.installer || !this.preparation) {
      throw new Error('Resolver not initialized. Call initialize() first.');
    }
    this.preparing = true;
    try {
      await withProjectPreparation(
        this.preparation,
        async (markChanged) => {
          try {
            const registryClient = new NpmRegistryClient(this.metrics, this.options);
            this.watch.snapshot = undefined;
            this.draft = { ...emptyDraft(), installation: this.draft.installation };
            this.draft.analysis = await this.analyzeCurrent({ clearCache: false, registryClient });
            this.assertResolved(null);
            if (!this.options.offline) await this.installGeneration(markChanged, registryClient);
            else this.publishWithoutInstallation();
            this.observeSnapshot();
            if (this.watch.files) this.recordWatchFiles();
          } catch (error) {
            this.draft.activeMappings = [];
            this.draft.matcher = null;
            if (!(error instanceof ResolutionError && error.preparation)) {
              this.draft.installDiagnostics.push({
                code: 'PROJECT_STATE_CHANGED',
                severity: 'error',
                packageName: this.options.dependencies.join(', '),
                message: 'Could not prepare dependency rules: ' + String(error),
              });
            }
            this.captureSnapshot(true);
            throw error;
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
    const analyzer = createDependencyAnalyzer(
      { ...this.options, offline },
      preparedAliases,
      registryClient ?? new NpmRegistryClient(this.metrics, this.options),
    );
    return this.metrics.measureAsync('analysis', () =>
      analyzer.analyze({ clearCache, metrics: this.metrics }),
    );
  }

  private publishWithoutInstallation(): void {
    const mappings = this.draft.analysis!.aliasMappings;
    this.setActiveAliasMappings(mappings.filter((mapping) => mapping.installSpec === ''));
    for (const mapping of mappings) {
      if (mapping.installSpec)
        this.draft.installDiagnostics.push({
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
    this.draft.installation = report;
    this.draft.installDiagnostics = [];
    const blocked = new Set<string>();
    for (let attempt = 0; attempt < 2; attempt++) {
      const planned = this.draft.analysis!.aliasMappings;
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
        this.draft.installDiagnostics.push({
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
      this.draft.analysis = await this.analyzeCurrent({
        offline: !result.success || this.options.offline,
        preparedAliases: verified,
        clearCache: false,
        registryClient,
      });
      const fresh = this.draft.analysis.aliasMappings;
      const pending = fresh.filter(
        (mapping) => mapping.installSpec && !blocked.has(mapping.aliasName),
      );
      if (result.success && pending.length > 0 && attempt === 0) continue;
      if (result.success && pending.length > 0) {
        report.success = false;
        const message =
          'Dependency inputs changed during preparation; refusing to publish an unstable installation plan';
        report.errors.push(message);
        this.draft.installDiagnostics.push({
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
    this.initialReplanNeeded = false;
    if (!this.snapshotObserver) {
      this.snapshotObserver = new WeakRef(this.observer);
      this.preparation!.observers.add(this.snapshotObserver);
    }
    this.captureSnapshot();
  }

  private async refreshSnapshot(): Promise<void> {
    const current = this.published;
    if (!current) return;
    this.watch.snapshot = undefined;
    if (current.invalidated) {
      this.published = { ...current, revision: this.preparation!.revision };
      return;
    }
    const generation = this.snapshotGeneration;
    let invalidated = false;
    try {
      try {
        const analysis = await this.analyzeCurrent({
          offline: true,
          preparedAliases: current.rules.activeMappings,
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
        this.draft = { ...emptyDraft(), analysis, installation: this.draft.installation };
        this.setActiveAliasMappings(
          analysis.aliasMappings.filter((mapping) => !mapping.installSpec),
        );
        const changed = current.signature !== this.describeSnapshot();
        if (this.initialized && changed) {
          invalidated = true;
          this.setActiveAliasMappings([]);
          this.draft.installDiagnostics.push({
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
        invalidated = true;
        this.draft = { ...emptyDraft(), installation: this.draft.installation };
        this.draft.installDiagnostics.push({
          code: 'PROJECT_STATE_CHANGED',
          severity: 'error',
          packageName: this.options.dependencies.join(', '),
          message: 'Cannot refresh dependency rules after another installation: ' + String(error),
        });
      }
      this.captureSnapshot(invalidated);
      if (this.watch.files) this.recordWatchFiles();
    } finally {
      clearPackageJsonCache();
    }
  }

  private describeSnapshot(providers = this.describeProviders()): string {
    const mappings = this.draft.activeMappings
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
    return (this.draft.matcher?.getAliasPathMappings() ?? [])
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

  private captureSnapshot(invalidated = false): void {
    const providers = this.metrics.measure('verify', () => this.describeProviders());
    const versions = new Map(
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
    this.published = {
      rules: { ...this.draft, installDiagnostics: [...this.draft.installDiagnostics] },
      revision: this.preparation!.revision,
      signature: this.describeSnapshot(providers),
      providers: versions,
      error: errors.length ? new ResolutionError(structuredClone(errors)) : null,
      invalidated,
    };
  }

  private async notifyInstallComplete(): Promise<void> {
    const hook = this.hooks.onInstallComplete;
    if (!this.draft.installation || !hook) return;
    const completed = this.filterCompletedMappings(
      this.draft.analysis!.aliasMappings,
      this.draft.installation,
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
      this.published?.revision !== this.preparation.revision
    ) {
      if (this.options.strict) {
        throw this.projectChanged(
          'Dependency preparation is changing this project; wait for preparation to finish before resolving modules',
        );
      }
      return false;
    }
    if (this.options.strict && this.published?.error) throw this.published.error;
    return true;
  }

  private guardGeneration(): () => void {
    this.snapshotCurrent();
    const revision = this.preparation?.revision;
    const generation = this.snapshotGeneration;
    const fingerprint = this.published?.signature;
    return () => {
      if (
        revision !== this.preparation?.revision ||
        generation !== this.snapshotGeneration ||
        fingerprint !== this.published?.signature
      ) {
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
    if (!this.draft.analysis) {
      return;
    }

    const activeAliasNames = new Set(mappings.map((mapping) => mapping.aliasName));
    const inactiveAliasNames = new Set(blockedAliasNames);
    for (const mapping of this.draft.analysis.aliasMappings) {
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

    this.draft.activeMappings = activeMappings;
    // A writer can refresh another resolver. Compile into an unpublished
    // matcher so the previous generation keeps its complete set of rules.
    if (!this.draft.matcher || this.draft.matcher === this.published?.rules.matcher) {
      this.draft.matcher = createAliasManager(this.options, this.fileSystemCache);
    }
    this.draft.matcher.initFromAnalysisResult({
      ...this.draft.analysis,
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
    const matcher = this.published?.rules.matcher;
    if (!this.initialized || !this.snapshotCurrent() || !matcher) {
      return null;
    }

    // 检查钩子
    if (this.hooks.beforeResolve) {
      const hookResult = this.hooks.beforeResolve(request, importer);
      if (hookResult !== undefined) {
        return hookResult === null ? null : { target: hookResult, source: 'hook' };
      }
    }

    const target = matcher.resolveModule({ request, importer });
    return target === null ? null : { target, source: 'alias' };
  }

  /**
   * 获取别名路径映射
   * 返回别名名称到实际路径的映射，供构建工具插件转换为各自的格式
   */
  getAliasPathMappings(): AliasPathMapping[] {
    const matcher = this.published?.rules.matcher;
    if (!this.initialized || !this.snapshotCurrent() || !matcher) {
      return [];
    }

    return matcher.getAliasPathMappings();
  }

  /** Stable identity of the active rules and their installed providers. */
  getResolutionFingerprint(): string {
    return this.initialized && this.snapshotCurrent() ? (this.published?.signature ?? '') : '';
  }

  /**
   * 获取分析结果
   */
  getAnalysisResult(): AnalysisResult | null {
    return structuredClone(this.visibleRules().analysis);
  }

  private visibleRules(): Readonly<ResolutionDraft> {
    return this.initialized && this.published ? this.published.rules : this.draft;
  }

  private generationDiagnostics(
    rules: Readonly<ResolutionDraft> = this.draft,
  ): ResolverDiagnostic[] {
    const analysis = rules.analysis?.diagnostics ?? [];
    const runtime = rules.matcher?.getDiagnostics?.() ?? [];
    if (runtime.length === 0) return [...analysis, ...rules.installDiagnostics];

    // Keep the initialization diagnostic with its configured requesters when
    // an actual import encounters the same set of rules at the same path.
    const knownAmbiguities = new Set(
      analysis.filter(({ code }) => code === 'AMBIGUOUS_IMPORTER').map(importerAmbiguityKey),
    );
    return [
      ...analysis,
      ...rules.installDiagnostics,
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
      ...this.generationDiagnostics(this.visibleRules()),
    ].map((diagnostic) =>
      Object.assign({}, diagnostic, {
        ...(diagnostic.aliases && { aliases: [...diagnostic.aliases] }),
        ...(diagnostic.requestedBy && { requestedBy: [...diagnostic.requestedBy] }),
        ...(diagnostic.importerPaths && { importerPaths: [...diagnostic.importerPaths] }),
      }),
    );
  }

  private assertResolved(installation: InstallReport | null = this.draft.installation): void {
    if (!this.options.strict) return;
    const diagnostics = this.generationDiagnostics();
    if (!diagnostics.some(({ severity }) => severity === 'error')) return;
    const preparation = structuredClone({
      aliases: this.draft.analysis?.aliasMappings ?? [],
      diagnostics,
      installation,
    });
    throw new ResolutionError(
      preparation.diagnostics.filter(({ severity }) => severity === 'error'),
      preparation,
    );
  }

  /** Explain a request; skipHook permits side-effect-free cache validation. */
  explainResolution(
    request: string,
    importer?: string,
    options: { skipHook?: boolean } = {},
  ): ResolutionExplanation {
    const matcher = this.published?.rules.matcher;
    if (!this.initialized || !this.snapshotCurrent() || !matcher) {
      return {
        request,
        importer,
        resolved: null,
        reason: 'inactive',
        aliases: [],
        matchedPaths: [],
      };
    }
    if (!options.skipHook && this.hooks.beforeResolve) {
      const resolved = this.hooks.beforeResolve(request, importer);
      if (resolved !== undefined) {
        return { request, importer, resolved, reason: 'hook', aliases: [], matchedPaths: [] };
      }
    }
    return matcher.explainResolution(request, importer);
  }

  getInstallResult(): InstallReport | null {
    const { installation } = this.visibleRules();
    return (
      installation && {
        ...installation,
        installed: [...installation.installed],
        reused: [...installation.reused],
        failed: [...installation.failed],
        errors: [...installation.errors],
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
