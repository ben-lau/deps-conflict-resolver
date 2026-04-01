import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchAllVersions, clearNpmRegistryCache } from '../../src/core/npm-registry';

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('npm-registry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    clearNpmRegistryCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
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
          headers: { Accept: 'application/json' },
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

    it('should return empty array when package not found (404)', async () => {
      const mockResponse = {
        ok: false,
        status: 404,
        statusText: 'Not Found',
      };

      mockFetch.mockResolvedValue(mockResponse);

      const versionsPromise = fetchAllVersions('nonexistent-package');
      await vi.runAllTimersAsync();
      const versions = await versionsPromise;

      expect(versions).toEqual([]);
    });

    it('should return empty array on HTTP error', async () => {
      const mockResponse = {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      };

      mockFetch.mockResolvedValue(mockResponse);

      const versionsPromise = fetchAllVersions('some-package');
      await vi.runAllTimersAsync();
      const versions = await versionsPromise;

      expect(versions).toEqual([]);
    });

    it('should return empty array on network error', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const versionsPromise = fetchAllVersions('some-package');
      await vi.runAllTimersAsync();
      const versions = await versionsPromise;

      expect(versions).toEqual([]);
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

      const versionsPromise = fetchAllVersions('aborted-package');
      await vi.runAllTimersAsync();
      const versions = await versionsPromise;

      expect(versions).toEqual([]);
    });
  });
});
