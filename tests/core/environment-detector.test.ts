import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EnvironmentDetector } from '../../src/core/environment-detector';
import { DEFAULT_NPM_REGISTRY } from '../../src/constants';
import { existsSync, promises as fs, readFileSync } from 'fs';
import { clearPackageJsonCache } from '../../src/utils/fs';

// Mock fs 模块
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    promises: {
      readFile: vi.fn(),
    },
  };
});

describe('EnvironmentDetector', () => {
  beforeEach(() => {
    clearPackageJsonCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getDetectionResult', () => {
    it('should detect pnpm from packageManager field', async () => {
      vi.mocked(existsSync).mockImplementation(path => {
        return path.toString().endsWith('package.json');
      });

      vi.mocked(readFileSync).mockReturnValue('{"packageManager": "pnpm@8.0.0"}');

      const result = await new EnvironmentDetector('/project').getDetectionResult();

      expect(result.packageManager).toBe('pnpm');
      expect(result.detectedFrom).toBe('packageJson');
    });

    it('should detect yarn from packageManager field', async () => {
      vi.mocked(existsSync).mockImplementation(path => {
        return path.toString().endsWith('package.json');
      });

      vi.mocked(readFileSync).mockReturnValue('{"packageManager": "yarn@3.2.0"}');

      const result = await new EnvironmentDetector('/project').getDetectionResult();

      expect(result.packageManager).toBe('yarn');
      expect(result.detectedFrom).toBe('packageJson');
    });

    it('should detect npm from packageManager field', async () => {
      vi.mocked(existsSync).mockImplementation(path => {
        return path.toString().endsWith('package.json');
      });

      vi.mocked(readFileSync).mockReturnValue('{"packageManager": "npm@9.0.0"}');

      const result = await new EnvironmentDetector('/project').getDetectionResult();

      expect(result.packageManager).toBe('npm');
      expect(result.detectedFrom).toBe('packageJson');
    });

    it('should detect pnpm from pnpm-lock.yaml', async () => {
      vi.mocked(existsSync).mockImplementation(path => {
        const pathStr = path.toString();
        return pathStr.endsWith('pnpm-lock.yaml');
      });

      const result = await new EnvironmentDetector('/project').getDetectionResult();

      expect(result.packageManager).toBe('pnpm');
      expect(result.detectedFrom).toBe('lockfile');
    });

    it('should detect yarn from yarn.lock', async () => {
      vi.mocked(existsSync).mockImplementation(path => {
        const pathStr = path.toString();
        return pathStr.endsWith('yarn.lock');
      });

      const result = await new EnvironmentDetector('/project').getDetectionResult();

      expect(result.packageManager).toBe('yarn');
      expect(result.detectedFrom).toBe('lockfile');
    });

    it('should detect npm from package-lock.json', async () => {
      vi.mocked(existsSync).mockImplementation(path => {
        const pathStr = path.toString();
        return pathStr.endsWith('package-lock.json');
      });

      const result = await new EnvironmentDetector('/project').getDetectionResult();

      expect(result.packageManager).toBe('npm');
      expect(result.detectedFrom).toBe('lockfile');
    });

    it('should detect npm from npm-shrinkwrap.json', async () => {
      vi.mocked(existsSync).mockImplementation(path => {
        const pathStr = path.toString();
        return pathStr.endsWith('npm-shrinkwrap.json');
      });

      const result = await new EnvironmentDetector('/project').getDetectionResult();

      expect(result.packageManager).toBe('npm');
      expect(result.detectedFrom).toBe('lockfile');
    });

    it('should default to npm when no lock file found', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const result = await new EnvironmentDetector('/project').getDetectionResult();

      expect(result.packageManager).toBe('npm');
      expect(result.detectedFrom).toBe('default');
    });

    it('should search parent directories for lock files', async () => {
      vi.mocked(existsSync).mockImplementation(path => {
        const pathStr = path.toString().replace(/\\/g, '/');
        // 只在父目录找到 yarn.lock
        return pathStr === '/parent/yarn.lock';
      });

      const result = await new EnvironmentDetector('/parent/child').getDetectionResult();

      expect(result.packageManager).toBe('yarn');
      expect(result.rootDir).toBe('/parent');
    });

    it('should handle invalid packageManager field gracefully', async () => {
      vi.mocked(existsSync).mockImplementation(path => {
        const pathStr = path.toString();
        return pathStr.endsWith('package.json');
      });

      vi.mocked(readFileSync).mockReturnValue('{"packageManager": "invalid-pm"}');

      const result = await new EnvironmentDetector('/project').getDetectionResult();

      expect(result.packageManager).toBe('npm');
      expect(result.detectedFrom).toBe('default');
    });

    it('should handle JSON parse error gracefully', async () => {
      vi.mocked(existsSync).mockImplementation(path => {
        const pathStr = path.toString();
        return pathStr.endsWith('package.json');
      });

      vi.mocked(readFileSync).mockReturnValue('invalid json');

      const result = await new EnvironmentDetector('/project').getDetectionResult();

      expect(result.packageManager).toBe('npm');
      expect(result.detectedFrom).toBe('default');
    });
  });

  describe('getRegistryForPackageManager', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should detect registry from project .npmrc', async () => {
      vi.mocked(existsSync).mockImplementation(path => {
        return path.toString().endsWith('.npmrc');
      });

      vi.mocked(fs.readFile).mockResolvedValue('registry=https://custom.registry.com');

      const result = await new EnvironmentDetector('/project').getRegistryForPackageManager('npm');

      expect(result).toBe('https://custom.registry.com');
    });

    it('should handle registry with spaces and quotes', async () => {
      vi.mocked(existsSync).mockImplementation(path => {
        return path.toString().endsWith('.npmrc');
      });

      vi.mocked(fs.readFile).mockResolvedValue('registry = "https://quoted.registry.com"');

      const result = await new EnvironmentDetector('/project').getRegistryForPackageManager('npm');

      expect(result).toBe('https://quoted.registry.com');
    });

    it('should skip comments in .npmrc', async () => {
      vi.mocked(existsSync).mockImplementation(path => {
        return path.toString().endsWith('.npmrc');
      });

      vi.mocked(fs.readFile).mockResolvedValue(`
# This is a comment
; Another comment
registry=https://actual.registry.com
`);

      const result = await new EnvironmentDetector('/project').getRegistryForPackageManager('npm');

      expect(result).toBe('https://actual.registry.com');
    });

    it('should detect registry from user .npmrc', async () => {
      process.env.HOME = '/home/user';

      vi.mocked(existsSync).mockImplementation(path => {
        const pathStr = path.toString().replace(/\\/g, '/');
        return pathStr === '/home/user/.npmrc';
      });

      vi.mocked(fs.readFile).mockResolvedValue('registry=https://user.registry.com');

      const result = await new EnvironmentDetector('/project').getRegistryForPackageManager('npm');

      expect(result).toBe('https://user.registry.com');
    });

    it('should detect registry from .pnpmrc for pnpm', async () => {
      process.env.HOME = '/home/user';

      vi.mocked(existsSync).mockImplementation(path => {
        const pathStr = path.toString().replace(/\\/g, '/');
        return pathStr === '/home/user/.pnpmrc';
      });

      vi.mocked(fs.readFile).mockResolvedValue('registry=https://pnpm.registry.com');

      const result = await new EnvironmentDetector('/project').getRegistryForPackageManager('pnpm');

      expect(result).toBe('https://pnpm.registry.com');
    });

    it('should detect registry from .yarnrc.yml for yarn', async () => {
      process.env.HOME = '/home/user';

      vi.mocked(existsSync).mockImplementation(path => {
        return path.toString().endsWith('.yarnrc.yml');
      });

      vi.mocked(fs.readFile).mockResolvedValue('npmRegistryServer: https://yarn.registry.com');

      const result = await new EnvironmentDetector('/project').getRegistryForPackageManager('yarn');

      expect(result).toBe('https://yarn.registry.com');
    });

    it('should handle quoted npmRegistryServer in .yarnrc.yml', async () => {
      process.env.HOME = '/home/user';

      vi.mocked(existsSync).mockImplementation(path => {
        return path.toString().endsWith('.yarnrc.yml');
      });

      vi.mocked(fs.readFile).mockResolvedValue('npmRegistryServer: "https://yarn.registry.com"');

      const result = await new EnvironmentDetector('/project').getRegistryForPackageManager('yarn');

      expect(result).toBe('https://yarn.registry.com');
    });

    it('should return default registry when no config found', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const result = await new EnvironmentDetector('/project').getRegistryForPackageManager('npm');

      expect(result).toBe(DEFAULT_NPM_REGISTRY);
    });

    it('should return default registry when .npmrc has no registry', async () => {
      vi.mocked(existsSync).mockImplementation(path => {
        return path.toString().endsWith('.npmrc');
      });

      vi.mocked(fs.readFile).mockResolvedValue('some-other-config=value');

      const result = await new EnvironmentDetector('/project').getRegistryForPackageManager('npm');

      expect(result).toBe(DEFAULT_NPM_REGISTRY);
    });

    it('should handle file read error gracefully', async () => {
      vi.mocked(existsSync).mockImplementation(path => {
        return path.toString().endsWith('.npmrc');
      });

      vi.mocked(fs.readFile).mockRejectedValue(new Error('Permission denied'));

      const result = await new EnvironmentDetector('/project').getRegistryForPackageManager('npm');

      expect(result).toBe(DEFAULT_NPM_REGISTRY);
    });

    it('should use USERPROFILE on Windows when HOME is not set', async () => {
      delete process.env.HOME;
      process.env.USERPROFILE = 'C:\\Users\\test';

      vi.mocked(existsSync).mockImplementation(path => {
        const pathStr = path.toString();
        return pathStr.includes('Users') && pathStr.endsWith('.npmrc');
      });

      vi.mocked(fs.readFile).mockResolvedValue('registry=https://windows.registry.com');

      const result = await new EnvironmentDetector('/project').getRegistryForPackageManager('npm');

      expect(result).toBe('https://windows.registry.com');
    });
  });
});
