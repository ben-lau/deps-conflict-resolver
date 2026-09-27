import type {
  AliasMapping,
  ResolvedOptions,
  AliasPathMapping,
  AnalysisResult,
} from '../types/index';
import { realpathSync } from 'node:fs';
import { createLogger } from '../utils/logger';
import { findPackagePath } from '../utils/fs';
import { join, posix } from 'path';
import { LruCache } from '../utils/lru-cache';

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
  importerPaths?: string[];
  excludedPackages: Set<string>;
}

interface ImporterPackageInstance {
  name: string;
  path: string;
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
  /**
   * importer 路径 -> 包名列表 的 LRU 缓存
   * dev server / HMR 场景下同一 importer 会被反复解析，缓存避免重复字符串拆分
   */
  private importerCache = new LruCache<string, ImporterPackageInstance[]>({ maxEntries: 1000 });

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
   * 清理当前 generation 的别名规则。
   *
   * Resolver 失效或回滚时必须移除旧规则，避免失败的 generation 继续参与解析。
   */
  clear(): void {
    this.aliasMappings = [];
    this.rulesMap = new Map();
    this.importerCache.clear();
  }

  /**
   * 基于 allDependents 构建规则（用 Set 做成员判断，避免超大正则导致的性能与长度问题）
   */
  private buildRules(): void {
    this.rulesMap = new Map();
    this.importerCache.clear();

    for (const mapping of this.aliasMappings) {
      const isPathScoped = mapping.importerPaths !== undefined;
      const dependents = new Set(isPathScoped ? [] : (mapping.allDependents ?? []));

      // 1. 先叠加 includeRedirects：显式强制纳入的包（优先于 exclude 执行）
      const includeList = this.options.includeRedirects[mapping.originalName] ?? [];
      if (includeList.length > 0) {
        for (const dep of includeList) {
          dependents.add(dep);
        }
        logger.debug(`Included redirects for ${mapping.originalName}: ${includeList.join(', ')}`);
      }

      const excludeList = this.options.excludeRedirects[mapping.originalName] ?? [];
      // Name-only rules can remove excluded names from the legacy dependent
      // set. Path-scoped rules retain ancestor paths and apply exclusions to
      // the most-specific importer instance at resolution time.
      if (!isPathScoped && excludeList.length > 0) {
        for (const dep of excludeList) {
          dependents.delete(dep);
        }
        logger.debug(`Excluded redirects for ${mapping.originalName}: ${excludeList.join(', ')}`);
      }

      const rule: AliasRule = {
        originalName: mapping.originalName,
        aliasName: mapping.aliasName,
        dependents,
        importerPaths: isPathScoped
          ? mapping.importerPaths!.map((path) => this.normalizeImporterPath(path))
          : undefined,
        excludedPackages: new Set(excludeList),
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
  private normalizeImporterPath(importerPath: string): string {
    const normalized = posix.normalize(importerPath.replace(/\\/g, '/'));
    if (normalized.length <= 1) return normalized;
    return normalized.replace(/\/+$/, '');
  }

  private extractImporterPackageInstances(importer: string): ImporterPackageInstance[] {
    const cached = this.importerCache.get(importer);
    if (cached) {
      return cached;
    }

    const normalized = this.normalizeImporterPath(importer);
    const parts = normalized.split('/');

    const packages: ImporterPackageInstance[] = [];

    for (let i = 0; i < parts.length - 1; i++) {
      if (parts[i] !== 'node_modules') continue;

      const next = parts[i + 1];
      if (!next || next.startsWith('.')) {
        continue;
      }

      if (next.startsWith('@')) {
        const name = parts[i + 2];
        if (name) {
          packages.push({
            name: `${next}/${name}`,
            path: this.normalizeImporterPath(parts.slice(0, i + 3).join('/')),
          });
        }
        continue;
      }

      packages.push({
        name: next,
        path: this.normalizeImporterPath(parts.slice(0, i + 2).join('/')),
      });
    }

    this.importerCache.set(importer, packages);
    return packages;
  }

  private matchesImporterPath(importer: string, packagePath: string): boolean {
    const importerCandidates = this.getNormalizedPathCandidates(importer);
    const packageCandidates = this.getNormalizedPathCandidates(packagePath);
    return [...importerCandidates].some((normalizedImporter) =>
      [...packageCandidates].some(
        (normalizedPackagePath) =>
          normalizedImporter === normalizedPackagePath ||
          normalizedImporter.startsWith(`${normalizedPackagePath}/`),
      ),
    );
  }

  private getNormalizedPathCandidates(path: string): Set<string> {
    const candidates = new Set([this.normalizeImporterPath(path)]);
    try {
      candidates.add(this.normalizeImporterPath(realpathSync(path)));
    } catch {
      // The importer can be a virtual/nonexistent path in unit tests. The
      // lexical candidate remains sufficient in that case.
    }
    return candidates;
  }

  private getPathScopedMatch(
    rule: AliasRule,
    importer: string,
    importerInstances: ImporterPackageInstance[],
  ): { excluded: boolean; specificity: number } | null {
    if (!rule.importerPaths) return null;

    const matchedPaths = rule.importerPaths.filter((packagePath) =>
      this.matchesImporterPath(importer, packagePath),
    );
    const bestPath = matchedPaths.reduce<string | null>(
      (current, packagePath) =>
        !current || packagePath.length > current.length ? packagePath : current,
      null,
    );
    if (!bestPath) return null;

    // Any excluded package instance in the matched scope excludes its whole
    // subtree, preserving the legacy name-based behavior for descendants.
    const nestedInstances = importerInstances.filter((instance) =>
      matchedPaths.some((matchedPath) => this.matchesImporterPath(instance.path, matchedPath)),
    );

    return {
      excluded: nestedInstances.some((instance) => rule.excludedPackages.has(instance.name)),
      specificity: bestPath.length,
    };
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

    const importerInstances = this.extractImporterPackageInstances(importer);
    if (importerInstances.length === 0) {
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

    const pathMatches = candidateRules
      .map((rule) => ({ rule, match: this.getPathScopedMatch(rule, importer, importerInstances) }))
      .filter(
        (entry): entry is { rule: AliasRule; match: { excluded: boolean; specificity: number } } =>
          entry.match !== null,
      )
      .sort(
        (left, right) =>
          right.match.specificity - left.match.specificity ||
          left.rule.aliasName.localeCompare(right.rule.aliasName),
      );

    for (const { rule, match } of pathMatches) {
      if (match.excluded) {
        return null;
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

    for (const rule of candidateRules) {
      // A mapping with importerPaths is authoritative. Name-only matching is
      // reserved for mappings produced by older callers without the field.
      if (rule.importerPaths) continue;

      // importer 是否位于需要重定向的依赖包链路中
      // 优化点：
      // - 避免每次都把 Set 展开成数组（会产生大量临时对象）
      // - importerPackages 通常很短（路径上出现的包名数量有限），因此遍历它并用 Set.has 做判断更高效
      const hasExcludedImporter = importerInstances.some(({ name: pkg }) =>
        rule.excludedPackages.has(pkg),
      );
      const shouldRedirect =
        !hasExcludedImporter && importerInstances.some(({ name: pkg }) => rule.dependents.has(pkg));
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
