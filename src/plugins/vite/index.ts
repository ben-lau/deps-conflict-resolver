import type { Alias, Plugin, SSROptions, UserConfig, ResolvedConfig } from 'vite';
import { randomUUID } from 'node:crypto';
import type { PluginConfig, PluginHooks, AliasPathMapping } from '../../types/index';
import { DepsConflictResolver, getResolverBuild } from '../../core/resolver';
import { createLogger, LogLevel, withLogLevel } from '../../utils/logger';
import { createFilter, mergeConfig, normalizePath, version as viteVersion } from 'vite';
import { aliasRequestFilter, createOptimizerOptions, type SsrExternalPolicy } from './optimizer';
import { createSsrExternalPolicy } from './ssr-external';
import { escapeRegex } from '../../utils/regex';
import { isPathLikeRequest, isVirtualModuleRequest } from '../../utils/module-request';
import { dirname, join } from 'node:path';

const logger = createLogger('vite-plugin');
const VITE_LOG_LEVELS = {
  silent: LogLevel.SILENT,
  error: LogLevel.ERROR,
  warn: LogLevel.WARN | LogLevel.ERROR,
  info: LogLevel.INFO | LogLevel.WARN | LogLevel.ERROR,
};

/**
 * Vite 插件名称
 */
const PLUGIN_NAME = 'deps-conflict-resolver';
const viteMajor = Number.parseInt(viteVersion, 10);

function withViteLogger<T>(config: ResolvedConfig, debug: boolean, task: () => T): T {
  const logLevel = config.logLevel ?? 'info';
  const level = logLevel === 'info' && debug ? LogLevel.ALL : VITE_LOG_LEVELS[logLevel];
  return withLogLevel(level, task, (method, message) => {
    config.logger[method === 'debug' ? 'info' : method](message);
  });
}

function ssrSettings(config: ResolvedConfig) {
  const environment = config.environments?.ssr;
  const resolve: Pick<SSROptions, 'external' | 'noExternal'> = mergeConfig(
    { resolve: { external: config.ssr?.external, noExternal: config.ssr?.noExternal } },
    { resolve: environment?.resolve ?? {} },
  ).resolve;
  const optimizer: NonNullable<SSROptions['optimizeDeps']> = mergeConfig(
    config.ssr?.optimizeDeps ?? {},
    environment?.optimizeDeps ?? {},
  );
  return { resolve, optimizer };
}

interface BuildWatch {
  first: boolean;
  fingerprint: string;
  environments: Map<object, EnvironmentWatch>;
  refreshing?: Promise<boolean>;
  files: Set<string>;
  modified: Set<string>;
  removed: Set<string>;
  verifySsrPolicy?: () => void;
}

interface EnvironmentWatch {
  published?: string;
  fingerprint: string;
  rulesChanged: boolean;
}

function watchInstalledProviders(config: ResolvedConfig, files: ReadonlySet<string>): void {
  if (viteMajor >= 8) return;
  const paths = new Set<string>();
  for (const file of files) {
    let path = normalizePath(file);
    while (/\/node_modules(?:\/|$)/.test(path)) {
      paths.add(path);
      path = normalizePath(dirname(path));
    }
  }
  const ignored = [...paths].map((path) => '!' + path.replace(/[*?{}()[\]\\!+@]/g, '\\$&'));
  for (const watchBuild of [
    config.build,
    ...Object.values(config.environments ?? {}).map((environment) => environment.build),
  ]) {
    const rollupWatch = watchBuild?.rollupOptions?.watch;
    if (
      !watchBuild?.watch ||
      watchBuild.watch.chokidar?.ignored ||
      (rollupWatch && rollupWatch.chokidar?.ignored)
    )
      continue;
    // Vite's Rollup watcher ignores node_modules. Match only the exact
    // provider slots and their ancestors, keeping the rest of the tree ignored.
    watchBuild.watch.chokidar = { ...watchBuild.watch.chokidar, ignored };
  }
}

/**
 * Vite 别名配置格式
 */
interface ViteAliasEntry {
  find: string | RegExp;
  replacement: string;
  customResolver?: Alias['customResolver'];
}

/**
 * 基于 AliasPathMapping 生成 Vite 的 resolve.alias 配置
 */
export function createViteAliases(
  mappings: AliasPathMapping[],
  projectRoot?: string,
): ViteAliasEntry[] {
  const aliases: ViteAliasEntry[] = [];

  for (const mapping of mappings) {
    // Keep the installed path for callers of the standalone helper. The plugin
    // resolves bare alias names from the host so root conditional exports are
    // honored, including packages whose ESM entry wraps the CommonJS runtime.
    aliases.push({
      find: new RegExp(`^${escapeRegex(mapping.aliasName)}$`),
      replacement: mapping.path,
      ...(projectRoot
        ? {
            customResolver: function (_source, _importer, options) {
              return this.resolve(mapping.aliasName, join(projectRoot, 'package.json'), {
                ...options,
                skipSelf: true,
              });
            } satisfies Alias['customResolver'],
          }
        : {}),
    });
  }

  return aliases;
}

/**
 * Vite 插件配置
 */
export interface VitePluginOptions extends PluginConfig {
  /**
   * 是否在开发模式下启用
   * @default true
   */
  enableInDev?: boolean;

  /**
   * 是否在构建模式下启用
   * @default true
   */
  enableInBuild?: boolean;

  /** Bundle affected packages for SSR builds and pre-bundle them for SSR development. */
  ssr?: 'manual' | 'auto';

  /** Stable identity of the state read by a custom beforeResolve hook for pre-bundle reuse. */
  beforeResolveCacheKey?: string;
}

function mergeOptimizer(
  target: NonNullable<UserConfig['optimizeDeps']>,
  addition: NonNullable<UserConfig['optimizeDeps']>,
): void {
  const merged = mergeConfig(target, addition);
  // Vite 8 exposes deprecated aliases as setters on this object. Reassign
  // only our own additions so an old alias cannot overwrite the new value.
  for (const key of Object.keys(addition)) Reflect.set(target, key, Reflect.get(merged, key));
  if (target.include) target.include = [...new Set(target.include)];
  if (target.exclude) target.exclude = [...new Set(target.exclude)];
}

/**
 * 创建 Vite 插件
 */
export function depsConflictResolverVitePlugin(options: VitePluginOptions): Plugin {
  let resolver: DepsConflictResolver | null = null;
  let resolveSsrExternal: SsrExternalPolicy['resolve'] | undefined;
  let ssrExternalEnabled = false;
  let isSsrExternal: SsrExternalPolicy['isExternal'] | undefined;
  let requestFilter: RegExp | undefined;
  let configured: ResolvedConfig | undefined;
  let filterRequests = true;
  let optimizerHookKey: string | undefined;
  let hasResolveHook = false;
  let watch: BuildWatch | undefined;
  const verifyBuild = new WeakMap<object, () => void>();

  const {
    enableInDev = true,
    enableInBuild = true,
    ssr = 'manual',
    hooks,
    beforeResolveCacheKey,
    ...resolverOptions
  } = options;

  function enabledFor(command: ResolvedConfig['command']): boolean {
    return command === 'serve' ? enableInDev : enableInBuild;
  }

  function resolverOwner(config: ResolvedConfig): ResolvedConfig {
    const mainConfig = (config as ResolvedConfig & { mainConfig?: ResolvedConfig }).mainConfig;
    return config.isWorker && mainConfig?.plugins.includes(plugin) ? mainConfig : config;
  }

  function runtimeConfig(
    config: ResolvedConfig,
    activeResolver: DepsConflictResolver,
    aliasPathMappings: AliasPathMapping[],
    ssrInput: ReturnType<typeof ssrSettings>,
  ): UserConfig | undefined {
    const command = config.command;
    // 获取分析结果
    const { analysis: analysisResult } = getResolverBuild(activeResolver).snapshot();

    if (!analysisResult) return undefined;
    if (aliasPathMappings.length === 0) {
      if (activeResolver.getDiagnostics().some((diagnostic) => diagnostic.severity === 'error')) {
        logger.warn(
          'No alias mappings available; inspect resolver diagnostics for unresolved conditions',
        );
      } else {
        logger.info('No aliases needed');
      }
      if (optimizerHookKey === undefined && !resolverOptions.strict && !options.debug)
        return undefined;
    } else {
      logger.info(`Configured ${aliasPathMappings.length} alias redirections`);
    }
    const activeOptions = activeResolver.getOptions();
    const projectRoot = activeOptions.projectRoot;

    // 收集需要包含在 optimizeDeps 中的别名包
    const aliasPackages = Array.from(new Set(aliasPathMappings.map((m) => m.aliasName)));
    const activeNames = new Set(aliasPackages);
    const ssrPackages = new Set(aliasPackages);
    // Pre-bundle roots, then let the optimizer follow actual imports. Eagerly
    // including every declared transitive dependency can load unused native
    // addons and optional platform packages before any SSR entry requests them.
    const ssrOptimizerPackages = new Set(aliasPackages);
    for (const mapping of analysisResult.aliasMappings) {
      if (!activeNames.has(mapping.aliasName)) continue;
      const excluded = new Set(activeOptions.excludeRedirects?.[mapping.originalName] ?? []);
      const usedBySegments = mapping.usedBy.flatMap((path) => path.split('>'));
      const usedByOptimizerIds = mapping.usedBy
        .map((path) => path.split('>'))
        .filter((segments) => !segments.some((segment) => excluded.has(segment)))
        .map((segments) => segments.join(' > '));
      for (const name of [
        ...mapping.allDependents,
        ...usedBySegments,
        ...(mapping.workspaceEntryNames ?? []),
        ...(activeOptions.includeRedirects?.[mapping.originalName] ?? []),
      ]) {
        if (!excluded.has(name)) ssrPackages.add(name);
      }
      for (const name of [
        ...usedByOptimizerIds,
        ...(activeOptions.includeRedirects?.[mapping.originalName] ?? []).filter(
          (entry) => !excluded.has(entry),
        ),
      ]) {
        ssrOptimizerPackages.add(name);
      }
    }

    const { resolve: ssrResolve, optimizer: ssrOptimizer } = ssrInput;
    const external = ssrResolve.external;
    const ssrExternal = Array.isArray(external) ? external : [];
    const ssrExcluded = [...ssrExternal, ...(ssrOptimizer.exclude ?? [])];
    const manualNoExternal = ssrResolve.noExternal;
    const keepsInternal =
      manualNoExternal === true
        ? () => true
        : manualNoExternal && (!Array.isArray(manualNoExternal) || manualNoExternal.length > 0)
          ? createFilter(manualNoExternal, undefined, { resolve: false })
          : () => false;
    const allowsSsrOptimization = (name: string) => {
      const segments = name.split(' > ');
      const target = segments.at(-1) ?? name;
      return (
        (external !== true || keepsInternal(target)) &&
        !segments.some((segment) =>
          ssrExcluded.some(
            (excluded) => segment === excluded || segment.startsWith(excluded + '/'),
          ),
        )
      );
    };

    logger.debug(`Alias packages to include: ${aliasPackages.join(', ')}`);

    // 创建 esbuild 插件用于预构建阶段的别名解析
    const optimizerOptions = {
      filterRequests: !hasResolveHook,
      hookKey: optimizerHookKey,
      guardChanges: Boolean(resolverOptions.strict),
      reportRun: options.debug
        ? (engine: string, key: string, milliseconds: number) => {
            config.logger.info(
              `[${PLUGIN_NAME}] [DEBUG] Pre-bundle ${engine} ran in ${milliseconds.toFixed(1)}ms (key ${key})`,
            );
          }
        : undefined,
    };
    const optimizeDeps = createOptimizerOptions(
      activeResolver,
      projectRoot,
      viteVersion,
      optimizerOptions,
    );
    ssrExternalEnabled =
      ssr === 'auto' && command === 'serve' && external === true && manualNoExternal !== true;
    isSsrExternal = (packageName) => !keepsInternal(packageName);
    const ssrOptimizeDeps = ssrExternalEnabled
      ? createOptimizerOptions(activeResolver, projectRoot, viteVersion, {
          ...optimizerOptions,
          ssrExternal: {
            isExternal: (packageName) => !keepsInternal(packageName),
            resolve: (source, importer, isRequire) => {
              if (!resolveSsrExternal) throw new Error('SSR external resolver is not initialized');
              return resolveSsrExternal(source, importer, isRequire);
            },
          },
        })
      : optimizeDeps;

    // 返回要合并的配置
    return {
      ...(ssr === 'auto'
        ? {
            ssr: {
              noExternal:
                ssrResolve.noExternal === true
                  ? true
                  : [...ssrPackages].filter(allowsSsrOptimization),
              ...(command === 'serve'
                ? {
                    optimizeDeps: {
                      ...ssrOptimizeDeps,
                      include: [...ssrOptimizerPackages].filter(allowsSsrOptimization),
                      // Vite's SSR optimizer is a separate bundler; forward
                      // explicit externals so nested imports stay external too.
                      exclude: ssrExternal,
                    },
                  }
                : {}),
            },
          }
        : {}),
      optimizeDeps,
    };
  }

  const plugin: Plugin = {
    name: PLUGIN_NAME,
    // Module resolution still runs before Vite's resolver. Preparation waits
    // for all config hooks, including framework plugins that choose the root.
    enforce: 'pre',
    config(config, { command }) {
      const [major, minor] = viteVersion.split('.').map(Number);
      if (
        enabledFor(command) &&
        ssr === 'auto' &&
        command === 'serve' &&
        (major! < 5 || (major === 5 && minor === 0)) &&
        config.ssr?.optimizeDeps?.disabled === undefined
      ) {
        // Legacy Vite decides which optimizer plugins exist before configResolved.
        // This default needs no project analysis and can be overridden by users.
        return { ssr: { optimizeDeps: { disabled: false as const } } };
      }
      return undefined;
    },
    async configResolved(config) {
      // Vite 4 invokes the same plugin concurrently for its worker config.
      // Membership, rather than initialization timing, identifies the main
      // instance. Worker-only instances must prepare their own resolver.
      if (resolverOwner(config) !== config) return;
      resolver = null;
      requestFilter = undefined;
      optimizerHookKey = undefined;
      configured = undefined;
      watch = undefined;
      ssrExternalEnabled = false;
      resolveSsrExternal = undefined;
      isSsrExternal = undefined;
      if (!enabledFor(config.command)) {
        configured = config;
        return;
      }
      const resolverHooks: PluginHooks | undefined = hooks && {
        get onAnalysisComplete() {
          return hooks.onAnalysisComplete?.bind(hooks);
        },
        get onInstallComplete() {
          return hooks.onInstallComplete?.bind(hooks);
        },
      };
      const active = new DepsConflictResolver(
        {
          ...resolverOptions,
          // The scoped host logger owns debug output for this preparation.
          debug: false,
          projectRoot: resolverOptions.projectRoot ?? config.root,
        },
        resolverHooks,
      );
      resolver = active;
      if (
        config.command === 'build' &&
        (config.build?.watch ||
          Object.values(config.environments ?? {}).some((environment) => environment.build?.watch))
      ) {
        await withViteLogger(config, Boolean(options.debug), () =>
          getResolverBuild(active).refreshForWatch({}),
        );
        const files = getResolverBuild(active).snapshot().watchFiles?.providerFiles;
        if (files?.size) watchInstalledProviders(config, files);
        watch = {
          first: true,
          fingerprint: active.getResolutionFingerprint(),
          environments: new Map(),
          files: new Set(),
          modified: new Set(),
          removed: new Set(),
        };
      } else {
        await withViteLogger(config, Boolean(options.debug), () => active.initialize());
      }
      // Capture the callback after preparation so build and pre-bundling use
      // the same registration. A declared function can delegate at runtime.
      const beforeResolve = hooks?.beforeResolve;
      if (resolverHooks && beforeResolve) {
        resolverHooks.beforeResolve = beforeResolve.bind(hooks);
        optimizerHookKey =
          beforeResolveCacheKey === undefined
            ? randomUUID()
            : JSON.stringify([
                beforeResolveCacheKey,
                Function.prototype.toString.call(beforeResolve),
              ]);
      } else {
        optimizerHookKey = undefined;
      }
      hasResolveHook = Boolean(beforeResolve);
      // Development serving has no artifact boundary. Strict requests there
      // continue to verify the snapshot even for unrelated imports.
      filterRequests = !hasResolveHook && (!resolverOptions.strict || config.command === 'build');
      const aliasPathMappings = active.getAliasPathMappings();
      if (filterRequests) requestFilter = aliasRequestFilter(aliasPathMappings);
      configured = config;
      // Worker builds inherit optimizer/SSR objects from the main config.
      // Only their module resolver is ours; keep those shared objects intact.
      if (config.isWorker) return;
      if (config.command === 'serve') {
        const watched = new Set(config.configFileDependencies);
        for (const file of getResolverBuild(active).snapshot().analysis?.watchFiles ?? []) {
          const path = normalizePath(file);
          // Vite ignores installed dependency directories by default. Track
          // project and linked source manifests as config inputs instead.
          if (path.includes('/node_modules/') || watched.has(path)) continue;
          watched.add(path);
          config.configFileDependencies.push(path);
        }
      }
      const ssrInput = ssrSettings(config);
      const addition = withViteLogger(config, Boolean(options.debug), () => {
        if (config.command === 'serve' && beforeResolve && beforeResolveCacheKey === undefined) {
          logger.info(
            'Vite will rebuild the pre-bundle for the custom beforeResolve hook. Set beforeResolveCacheKey to enable reuse while its inputs are unchanged.',
          );
        }
        return runtimeConfig(config, active, aliasPathMappings, ssrInput);
      });
      if (watch && ssr === 'auto' && ssrInput.resolve.noExternal !== true) {
        const initial = [...((addition?.ssr?.noExternal as string[] | undefined) ?? [])]
          .sort()
          .join('\0');
        watch.verifySsrPolicy = () => {
          const current = runtimeConfig(config, active, active.getAliasPathMappings(), ssrInput);
          const policy = [...((current?.ssr?.noExternal as string[] | undefined) ?? [])]
            .sort()
            .join('\0');
          if (initial !== policy) {
            // Vite memoizes externalization decisions for the build environment.
            throw new Error(
              'Dependency redirects changed the SSR externalization policy. Restart the Vite watch build to use the new policy.',
            );
          }
        };
      }
      if (!addition) return;
      // Do not reassign resolve.alias here: Vite already created its alias
      // plugin. resolveId and the optimizer resolve through the final resolver.
      const clientOptimizer = addition.optimizeDeps;
      if (clientOptimizer) {
        mergeOptimizer(config.optimizeDeps, clientOptimizer);
        const environment = config.environments?.client;
        if (environment && environment.optimizeDeps !== config.optimizeDeps)
          mergeOptimizer((environment.optimizeDeps ??= {}), clientOptimizer);
      }
      if (addition.ssr) {
        config.ssr.noExternal = mergeConfig(
          { ssr: { noExternal: config.ssr.noExternal } },
          { ssr: { noExternal: addition.ssr.noExternal } },
        ).ssr.noExternal;
        const environment = config.environments?.ssr;
        if (environment)
          (environment.resolve ??= {} as typeof environment.resolve).noExternal = mergeConfig(
            { ssr: { noExternal: environment.resolve.noExternal } },
            { ssr: { noExternal: addition.ssr.noExternal } },
          ).ssr.noExternal;
        const ssrOptimizer = addition.ssr.optimizeDeps;
        if (ssrOptimizer) {
          config.ssr.optimizeDeps ??= {};
          mergeOptimizer(config.ssr.optimizeDeps, ssrOptimizer);
          if (environment && environment.optimizeDeps !== config.ssr.optimizeDeps)
            mergeOptimizer((environment.optimizeDeps ??= {}), ssrOptimizer);
        }
      }
      if (ssrExternalEnabled)
        resolveSsrExternal = createSsrExternalPolicy(
          config,
          active.getOptions().projectRoot,
          isSsrExternal!,
        ).resolve;
    },

    applyToEnvironment(environment) {
      if (resolverOwner(environment.getTopLevelConfig()) !== configured) return true;
      if (!resolver) return false;
      // The target set can change between builds in the same environment.
      if (watch) return true;
      if (!filterRequests) return true;
      const lifecycle: Plugin = {
        name: PLUGIN_NAME,
        enforce: 'pre',
        buildStart: plugin.buildStart,
        generateBundle: plugin.generateBundle,
      };
      if (!requestFilter) return resolverOptions.strict ? lifecycle : false;
      // Vite caches compiled filters by plugin identity. Give each environment
      // a fresh hook so restarting a shared plugin can change the target set.
      const hook = plugin.resolveId;
      if (!hook || typeof hook === 'function') return true;
      return {
        ...lifecycle,
        resolveId: { ...hook, filter: { id: requestFilter } },
      };
    },
    watchChange(file, { event }) {
      if (!watch) return;
      (event === 'delete' ? watch.removed : watch.modified).add(file);
    },
    async buildStart() {
      if (!resolver || configured?.command !== 'build') return;
      const active = resolver;
      const build = getResolverBuild(active);
      const environment = this.environment ?? configured;
      if (!watch || !this.meta.watchMode) {
        if (resolverOptions.strict) verifyBuild.set(environment, build.guardGeneration());
        return;
      }
      const session = watch;
      try {
        if (!session.refreshing) {
          const { first, modified, removed } = session;
          session.first = false;
          session.modified = new Set();
          session.removed = new Set();
          if (!first || modified.size || removed.size) {
            session.refreshing = withViteLogger(configured, Boolean(options.debug), () =>
              build.refreshForWatch({ modifiedFiles: modified, removedFiles: removed }),
            ).finally(() => {
              session.refreshing = undefined;
            });
          }
        }
        await session.refreshing;
        const fingerprint = active.getResolutionFingerprint();
        if (fingerprint !== session.fingerprint) {
          const { packageCache } = configured as ResolvedConfig & {
            packageCache?: Map<unknown, unknown>;
          };
          packageCache?.clear();
        }
        if (configured.build.ssr || this.environment?.config.consumer === 'server') {
          withViteLogger(configured, Boolean(options.debug), () => session.verifySsrPolicy?.());
        }
        session.fingerprint = fingerprint;
        // Each environment has its own module cache. A custom redirect can
        // change the resolution without changing the dependency plan.
        const published = session.environments.get(environment)?.published;
        session.environments.set(environment, {
          published,
          fingerprint,
          rulesChanged: hasResolveHook || published !== fingerprint,
        });
        if (filterRequests) requestFilter = aliasRequestFilter(active.getAliasPathMappings());
        if (resolverOptions.strict) verifyBuild.set(environment, build.guardGeneration());
      } finally {
        const { analysis, watchFiles } = build.snapshot();
        session.files = new Set(watchFiles?.existing ?? analysis?.watchFiles ?? []);
        for (const file of session.files) this.addWatchFile(file);
        for (const file of watchFiles?.missing ?? []) {
          // Chokidar watches the existing ancestor instead. Registering the
          // missing leaf as well can race its scan of the newly created slot.
          if (
            viteMajor < 8 &&
            watchFiles?.providerFiles.has(file) &&
            /\/node_modules\//.test(normalizePath(file))
          )
            continue;
          this.addWatchFile(file);
        }
        if (viteMajor < 8) {
          for (const directory of watchFiles?.providerDirectories ?? [])
            this.addWatchFile(directory);
        }
      }
    },
    generateBundle: {
      order: 'post',
      handler() {
        if (configured) verifyBuild.get(this.environment ?? configured)?.();
      },
    },
    writeBundle() {
      if (!configured || !this.meta.watchMode) return;
      const state = watch?.environments.get(this.environment ?? configured);
      if (state) state.published = state.fingerprint;
    },
    ...(viteMajor < 8
      ? ({
          shouldTransformCachedModule() {
            const environment = this.environment ?? configured;
            return environment && watch?.environments.get(environment)?.rulesChanged ? true : null;
          },
        } satisfies Partial<Plugin>)
      : {}),
    transform(_code, id) {
      // Rolldown rebuilds the graph by default. Incremental builds also need
      // per-module input dependencies, as they can reuse transformed modules.
      if (!watch || !this.meta.watchMode || viteMajor < 8 || !/^(?:\/|[A-Za-z]:[\\/])/.test(id))
        return null;
      const build = configured?.build as
        | { rolldownOptions?: { experimental?: { incrementalBuild?: boolean } } }
        | undefined;
      if (build?.rolldownOptions?.experimental?.incrementalBuild) {
        for (const file of watch.files) this.addWatchFile(file);
      }
      return null;
    },
    closeWatcher() {
      if (!watch || !resolver || !configured) return;
      watch.environments.delete(this.environment ?? configured);
      if (watch.environments.size === 0) getResolverBuild(resolver).closeWatch();
    },
    resolveId: {
      // Vite's alias plugin precedes user plugins ordered by enforce.
      // Inspect the original request before a global alias rewrites it.
      order: 'pre',
      handler(source, importer, resolveOptions) {
        if (
          !resolver ||
          (filterRequests && !requestFilter?.test(source)) ||
          isPathLikeRequest(source) ||
          isVirtualModuleRequest(source)
        )
          return null;
        const redirect = getResolverBuild(resolver).redirect(source, importer);
        const resolved = redirect?.target;
        if (!resolved) return null;
        if (options.debug && (configured?.logLevel ?? 'info') === 'info') {
          configured?.logger.info(
            `[${PLUGIN_NAME}] [DEBUG] Redirecting ${source} -> ${resolved} (from ${importer ?? 'entry'})`,
          );
        }

        // Active aliases were verified from the host. A linked importer may
        // live outside that host's node_modules resolution ancestry.
        const origin =
          redirect.source === 'alias'
            ? join(resolver.getOptions().projectRoot, 'package.json')
            : importer;
        return this.resolve(resolved, origin, {
          ...resolveOptions,
          skipSelf: true,
        }).then((result) => {
          if (!result) throw new Error('Cannot resolve active alias: ' + resolved);
          return result;
        });
      },
    },
  };
  return plugin;
}

// 默认导出
export default depsConflictResolverVitePlugin;
