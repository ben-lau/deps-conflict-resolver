import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PackageInstaller, createPackageInstaller } from '../../src/core/package-installer';
import { clearPackageJsonCache, fileExists } from '../../src/utils/fs';
import { promises as fs, readFileSync } from 'fs';
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { existsSync as realExistsSync, readFileSync as realReadFileSync } from 'node:fs';
import type { ResolvedOptions, AliasMapping } from '../../src/types';
import type {
  PackageManagerAdapter,
  PackageManagerRunResult,
} from '../../src/core/package-manager-adapter';

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

    it('should report reused and newly installed aliases separately', async () => {
      vi.mocked(fileExists).mockImplementation((path) => path.toString().includes('aliased-vue2'));
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({
          name: 'vue',
          version: '2.7.0',
        }),
      );
      const install = vi.fn().mockResolvedValue({
        success: true,
        exitCode: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
      } satisfies PackageManagerRunResult);
      const injectedInstaller = new PackageInstaller(mockOptions, { install });

      const result = await injectedInstaller.installAliases([
        {
          originalName: 'vue',
          aliasName: 'aliased-vue2',
          resolvedVersion: '2.7.0',
          usedBy: ['legacy-package'],
          allDependents: ['legacy-package'],
          installSpec: '',
        },
        {
          originalName: 'vue',
          aliasName: 'aliased-vue3',
          resolvedVersion: '2.7.1',
          usedBy: ['modern-package'],
          allDependents: ['modern-package'],
          installSpec: 'aliased-vue3@npm:vue@2.7.1',
        },
      ]);

      expect(result.success).toBe(true);
      expect(result.reused).toEqual(['aliased-vue2']);
      expect(result.installed).toEqual(['aliased-vue3']);
      expect(result.failed).toEqual([]);
    });

    it('should report an occupied alias without replacing it', async () => {
      const projectRoot = await fs.mkdtemp(
        join(tmpdir(), 'deps-conflict-resolver-alias-collision-'),
      );
      const aliasPath = join(projectRoot, 'node_modules', 'aliased-vue2');

      try {
        await fs.mkdir(aliasPath, { recursive: true });
        await fs.writeFile(
          join(aliasPath, 'package.json'),
          JSON.stringify({ name: 'different-package', version: '1.0.0' }),
          'utf8',
        );

        vi.mocked(fileExists).mockReturnValue(true);
        vi.mocked(readFileSync).mockReturnValue(
          JSON.stringify({
            name: 'different-package',
            version: '1.0.0',
          }),
        );

        const install = vi.fn().mockResolvedValue({
          success: true,
          exitCode: 0,
          stdout: '',
          stderr: '',
          timedOut: false,
        });
        const collisionInstaller = new PackageInstaller(
          { ...mockOptions, projectRoot },
          { install },
        );
        const mapping: AliasMapping = {
          originalName: 'vue',
          aliasName: 'aliased-vue2',
          resolvedVersion: '2.7.0',
          usedBy: ['some-package'],
          allDependents: ['some-package'],
          installSpec: 'aliased-vue2@npm:vue@2.7.0',
        };

        const result = await collisionInstaller.installAliases([mapping]);

        expect(result.success).toBe(false);
        expect(result.installed).toEqual([]);
        expect(result.failed).toContain('aliased-vue2');
        expect(result.errors).toContainEqual(expect.stringContaining('Alias collision'));
        expect(install).not.toHaveBeenCalled();
        expect(spawn).not.toHaveBeenCalled();
      } finally {
        await fs.rm(projectRoot, { recursive: true, force: true });
      }
    });

    it('should revalidate aliases after install to reject a race collision', async () => {
      const projectRoot = await fs.mkdtemp(join(tmpdir(), 'deps-conflict-resolver-install-race-'));
      const aliasPath = join(projectRoot, 'node_modules', 'aliased-vue2');

      try {
        vi.mocked(fileExists).mockImplementation((path) => realExistsSync(path));
        vi.mocked(readFileSync).mockImplementation((path) => realReadFileSync(path, 'utf8'));

        const install = vi.fn(async () => {
          // Another process claims the alias between the preflight check and
          // the package manager's successful return.
          await fs.mkdir(aliasPath, { recursive: true });
          await fs.writeFile(
            join(aliasPath, 'package.json'),
            JSON.stringify({ name: 'different-package', version: '1.0.0' }),
            'utf8',
          );
          return {
            success: true,
            exitCode: 0,
            stdout: '',
            stderr: '',
            timedOut: false,
          } satisfies PackageManagerRunResult;
        });
        const collisionInstaller = new PackageInstaller(
          { ...mockOptions, projectRoot },
          { install },
        );

        const result = await collisionInstaller.installAliases([
          {
            originalName: 'vue',
            aliasName: 'aliased-vue2',
            resolvedVersion: '2.7.0',
            usedBy: ['some-package'],
            allDependents: ['some-package'],
            installSpec: 'aliased-vue2@npm:vue@2.7.0',
          },
        ]);

        expect(result.success).toBe(false);
        expect(result.installed).toEqual([]);
        expect(result.failed).toEqual(['aliased-vue2']);
        expect(result.errors).toContainEqual(expect.stringContaining('ALIAS_NAME_OCCUPIED'));
      } finally {
        await fs.rm(projectRoot, { recursive: true, force: true });
      }
    });

    it('should reject a reused alias when its directory contains a different package', async () => {
      const projectRoot = await fs.mkdtemp(join(tmpdir(), 'deps-conflict-resolver-reused-alias-'));
      const aliasPath = join(projectRoot, 'node_modules', 'aliased-vue2');
      const packageJsonPath = join(aliasPath, 'package.json');

      try {
        await fs.mkdir(aliasPath, { recursive: true });
        await fs.writeFile(
          packageJsonPath,
          JSON.stringify({ name: 'different-package', version: '2.7.0' }),
          'utf8',
        );

        vi.mocked(fileExists).mockImplementation((path) => realExistsSync(path));
        vi.mocked(readFileSync).mockImplementation((path) => realReadFileSync(path, 'utf8'));

        const install = vi.fn();
        const collisionInstaller = new PackageInstaller(
          { ...mockOptions, projectRoot },
          { install },
        );
        const mapping: AliasMapping = {
          originalName: 'vue',
          aliasName: 'aliased-vue2',
          resolvedVersion: '2.7.0',
          usedBy: ['some-package'],
          allDependents: ['some-package'],
          installSpec: '',
        };

        const result = await collisionInstaller.installAliases([mapping]);

        expect(result.success).toBe(false);
        expect(result.failed).toEqual(['aliased-vue2']);
        expect(result.errors).toContainEqual(expect.stringContaining('ALIAS_NAME_OCCUPIED'));
        expect(install).not.toHaveBeenCalled();
        expect(spawn).not.toHaveBeenCalled();
      } finally {
        await fs.rm(projectRoot, { recursive: true, force: true });
      }
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

      // 已占用的别名不能被原地替换
      const result = await installer.installAliases(mappings);

      expect(result.success).toBe(false);
      expect(result.failed).toContain('aliased-vue');
      expect(result.errors).toContainEqual(expect.stringContaining('Alias collision'));
      expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    });

    it('should handle package.json read error in verification', async () => {
      vi.mocked(fileExists).mockImplementation((path) => {
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

      const result = await installer.installAliases(mappings);

      expect(result.success).toBe(false);
      expect(result.failed).toContain('aliased-vue');
      expect(result.errors).toContainEqual(expect.stringContaining('Alias collision'));
      expect(vi.mocked(spawn)).not.toHaveBeenCalled();
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

      const result = await installer.installAliases(mappings);

      expect(result.success).toBe(false);
      expect(result.failed).toContain('aliased-vue');
      expect(result.errors).toContainEqual(expect.stringContaining('Alias collision'));
      expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    });

    it('should route installation through the supplied package manager adapter', async () => {
      vi.mocked(fileExists).mockReturnValue(false);
      const runResult: PackageManagerRunResult = {
        success: false,
        exitCode: 1,
        stdout: 'partial output',
        stderr: 'Install failed',
        timedOut: false,
      };
      const install = vi.fn().mockResolvedValue(runResult);
      const packageManager: PackageManagerAdapter = {
        install,
      };
      const injectedInstaller = new PackageInstaller(mockOptions, packageManager);
      const mapping: AliasMapping = {
        originalName: 'vue',
        aliasName: 'aliased-vue',
        resolvedVersion: '2.7.0',
        usedBy: ['some-package'],
        allDependents: ['some-package'],
        installSpec: 'aliased-vue@npm:vue@2.7.0',
      };

      const result = await injectedInstaller.installAliases([mapping]);

      expect(install).toHaveBeenCalledWith([mapping.installSpec]);
      expect(spawn).not.toHaveBeenCalled();
      expect(result).toEqual({
        success: false,
        installed: [],
        reused: [],
        failed: ['aliased-vue'],
        errors: ['Install failed'],
      });
    });

    it('should preserve the legacy timeout error when the adapter times out', async () => {
      vi.mocked(fileExists).mockReturnValue(false);
      const packageManager: PackageManagerAdapter = {
        install: vi.fn().mockResolvedValue({
          success: false,
          exitCode: null,
          stdout: '',
          stderr: 'partial output before timeout',
          timedOut: true,
        } satisfies PackageManagerRunResult),
      };
      const injectedInstaller = new PackageInstaller(mockOptions, packageManager);
      const mapping: AliasMapping = {
        originalName: 'vue',
        aliasName: 'aliased-vue',
        resolvedVersion: '2.7.0',
        usedBy: ['some-package'],
        allDependents: ['some-package'],
        installSpec: 'aliased-vue@npm:vue@2.7.0',
      };

      const result = await injectedInstaller.installAliases([mapping]);

      expect(result.errors).toEqual(['Install timeout after 120s']);
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
      events[event] ??= [];
      events[event].push(callback);

      if (event === 'close') {
        setTimeout(() => callback(exitCode), 20);
      }
    }),
    emit: (event: string, ...args: unknown[]) => {
      if (events[event]) {
        events[event].forEach((cb) => cb(...args));
      }
    },
    kill: vi.fn(),
    killed: false,
  };

  return mockChild;
}
