import type {
  AliasMapping,
  ResolvedOptions,
  AliasPathMapping,
  AnalysisResult,
  ResolutionExplanation,
  ResolverDiagnostic,
} from '../types/index';
import { basename, dirname, isAbsolute, join } from 'path';
import { createLogger } from '../utils/logger';
import { findPackagePath, getCachedRealPath, type FileSystemCache } from '../utils/fs';
import {
  observedIsFile,
  observedIsRegularFile,
  observedRealpath,
} from '../utils/dependency-inputs';
import { LruCache } from '../utils/lru-cache';
import { isPathLikeRequest, isVirtualModuleRequest } from '../utils/module-request';
import { ResolutionError } from './resolution-error';
import { describeImporter, describeScope, normalizePath } from './scope-paths';
import {
  NO_IMPORTER,
  NO_RULE,
  ScopeMatcher,
  type Decision,
  type ImporterInfo,
} from './scope-matcher';

const logger = createLogger('alias-manager');

interface ResolveContext {
  request: string;
  importer?: string;
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
const MAX_IMPORTER_DIRECTORIES = 4096;
const MAX_IMPORTER_DIRECTORY_FILES = 64_000;
const MIN_DIRECTORY_IMPORTERS = 4;

function isInstalledPackageDirectory(path: string): boolean {
  return (
    path.includes('/node_modules/') &&
    !path.endsWith('/node_modules') &&
    !/\/node_modules\/@[^/]*$/.test(path)
  );
}

/**
 * Compile active mappings into package-path indexes. Filesystem work is
 * bounded to publication and an importer's first lookup. All caches belong
 * to this generation and have bounded capacity.
 */
export class AliasManager {
  private aliasMappings: AliasMapping[] = [];
  private scopes?: ScopeMatcher;
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
  private readonly warnAmbiguity = logger.bindWarning();

  constructor(
    private options: ResolvedOptions,
    private fileSystemCache?: FileSystemCache,
  ) {}

  initFromAnalysisResult(result: AnalysisResult): void {
    this.clear();
    this.aliasMappings = result.aliasMappings;
    this.scopes = new ScopeMatcher(this.aliasMappings, this.options, (path) =>
      describeScope(path, this.pathCandidates(path).paths, this.fileSystemCache),
    );
    logger.info('Initialized ' + this.aliasMappings.length + ' alias mappings');
  }

  clear(): void {
    this.aliasMappings = [];
    this.scopes = undefined;
    this.clearImporterCache();
  }

  clearImporterCache(): void {
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
    let realPath = !moduleId ? getCachedRealPath(path, this.fileSystemCache) : undefined;
    if (realPath === undefined) {
      try {
        realPath = observedRealpath(path);
      } catch {
        // Physical directory paths are literal. For module IDs, recognize a
        // suffix only after a real file, preserving '#' and '?' in directories
        // and filenames. Longest prefixes handle multiple query/hash markers.
        if (moduleId) {
          const markers = [...path.matchAll(/[?#]/g)];
          for (let index = markers.length - 1; index >= 0; index--) {
            const candidate = path.slice(0, markers[index]!.index);
            try {
              if (!observedIsFile(candidate)) continue;
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
    const info = describeImporter(this.pathCandidates(importer, true).paths, this.fileSystemCache);
    this.importerCache.set(importer, info);
    return info;
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
      if (!observedIsRegularFile(join(cached.realPath, file))) {
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
    return {
      key: directory + '\0' + realPath,
      realPath,
      info: describeImporter(paths, this.fileSystemCache),
    };
  }

  private requestPackageName(request: string): string {
    if (!request || isPathLikeRequest(request) || isVirtualModuleRequest(request)) return '';
    const base = request.split(/[?#]/, 1)[0] ?? '';
    const parts = base.split('/');
    return base.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? '');
  }

  private decide(packageName: string, importer?: string): Decision {
    if (!importer) return NO_IMPORTER;
    if (!this.scopes?.hasRules(packageName)) return NO_RULE;
    const cacheKey = packageName + '\0' + importer;
    const cached = this.decisionCache.get(cacheKey);
    if (cached) return cached;

    const directory = this.importerDirectory(importer);
    if (directory) {
      const directoryKey = packageName + '\0' + directory.key;
      const directoryDecision = this.directoryDecisions.get(directoryKey);
      if (directoryDecision) return directoryDecision;
      const decision = this.matchImporter(packageName, directory.info);
      this.directoryDecisions.set(directoryKey, decision);
      return decision;
    }
    const decision = this.matchImporter(packageName, this.importerInfo(importer));
    this.decisionCache.set(cacheKey, decision);
    return decision;
  }

  private matchImporter(packageName: string, info: ImporterInfo): Decision {
    const decision = this.scopes!.match(packageName, info);
    if (decision.reason === 'ambiguous') {
      const { aliases, matchedPaths } = decision;
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
        this.warnAmbiguity(diagnostic.message);
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
        findPackagePath(mapping.aliasName, this.options.projectRoot, this.fileSystemCache) ??
        join(this.options.projectRoot, 'node_modules', mapping.aliasName),
    }));
  }
}

export function createAliasManager(
  options: ResolvedOptions,
  fileSystemCache?: FileSystemCache,
): AliasManager {
  return new AliasManager(options, fileSystemCache);
}
