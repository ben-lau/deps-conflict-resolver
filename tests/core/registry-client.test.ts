import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NpmRegistryClient } from '../../src/core/registry-client';
import { DEFAULT_NPM_REGISTRY, DEFAULT_NPM_REGISTRY_TIMEOUT_MS } from '../../src/constants';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('NpmRegistryClient', () => {
  let client: NpmRegistryClient;
  function fetchAllVersions(name: string, registry = DEFAULT_NPM_REGISTRY) {
    return client.fetchAllVersions(name, registry);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    client = new NpmRegistryClient();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('routes scoped metadata and sends tokens only to the configured host and path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'deps-scoped-registry-'));
    try {
      for (const setting of [
        'npm_config_userconfig',
        'NPM_CONFIG_USERCONFIG',
        'npm_config_globalconfig',
        'NPM_CONFIG_GLOBALCONFIG',
      ]) {
        vi.stubEnv(setting, join(root, 'isolated.npmrc'));
      }
      vi.stubEnv('DCR_TEST_REGISTRY_TOKEN', 'fixture-token');
      writeFileSync(
        join(root, '.npmrc'),
        [
          '@private:REGISTRY="https://registry.test/Team/" ; scoped mirror',
          '@sibling:registry=https://registry.test/teams/',
          '//REGISTRY.TEST/Team/:_authToken=${DCR_TEST_REGISTRY_TOKEN} # credential',
          '_authToken=unscoped-token',
        ].join('\n'),
      );
      mockFetch.mockImplementation(async (url: string) => {
        const version = url.endsWith('/1.0.0') ? '1.0.0' : undefined;
        return new Response(
          JSON.stringify({ name: '@private/runtime', versions: { '1.0.0': {} }, version }),
        );
      });
      const project = new NpmRegistryClient(undefined, {
        projectRoot: root,
        packageManager: 'npm',
      });
      await project.fetchAllVersions('@private/runtime', DEFAULT_NPM_REGISTRY);
      await project.fetchPackageManifest('@private/runtime', '1.0.0', DEFAULT_NPM_REGISTRY);
      await project.fetchAllVersions('@sibling/runtime', DEFAULT_NPM_REGISTRY);
      await project.fetchAllVersions('runtime', DEFAULT_NPM_REGISTRY);
      const override = new NpmRegistryClient(undefined, {
        projectRoot: root,
        packageManager: 'npm',
        registryOverride: 'https://override.test/npm/',
      });
      await override.fetchAllVersions('@private/runtime', 'https://override.test/npm/');
      const requests = mockFetch.mock.calls;
      expect(requests.map(([url]) => url)).toEqual([
        'https://registry.test/Team/@private%2Fruntime',
        'https://registry.test/Team/@private%2Fruntime/1.0.0',
        'https://registry.test/teams/@sibling%2Fruntime',
        'https://registry.npmjs.org/runtime',
        'https://override.test/npm/@private%2Fruntime',
      ]);
      const headers = requests.map(([, options]) => new Headers(options.headers));
      expect(
        headers
          .slice(0, 2)
          .every((header) => header.get('Authorization') === 'Bearer fixture-token'),
      ).toBe(true);
      expect(requests.slice(0, 2).every(([, options]) => options.redirect === 'error')).toBe(true);
      expect(headers.slice(2).some((header) => header.has('Authorization'))).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  describe('fetchAllVersions', () => {
    it('should fetch and return all versions of a package', async () => {
      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({
          name: 'lodash',
          versions: {
            '4.17.20': {},
            '4.17.21': {},
          },
          'dist-tags': { latest: '4.17.21' },
        }),
      };

      mockFetch.mockResolvedValue(mockResponse);

      const versionsPromise = fetchAllVersions('lodash');
      await vi.runAllTimersAsync();
      const versions = await versionsPromise;

      expect(versions).toEqual(['4.17.20', '4.17.21']);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://registry.npmjs.org/lodash',
        expect.objectContaining({
          headers: { Accept: 'application/vnd.npm.install-v1+json' },
        }),
      );
    });

    it('should use custom registry when provided', async () => {
      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({
          name: 'lodash',
          versions: { '1.0.0': {} },
          'dist-tags': { latest: '1.0.0' },
        }),
      };

      mockFetch.mockResolvedValue(mockResponse);

      const versionsPromise = fetchAllVersions('lodash', 'https://custom.registry.com');
      await vi.runAllTimersAsync();
      await versionsPromise;

      expect(mockFetch).toHaveBeenCalledWith(
        'https://custom.registry.com/lodash',
        expect.anything(),
      );
    });

    it('should handle scoped packages with URL encoding', async () => {
      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({
          name: '@vue/reactivity',
          versions: { '3.0.0': {} },
          'dist-tags': { latest: '3.0.0' },
        }),
      };

      mockFetch.mockResolvedValue(mockResponse);

      const versionsPromise = fetchAllVersions('@vue/reactivity');
      await vi.runAllTimersAsync();
      await versionsPromise;

      // 作用域包应该被正确编码
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('@vue%2Freactivity'),
        expect.anything(),
      );
    });

    it('reports a missing package', async () => {
      const mockResponse = {
        ok: false,
        status: 404,
        statusText: 'Not Found',
      };

      mockFetch.mockResolvedValue(mockResponse);

      await expect(fetchAllVersions('nonexistent-package')).rejects.toThrow('HTTP 404');
    });

    it('reports an HTTP error', async () => {
      const mockResponse = {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      };

      mockFetch.mockResolvedValue(mockResponse);

      await expect(fetchAllVersions('some-package')).rejects.toThrow('HTTP 500');
    });

    it('preserves the network error', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      await expect(fetchAllVersions('some-package')).rejects.toThrow('Network error');
    });

    it('should cache results for subsequent calls', async () => {
      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({
          name: 'cached-pkg',
          versions: { '1.0.0': {} },
          'dist-tags': { latest: '1.0.0' },
        }),
      };

      mockFetch.mockResolvedValue(mockResponse);

      // 第一次调用
      const versionsPromise1 = fetchAllVersions('cached-pkg');
      await vi.runAllTimersAsync();
      await versionsPromise1;

      // 第二次调用应该使用缓存
      const versionsPromise2 = fetchAllVersions('cached-pkg');
      await vi.runAllTimersAsync();
      const versions2 = await versionsPromise2;

      expect(versions2).toEqual(['1.0.0']);
      // fetch 只应该被调用一次
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should handle abort error specifically', async () => {
      const abortError = new Error('Aborted');
      abortError.name = 'AbortError';
      mockFetch.mockRejectedValue(abortError);

      await expect(fetchAllVersions('aborted-package')).rejects.toThrow('Aborted');
    });

    it('should abort a stalled response body and preserve the body error reason', async () => {
      const bodyAbortError = new Error('response body stalled');
      bodyAbortError.name = 'AbortError';
      let bodyAborted = false;
      let rejectBody!: (reason?: unknown) => void;

      mockFetch.mockImplementation(async (_url, init) => {
        const signal = init?.signal as AbortSignal;
        return {
          ok: true,
          json: () =>
            new Promise((_resolve, reject) => {
              rejectBody = reject;
              signal.addEventListener(
                'abort',
                () => {
                  bodyAborted = true;
                  reject(bodyAbortError);
                },
                { once: true },
              );
            }),
        };
      });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const failure = expect(fetchAllVersions('stalled-body')).rejects.toThrow(
        'response body stalled',
      );
      await vi.advanceTimersByTimeAsync(DEFAULT_NPM_REGISTRY_TIMEOUT_MS);

      try {
        expect(bodyAborted).toBe(true);
      } finally {
        // Keep the test bounded if the timeout regression is still present.
        rejectBody(bodyAbortError);
      }

      await failure;
      expect(errorSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('Timeout fetching package info'),
        bodyAbortError,
      );
    });
  });
});
