import type { Alias, Plugin, SSROptions, UserConfig } from 'vite';
import type { PluginConfig, AliasPathMapping } from '../../types/index';
import { DepsConflictResolver } from '../../core/resolver';
import { createLogger, LogLevel } from '../../utils/logger';
import { createFilter, mergeConfig, version as viteVersion } from 'vite';
import { createOptimizerOptions, type SsrExternalPolicy } from './optimizer';
import { createSsrExternalPolicy } from './ssr-external';
import { escapeRegex } from '../../utils/regex';
import { isPathLikeRequest, isVirtualModuleRequest } from '../../utils/module-request';
import { join, resolve as resolvePath } from 'node:path';

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

  return {
    name: PLUGIN_NAME,

    // 确保在 vite:resolve 之前运行
    enforce: 'pre',

    /**
     * 配置阶段 - 修改 Vite 配置
     */
    async config(config, { command }): Promise<UserConfig | null | void> {
      // 根据模式决定是否启用
      isEnabled = (command === 'serve' && enableInDev) || (command === 'build' && enableInBuild);
      ssrExternalEnabled = false;
      resolveSsrExternal = undefined;
      isSsrExternal = undefined;

      if (!isEnabled) {
        logger.info(`Plugin disabled for ${command} mode`);
        return;
      }

      logger.info('Initializing dependencies resolver...');

      // 初始化解析器
      resolver = new DepsConflictResolver(
        {
          ...resolverOptions,
          projectRoot: resolverOptions.projectRoot ?? resolvePath(config.root ?? process.cwd()),
        },
        hooks,
      );
      await resolver.initialize();

      // 获取分析结果
      const analysisResult = resolver.getAnalysisResult();

      if (!analysisResult || analysisResult.aliasMappings.length === 0) {
        if (resolver.getDiagnostics().some((diagnostic) => diagnostic.severity === 'error')) {
          logger.warn(
            'No alias mappings available; inspect resolver diagnostics for unresolved conditions',
          );
        } else {
          logger.info('No aliases needed');
        }
        return;
      }

      // 获取别名路径映射并转换为 Vite 格式
      const aliasPathMappings = resolver.getAliasPathMappings();
      if (aliasPathMappings.length === 0) {
        logger.info('No active aliases available');
        return;
      }
      const projectRoot = resolver.getOptions().projectRoot;
      const aliases = createViteAliases(aliasPathMappings, projectRoot);

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
        for (const name of [
          ...mapping.allDependents,
          ...mapping.usedBy.map((path) => path.split('>')[0]!),
          ...(resolverOptions.includeRedirects?.[mapping.originalName] ?? []),
        ]) {
          if (!excluded.has(name)) ssrPackages.add(name);
        }
        for (const name of [
          ...mapping.usedBy.map((path) => path.split('>')[0]!),
          ...(resolverOptions.includeRedirects?.[mapping.originalName] ?? []),
        ]) {
          if (!excluded.has(name)) ssrOptimizerPackages.add(name);
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
      const allowsSsrOptimization = (name: string) =>
        (external !== true || keepsInternal(name)) &&
        !ssrExcluded.some((excluded) => name === excluded || name.startsWith(excluded + '/'));

      logger.debug(`Alias packages to include: ${aliasPackages.join(', ')}`);

      // 创建 esbuild 插件用于预构建阶段的别名解析
      const optimizeDeps = createOptimizerOptions(resolver, projectRoot, viteVersion);
      ssrExternalEnabled =
        ssr === 'auto' && command === 'serve' && external === true && manualNoExternal !== true;
      isSsrExternal = (packageName) => !keepsInternal(packageName);
      const ssrOptimizeDeps = ssrExternalEnabled
        ? createOptimizerOptions(resolver, projectRoot, viteVersion, {
            isExternal: (packageName) => !keepsInternal(packageName),
            resolve: (source, importer, isRequire) => {
              if (!resolveSsrExternal) throw new Error('SSR external resolver is not initialized');
              return resolveSsrExternal(source, importer, isRequire);
            },
          })
        : optimizeDeps;
      const [viteMajor, viteMinor] = viteVersion.split('.').map(Number);
      const legacySsrOptimizer = viteMajor! < 5 || (viteMajor === 5 && viteMinor === 0);

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
                        ...(legacySsrOptimizer && ssrOptimizer.disabled === undefined
                          ? { disabled: false as const }
                          : {}),
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
        resolve: {
          alias: aliases,
        },
        optimizeDeps,
      };
    },

    configResolved(config) {
      if (!ssrExternalEnabled) return;
      resolveSsrExternal = createSsrExternalPolicy(
        config,
        resolver!.getOptions().projectRoot,
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

        // 返回解析后的模块 ID，让 Vite 继续解析
        return this.resolve(resolved, importer, {
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
}

// 默认导出
export default depsConflictResolverVitePlugin;
