import type { Alias, Plugin, SSROptions, UserConfig, ResolvedConfig } from 'vite';
import type { PluginConfig, AliasPathMapping } from '../../types/index';
import { DepsConflictResolver } from '../../core/resolver';
import { createLogger, LogLevel } from '../../utils/logger';
import { createFilter, mergeConfig, version as viteVersion } from 'vite';
import { createOptimizerOptions, type SsrExternalPolicy } from './optimizer';
import { createSsrExternalPolicy } from './ssr-external';
import { escapeRegex } from '../../utils/regex';
import { isPathLikeRequest, isVirtualModuleRequest } from '../../utils/module-request';
import { join } from 'node:path';

const logger = createLogger('vite-plugin');

/**
 * Vite 插件名称
 */
const PLUGIN_NAME = 'deps-conflict-resolver';

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
  let isEnabled = true;
  let resolveSsrExternal: SsrExternalPolicy['resolve'] | undefined;
  let ssrExternalEnabled = false;
  let isSsrExternal: SsrExternalPolicy['isExternal'] | undefined;

  const {
    enableInDev = true,
    enableInBuild = true,
    ssr = 'manual',
    hooks,
    ...resolverOptions
  } = options;

  if (options.debug) {
    logger.setLevel(LogLevel.ALL);
  }

  function runtimeConfig(
    config: ResolvedConfig,
    activeResolver: DepsConflictResolver,
  ): UserConfig | undefined {
    const command = config.command;
    // 获取分析结果
    const analysisResult = activeResolver.getAnalysisResult();

    if (!analysisResult || analysisResult.aliasMappings.length === 0) {
      if (activeResolver.getDiagnostics().some((diagnostic) => diagnostic.severity === 'error')) {
        logger.warn(
          'No alias mappings available; inspect resolver diagnostics for unresolved conditions',
        );
      } else {
        logger.info('No aliases needed');
      }
      return undefined;
    }

    // 获取别名路径映射并转换为 Vite 格式
    const aliasPathMappings = activeResolver.getAliasPathMappings();
    if (aliasPathMappings.length === 0) {
      logger.info('No active aliases available');
      return undefined;
    }
    const projectRoot = activeResolver.getOptions().projectRoot;

    logger.info(`Configured ${aliasPathMappings.length} alias redirections`);

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
      const excluded = new Set(resolverOptions.excludeRedirects?.[mapping.originalName] ?? []);
      const usedBySegments = mapping.usedBy.flatMap((path) => path.split('>'));
      const usedByOptimizerIds = mapping.usedBy
        .map((path) => path.split('>'))
        .filter((segments) => !segments.some((segment) => excluded.has(segment)))
        .map((segments) => segments.join(' > '));
      for (const name of [
        ...mapping.allDependents,
        ...usedBySegments,
        ...(resolverOptions.includeRedirects?.[mapping.originalName] ?? []),
      ]) {
        if (!excluded.has(name)) ssrPackages.add(name);
      }
      for (const name of [
        ...usedByOptimizerIds,
        ...(resolverOptions.includeRedirects?.[mapping.originalName] ?? []).filter(
          (entry) => !excluded.has(entry),
        ),
      ]) {
        ssrOptimizerPackages.add(name);
      }
    }

    const ssrEnvironment = config.environments?.ssr;
    // Match Vite's legacy-SSR to environment merge, including array
    // concatenation and true taking precedence over arrays for these keys.
    const ssrResolve: Pick<SSROptions, 'external' | 'noExternal'> = mergeConfig(
      { resolve: { external: config.ssr?.external, noExternal: config.ssr?.noExternal } },
      { resolve: ssrEnvironment?.resolve ?? {} },
    ).resolve;
    const ssrOptimizer: NonNullable<SSROptions['optimizeDeps']> = mergeConfig(
      config.ssr?.optimizeDeps ?? {},
      ssrEnvironment?.optimizeDeps ?? {},
    );
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
    const optimizeDeps = createOptimizerOptions(activeResolver, projectRoot, viteVersion);
    ssrExternalEnabled =
      ssr === 'auto' && command === 'serve' && external === true && manualNoExternal !== true;
    isSsrExternal = (packageName) => !keepsInternal(packageName);
    const ssrOptimizeDeps = ssrExternalEnabled
      ? createOptimizerOptions(activeResolver, projectRoot, viteVersion, {
          isExternal: (packageName) => !keepsInternal(packageName),
          resolve: (source, importer, isRequire) => {
            if (!resolveSsrExternal) throw new Error('SSR external resolver is not initialized');
            return resolveSsrExternal(source, importer, isRequire);
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
      const enabled =
        (command === 'serve' && enableInDev) || (command === 'build' && enableInBuild);
      const [major, minor] = viteVersion.split('.').map(Number);
      if (
        enabled &&
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
      const mainConfig = (config as ResolvedConfig & { mainConfig?: ResolvedConfig }).mainConfig;
      if (config.isWorker && mainConfig?.plugins.includes(plugin)) return;
      isEnabled =
        (config.command === 'serve' && enableInDev) ||
        (config.command === 'build' && enableInBuild);
      resolver = null;
      ssrExternalEnabled = false;
      resolveSsrExternal = undefined;
      isSsrExternal = undefined;
      if (!isEnabled) return;
      resolver = new DepsConflictResolver(
        {
          ...resolverOptions,
          projectRoot: resolverOptions.projectRoot ?? config.root,
        },
        hooks,
      );
      await resolver.initialize();
      // Worker builds inherit optimizer/SSR objects from the main config.
      // Only their module resolver is ours; keep those shared objects intact.
      if (config.isWorker) return;
      const addition = runtimeConfig(config, resolver);
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
          resolver.getOptions().projectRoot,
          isSsrExternal!,
        ).resolve;
    },

    /**
     * 解析模块 ID
     */
    resolveId(source, importer, resolveOptions) {
      if (!isEnabled || !resolver) {
        return null;
      }

      // 跳过相对路径和绝对路径
      if (isPathLikeRequest(source)) {
        return null;
      }

      // 跳过虚拟模块
      if (isVirtualModuleRequest(source)) {
        return null;
      }

      // 尝试解析别名
      const resolved = resolver.resolveModule(source, importer);

      if (resolved) {
        logger.debug(`Redirecting ${source} -> ${resolved} (from ${importer ?? 'entry'})`);

        // Active aliases were verified from the host. A linked importer may
        // live outside that host's node_modules resolution ancestry.
        return this.resolve(resolved, join(resolver.getOptions().projectRoot, 'package.json'), {
          ...resolveOptions,
          skipSelf: true,
        }).then((result) => {
          if (!result) throw new Error('Cannot resolve active alias: ' + resolved);
          return result;
        });
      }

      return null;
    },
  };
  return plugin;
}

// 默认导出
export default depsConflictResolverVitePlugin;
