import type {
  AliasMapping,
  ResolvedOptions,
  AliasPathMapping,
  AnalysisResult,
  ResolutionExplanation,
  ResolverDiagnostic,
} from '../types/index';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix } from 'path';
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
interface PathScopeEntry {
  rule: AliasRule;
  scope: PackageScope;
  pruned?: boolean;
}
interface RuleIndex {
  paths: Map<string, PathScopeEntry[]>;
  rules: AliasRule[];
}
interface ImporterInfo {
  paths: string[];
  instances: PackageInstance[];
}
interface ResolvedPath {
  paths: string[];
  realPath: string | undefined;
}
interface ImporterDirectory {
  key: string;
  realPath: string;
  info: ImporterInfo;
}
interface RuleMatch {
  rule: AliasRule;
  specificity: number;
  scopes: PackageScope[];
  excluded: boolean;
}
interface PrunedMatch {
  specificity: number;
  scopes: PackageScope[];
}
interface Decision {
  reason: ResolutionExplanation['reason'];
  aliases: string[];
  matchedPaths: string[];
}

const NO_RULE: Decision = { reason: 'no-rule', aliases: [], matchedPaths: [] };
const NO_IMPORTER: Decision = { reason: 'no-importer', aliases: [], matchedPaths: [] };
const UNMATCHED: Decision = { reason: 'unmatched', aliases: [], matchedPaths: [] };
const MAX_IMPORTER_DIRECTORIES = 4096;
const MAX_IMPORTER_DIRECTORY_FILES = 64_000;
const MIN_DIRECTORY_IMPORTERS = 4;

function normalizePath(path: string): string {
  const normalized = posix.normalize(path.replace(/\\/g, '/'));
  return normalized.length <= 1 ? normalized : normalized.replace(/\/+$/, '');
}

function isWithin(path: string, directory: string): boolean {
  return (
    path === directory || path.startsWith(directory.endsWith('/') ? directory : directory + '/')
  );
}

function isInstalledPackageDirectory(path: string): boolean {
  return (
    path.includes('/node_modules/') &&
    !path.endsWith('/node_modules') &&
    !/\/node_modules\/@[^/]*$/.test(path)
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
  private pathCache = new LruCache<string, ResolvedPath>({ maxEntries: 5000 });
  private exactPathCache = new LruCache<string, ResolvedPath>({ maxEntries: 5000 });
  private decisionCache = new LruCache<string, Decision>({ maxEntries: 5000 });
  private seenImporters = new LruCache<string, Set<string>>({
    maxEntries: MAX_IMPORTER_DIRECTORIES,
  });
  private importerDirectories = new LruCache<string, ImporterDirectory | null>({
    maxEntries: MAX_IMPORTER_DIRECTORIES,
  });
  private verifiedImporterFiles = new LruCache<string, string>({
    maxEntries: MAX_IMPORTER_DIRECTORY_FILES,
  });
  private directoryDecisions = new LruCache<string, Decision>({ maxEntries: 5000 });
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
        const { paths: candidates } = this.pathCandidates(packagePath);
        const name =
          packageInstances(normalizePath(packagePath)).at(-1)?.name ??
          readPackageJsonCached(packagePath)?.name;
        for (const candidate of candidates) {
          const entries = index.paths.get(candidate) ?? [];
          entries.push({ rule, scope: { path: candidate, name } });
          index.paths.set(candidate, entries);
        }
      }
      for (const packagePath of mapping.excludedImporterPaths ?? []) {
        const { paths: candidates } = this.pathCandidates(packagePath);
        const name =
          packageInstances(normalizePath(packagePath)).at(-1)?.name ??
          readPackageJsonCached(packagePath)?.name;
        for (const candidate of candidates) {
          const entries = index.paths.get(candidate) ?? [];
          entries.push({ rule, scope: { path: candidate, name }, pruned: true });
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
    this.exactPathCache.clear();
    this.decisionCache.clear();
    this.seenImporters.clear();
    this.importerDirectories.clear();
    this.verifiedImporterFiles.clear();
    this.directoryDecisions.clear();
    this.diagnostics.clear();
  }

  private pathCandidates(path: string, moduleId = false): ResolvedPath {
    // Query prefixes and shared directories have their own budget so they
    // cannot evict otherwise resident module IDs.
    const cache = moduleId ? this.pathCache : this.exactPathCache;
    const cached = cache.get(path);
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
              realPath = this.pathCandidates(candidate).realPath;
              if (realPath === undefined) continue;
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
    const result = { paths: [...paths], realPath };
    cache.set(path, result);
    return result;
  }

  private importerInfo(importer: string): ImporterInfo {
    const cached = this.importerCache.get(importer);
    if (cached) return cached;
    const info = this.describeImporter(this.pathCandidates(importer, true).paths);
    this.importerCache.set(importer, info);
    return info;
  }

  private describeImporter(paths: string[]): ImporterInfo {
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
    return { paths, instances };
  }

  private importerDirectory(importer: string): ImporterDirectory | undefined {
    // Use the existing file path even when its per-request decision was evicted.
    if (this.pathCache.has(importer)) return undefined;

    const verifiedDirectory = this.verifiedImporterFiles.get(importer);
    if (
      verifiedDirectory === undefined &&
      (!isAbsolute(importer) || /[?#]|(?:^|[\\/])\.{1,2}(?:[\\/]|$)/.test(importer))
    ) {
      return undefined;
    }
    const directory = dirname(importer);
    const file = basename(importer);
    // A literal backslash can introduce a scope when the full ID is normalized.
    if (file.includes('\\')) return undefined;
    let cached = this.importerDirectories.get(directory);
    if (cached === undefined) {
      if (!isInstalledPackageDirectory(normalizePath(directory))) return undefined;
      if (verifiedDirectory === undefined) {
        const files = this.seenImporters.get(directory) ?? new Set<string>();
        files.add(file);
        if (files.size < MIN_DIRECTORY_IMPORTERS) {
          this.seenImporters.set(directory, files);
          return undefined;
        }
      }
      this.seenImporters.delete(directory);
      cached = this.readImporterDirectory(directory);
      this.importerDirectories.set(directory, cached);
    }
    if (!cached) return undefined;
    if (verifiedDirectory === cached.realPath) return cached;

    // Check only the requested file. A symlink can belong to a different scope.
    try {
      if (!lstatSync(join(cached.realPath, file), { throwIfNoEntry: false })?.isFile()) {
        return undefined;
      }
    } catch {
      return undefined;
    }
    this.verifiedImporterFiles.set(importer, cached.realPath);
    return cached;
  }

  private readImporterDirectory(directory: string): ImporterDirectory | null {
    const { paths, realPath } = this.pathCandidates(directory);
    // Linked source directories can change independently of this generation.
    if (!realPath || !isInstalledPackageDirectory(paths.at(-1)!)) return null;
    return { key: directory + '\0' + realPath, realPath, info: this.describeImporter(paths) };
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

    const directory = this.importerDirectory(importer);
    if (directory) {
      const directoryKey = packageName + '\0' + directory.key;
      const directoryDecision = this.directoryDecisions.get(directoryKey);
      if (directoryDecision) return directoryDecision;
      const decision = this.matchImporter(packageName, index, directory.info);
      this.directoryDecisions.set(directoryKey, decision);
      return decision;
    }
    const decision = this.matchImporter(packageName, index, this.importerInfo(importer));
    this.decisionCache.set(cacheKey, decision);
    return decision;
  }

  private matchImporter(packageName: string, index: RuleIndex, info: ImporterInfo): Decision {
    const matches = new Map<AliasRule, RuleMatch>();
    const prunedMatches = new Map<AliasRule, PrunedMatch>();
    // Walk ancestors instead of scanning every path in every rule.
    for (const candidate of info.paths) {
      let path = candidate;
      let distance = 0;
      while (true) {
        for (const { rule, scope, pruned } of index.paths.get(path) ?? []) {
          if (pruned) {
            const specificity = -distance;
            let prunedMatch = prunedMatches.get(rule);
            if (!prunedMatch) {
              prunedMatch = { specificity, scopes: [scope] };
              prunedMatches.set(rule, prunedMatch);
            } else if (specificity > prunedMatch.specificity) {
              prunedMatch.specificity = specificity;
              prunedMatch.scopes = [scope];
            } else if (specificity === prunedMatch.specificity) {
              prunedMatch.scopes.push(scope);
            }
            continue;
          }
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

    // Negative boundaries mask only their own rule's ancestor scopes, so a
    // pruned nested package never poisons another alias rule at the same depth.
    for (const [rule, prunedMatch] of prunedMatches) {
      const match = matches.get(rule);
      if (match && prunedMatch.specificity >= match.specificity) {
        matches.delete(rule);
      }
    }

    for (const rule of index.rules) {
      const prunedMatch = prunedMatches.get(rule);
      const included = info.instances.filter(
        (instance) =>
          rule.dependents.has(instance.name) &&
          (!prunedMatch || prunedMatch.scopes.some((scope) => isWithin(instance.path, scope.path))),
      );
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
