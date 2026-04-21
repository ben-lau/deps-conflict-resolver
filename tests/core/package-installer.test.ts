import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PackageInstaller, createPackageInstaller } from '../../src/core/package-installer';
import { clearPackageJsonCache, fileExists } from '../../src/utils/fs';
import { readFileSync } from 'fs';
import { spawn } from 'child_process';
import type { ResolvedOptions, AliasMapping } from '../../src/types';

// Mock 依赖
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    readFileSync: vi.fn(),
  };
});

vi.mock('../../src/utils/fs', async () => {
  // 保留 utils/fs 的真实实现（含 readPackageJsonCached 缓存等）
  // 只覆盖 fileExists 便于测试不同文件存在性分支
  const actual = await vi.importActual<typeof import('../../src/utils/fs')>('../../src/utils/fs');
  return {
    ...actual,
    fileExists: vi.fn(),
  };
});

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

describe('PackageInstaller', () => {
  const mockOptions: ResolvedOptions = {
    dependencies: ['vue'],
    projectRoot: '/test/project',
    packageManager: 'npm',
    registry: 'https://registry.npmjs.org',
    autoInstall: true,
    debug: false,
    aliasPrefix: 'aliased-',
    excludeRedirects: {},
    includeRedirects: {},
  };

  let installer: PackageInstaller;

  beforeEach(() => {
    vi.clearAllMocks();
    clearPackageJsonCache();
    installer = new PackageInstaller(mockOptions);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('installAliases', () => {
    it('should return success when no mappings provided', async () => {
      const result = await installer.installAliases([]);

      expect(result.success).toBe(true);
      expect(result.installed).toEqual([]);
      expect(result.failed).toEqual([]);
    });

    it('should skip mappings without installSpec (reuse existing)', async () => {
      const mappings: AliasMapping[] = [
        {
          originalName: 'vue',
          aliasName: 'aliased-vue',
          resolvedVersion: '2.7.0',
          usedBy: ['some-package'],
          allDependents: ['some-package'],
          installSpec: '', // 空表示复用
        },
      ];

      const result = await installer.installAliases(mappings);

      expect(result.success).toBe(true);
      expect(result.installed).toEqual([]);
    });

    it('should skip already installed aliases with correct version', async () => {
      vi.mocked(fileExists).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({
          name: 'vue',
          version: '2.7.0',
        }),
      );

      const mappings: AliasMapping[] = [
        {
          originalName: 'vue',
          aliasName: 'aliased-vue',
          resolvedVersion: '2.7.0',
          usedBy: ['some-package'],
          allDependents: ['some-package'],
          installSpec: 'aliased-vue@npm:vue@2.7.0',
        },
      ];

      const result = await installer.installAliases(mappings);

      expect(result.success).toBe(true);
      expect(result.installed).toEqual([]);
    });

    it('should reinstall when version mismatch', async () => {
      vi.mocked(fileExists).mockImplementation(path => {
        return path.toString().includes('node_modules');
      });
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({
          name: 'vue',
          version: '2.6.0', // 版本不匹配
        }),
      );

      // Mock spawn 成功
      const mockChild = createMockChildProcess(0);
      vi.mocked(spawn).mockReturnValue(mockChild as never);

      const mappings: AliasMapping[] = [
        {
          originalName: 'vue',
          aliasName: 'aliased-vue',
          resolvedVersion: '2.7.0',
          usedBy: ['some-package'],
          allDependents: ['some-package'],
          installSpec: 'aliased-vue@npm:vue@2.7.0',
        },
      ];

      const result = await installer.installAliases(mappings);

      expect(result.success).toBe(true);
      expect(result.installed).toContain('aliased-vue');
    });

    it('should install when alias not exists', async () => {
      vi.mocked(fileExists).mockReturnValue(false);

      const mockChild = createMockChildProcess(0);
      vi.mocked(spawn).mockReturnValue(mockChild as never);

      const mappings: AliasMapping[] = [
        {
          originalName: 'vue',
          aliasName: 'aliased-vue',
          resolvedVersion: '2.7.0',
          usedBy: ['some-package'],
          allDependents: ['some-package'],
          installSpec: 'aliased-vue@npm:vue@2.7.0',
        },
      ];

      const result = await installer.installAliases(mappings);

      expect(result.success).toBe(true);
      expect(result.installed).toContain('aliased-vue');
      expect(vi.mocked(spawn)).toHaveBeenCalledWith(
        'npm',
        expect.arrayContaining(['install', '--legacy-peer-deps']),
        expect.any(Object),
      );
    });

    it('should use yarn for yarn package manager', async () => {
      const yarnInstaller = new PackageInstaller({
        ...mockOptions,
        packageManager: 'yarn',
      });

      vi.mocked(fileExists).mockReturnValue(false);
      const mockChild = createMockChildProcess(0);
      vi.mocked(spawn).mockReturnValue(mockChild as never);

      const mappings: AliasMapping[] = [
        {
          originalName: 'vue',
          aliasName: 'aliased-vue',
          resolvedVersion: '2.7.0',
          usedBy: ['some-package'],
          allDependents: ['some-package'],
          installSpec: 'aliased-vue@npm:vue@2.7.0',
        },
      ];

      await yarnInstaller.installAliases(mappings);

      expect(vi.mocked(spawn)).toHaveBeenCalledWith(
        'yarn',
        expect.arrayContaining(['add']),
        expect.any(Object),
      );
    });

    it('should use pnpm for pnpm package manager', async () => {
      const pnpmInstaller = new PackageInstaller({
        ...mockOptions,
        packageManager: 'pnpm',
      });

      vi.mocked(fileExists).mockReturnValue(false);
      const mockChild = createMockChildProcess(0);
      vi.mocked(spawn).mockReturnValue(mockChild as never);

      const mappings: AliasMapping[] = [
        {
          originalName: 'vue',
          aliasName: 'aliased-vue',
          resolvedVersion: '2.7.0',
          usedBy: ['some-package'],
          allDependents: ['some-package'],
          installSpec: 'aliased-vue@npm:vue@2.7.0',
        },
      ];

      await pnpmInstaller.installAliases(mappings);

      expect(vi.mocked(spawn)).toHaveBeenCalledWith(
        'pnpm',
        expect.arrayContaining(['add']),
        expect.any(Object),
      );
    });

    it('should handle install failure', async () => {
      vi.mocked(fileExists).mockReturnValue(false);

      const mockChild = createMockChildProcess(1, '', 'Install failed');
      vi.mocked(spawn).mockReturnValue(mockChild as never);

      const mappings: AliasMapping[] = [
        {
          originalName: 'vue',
          aliasName: 'aliased-vue',
          resolvedVersion: '2.7.0',
          usedBy: ['some-package'],
          allDependents: ['some-package'],
          installSpec: 'aliased-vue@npm:vue@2.7.0',
        },
      ];

      const result = await installer.installAliases(mappings);

      expect(result.success).toBe(false);
      expect(result.failed).toContain('aliased-vue');
    });

    it('should handle spawn error', async () => {
      vi.mocked(fileExists).mockReturnValue(false);

      const mockChild = createMockChildProcess(0);
      vi.mocked(spawn).mockReturnValue(mockChild as never);

      // 触发 error 事件
      setTimeout(() => {
        mockChild.emit('error', new Error('Command not found'));
      }, 10);

      const mappings: AliasMapping[] = [
        {
          originalName: 'vue',
          aliasName: 'aliased-vue',
          resolvedVersion: '2.7.0',
          usedBy: ['some-package'],
          allDependents: ['some-package'],
          installSpec: 'aliased-vue@npm:vue@2.7.0',
        },
      ];

      const result = await installer.installAliases(mappings);

      expect(result.success).toBe(false);
      expect(result.errors).toContain('Command not found');
    });

    it('should handle package name mismatch in verification', async () => {
      vi.mocked(fileExists).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({
          name: 'wrong-package', // 包名不匹配
          version: '2.7.0',
        }),
      );

      const mockChild = createMockChildProcess(0);
      vi.mocked(spawn).mockReturnValue(mockChild as never);

      const mappings: AliasMapping[] = [
        {
          originalName: 'vue',
          aliasName: 'aliased-vue',
          resolvedVersion: '2.7.0',
          usedBy: ['some-package'],
          allDependents: ['some-package'],
          installSpec: 'aliased-vue@npm:vue@2.7.0',
        },
      ];

      await installer.installAliases(mappings);

      // 应该重新安装
      expect(vi.mocked(spawn)).toHaveBeenCalled();
    });

    it('should handle package.json read error in verification', async () => {
      vi.mocked(fileExists).mockImplementation(path => {
        // node_modules/aliased-vue 存在但 package.json 不存在
        return !path.toString().includes('package.json');
      });

      const mockChild = createMockChildProcess(0);
      vi.mocked(spawn).mockReturnValue(mockChild as never);

      const mappings: AliasMapping[] = [
        {
          originalName: 'vue',
          aliasName: 'aliased-vue',
          resolvedVersion: '2.7.0',
          usedBy: ['some-package'],
          allDependents: ['some-package'],
          installSpec: 'aliased-vue@npm:vue@2.7.0',
        },
      ];

      await installer.installAliases(mappings);

      // 应该安装
      expect(vi.mocked(spawn)).toHaveBeenCalled();
    });

    it('should handle JSON parse error in verification', async () => {
      vi.mocked(fileExists).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('invalid json');

      const mockChild = createMockChildProcess(0);
      vi.mocked(spawn).mockReturnValue(mockChild as never);

      const mappings: AliasMapping[] = [
        {
          originalName: 'vue',
          aliasName: 'aliased-vue',
          resolvedVersion: '2.7.0',
          usedBy: ['some-package'],
          allDependents: ['some-package'],
          installSpec: 'aliased-vue@npm:vue@2.7.0',
        },
      ];

      await installer.installAliases(mappings);

      // 应该安装
      expect(vi.mocked(spawn)).toHaveBeenCalled();
    });
  });
});

describe('createPackageInstaller', () => {
  it('should create PackageInstaller instance', () => {
    const options: ResolvedOptions = {
      dependencies: ['vue'],
      projectRoot: '/test/project',
      packageManager: 'npm',
      registry: 'https://registry.npmjs.org',
      autoInstall: true,
      debug: false,
      aliasPrefix: 'aliased-',
      excludeRedirects: {},
      includeRedirects: {},
    };

    const installer = createPackageInstaller(options);

    expect(installer).toBeInstanceOf(PackageInstaller);
  });
});

// Helper function to create mock child process
function createMockChildProcess(exitCode: number, stdout = '', stderr = '') {
  const events: Record<string, ((...args: unknown[]) => void)[]> = {};

  const mockChild = {
    stdout: {
      on: vi.fn((_event: string, callback: (data: Buffer) => void) => {
        if (stdout) {
          setTimeout(() => callback(Buffer.from(stdout)), 5);
        }
      }),
    },
    stderr: {
      on: vi.fn((_event: string, callback: (data: Buffer) => void) => {
        if (stderr) {
          setTimeout(() => callback(Buffer.from(stderr)), 5);
        }
      }),
    },
    on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
      if (!events[event]) {
        events[event] = [];
      }
      events[event].push(callback);

      if (event === 'close') {
        setTimeout(() => callback(exitCode), 20);
      }
    }),
    emit: (event: string, ...args: unknown[]) => {
      if (events[event]) {
        events[event].forEach(cb => cb(...args));
      }
    },
    kill: vi.fn(),
    killed: false,
  };

  return mockChild;
}
