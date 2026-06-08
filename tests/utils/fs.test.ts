import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import {
  clearPackageJsonCache,
  fileExists,
  readPackageJsonCached,
  findProjectRoot,
  findPackagePath,
} from '../../src/utils/fs';
import { existsSync, readFileSync } from 'fs';
import { createRequire } from 'module';

// Mock fs 模块
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

// Mock module 模块
vi.mock('module', () => ({
  createRequire: vi.fn(),
}));

describe('fs utils', () => {
  beforeEach(() => {
    clearPackageJsonCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('clearPackageJsonCache', () => {
    it('should clear the cache', () => {
      // 先读取一次 package.json 让缓存有内容
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('{"name": "test"}');

      readPackageJsonCached('/test/project');

      // 清理缓存
      clearPackageJsonCache();

      // 再次读取应该会重新调用 readFileSync
      readPackageJsonCached('/test/project');

      expect(vi.mocked(readFileSync)).toHaveBeenCalledTimes(2);
    });
  });

  describe('fileExists', () => {
    it('should return true when file exists', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      expect(fileExists('/some/path')).toBe(true);
    });

    it('should return false when file does not exist', () => {
      vi.mocked(existsSync).mockReturnValue(false);
      expect(fileExists('/some/path')).toBe(false);
    });
  });

  describe('readPackageJsonCached', () => {
    it('should read and parse package.json', () => {
      vi.mocked(readFileSync).mockReturnValue('{"name": "test-package", "version": "1.0.0"}');

      const result = readPackageJsonCached('/test/project');

      expect(result).toEqual({ name: 'test-package', version: '1.0.0' });
      expect(vi.mocked(readFileSync)).toHaveBeenCalledWith(
        join('/test/project', 'package.json'),
        'utf-8',
      );
    });

    it('should return cached result on second call', () => {
      vi.mocked(readFileSync).mockReturnValue('{"name": "cached"}');

      readPackageJsonCached('/cached/project');
      readPackageJsonCached('/cached/project');

      // 只应该调用一次
      expect(vi.mocked(readFileSync)).toHaveBeenCalledTimes(1);
    });

    it('should return null when file read fails', () => {
      vi.mocked(readFileSync).mockImplementation(() => {
        throw new Error('File not found');
      });

      const result = readPackageJsonCached('/nonexistent');

      expect(result).toBeNull();
    });

    it('should return null when JSON parse fails', () => {
      vi.mocked(readFileSync).mockReturnValue('invalid json');

      const result = readPackageJsonCached('/invalid');

      expect(result).toBeNull();
    });

    it('should cache null result', () => {
      vi.mocked(readFileSync).mockImplementation(() => {
        throw new Error('File not found');
      });

      readPackageJsonCached('/null-cached');
      readPackageJsonCached('/null-cached');

      // 即使返回 null 也应该缓存，只调用一次
      expect(vi.mocked(readFileSync)).toHaveBeenCalledTimes(1);
    });
  });

  describe('findProjectRoot', () => {
    it('should find project root when package.json exists', () => {
      vi.mocked(existsSync).mockImplementation((path) => {
        return path === join('/project/src', 'package.json')
          ? false
          : path === join('/project', 'package.json')
            ? true
            : false;
      });

      const result = findProjectRoot('/project/src');

      expect(result).toBe('/project');
    });

    it('should return starting directory if package.json is there', () => {
      vi.mocked(existsSync).mockImplementation((path) => {
        return path === join('/project', 'package.json');
      });

      const result = findProjectRoot('/project');

      expect(result).toBe('/project');
    });

    it('should return null when no package.json found', () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const result = findProjectRoot('/some/deep/path');

      expect(result).toBeNull();
    });
  });

  describe('findPackagePath', () => {
    it('should find package using require.resolve', () => {
      const mockRequireFn = vi.fn().mockReturnValue('/project/node_modules/lodash/package.json');
      vi.mocked(createRequire).mockReturnValue({
        resolve: mockRequireFn,
      } as unknown as NodeRequire);

      const result = findPackagePath('lodash', '/project');

      expect(result).toBe('/project/node_modules/lodash');
    });

    it('should fall back to manual search when require.resolve fails', () => {
      vi.mocked(createRequire).mockReturnValue({
        resolve: vi.fn().mockImplementation(() => {
          throw new Error('Cannot resolve');
        }),
      } as unknown as NodeRequire);

      // 模拟 node_modules 中存在包
      vi.mocked(existsSync).mockImplementation((path) => {
        return path === join('/project', 'node_modules', 'some-package');
      });

      const result = findPackagePath('some-package', '/project');

      expect(result).toBe(join('/project', 'node_modules', 'some-package'));
    });

    it('should search parent directories for package', () => {
      vi.mocked(createRequire).mockReturnValue({
        resolve: vi.fn().mockImplementation(() => {
          throw new Error('Cannot resolve');
        }),
      } as unknown as NodeRequire);

      // 假设包在父目录的 node_modules 目录中
      vi.mocked(existsSync).mockImplementation((path) => {
        // Windows 路径兼容
        const normalizedPath = path.toString().replace(/\\/g, '/');
        return normalizedPath.includes('/parent/node_modules/hoisted-pkg');
      });

      const result = findPackagePath('hoisted-pkg', '/parent/child');

      expect(result).not.toBeNull();
    });

    it('should return null when package not found anywhere', () => {
      vi.mocked(createRequire).mockReturnValue({
        resolve: vi.fn().mockImplementation(() => {
          throw new Error('Cannot resolve');
        }),
      } as unknown as NodeRequire);

      vi.mocked(existsSync).mockReturnValue(false);

      const result = findPackagePath('nonexistent-package', '/project');

      expect(result).toBeNull();
    });

    it('should handle scoped packages', () => {
      const mockRequireFn = vi
        .fn()
        .mockReturnValue('/project/node_modules/@scope/pkg/package.json');
      vi.mocked(createRequire).mockReturnValue({
        resolve: mockRequireFn,
      } as unknown as NodeRequire);

      const result = findPackagePath('@scope/pkg', '/project');

      expect(result).toBe('/project/node_modules/@scope/pkg');
      expect(mockRequireFn).toHaveBeenCalledWith('@scope/pkg/package.json');
    });
  });
});
