import type { NpmPackageInfo, PackageJson, ResolvedOptions } from '../types/index';
import { createLogger } from '../utils/logger';
import { DEFAULT_NPM_REGISTRY_TIMEOUT_MS } from '../constants';
import { currentDependencyInputs } from '../utils/dependency-inputs';
import { LruCache } from '../utils/lru-cache';
import type { PreparationMetrics } from '../utils/preparation-metrics';
import { loadNpmrcSettings, registryToken } from './npmrc-settings';

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
  url: URL,
  token: string | undefined,
  metrics?: PreparationMetrics,
): Promise<NpmPackageInfo> {
  try {
    logger.debug(`Fetching package info from: ${url}`);

    const { response, data } = await fetchWithTimeout(
      url.href,
      requestOptions('application/vnd.npm.install-v1+json', token),
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
      throw new Error(`HTTP ${response.status}`);
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

function requestOptions(accept: string, token?: string): RequestInit {
  // A redirect can leave the configured registry path, even on the same host.
  return token
    ? { headers: { Accept: accept, Authorization: 'Bearer ' + token }, redirect: 'error' }
    : { headers: { Accept: accept } };
}

/** Metadata survives corrective analysis within the same preparation. */
export class NpmRegistryClient implements RegistryClient {
  private readonly packageCache = new Map<string, NpmPackageInfo>();
  private readonly manifestCache = new LruCache<string, PackageJson>({ maxEntries: 200 });

  private settings?: Promise<ReadonlyMap<string, string>>;

  constructor(
    private readonly metrics?: PreparationMetrics,
    private readonly project?: Pick<
      ResolvedOptions,
      'projectRoot' | 'packageManager' | 'registryOverride'
    >,
  ) {}

  private async endpoint(packageName: string, registry: string, version?: string) {
    if (this.project) {
      this.settings ??= loadNpmrcSettings(this.project.projectRoot, this.project.packageManager);
    }
    const settings = await this.settings;
    const scope = packageName.startsWith('@') ? packageName.split('/', 1)[0] : undefined;
    const configured =
      this.project?.registryOverride ?? (scope && settings?.get(scope + ':registry')) ?? registry;
    let base: URL;
    try {
      base = new URL(configured);
      if (
        !['https:', 'http:'].includes(base.protocol) ||
        base.username ||
        base.password ||
        base.search ||
        base.hash
      )
        throw new Error('Invalid registry address');
    } catch {
      throw new Error('Invalid registry address for ' + packageName);
    }
    const encodedName = scope
      ? '@' + encodeURIComponent(packageName.slice(1))
      : encodeURIComponent(packageName);
    base.pathname =
      base.pathname.replace(/\/+$/, '') +
      '/' +
      encodedName +
      (version === undefined ? '' : '/' + encodeURIComponent(version));
    return { url: base, token: settings && registryToken(base, settings) };
  }

  async fetchAllVersions(packageName: string, registry: string): Promise<string[]> {
    const key = `${registry}\0${packageName}`;
    let info = this.packageCache.get(key);
    if (!info) {
      const { url, token } = await this.endpoint(packageName, registry);
      info = await fetchPackageInfo(packageName, url, token, this.metrics);
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
    const { url, token } = await this.endpoint(packageName, registry, version);
    const manifest = await fetchWithTimeout(
      url.href,
      requestOptions('application/json', token),
      async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
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
}
