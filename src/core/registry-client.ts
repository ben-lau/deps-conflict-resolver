import type { NpmPackageInfo, PackageJson } from '../types/index';
import { createLogger } from '../utils/logger';
import { DEFAULT_NPM_REGISTRY, DEFAULT_NPM_REGISTRY_TIMEOUT_MS } from '../constants';
import { LruCache } from '../utils/lru-cache';

const logger = createLogger('npm-registry');

export interface RegistryClient {
  fetchAllVersions(packageName: string, registry: string): Promise<string[]>;
  fetchPackageManifest?(
    packageName: string,
    version: string,
    registry: string,
  ): Promise<PackageJson>;
}

/**
 * NPM 注册表缓存
 */
const packageCache = new Map<string, NpmPackageInfo>();
const manifestCache = new LruCache<string, PackageJson>({ maxEntries: 200 });

export function clearNpmRegistryCache(): void {
  packageCache.clear();
  manifestCache.clear();
}

/**
 * 带超时的 fetch 与响应体读取。
 *
 * `fetch()` resolve 只表示响应头已到达；注册表响应体仍可能卡住。因此
 * 消费响应体的回调也必须在同一个 AbortController 的生命周期内执行。
 */
async function fetchWithTimeout<T>(
  url: string,
  options: RequestInit = {},
  consumeResponse: (response: Response) => Promise<T>,
  timeout = DEFAULT_NPM_REGISTRY_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return await consumeResponse(response);
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
): Promise<NpmPackageInfo> {
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

    const url = `${registry.replace(/\/+$/, '')}/${encodedName}`;
    logger.debug(`Fetching package info from: ${url}`);

    const { response, data } = await fetchWithTimeout(
      url,
      {
        headers: {
          Accept: 'application/vnd.npm.install-v1+json',
        },
      },
      async (fetchedResponse) => {
        if (!fetchedResponse.ok) {
          return { response: fetchedResponse, data: null };
        }

        return {
          response: fetchedResponse,
          data: (await fetchedResponse.json()) as {
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
          },
        };
      },
    );

    if (!response.ok) {
      if (response.status === 404) {
        logger.warn(`Package not found: ${packageName}`);
        throw new Error(`Package not found: ${packageName} (HTTP 404)`);
      }
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const packageInfo: NpmPackageInfo = {
      name: data!.name,
      versions: Object.keys(data!.versions),
      versionDetails: data!.versions,
      distTags: data!['dist-tags'],
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
        error,
      );
    } else {
      logger.error(`Failed to fetch package info for ${packageName}:`, error);
    }
    throw error;
  }
}

export const npmRegistryClient: RegistryClient = {
  async fetchAllVersions(packageName: string, registry: string): Promise<string[]> {
    const info = await fetchPackageInfo(packageName, registry);
    return info?.versions ?? [];
  },
  async fetchPackageManifest(packageName, version, registry) {
    const key = `${registry}\0${packageName}\0${version}`;
    const cached = manifestCache.get(key);
    if (cached) return cached;
    const encodedName = packageName.startsWith('@')
      ? `@${encodeURIComponent(packageName.slice(1))}`
      : encodeURIComponent(packageName);
    const url = `${registry.replace(/\/+$/, '')}/${encodedName}/${encodeURIComponent(version)}`;
    const manifest = await fetchWithTimeout(
      url,
      {
        headers: { Accept: 'application/json' },
      },
      async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        return (await response.json()) as PackageJson;
      },
    );
    if (manifest.name !== packageName || manifest.version !== version) {
      throw new Error(`Invalid manifest for ${packageName}@${version}`);
    }
    manifestCache.set(key, manifest);
    return manifest;
  },
};
