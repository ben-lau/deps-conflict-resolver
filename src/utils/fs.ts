import { basename, join, dirname, resolve } from 'path';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { PackageJson } from '../types/index';
import { LruCache } from './lru-cache';
import type { PreparationMetrics } from './preparation-metrics';
import {
  currentDependencyInputs,
  observedExists,
  observedLookupDirectory,
  observedLookupManifest,
  observedReadText,
  observedRealpath,
  type DependencyInputs,
} from './dependency-inputs';

/**
 * 从 startDir 开始向上遍历父目录（包含 startDir 与根目录）
 * 用于统一实现“向上查找”的逻辑，避免各处重复 while 循环。
 */
export function* iterateParentDirs(startDir: string): Generator<string> {
  let currentDir = startDir;

  while (true) {
    yield currentDir;

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      break; // 到达根目录
    }

    currentDir = parentDir;
  }
}

type RequireFn = ReturnType<typeof createRequire>;

export function createFileSystemCache(metrics?: PreparationMetrics) {
  return {
    metrics,
    packageJsonCache: new LruCache<string, PackageJson | null>({ maxEntries: 5000 }),
    requireCache: new LruCache<string, RequireFn>({ maxEntries: 200 }),
    packagePathCache: new LruCache<string, string | null>({ maxEntries: 20_000 }),
    lookupDirectories: new LruCache<string, boolean>({ maxEntries: 5000 }),
    canonicalPathCache: new LruCache<string, { path: string; real: boolean }>({
      maxEntries: 20_000,
    }),
  };
}

export type FileSystemCache = ReturnType<typeof createFileSystemCache>;
type LookupDirectoryCache = FileSystemCache['lookupDirectories'];

const defaultCaches = createFileSystemCache();
const cacheScope = new AsyncLocalStorage<FileSystemCache>();
const recordingCaches = new WeakMap<DependencyInputs, FileSystemCache>();

export function withFileSystemCache<T>(cache: FileSystemCache, task: () => T): T {
  return cacheScope.run(cache, task);
}

function getCaches(cache?: FileSystemCache): FileSystemCache {
  const inputs = currentDependencyInputs();
  if (!inputs) return cache ?? cacheScope.getStore() ?? defaultCaches;
  // A concurrent resolver must never supply a cached answer with no recorded inputs.
  let caches = recordingCaches.get(inputs);
  if (!caches)
    recordingCaches.set(
      inputs,
      (caches = createFileSystemCache(cache?.metrics ?? cacheScope.getStore()?.metrics)),
    );
  return caches;
}

/**
 * 清理本库的 IO 缓存，不修改 Node 的内部模块缓存。
 */
export function clearPackageJsonCache(cache = getCaches()): void {
  const { metrics: _metrics, ...entries } = cache;
  for (const entry of Object.values(entries)) entry.clear();
}

/**
 * 读取已缓存的真实物理路径（仅返回由 realpathSync 确认过的路径）
 */
export function getCachedRealPath(targetPath: string, cache?: FileSystemCache): string | undefined {
  const cached = getCaches(cache).canonicalPathCache.get(targetPath);
  return cached?.real ? cached.path : undefined;
}

/**
 * 解析目标路径的规范化物理路径（带代际缓存，失败时回退到 resolve）
 */
export function canonicalPath(targetPath: string, cache?: FileSystemCache): string {
  const { canonicalPathCache, metrics } = getCaches(cache);
  const cached = canonicalPathCache.get(targetPath);
  if (cached !== undefined) {
    return cached.path;
  }

  let resolved: string;
  let real = true;
  try {
    if (metrics) metrics.counts.realpaths++;
    resolved = observedRealpath(targetPath);
  } catch {
    resolved = resolve(targetPath);
    real = false;
  }

  const entry = { path: resolved, real };
  canonicalPathCache.set(targetPath, entry);
  if (real && resolved !== targetPath) {
    canonicalPathCache.set(resolved, entry);
  }
  return resolved;
}

/**
 * 同步读取 JSON 文件（性能更好，减少事件循环开销）
 */
function readJsonFileSync<T = unknown>(filePath: string): T | null {
  try {
    const content = observedReadText(filePath);
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

/**
 * 检查文件是否存在
 */
export function fileExists(filePath: string): boolean {
  return observedExists(filePath);
}

/**
 * 读取 package.json（带缓存）
 * 使用同步读取以减少事件循环开销
 */
export function readPackageJsonCached(dir: string, cache?: FileSystemCache): PackageJson | null {
  const { packageJsonCache, metrics } = getCaches(cache);
  const pkgPath = join(dir, 'package.json');

  const cached = packageJsonCache.get(pkgPath);
  if (cached !== undefined) {
    return cached;
  }

  // 使用同步读取，性能更好
  if (metrics) metrics.counts.manifestReads++;
  const result = readJsonFileSync<PackageJson>(pkgPath);
  // 缓存结果（包含 null，避免重复 IO 探测）
  packageJsonCache.set(pkgPath, result);
  return result;
}

/**
 * 查找项目根目录（通过向上查找 package.json）
 */
export function findProjectRoot(startDir: string): string | null {
  for (const dir of iterateParentDirs(startDir)) {
    if (fileExists(join(dir, 'package.json'))) {
      return dir;
    }
  }

  return null;
}

/**
 * Locate an installed package directory for metadata inspection. Node supplies
 * lookup order; current filesystem links supply identity. Entry points and
 * exports remain the responsibility of the module/bundler resolver.
 */
export function packageLookupPaths(baseDir: string): string[] | null {
  return createRequire(pathToFileURL(join(baseDir, 'package.json'))).resolve.paths(
    'deps-conflict-resolver/package.json',
  );
}

export function findPackagePath(
  packageName: string,
  baseDir: string,
  cache?: FileSystemCache,
): string | null {
  const caches = getCaches(cache);
  const { packagePathCache, requireCache } = caches;
  const cacheKey = `${baseDir}\0${packageName}`;
  const cached = packagePathCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const metadataRequest = `${packageName}/package.json`;
  // Directory-wide negative answers are valid for one preparation pass.
  const lookupDirectories =
    (currentDependencyInputs() ?? cacheScope.getStore()) ? caches.lookupDirectories : undefined;
  try {
    // 使用 createRequire 创建一个基于 baseDir 的 require 函数
    // 这样可以正确处理 ESM 和 CJS，以及各种包管理器的依赖结构
    let localRequire = requireCache.get(baseDir);
    if (!localRequire) {
      const baseUrl = pathToFileURL(join(baseDir, 'package.json')).href;
      localRequire = createRequire(baseUrl);
      requireCache.set(baseDir, localRequire);
    }

    const lookupPaths = localRequire.resolve.paths?.(metadataRequest);
    if (lookupPaths) {
      let visible = findSelfPackagePath(packageName, baseDir, caches);
      if (!visible) {
        for (const directory of lookupPaths) {
          visible = findPackageInLookupDirectory(directory, metadataRequest, lookupDirectories);
          if (visible) break;
        }
      }
      const resolved = visible ? canonicalPath(visible, caches) : null;
      // Do not fall back to require.resolve on a miss: it can still return a
      // deleted link's old store directory from Node's private path cache.
      packagePathCache.set(cacheKey, resolved);
      return resolved;
    }

    // Retain the existing adapter fallback for resolvers without lookup paths.
    currentDependencyInputs()?.invalidate();
    const pkgJsonPath = localRequire.resolve(metadataRequest);
    const resolved = dirname(pkgJsonPath);
    packagePathCache.set(cacheKey, resolved);
    return resolved;
  } catch {
    // 如果 require.resolve 失败，回退到手动查找
    // 这处理了一些边缘情况，比如包没有正确导出 package.json
    const resolved = findPackagePathFallback(metadataRequest, baseDir, lookupDirectories);
    packagePathCache.set(cacheKey, resolved);
    return resolved;
  }
}

function findSelfPackagePath(
  packageName: string,
  baseDir: string,
  cache: FileSystemCache,
): string | null {
  for (const directory of iterateParentDirs(resolve(baseDir))) {
    if (basename(directory) === 'node_modules') break;
    const manifest = readPackageJsonCached(directory, cache);
    if (!manifest) continue;
    return manifest.name === packageName && 'exports' in manifest && manifest.exports != null
      ? directory
      : null;
  }
  return null;
}

/**
 * 回退的包路径查找方法
 * 当 require.resolve 失败时使用（例如包没有导出 package.json）
 */
function findPackagePathFallback(
  metadataRequest: string,
  baseDir: string,
  lookupDirectories?: LookupDirectoryCache,
): string | null {
  for (const dir of iterateParentDirs(baseDir)) {
    const candidate = findPackageInLookupDirectory(
      join(dir, 'node_modules'),
      metadataRequest,
      lookupDirectories,
    );
    if (candidate) return candidate;
  }

  return null;
}

function findPackageInLookupDirectory(
  directory: string,
  request: string,
  lookupDirectories?: LookupDirectoryCache,
): string | null {
  const metrics = cacheScope.getStore()?.metrics;
  if (lookupDirectories) {
    let exists = lookupDirectories.get(directory);
    if (exists === undefined) {
      // An absent lookup directory accounts for every missing manifest below it.
      // If the directory appears, the recorded input forces a fresh analysis.
      if (metrics) metrics.counts.lookupProbes++;
      exists = observedLookupDirectory(directory);
      lookupDirectories.set(directory, exists);
    }
    if (!exists) return null;
  }
  const manifest = join(directory, request);
  if (metrics) metrics.counts.lookupProbes++;
  return observedLookupManifest(manifest) ? dirname(manifest) : null;
}
