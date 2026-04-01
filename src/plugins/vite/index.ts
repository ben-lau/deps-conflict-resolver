import type { Plugin, UserConfig } from 'vite';
import type { PluginConfig, AliasPathMapping } from '../../types/index';
import { DepsConflictResolver } from '../../core/resolver';
import { createLogger, LogLevel } from '../../utils/logger';
import type { Plugin as EsbuildPlugin } from 'esbuild';
import { escapeRegex } from '../../utils/regex';
import { isPathLikeRequest, isVirtualModuleRequest } from '../../utils/module-request';

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
}

/**
 * 基于 AliasPathMapping 生成 Vite 的 resolve.alias 配置
 */
export function createViteAliases(mappings: AliasPathMapping[]): ViteAliasEntry[] {
  const aliases: ViteAliasEntry[] = [];

  for (const mapping of mappings) {
    // 精确匹配
    aliases.push({
      find: new RegExp(`^${escapeRegex(mapping.aliasName)}$`),
      replacement: mapping.path,
    });

    // 子路径匹配
    aliases.push({
      find: new RegExp(`^${escapeRegex(mapping.aliasName)}/(.*)$`),
      replacement: `${mapping.path}/$1`,
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
}

/**
 * 创建 esbuild 别名插件，用于 optimizeDeps 预构建阶段
 * 注意：resolver 必须已完成 initialize()，否则 resolveModule 无法正常工作
 */
function createEsbuildAliasPlugin(
  resolver: DepsConflictResolver,
  projectRoot: string,
): EsbuildPlugin {
  return {
    name: 'deps-conflict-resolver-esbuild',
    setup(build) {
      const analysisResult = resolver.getAnalysisResult();
      if (!analysisResult || analysisResult.aliasMappings.length === 0) {
        return;
      }

      // 收敛为一个 onResolve，避免为每个包注册两次 handler
      const originalNames = Array.from(
        new Set(analysisResult.aliasMappings.map(m => m.originalName)),
      );

      const filter = new RegExp(`^(${originalNames.map(escapeRegex).join('|')})(?:/.*)?$`);

      // 检查 build.resolve 是否可用（esbuild 0.17+）
      const hasResolveApi = typeof build.resolve === 'function';

      build.onResolve({ filter }, async args => {
        if (!args.importer) {
          return null;
        }

        const resolved = resolver.resolveModule(args.path, args.importer);
        if (!resolved) {
          return null;
        }

        logger.debug(`[esbuild] Redirecting ${args.path} -> ${resolved} (from ${args.importer})`);

        // 优先使用 build.resolve API（esbuild 0.17+）
        if (hasResolveApi) {
          const result = await build.resolve(resolved, {
            kind: args.kind,
            resolveDir: projectRoot,
            importer: args.importer,
          });

          if (result.errors.length > 0) {
            return { errors: result.errors };
          }

          return { path: result.path };
        }

        // 降级方案：返回包名和 resolveDir，让 esbuild 解析
        return {
          path: resolved,
          resolveDir: projectRoot,
        };
      });
    },
  };
}

/**
 * 创建 Vite 插件
 */
export function depsConflictResolverVitePlugin(options: VitePluginOptions): Plugin {
  let resolver: DepsConflictResolver | null = null;
  let isEnabled = true;

  const { enableInDev = true, enableInBuild = true, hooks, ...resolverOptions } = options;

  if (options.debug) {
    logger.setLevel(LogLevel.DEBUG);
  }

  return {
    name: PLUGIN_NAME,

    // 确保在 vite:resolve 之前运行
    enforce: 'pre',

    /**
     * 配置阶段 - 修改 Vite 配置
     */
    async config(_config, { command }): Promise<UserConfig | null | void> {
      // 根据模式决定是否启用
      isEnabled = (command === 'serve' && enableInDev) || (command === 'build' && enableInBuild);

      if (!isEnabled) {
        logger.info(`Plugin disabled for ${command} mode`);
        return;
      }

      logger.info('Initializing dependencies resolver...');

      // 初始化解析器
      resolver = new DepsConflictResolver(resolverOptions, hooks);
      await resolver.initialize();

      // 获取分析结果
      const analysisResult = resolver.getAnalysisResult();

      if (!analysisResult || analysisResult.aliasMappings.length === 0) {
        logger.info('No aliases needed');
        return;
      }

      const { aliasMappings } = analysisResult;

      // 获取别名路径映射并转换为 Vite 格式
      const aliasPathMappings = resolver.getAliasPathMappings();
      const aliases = createViteAliases(aliasPathMappings);

      logger.info(`Configured ${aliasMappings.length} alias redirections`);

      // 收集需要包含在 optimizeDeps 中的别名包
      const aliasPackages = Array.from(new Set(aliasMappings.map(m => m.aliasName)));

      logger.debug(`Alias packages to include: ${aliasPackages.join(', ')}`);

      // 创建 esbuild 插件用于预构建阶段的别名解析
      const projectRoot = resolver.getOptions().projectRoot;
      const esbuildAliasPlugin = createEsbuildAliasPlugin(resolver, projectRoot);

      // 返回要合并的配置
      return {
        resolve: {
          alias: aliases,
        },
        optimizeDeps: {
          // 确保别名包被预构建
          include: aliasPackages,
          // 在 esbuild 预构建时也应用别名
          esbuildOptions: {
            plugins: [esbuildAliasPlugin],
          },
        },
      };
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
        return this.resolve?.(resolved, importer, {
          skipSelf: true,
          ...resolveOptions,
        });
      }

      return null;
    },
  };
}

// 默认导出
export default depsConflictResolverVitePlugin;
