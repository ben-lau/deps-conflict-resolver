import type { Compiler, NormalModule, WebpackPluginInstance, ResolveData } from 'webpack';
import type { PluginConfig, AnalysisResult } from '../../types/index';
import { DepsConflictResolver, getResolverBuild } from '../../core/resolver';
import { createLogger, LogLevel } from '../../utils/logger';
import { isPathLikeRequest, isWebpackInternalRequest } from '../../utils/module-request';
import { join } from 'node:path';

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

type RedirectBuildInfo = NonNullable<NormalModule['buildInfo']> & {
  depsConflictResolver?: string;
};
type ResolveOptions = NonNullable<ResolveData['resolveOptions']>;

const emptyResolveOptions: ResolveOptions = {};

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
  private generation = 0;
  private aliasVersions: ReadonlyMap<string, string> = new Map();
  private redirectOptions = new WeakMap<ResolveOptions, Map<string, ResolveOptions>>();

  constructor(config: PluginConfig) {
    this.config = config;

    if (config.debug) {
      logger.setLevel(LogLevel.ALL);
    }
  }

  /**
   * 初始化解析器
   */
  private initialize(compiler: Compiler): Promise<void> {
    if (this.initialized) {
      return Promise.resolve();
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    return this.startInitialization(compiler);
  }

  /**
   * 开始新一轮初始化，并只在该 generation 成功后公开解析器状态。
   */
  private startInitialization(compiler: Compiler, watch = false): Promise<void> {
    const generation = ++this.generation;

    try {
      if (!this.resolver) {
        logger.info('Initializing dependencies resolver...');

        const { hooks, ...resolverOptions } = this.config;
        this.resolver = new DepsConflictResolver(resolverOptions, hooks);
      }
    } catch (error) {
      this.analysisResult = null;
      this.initialized = false;
      logger.error('Error initializing dependencies resolver:', error);
      if (this.config.strict) return Promise.reject(error);
      return Promise.resolve();
    }

    const resolver = this.resolver;
    const build = getResolverBuild(resolver);
    this.initialized = false;
    const initialization = Promise.resolve()
      .then(async () => (watch ? build.refreshForWatch(compiler) : resolver.initialize()))
      .then((reused) => {
        if (generation !== this.generation || this.resolver !== resolver) {
          return;
        }
        if (reused) {
          this.initialized = true;
          return;
        }

        this.analysisResult = resolver.getAnalysisResult();
        const { providers: aliasVersions } = build.snapshot();
        if (
          generation > 1 &&
          (aliasVersions.size !== this.aliasVersions.size ||
            [...aliasVersions].some(([name, version]) => this.aliasVersions.get(name) !== version))
        ) {
          // The compiler can cache every link in a provider's lookup path.
          // Purge filesystem reads when the provider changes, keeping module caches.
          compiler.inputFileSystem?.purge?.();
          this.redirectOptions = new WeakMap();
        }
        this.aliasVersions = aliasVersions;

        if (this.analysisResult && this.analysisResult.aliasMappings.length > 0) {
          logger.info(`Planned ${this.analysisResult.aliasMappings.length} alias mappings`);

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
      })
      .catch((error: unknown) => {
        if (generation !== this.generation || this.resolver !== resolver) {
          return;
        }

        this.analysisResult = null;
        this.initialized = false;
        this.aliasVersions = new Map();
        logger.error('Error initializing dependencies resolver:', error);
        if (this.config.strict) throw error;
      })
      .finally(() => {
        if (generation === this.generation && this.initPromise === initialization) {
          this.initPromise = null;
        }
      });

    this.initPromise = initialization;
    return initialization;
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

    if (!this.resolver || !this.initialized) {
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
    // Resolve the verified alias from the host, preserving Webpack's exports
    // and dependency-type conditions even for linked packages outside it.
    resolveData.context = this.resolver.getOptions().projectRoot;
    const alias = resolvedModule.match(/^(?:@[^/?#]+\/)?[^/?#]+/)?.[0];
    const version = alias && this.aliasVersions.get(alias);
    if (version) {
      const original = resolveData.resolveOptions ?? emptyResolveOptions;
      let versions = this.redirectOptions.get(original);
      if (!versions) this.redirectOptions.set(original, (versions = new Map()));
      let options = versions.get(version);
      if (!options) {
        // Webpack keys its native resolver cache by the request and these options.
        // Keep exports and dependency-type conditions, with a key for the verified provider.
        const updated = { ...original, unsafeCache: false, depsConflictResolverProvider: version };
        versions.set(version, (options = updated));
      }
      resolveData.resolveOptions = options;
    }
  }

  private moduleResolutionVersion(module: NormalModule): string {
    if (!this.initialized || !module.resource || !this.resolver || this.aliasVersions.size === 0)
      return '';
    // Webpack uses nameForCondition() as the issuer when resolving dependencies.
    const importer = module.nameForCondition?.() ?? module.resource;
    const requests = new Set<string>();
    const versions: string[] = [];
    const blocks: Array<Pick<NormalModule, 'blocks' | 'dependencies'>> = [module];
    while (blocks.length > 0) {
      const block = blocks.pop()!;
      blocks.push(...block.blocks);
      for (const dependency of block.dependencies) {
        if (!('request' in dependency) || typeof dependency.request !== 'string') continue;
        const request = dependency.request;
        if (
          requests.has(request) ||
          isPathLikeRequest(request) ||
          isWebpackInternalRequest(request)
        )
          continue;
        requests.add(request);
        const decision = this.resolver.explainResolution(request, importer, {
          skipHook: true,
        });
        if (!decision.resolved && decision.reason !== 'ambiguous') continue;
        versions.push(
          JSON.stringify([
            request,
            decision.resolved,
            decision.aliases.map((alias) => this.aliasVersions.get(alias)),
          ]),
        );
      }
    }
    return versions.length > 0 ? JSON.stringify(versions.sort()) : '';
  }

  apply(compiler: Compiler): void {
    this.config = {
      ...this.config,
      projectRoot: this.config.projectRoot ?? compiler.context,
    };
    logger.info('Applying DepsConflictResolverWebpackPlugin...');

    let runPreparation: Promise<void> | undefined;
    compiler.hooks.beforeRun.tapPromise(PLUGIN_NAME, () => {
      runPreparation = this.initialize(compiler);
      return runPreparation;
    });

    // 对于 watch 模式
    compiler.hooks.watchRun.tapPromise(PLUGIN_NAME, async () => {
      if (this.initPromise) {
        getResolverBuild(this.resolver!).assertWatchCanWait();
        await this.initPromise;
      }
      await this.startInitialization(compiler, true);
    });
    compiler.hooks.watchClose?.tap(PLUGIN_NAME, () => {
      if (this.resolver) getResolverBuild(this.resolver).closeWatch();
    });

    let legacyCacheHookInstalled = false;
    compiler.hooks.compilation.tap(PLUGIN_NAME, (compilation) => {
      const watched = this.resolver && getResolverBuild(this.resolver).snapshot().watchFiles;
      for (const file of watched?.existing ?? this.analysisResult?.watchFiles ?? [])
        compilation.fileDependencies.add(file);
      for (const file of watched?.missing ?? []) compilation.missingDependencies?.add(file);
      const manifest = join(this.config.projectRoot!, 'package.json');
      if (!watched?.missing.has(manifest)) compilation.fileDependencies.add(manifest);
      compilation.hooks.succeedModule.tap(PLUGIN_NAME, (module) => {
        if ('resource' in module && module.buildInfo)
          (module.buildInfo as RedirectBuildInfo).depsConflictResolver =
            this.moduleResolutionVersion(module as NormalModule);
      });
      const hooks = compiler.webpack?.NormalModule?.getCompilationHooks?.(compilation);
      if (hooks?.needBuild) {
        hooks.needBuild.tapAsync(PLUGIN_NAME, (module, _context, callback) => {
          const previous =
            (module.buildInfo as RedirectBuildInfo | undefined)?.depsConflictResolver ?? '';
          if (previous !== this.moduleResolutionVersion(module)) return callback(null, true);
          callback();
        });
      } else if (!legacyCacheHookInstalled && compiler.cache?.hooks?.get?.tap) {
        // Early Webpack 5 has no needBuild hook. Observe cache restoration
        // before its native build check; unchanged modules remain cached.
        compiler.cache.hooks.get.tap(
          { name: PLUGIN_NAME, stage: Number.NEGATIVE_INFINITY },
          (identifier, _etag, gotHandlers) => {
            if (!identifier.includes('Compilation/modules|')) return;
            gotHandlers.push((cached: NormalModule | undefined, callback) => {
              if (cached?.resource && typeof cached.invalidateBuild === 'function') {
                const previous =
                  (cached.buildInfo as RedirectBuildInfo | undefined)?.depsConflictResolver ?? '';
                if (previous !== this.moduleResolutionVersion(cached)) cached.invalidateBuild();
              }
              callback();
            });
          },
        );
        legacyCacheHookInstalled = true;
      }
    });

    // 使用 normalModuleFactory 钩子拦截模块请求
    compiler.hooks.normalModuleFactory.tap(PLUGIN_NAME, (nmf: NormalModuleFactory) => {
      // Direct compile() calls do not run beforeRun. Share their preparation
      // within this factory and retry at the start of the next compilation.
      let preparation = ! compiler.running ? undefined : runPreparation;
      // beforeResolve: 在模块解析之前修改请求
      // 这是最早能够拦截模块请求的时机
      // AsyncSeriesBailHook<[ResolveData], false | void>
      // - 直接修改 resolveData 对象即可
      // - 返回 false 表示跳过该模块
      // - 返回 undefined/void 表示继续处理
      nmf.hooks.beforeResolve.tapPromise(PLUGIN_NAME, async (resolveData) => {
        try {
          // watchRun prepares once per compilation, including permissive failures.
          if (!compiler.watchMode && !this.initialized) {
            await (preparation ??= this.initialize(compiler));
          }
          this.handleResolve(resolveData);
        } catch (err) {
          logger.error('Error during module resolution:', err);
          if (this.config.strict) throw err;
        }
      });
    });

    // 在编译完成后输出信息
    compiler.hooks.done.tap(PLUGIN_NAME, (stats) => {
      if (!this.initialized || stats.hasErrors()) {
        return;
      }

      const activeCount = this.resolver?.getAliasPathMappings().length ?? 0;
      if (activeCount > 0) {
        logger.info(`Activated ${activeCount} alias mappings`);
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
    if (!this.resolver || !this.initialized) {
      return {};
    }

    try {
      // 将核心的 AliasPathMapping[] 转换为 Webpack 的别名格式
      const mappings = this.resolver.getAliasPathMappings();
      const aliases: Record<string, string | false | string[]> = {};
      for (const mapping of mappings) {
        aliases[mapping.aliasName] = mapping.path;
      }
      return aliases;
    } catch (error) {
      logger.error('Error reading alias configuration:', error);
      return {};
    }
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
