import type {
  AliasMapping,
  ResolvedOptions,
  AliasPathMapping,
  AnalysisResult,
  ResolutionExplanation,
  ResolverDiagnostic,
} from '../types/index';
import { realpathSync, statSync } from 'node:fs';
import { join, posix } from 'path';
import { createLogger } from '../utils/logger';
import { findPackagePath, getCachedRealPath, readPackageJsonCached } from '../utils/fs';
import { LruCache } from '../utils/lru-cache';
import { isPathLikeRequest, isVirtualModuleRequest } from '../utils/module-request';
import { ResolutionError } from './resolution-error';

const logger = createLogger('alias-manager');

interface ResolveContext {
  request: string;
  importer?: string;
}
interface PackageInstance {
  name: string;
  path: string;
}
interface PackageScope {
  path: string;
  name?: string;
}
interface AliasRule {
  aliasName: string;
  dependents: Set<string>;
  excludedPackages: Set<string>;
  pathScoped: boolean;
}
interface RuleIndex {
  paths: Map<string, Array<{ rule: AliasRule; scope: PackageScope }>>;
  rules: AliasRule[];
}
interface ImporterInfo {
  paths: string[];
  instances: PackageInstance[];
}
interface RuleMatch {
  rule: AliasRule;
  specificity: number;
  scopes: PackageScope[];
  excluded: boolean;
}
interface Decision {
  reason: ResolutionExplanation['reason'];
  aliases: string[];
  matchedPaths: string[];
}

const NO_RULE: Decision = { reason: 'no-rule', aliases: [], matchedPaths: [] };
const NO_IMPORTER: Decision = { reason: 'no-importer', aliases: [], matchedPaths: [] };
const UNMATCHED: Decision = { reason: 'unmatched', aliases: [], matchedPaths: [] };

function normalizePath(path: string): string {
  const normalized = posix.normalize(path.replace(/\\/g, '/'));
  return normalized.length <= 1 ? normalized : normalized.replace(/\/+$/, '');
}

function isWithin(path: string, directory: string): boolean {
  return (
    path === directory || path.startsWith(directory.endsWith('/') ? directory : directory + '/')
  );
}

/** Extract lexical package instances, including nested and scoped packages. */
function packageInstances(path: string): PackageInstance[] {
  const parts = path.split('/');
  const instances: PackageInstance[] = [];
  for (let index = 0; index < parts.length - 1; index++) {
    if (parts[index] !== 'node_modules') continue;
    const name = parts[index + 1];
    if (!name || name.startsWith('.')) continue;
    const scopedName = name.startsWith('@') ? parts[index + 2] : undefined;
    if (name.startsWith('@') && !scopedName) continue;
    const end = scopedName ? index + 3 : index + 2;
    instances.push({
      name: scopedName ? name + '/' + scopedName : name,
      path: parts.slice(0, end).join('/'),
    });
  }
  return instances;
}

/**
 * Compile active mappings into package-path indexes. Filesystem work is
 * bounded to publication and an importer's first lookup. All caches belong
 * to this generation and have bounded capacity.
 */
export class AliasManager {
  private aliasMappings: AliasMapping[] = [];
  private rulesMap = new Map<string, RuleIndex>();
  private importerCache = new LruCache<string, ImporterInfo>({ maxEntries: 1000 });
  private pathCache = new LruCache<string, string[]>({ maxEntries: 5000 });
  private decisionCache = new LruCache<string, Decision>({ maxEntries: 5000 });
  private diagnostics = new Map<string, ResolverDiagnostic>();

  constructor(private options: ResolvedOptions) {}

  initFromAnalysisResult(result: AnalysisResult): void {
    this.clear();
    this.aliasMappings = result.aliasMappings;
    for (const mapping of this.aliasMappings) {
      const pathScoped = mapping.importerPaths !== undefined;
      const rule: AliasRule = {
        aliasName: mapping.aliasName,
        pathScoped,
        dependents: new Set([
          ...(pathScoped ? [] : mapping.allDependents),
          ...(this.options.includeRedirects[mapping.originalName] ?? []),
        ]),
        excludedPackages: new Set(this.options.excludeRedirects[mapping.originalName] ?? []),
      };
      let index = this.rulesMap.get(mapping.originalName);
      if (!index) {
        index = { paths: new Map(), rules: [] };
        this.rulesMap.set(mapping.originalName, index);
      }
      index.rules.push(rule);
      for (const packagePath of mapping.importerPaths ?? []) {
        const candidates = this.pathCandidates(packagePath);
        const name =
          packageInstances(normalizePath(packagePath)).at(-1)?.name ??
          readPackageJsonCached(packagePath)?.name;
        for (const candidate of candidates) {
          const entries = index.paths.get(candidate) ?? [];
          entries.push({ rule, scope: { path: candidate, name } });
          index.paths.set(candidate, entries);
        }
      }
    }
    logger.info('Initialized ' + this.aliasMappings.length + ' alias mappings');
  }

  clear(): void {
    this.aliasMappings = [];
    this.rulesMap.clear();
    this.importerCache.clear();
    this.pathCache.clear();
    this.decisionCache.clear();
    this.diagnostics.clear();
  }

  private pathCandidates(path: string, moduleId = false): string[] {
    const cacheKey = (moduleId ? 'id\0' : 'path\0') + path;
    const cached = this.pathCache.get(cacheKey);
    if (cached) return cached;
    let literalPath = path;
    let realPath = !moduleId ? getCachedRealPath(path) : undefined;
    if (realPath === undefined) {
      try {
        realPath = realpathSync(path);
      } catch {
        // Physical directory paths are literal. For module IDs, recognize a
        // suffix only after a real file, preserving '#' and '?' in directories
        // and filenames. Longest prefixes handle multiple query/hash markers.
        if (moduleId) {
          const markers = [...path.matchAll(/[?#]/g)];
          for (let index = markers.length - 1; index >= 0; index--) {
            const candidate = path.slice(0, markers[index]!.index);
            try {
              if (!statSync(candidate).isFile()) continue;
              realPath = realpathSync(candidate);
              literalPath = candidate;
              break;
            } catch {
              // Nonexistent/virtual importers retain their lexical path.
            }
          }
        }
      }
    }
    const paths = new Set([normalizePath(literalPath)]);
    if (realPath) paths.add(normalizePath(realPath));
    const candidates = [...paths];
    this.pathCache.set(cacheKey, candidates);
    return candidates;
  }

  private importerInfo(importer: string): ImporterInfo {
    const cached = this.importerCache.get(importer);
    if (cached) return cached;
    const paths = this.pathCandidates(importer, true);
    const instances = paths.flatMap(packageInstances);
    if (instances.length === 0) {
      // Workspace sources have no node_modules segment. Find their owner
      // once so explicit include/exclude rules work for real paths, too.
      for (const path of paths) {
        let directory = path;
        while (true) {
          const manifest = readPackageJsonCached(directory);
          if (manifest?.name) {
            instances.push({ name: manifest.name, path: directory });
            break;
          }
          const parent = posix.dirname(directory);
          if (parent === directory) break;
          directory = parent;
        }
      }
    }
    const info = { paths, instances };
    this.importerCache.set(importer, info);
    return info;
  }

  private requestPackageName(request: string): string {
    if (!request || isPathLikeRequest(request) || isVirtualModuleRequest(request)) return '';
    const base = request.split(/[?#]/, 1)[0] ?? '';
    const parts = base.split('/');
    return base.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? '');
  }

  private decide(packageName: string, importer?: string): Decision {
    if (!importer) return NO_IMPORTER;
    const index = this.rulesMap.get(packageName);
    if (!index) return NO_RULE;
    const cacheKey = packageName + '\0' + importer;
    const cached = this.decisionCache.get(cacheKey);
    if (cached) return cached;

    const info = this.importerInfo(importer);
    const matches = new Map<AliasRule, RuleMatch>();
    // Walk ancestors instead of scanning every path in every rule.
    for (const candidate of info.paths) {
      let path = candidate;
      let distance = 0;
      while (true) {
        for (const { rule, scope } of index.paths.get(path) ?? []) {
          let match = matches.get(rule);
          if (!match) {
            match = { rule, specificity: Number.NEGATIVE_INFINITY, scopes: [], excluded: false };
            matches.set(rule, match);
          }
          match.specificity = Math.max(match.specificity, -distance);
          match.scopes.push(scope);
        }
        const parent = posix.dirname(path);
        if (parent === path) break;
        path = parent;
        distance++;
      }
    }

    for (const rule of index.rules) {
      const included = info.instances.filter((instance) => rule.dependents.has(instance.name));
      let match = matches.get(rule);
      if (!match && included.length > 0) {
        match = { rule, specificity: Number.NEGATIVE_INFINITY, scopes: [], excluded: false };
        matches.set(rule, match);
      }
      if (!match) continue;
      match.excluded =
        match.scopes.some((scope) => scope.name && rule.excludedPackages.has(scope.name)) ||
        info.instances.some(
          (instance) =>
            rule.excludedPackages.has(instance.name) &&
            (!rule.pathScoped ||
              match.scopes.some(
                (scope) =>
                  isWithin(instance.path, scope.path) || isWithin(scope.path, instance.path),
              ) ||
              included.some(
                (parent) =>
                  isWithin(instance.path, parent.path) || isWithin(parent.path, instance.path),
              )),
        );
    }

    let specificity = Number.NEGATIVE_INFINITY;
    let best: RuleMatch[] = [];
    for (const match of matches.values()) {
      if (match.specificity > specificity) {
        specificity = match.specificity;
        best = [match];
      } else if (match.specificity === specificity) {
        best.push(match);
      }
    }
    let decision: Decision = UNMATCHED;
    if (best.length > 0) {
      const aliases = [...new Set(best.map((match) => match.rule.aliasName))].sort();
      const matchedPaths = [
        ...new Set(best.flatMap((match) => match.scopes.map((scope) => scope.path))),
      ].sort();
      decision = {
        reason: best.some((match) => match.excluded)
          ? 'excluded'
          : aliases.length > 1
            ? 'ambiguous'
            : 'redirected',
        aliases,
        matchedPaths,
      };
      if (decision.reason === 'ambiguous') {
        const key = packageName + '\0' + JSON.stringify([aliases, matchedPaths]);
        if (!this.diagnostics.has(key) && this.diagnostics.size < 1000) {
          const diagnostic: ResolverDiagnostic = {
            code: 'AMBIGUOUS_IMPORTER',
            severity: 'error',
            message:
              'Multiple aliases match the same importer for ' +
              packageName +
              ': ' +
              aliases.join(', '),
            packageName,
            aliases,
            importerPaths: matchedPaths,
          };
          this.diagnostics.set(key, diagnostic);
          logger.warn(diagnostic.message);
        }
      }
    }
    this.decisionCache.set(cacheKey, decision);
    return decision;
  }

  resolveModule({ request, importer }: ResolveContext): string | null {
    const packageName = this.requestPackageName(request);
    if (!packageName) return null;
    const decision = this.decide(packageName, importer);
    if (decision.reason === 'ambiguous' && this.options.strict) {
      throw new ResolutionError(this.getDiagnostics());
    }
    return decision.reason === 'redirected'
      ? decision.aliases[0]! + request.slice(packageName.length)
      : null;
  }

  explainResolution(request: string, importer?: string): ResolutionExplanation {
    const packageName = this.requestPackageName(request);
    const decision = packageName ? this.decide(packageName, importer) : NO_RULE;
    return {
      request,
      importer,
      resolved:
        decision.reason === 'redirected'
          ? decision.aliases[0]! + request.slice(packageName.length)
          : null,
      reason: decision.reason,
      aliases: [...decision.aliases],
      matchedPaths: [...decision.matchedPaths],
    };
  }

  getDiagnostics(): ResolverDiagnostic[] {
    return [...this.diagnostics.values()].map((diagnostic) =>
      Object.assign({}, diagnostic, {
        aliases: [...(diagnostic.aliases ?? [])],
        importerPaths: [...(diagnostic.importerPaths ?? [])],
      }),
    );
  }

  getAliasPathMappings(): AliasPathMapping[] {
    return this.aliasMappings.map((mapping) => ({
      aliasName: mapping.aliasName,
      originalName: mapping.originalName,
      path:
        findPackagePath(mapping.aliasName, this.options.projectRoot) ??
        join(this.options.projectRoot, 'node_modules', mapping.aliasName),
    }));
  }
}

export function createAliasManager(options: ResolvedOptions): AliasManager {
  return new AliasManager(options);
}
