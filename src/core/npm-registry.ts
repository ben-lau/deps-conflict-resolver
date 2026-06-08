import type { NpmPackageInfo } from '../types/index';
import { createLogger } from '../utils/logger';
import { DEFAULT_NPM_REGISTRY, DEFAULT_NPM_REGISTRY_TIMEOUT_MS } from '../constants';

const logger = createLogger('npm-registry');

/**
 * NPM 注册表缓存
 */
const packageCache = new Map<string, NpmPackageInfo>();

export function clearNpmRegistryCache(): void {
  packageCache.clear();
}

/**
 * 带超时的 fetch
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeout = DEFAULT_NPM_REGISTRY_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 从 NPM 注册表获取包信息
 */
async function fetchPackageInfo(
  packageName: string,
  registry = DEFAULT_NPM_REGISTRY,
): Promise<NpmPackageInfo | null> {
  // 检查缓存
  const cacheKey = `${registry}:${packageName}`;
  const cached = packageCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    // 处理作用域包的 URL 编码
    const encodedName = packageName.startsWith('@')
      ? `@${encodeURIComponent(packageName.slice(1))}`
      : packageName;

    const url = `${registry}/${encodedName}`;
    logger.debug(`Fetching package info from: ${url}`);

    const response = await fetchWithTimeout(url, {
      headers: {
        Accept: 'application/vnd.npm.install-v1+json',
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        logger.warn(`Package not found: ${packageName}`);
        return null;
      }
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as {
      name: string;
      versions: Record<
        string,
        {
          dependencies?: Record<string, string>;
          peerDependencies?: Record<string, string>;
          peerDependenciesMeta?: Record<string, { optional?: boolean }>;
        }
      >;
      'dist-tags': Record<string, string>;
    };

    const packageInfo: NpmPackageInfo = {
      name: data.name,
      versions: Object.keys(data.versions),
      versionDetails: data.versions,
      distTags: data['dist-tags'],
    };

    // 缓存时只保留版本列表和 distTags，丢弃庞大的 versionDetails 以节省内存
    const cacheEntry: NpmPackageInfo = {
      name: packageInfo.name,
      versions: packageInfo.versions,
      versionDetails: {},
      distTags: packageInfo.distTags,
    };
    packageCache.set(cacheKey, cacheEntry);

    return packageInfo;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      logger.error(
        `Timeout fetching package info for ${packageName} (>${DEFAULT_NPM_REGISTRY_TIMEOUT_MS}ms)`,
      );
    } else {
      logger.error(`Failed to fetch package info for ${packageName}:`, error);
    }
    return null;
  }
}

/**
 * 获取包的所有可用版本
 */
export async function fetchAllVersions(
  packageName: string,
  registry = DEFAULT_NPM_REGISTRY,
): Promise<string[]> {
  const info = await fetchPackageInfo(packageName, registry);
  return info?.versions ?? [];
}
