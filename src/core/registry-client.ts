import type { NpmPackageInfo, PackageJson } from '../types/index';
import { createLogger } from '../utils/logger';
import { DEFAULT_NPM_REGISTRY_TIMEOUT_MS } from '../constants';
import { currentDependencyInputs } from '../utils/dependency-inputs';
import { LruCache } from '../utils/lru-cache';
import type { PreparationMetrics } from '../utils/preparation-metrics';

const logger = createLogger('npm-registry');

export interface RegistryClient {
  fetchAllVersions(packageName: string, registry: string): Promise<string[]>;
  getCachedManifest?(
    packageName: string,
    version: string,
    registry: string,
  ): PackageJson | undefined;
  fetchPackageManifest?(
    packageName: string,
    version: string,
    registry: string,
  ): Promise<PackageJson>;
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
  metrics?: PreparationMetrics,
): Promise<T> {
  // Registry responses can change without a corresponding filesystem change.
  currentDependencyInputs()?.invalidate();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_NPM_REGISTRY_TIMEOUT_MS);
  const start = performance.now();
  if (metrics) metrics.counts.registryRequests++;

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return await consumeResponse(response);
  } finally {
    clearTimeout(timeoutId);
    if (metrics) metrics.milliseconds.registry += performance.now() - start;
  }
}

/**
 * 从 NPM 注册表获取包信息
 */
async function fetchPackageInfo(
  packageName: string,
  registry: string,
  metrics?: PreparationMetrics,
): Promise<NpmPackageInfo> {
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
            versions: Record<string, PackageJson>;
            'dist-tags': Record<string, string>;
          },
        };
      },
      metrics,
    );

    if (!response.ok) {
      if (response.status === 404) {
        logger.warn(`Package not found: ${packageName}`);
        throw new Error(`Package not found: ${packageName} (HTTP 404)`);
      }
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return {
      name: data!.name,
      versions: Object.keys(data!.versions),
      // Installation metadata includes peer declarations. Retain only the
      // fields needed for planning, and only for identifiable manifests.
      versionDetails: Object.fromEntries(
        Object.entries(data!.versions)
          .filter(
            ([version, manifest]) => manifest?.name === packageName && manifest.version === version,
          )
          .map(([version, manifest]) => [
            version,
            {
              name: manifest.name,
              version: manifest.version,
              dependencies: manifest.dependencies,
              optionalDependencies: manifest.optionalDependencies,
              peerDependencies: manifest.peerDependencies,
              peerDependenciesMeta: manifest.peerDependenciesMeta,
            },
          ]),
      ),
      distTags: data!['dist-tags'],
    };
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

/** Metadata survives corrective analysis within the same preparation. */
export class NpmRegistryClient implements RegistryClient {
  private readonly packageCache = new Map<string, NpmPackageInfo>();
  private readonly manifestCache = new LruCache<string, PackageJson>({ maxEntries: 200 });

  constructor(private readonly metrics?: PreparationMetrics) {}

  async fetchAllVersions(packageName: string, registry: string): Promise<string[]> {
    const key = `${registry}\0${packageName}`;
    let info = this.packageCache.get(key);
    if (!info) {
      info = await fetchPackageInfo(packageName, registry, this.metrics);
      this.packageCache.set(key, info);
    }
    return info.versions;
  }

  getCachedManifest(
    packageName: string,
    version: string,
    registry: string,
  ): PackageJson | undefined {
    return (
      this.manifestCache.get(`${registry}\0${packageName}\0${version}`) ??
      this.packageCache.get(`${registry}\0${packageName}`)?.versionDetails[version]
    );
  }

  async fetchPackageManifest(
    packageName: string,
    version: string,
    registry: string,
  ): Promise<PackageJson> {
    const key = `${registry}\0${packageName}\0${version}`;
    const cached = this.getCachedManifest(packageName, version, registry);
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
      this.metrics,
    );
    if (manifest.name !== packageName || manifest.version !== version) {
      throw new Error(`Invalid manifest for ${packageName}@${version}`);
    }
    this.manifestCache.set(key, manifest);
    return manifest;
  }

  clear(): void {
    this.packageCache.clear();
    this.manifestCache.clear();
  }
}

// Shared only by the legacy npm-registry helper.
export const npmRegistryClient = new NpmRegistryClient();

export function clearNpmRegistryCache(): void {
  npmRegistryClient.clear();
}
