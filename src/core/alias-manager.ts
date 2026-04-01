import type {
  AliasMapping,
  ResolvedOptions,
  AliasPathMapping,
  AnalysisResult,
} from '../types/index';
import { createLogger } from '../utils/logger';
import { findPackagePath } from '../utils/fs';
import { join } from 'path';

const logger = createLogger('alias-manager');

/**
 * 模块解析上下文
 */
interface ResolveContext {
  /**
   * 请求的模块
   */
  request: string;

  /**
   * 导入者的路径
   */
  importer?: string;
}

interface AliasRule {
  originalName: string;
  aliasName: string;
  dependents: Set<string>;
}

/**
 * 别名管理器
 * 负责管理模块别名和生成解析规则
 */
export class AliasManager {
  private options: ResolvedOptions;
  private aliasMappings: AliasMapping[] = [];
  /**
   * 规则索引：originalName -> 相关规则列表
   * 用于在 resolveModule 时避免全量遍历所有规则，提升 dev server/HMR 场景下性能。
   */
  private rulesMap: Map<string, AliasRule[]> = new Map();

  constructor(options: ResolvedOptions) {
    this.options = options;
  }

  /**
   * 从分析结果初始化别名映射
   */
  initFromAnalysisResult(result: AnalysisResult): void {
    this.aliasMappings = result.aliasMappings;
    this.buildRules();

    logger.info(`Initialized ${this.aliasMappings.length} alias mappings`);
  }

  /**
   * 基于 allDependents 构建规则（用 Set 做成员判断，避免超大正则导致的性能与长度问题）
   */
  private buildRules(): void {
    this.rulesMap = new Map();

    for (const mapping of this.aliasMappings) {
      let dependents = mapping.allDependents ?? [];

      // 过滤掉配置中排除的依赖包
      const excludeList = this.options.excludeRedirects[mapping.originalName] ?? [];
      if (excludeList.length > 0) {
        dependents = dependents.filter(dep => !excludeList.includes(dep));
        logger.debug(`Excluded redirects for ${mapping.originalName}: ${excludeList.join(', ')}`);
      }

      const rule: AliasRule = {
        originalName: mapping.originalName,
        aliasName: mapping.aliasName,
        dependents: new Set(dependents),
      };

      const list = this.rulesMap.get(rule.originalName);
      if (list) {
        list.push(rule);
      } else {
        this.rulesMap.set(rule.originalName, [rule]);
      }
    }
  }

  /**
   * 从模块请求中提取“包名部分”，用于索引命中：
   * - vue/compiler-sfc            -> vue
   * - @scope/pkg/subpath          -> @scope/pkg
   * - @scope/pkg/subpath?raw      -> @scope/pkg
   * - virtual:xxx                 -> virtual:xxx
   * - C:\path\to\file (Windows)   -> ''（视为非包请求）
   */
  private getRequestPackageName(request: string): string {
    if (!request) return '';

    // 去掉 query/hash（保留原 request 用于最终返回，避免改变行为）
    const base = request.split(/[?#]/, 1)[0] ?? '';
    if (!base) return '';

    // Windows 绝对路径（避免误判为包名）
    if (/^[a-zA-Z]:[\\/]/.test(base)) {
      return '';
    }

    // scoped package
    if (base.startsWith('@')) {
      const firstSlash = base.indexOf('/');
      if (firstSlash === -1) return base;
      const secondSlash = base.indexOf('/', firstSlash + 1);
      return secondSlash === -1 ? base : base.slice(0, secondSlash);
    }

    const slash = base.indexOf('/');
    return slash === -1 ? base : base.slice(0, slash);
  }

  /**
   * 从 importer 路径中提取所有 node_modules 里出现过的包名（包含嵌套 node_modules）。
   *
   * 示例：
   * - /p/node_modules/a/index.js                -> ["a"]
   * - /p/node_modules/a/node_modules/b/x.js     -> ["a","b"]
   * - /p/node_modules/@s/a/dist/index.js        -> ["@s/a"]
   * - /p/node_modules/.pnpm/a@1/node_modules/a/ -> ["a"]（会跳过 ".pnpm"）
   */
  private extractImporterPackages(importer: string): string[] {
    const normalized = importer.replace(/\\/g, '/');
    const parts = normalized.split('/');

    const packages: string[] = [];

    for (let i = 0; i < parts.length - 1; i++) {
      if (parts[i] !== 'node_modules') continue;

      const next = parts[i + 1];
      if (!next || next.startsWith('.')) {
        continue;
      }

      if (next.startsWith('@')) {
        const name = parts[i + 2];
        if (name) {
          packages.push(`${next}/${name}`);
        }
        continue;
      }

      packages.push(next);
    }

    return packages;
  }

  /**
   * 解析模块请求
   * @returns 解析后的模块名，如果不需要重定向则返回 null
   */
  resolveModule(context: ResolveContext): string | null {
    const { request, importer } = context;

    // 如果没有导入者，不处理
    if (!importer) {
      return null;
    }

    const importerPackages = this.extractImporterPackages(importer);
    if (importerPackages.length === 0) {
      return null;
    }

    const requestPackageName = this.getRequestPackageName(request);
    if (!requestPackageName) {
      return null;
    }

    const candidateRules = this.rulesMap.get(requestPackageName);
    if (!candidateRules || candidateRules.length === 0) {
      return null;
    }

    for (const rule of candidateRules) {
      // importer 是否位于需要重定向的依赖包链路中
      // 优化点：
      // - 避免每次都把 Set 展开成数组（会产生大量临时对象）
      // - importerPackages 通常很短（路径上出现的包名数量有限），因此遍历它并用 Set.has 做判断更高效
      let shouldRedirect = false;
      for (const pkg of importerPackages) {
        if (rule.dependents.has(pkg)) {
          shouldRedirect = true;
          break;
        }
      }
      if (!shouldRedirect) {
        continue;
      }

      if (request === rule.originalName) {
        logger.debug(`Resolving ${request} -> ${rule.aliasName} (from ${importer})`);
        return rule.aliasName;
      }

      const prefix = `${rule.originalName}/`;
      if (request.startsWith(prefix)) {
        const resolved = `${rule.aliasName}${request.slice(rule.originalName.length)}`;
        logger.debug(`Resolving ${request} -> ${resolved} (from ${importer})`);
        return resolved;
      }
    }

    return null;
  }

  /**
   * 获取别名路径映射
   * 返回别名名称到实际路径的映射，供构建工具插件转换为各自的格式
   */
  getAliasPathMappings(): AliasPathMapping[] {
    const mappings: AliasPathMapping[] = [];

    for (const mapping of this.aliasMappings) {
      // 查找别名包的实际路径
      const aliasPath = findPackagePath(mapping.aliasName, this.options.projectRoot);

      const resolvedPath =
        aliasPath ?? join(this.options.projectRoot, 'node_modules', mapping.aliasName);

      mappings.push({
        aliasName: mapping.aliasName,
        originalName: mapping.originalName,
        path: resolvedPath,
      });
    }

    return mappings;
  }
}

/**
 * 创建别名管理器实例
 */
export function createAliasManager(options: ResolvedOptions): AliasManager {
  return new AliasManager(options);
}
