import type { Compiler, WebpackPluginInstance, ResolveData } from 'webpack';
import type { PluginConfig, AnalysisResult } from '../../types/index';
import { DepsConflictResolver } from '../../core/resolver';
import { createLogger, LogLevel } from '../../utils/logger';
import { isPathLikeRequest, isWebpackInternalRequest } from '../../utils/module-request';

const logger = createLogger('webpack-plugin');

/**
 * Webpack 插件名称
 */
const PLUGIN_NAME = 'DepsConflictResolverWebpackPlugin';

/**
 * NormalModuleFactory 的类型
 * webpack 没有直接导出这个类型，通过 Compiler hooks 推断
 */
type NormalModuleFactory = Parameters<
  Parameters<Compiler['hooks']['normalModuleFactory']['tap']>[1]
>[0];

/**
 * Webpack 插件主类
 *
 * 使用 compiler.hooks.normalModuleFactory 实现模块请求拦截
 * 相比 resolve 插件，这种方式更加直接和高效：
 * 1. 在模块工厂创建阶段就能拦截请求，时机更早
 * 2. 可以直接修改 request，不需要复杂的 resolve 链处理
 * 3. 更好的 TypeScript 类型支持
 * 4. 代码更简洁，易于维护
 */
export class DepsConflictResolverWebpackPlugin implements WebpackPluginInstance {
  private config: PluginConfig;
  private resolver: DepsConflictResolver | null = null;
  private analysisResult: AnalysisResult | null = null;
  private initPromise: Promise<void> | null = null;
  private initialized = false;

  constructor(config: PluginConfig) {
    this.config = config;

    if (config.debug) {
      logger.setLevel(LogLevel.DEBUG);
    }
  }

  /**
   * 初始化解析器
   */
  private async initialize(): Promise<void> {
    if (this.initialized) return;

    logger.info('Initializing dependencies resolver...');

    const { hooks, ...resolverOptions } = this.config;
    this.resolver = new DepsConflictResolver(resolverOptions, hooks);
    await this.resolver.initialize();

    this.analysisResult = this.resolver.getAnalysisResult();

    if (this.analysisResult && this.analysisResult.aliasMappings.length > 0) {
      logger.info(`Detected ${this.analysisResult.aliasMappings.length} peer dependency conflicts`);

      if (this.config.debug) {
        logger.debug(
          'Alias mappings:',
          this.analysisResult.aliasMappings.map((m) => ({
            original: m.originalName,
            alias: m.aliasName,
            usedBy: m.usedBy,
            allDependents: m.allDependents,
          })),
        );
      }
    } else {
      logger.info('No peer dependency conflicts detected');
    }

    this.initialized = true;
  }

  /**
   * 处理模块解析请求
   * 直接修改 resolveData.request 来实现重定向
   *
   * 注意：这里直接使用别名包名作为新的请求，而不是转换为文件系统路径
   * 因为 webpack 5 的 ESM 模式需要模块请求而不是目录路径
   */
  private handleResolve(resolveData: ResolveData): void {
    const { request, contextInfo } = resolveData;

    // 跳过非模块请求（相对路径、绝对路径）
    if (!request || isPathLikeRequest(request)) {
      return;
    }

    // 跳过 webpack 内部请求
    if (isWebpackInternalRequest(request)) {
      return;
    }

    if (!this.resolver) {
      return;
    }

    const importer = contextInfo.issuer || resolveData.context;

    // 检查是否需要重定向
    if (!importer) {
      return;
    }

    // resolveModule 返回别名包名（如 "aliased-vue2"），可能带子路径（如 "aliased-vue2/dist/vue.esm.js"）
    // 直接作为新的模块请求使用，让 webpack 的正常解析机制来处理
    const resolvedModule = this.resolver.resolveModule(request, importer);

    if (!resolvedModule) {
      return;
    }

    if (this.config.debug) {
      logger.debug(`Redirecting ${request} -> ${resolvedModule} (importer: ${importer})`);
    }

    // 直接使用解析后的模块名（别名包名），而不是转换为文件系统路径
    resolveData.request = resolvedModule;
  }

  apply(compiler: Compiler): void {
    logger.info('Applying DepsConflictResolverWebpackPlugin...');

    // 立即开始初始化（不阻塞）
    this.initPromise = this.initialize();

    // 在编译开始前确保初始化完成
    compiler.hooks.beforeRun.tapPromise(PLUGIN_NAME, async () => {
      await this.initPromise;
    });

    // 对于 watch 模式
    compiler.hooks.watchRun.tapPromise(PLUGIN_NAME, async () => {
      await this.initPromise;
    });

    // 使用 normalModuleFactory 钩子拦截模块请求
    compiler.hooks.normalModuleFactory.tap(PLUGIN_NAME, (nmf: NormalModuleFactory) => {
      // beforeResolve: 在模块解析之前修改请求
      // 这是最早能够拦截模块请求的时机
      // AsyncSeriesBailHook<[ResolveData], false | void>
      // - 直接修改 resolveData 对象即可
      // - 返回 false 表示跳过该模块
      // - 返回 undefined/void 表示继续处理
      nmf.hooks.beforeResolve.tapPromise(PLUGIN_NAME, async (resolveData) => {
        try {
          await this.initPromise;
          this.handleResolve(resolveData);
        } catch (err) {
          logger.error('Error during module resolution:', err);
        }
      });
    });

    // 在编译完成后输出信息
    compiler.hooks.done.tap(PLUGIN_NAME, (stats) => {
      if (stats.hasErrors()) {
        return;
      }

      if (this.analysisResult && this.analysisResult.aliasMappings.length > 0) {
        logger.info(
          `Resolved ${this.analysisResult.aliasMappings.length} peer dependency conflicts`,
        );
      }
    });
  }

  /**
   * 获取解析器实例
   */
  getResolver(): DepsConflictResolver | null {
    return this.resolver;
  }

  /**
   * 获取分析结果
   */
  getAnalysisResult(): AnalysisResult | null {
    return this.analysisResult;
  }

  /**
   * 获取别名配置
   * 返回 webpack 格式的别名映射
   */
  getAliasConfig(): Record<string, string | false | string[]> {
    if (!this.resolver) {
      return {};
    }
    // 将核心的 AliasPathMapping[] 转换为 Webpack 的别名格式
    const mappings = this.resolver.getAliasPathMappings();
    const aliases: Record<string, string | false | string[]> = {};
    for (const mapping of mappings) {
      aliases[mapping.aliasName] = mapping.path;
    }
    return aliases;
  }

  /**
   * 检查是否已初始化
   */
  isInitialized(): boolean {
    return this.initialized;
  }
}

/**
 * 创建 Webpack 插件
 */
export function createWebpackPlugin(config: PluginConfig): DepsConflictResolverWebpackPlugin {
  return new DepsConflictResolverWebpackPlugin(config);
}

// 默认导出
export default DepsConflictResolverWebpackPlugin;
