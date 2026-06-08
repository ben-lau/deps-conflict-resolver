import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import type { PackageJson } from '../types/index';
import { LruCache } from './lru-cache';

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

/**
 * package.json 读取缓存，避免重复 IO 操作
 */
const DEFAULT_PACKAGE_JSON_CACHE_MAX_ENTRIES = 5000;
const packageJsonCache = new LruCache<string, PackageJson | null>({
  maxEntries: DEFAULT_PACKAGE_JSON_CACHE_MAX_ENTRIES,
});

/**
 * require() 实例缓存（按 baseDir）
 * - findPackagePath 会频繁 createRequire，缓存可显著减少开销
 */
type RequireFn = ReturnType<typeof createRequire>;

const DEFAULT_REQUIRE_CACHE_MAX_ENTRIES = 200;
const requireCache = new LruCache<string, RequireFn>({
  maxEntries: DEFAULT_REQUIRE_CACHE_MAX_ENTRIES,
});

/**
 * 包路径解析缓存（按 baseDir + packageName）
 * - 缓存 null，避免重复探测
 */
const DEFAULT_PACKAGE_PATH_CACHE_MAX_ENTRIES = 20000;
const packagePathCache = new LruCache<string, string | null>({
  maxEntries: DEFAULT_PACKAGE_PATH_CACHE_MAX_ENTRIES,
});

/**
 * 清理 package.json 缓存，释放内存
 */
export function clearPackageJsonCache(): void {
  packageJsonCache.clear();
  packagePathCache.clear();
  requireCache.clear();
}

/**
 * 同步读取 JSON 文件（性能更好，减少事件循环开销）
 */
function readJsonFileSync<T = unknown>(filePath: string): T | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

/**
 * 检查文件是否存在
 */
export function fileExists(filePath: string): boolean {
  return existsSync(filePath);
}

/**
 * 读取 package.json（带缓存）
 * 使用同步读取以减少事件循环开销
 */
export function readPackageJsonCached(dir: string): PackageJson | null {
  const pkgPath = join(dir, 'package.json');

  const cached = packageJsonCache.get(pkgPath);
  if (cached !== undefined) {
    return cached;
  }

  // 使用同步读取，性能更好
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
 * 查找 node_modules 中的包路径
 * 使用 require.resolve 机制来正确处理各种包管理器（npm, yarn, pnpm）的依赖结构
 */
export function findPackagePath(packageName: string, baseDir: string): string | null {
  const cacheKey = `${baseDir}\0${packageName}`;
  const cached = packagePathCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  try {
    // 使用 createRequire 创建一个基于 baseDir 的 require 函数
    // 这样可以正确处理 ESM 和 CJS，以及各种包管理器的依赖结构
    let localRequire = requireCache.get(baseDir);
    if (!localRequire) {
      const baseUrl = pathToFileURL(join(baseDir, 'package.json')).href;
      localRequire = createRequire(baseUrl);
      requireCache.set(baseDir, localRequire);
    }

    const pkgJsonPath = localRequire.resolve(`${packageName}/package.json`);
    const resolved = dirname(pkgJsonPath);
    packagePathCache.set(cacheKey, resolved);
    return resolved;
  } catch {
    // 如果 require.resolve 失败，回退到手动查找
    // 这处理了一些边缘情况，比如包没有正确导出 package.json
    const resolved = findPackagePathFallback(packageName, baseDir);
    packagePathCache.set(cacheKey, resolved);
    return resolved;
  }
}

/**
 * 回退的包路径查找方法
 * 当 require.resolve 失败时使用（例如包没有导出 package.json）
 */
function findPackagePathFallback(packageName: string, baseDir: string): string | null {
  for (const dir of iterateParentDirs(baseDir)) {
    const candidatePath = join(dir, 'node_modules', packageName);
    if (fileExists(candidatePath)) {
      return candidatePath;
    }
  }

  return null;
}
