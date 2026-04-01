import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkspaceDetector, createWorkspaceDetector } from '../../src/core/workspace-detector';
import * as fs from 'fs';
import { join } from 'path';
import { clearPackageJsonCache } from '../../src/utils/fs';

// Mock fs 模块
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

describe('WorkspaceDetector', () => {
  let detector: WorkspaceDetector;
  const projectRoot = '/test/project/packages/app';
  const workspaceRoot = '/test/project';

  beforeEach(() => {
    vi.resetAllMocks();
    clearPackageJsonCache();
    detector = createWorkspaceDetector(projectRoot);
  });

  describe('detect', () => {
    it('should detect pnpm workspace with catalog', async () => {
      // Mock pnpm-workspace.yaml exists at workspace root
      vi.mocked(fs.existsSync).mockImplementation(path => {
        if (path === join(workspaceRoot, 'pnpm-workspace.yaml')) return true;
        return false;
      });

      vi.mocked(fs.readFileSync).mockImplementation(path => {
        if (path === join(workspaceRoot, 'pnpm-workspace.yaml')) {
          return `
packages:
  - packages/*

catalog:
  vue: ^3.4.0
  react: ^18.2.0
  lodash: ^4.17.21

catalogs:
  react17:
    react: ^17.0.2
    react-dom: ^17.0.2
`;
        }
        throw new Error('File not found');
      });

      const result = await detector.detect();

      expect(result.isMonorepo).toBe(true);
      expect(result.workspaceType).toBe('pnpm');
      expect(result.workspaceRoot).toBe(workspaceRoot);
      expect(result.catalog).toEqual({
        vue: '^3.4.0',
        react: '^18.2.0',
        lodash: '^4.17.21',
      });
      expect(result.catalogs).toEqual({
        react17: {
          react: '^17.0.2',
          'react-dom': '^17.0.2',
        },
      });
    });

    it('should detect yarn workspace', async () => {
      vi.mocked(fs.existsSync).mockImplementation(path => {
        if (path === join(workspaceRoot, 'package.json')) return true;
        if (path === join(workspaceRoot, 'yarn.lock')) return true;
        return false;
      });

      vi.mocked(fs.readFileSync).mockImplementation(path => {
        if (path === join(workspaceRoot, 'package.json')) {
          return JSON.stringify({
            name: 'monorepo',
            workspaces: ['packages/*'],
          });
        }
        throw new Error('File not found');
      });

      const result = await detector.detect();

      expect(result.isMonorepo).toBe(true);
      expect(result.workspaceType).toBe('yarn');
      expect(result.workspaceRoot).toBe(workspaceRoot);
    });

    it('should detect npm workspace', async () => {
      vi.mocked(fs.existsSync).mockImplementation(path => {
        if (path === join(workspaceRoot, 'package.json')) return true;
        // No yarn.lock
        if (path === join(workspaceRoot, 'yarn.lock')) return false;
        return false;
      });

      vi.mocked(fs.readFileSync).mockImplementation(path => {
        if (path === join(workspaceRoot, 'package.json')) {
          return JSON.stringify({
            name: 'monorepo',
            workspaces: ['packages/*'],
          });
        }
        throw new Error('File not found');
      });

      const result = await detector.detect();

      expect(result.isMonorepo).toBe(true);
      expect(result.workspaceType).toBe('npm');
    });

    it('should return not monorepo when no workspace config found', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = await detector.detect();

      expect(result.isMonorepo).toBe(false);
      expect(result.workspaceType).toBe('none');
      expect(result.workspaceRoot).toBeNull();
    });
  });

  describe('resolveCatalogVersion', () => {
    beforeEach(() => {
      // Setup pnpm workspace with catalog
      vi.mocked(fs.existsSync).mockImplementation(path => {
        if (path === join(workspaceRoot, 'pnpm-workspace.yaml')) return true;
        return false;
      });

      vi.mocked(fs.readFileSync).mockImplementation(path => {
        if (path === join(workspaceRoot, 'pnpm-workspace.yaml')) {
          return `
packages:
  - packages/*

catalog:
  vue: ^3.4.0
  react: ^18.2.0

catalogs:
  react17:
    react: ^17.0.2
`;
        }
        throw new Error('File not found');
      });
    });

    it('should resolve catalog: to default catalog', async () => {
      const result = await detector.resolveCatalogVersion('vue', 'catalog:');

      expect(result.success).toBe(true);
      expect(result.resolved).toBe('^3.4.0');
      expect(result.catalogName).toBe('default');
    });

    it('should resolve catalog:default to default catalog', async () => {
      const result = await detector.resolveCatalogVersion('react', 'catalog:default');

      expect(result.success).toBe(true);
      expect(result.resolved).toBe('^18.2.0');
      expect(result.catalogName).toBe('default');
    });

    it('should resolve named catalog (catalog:react17)', async () => {
      const result = await detector.resolveCatalogVersion('react', 'catalog:react17');

      expect(result.success).toBe(true);
      expect(result.resolved).toBe('^17.0.2');
      expect(result.catalogName).toBe('react17');
    });

    it('should fail when package not in catalog', async () => {
      const result = await detector.resolveCatalogVersion('lodash', 'catalog:');

      expect(result.success).toBe(false);
      expect(result.resolved).toBeNull();
    });

    it('should fail when named catalog not found', async () => {
      const result = await detector.resolveCatalogVersion('vue', 'catalog:unknown');

      expect(result.success).toBe(false);
      expect(result.resolved).toBeNull();
    });
  });

  describe('resolveVersionSpec', () => {
    beforeEach(() => {
      vi.mocked(fs.existsSync).mockImplementation(path => {
        if (path === join(workspaceRoot, 'pnpm-workspace.yaml')) return true;
        return false;
      });

      vi.mocked(fs.readFileSync).mockImplementation(path => {
        if (path === join(workspaceRoot, 'pnpm-workspace.yaml')) {
          return `
catalog:
  vue: ^3.4.0
`;
        }
        throw new Error('File not found');
      });
    });

    it('should resolve catalog: protocol', async () => {
      const result = await detector.resolveVersionSpec('vue', 'catalog:');
      expect(result).toBe('^3.4.0');
    });

    it('should resolve workspace: protocol to *', async () => {
      const result = await detector.resolveVersionSpec('internal-pkg', 'workspace:*');
      expect(result).toBe('*');
    });

    it('should resolve npm: protocol to version', async () => {
      const result = await detector.resolveVersionSpec('aliased-vue', 'npm:vue@^2.7.0');
      expect(result).toBe('^2.7.0');
    });

    it('should return normal version as-is', async () => {
      const result = await detector.resolveVersionSpec('lodash', '^4.17.21');
      expect(result).toBe('^4.17.21');
    });

    it('should return * for file: protocol', async () => {
      const result = await detector.resolveVersionSpec('local-pkg', 'file:../local');
      expect(result).toBe('*');
    });
  });

  describe('getVersionProtocol', () => {
    it('should identify catalog protocol', () => {
      expect(detector.getVersionProtocol('catalog:')).toBe('catalog');
      expect(detector.getVersionProtocol('catalog:default')).toBe('catalog');
      expect(detector.getVersionProtocol('catalog:react17')).toBe('catalog');
    });

    it('should identify workspace protocol', () => {
      expect(detector.getVersionProtocol('workspace:*')).toBe('workspace');
      expect(detector.getVersionProtocol('workspace:^')).toBe('workspace');
    });

    it('should identify npm protocol', () => {
      expect(detector.getVersionProtocol('npm:vue@^3.0.0')).toBe('npm');
    });

    it('should identify file/link protocols', () => {
      expect(detector.getVersionProtocol('file:./local')).toBe('file');
      expect(detector.getVersionProtocol('link:./local')).toBe('link');
      expect(detector.getVersionProtocol('portal:./local')).toBe('portal');
    });

    it('should identify normal version', () => {
      expect(detector.getVersionProtocol('^1.0.0')).toBe('normal');
      expect(detector.getVersionProtocol('~1.0.0')).toBe('normal');
      expect(detector.getVersionProtocol('1.0.0')).toBe('normal');
    });
  });

  describe('findWorkspaceAliases', () => {
    it('should find aliases in pnpm catalog', async () => {
      vi.mocked(fs.existsSync).mockImplementation(path => {
        if (path === join(workspaceRoot, 'pnpm-workspace.yaml')) return true;
        if (path === join(workspaceRoot, 'package.json')) return true;
        return false;
      });

      vi.mocked(fs.readFileSync).mockImplementation(path => {
        if (path === join(workspaceRoot, 'pnpm-workspace.yaml')) {
          return `packages:
  - packages/*

catalog:
  vue: ^3.4.0
  vue2: npm:vue@2.6.14
  vue-router: ^4.2.2
`;
        }
        if (path === join(workspaceRoot, 'package.json')) {
          return JSON.stringify({
            dependencies: {
              vue: 'catalog:',
              vue2: 'catalog:',
            },
          });
        }
        throw new Error('File not found');
      });

      const aliases = await detector.findWorkspaceAliases('vue');

      expect(aliases).toHaveLength(1);
      expect(aliases[0]).toMatchObject({
        aliasName: 'vue2',
        targetPackage: 'vue',
        versionSpec: '2.6.14',
        isWorkspaceRoot: true,
      });
    });

    it('should find aliases in named catalogs', async () => {
      vi.mocked(fs.existsSync).mockImplementation(path => {
        if (path === join(workspaceRoot, 'pnpm-workspace.yaml')) return true;
        if (path === join(workspaceRoot, 'package.json')) return true;
        return false;
      });

      vi.mocked(fs.readFileSync).mockImplementation(path => {
        if (path === join(workspaceRoot, 'pnpm-workspace.yaml')) {
          return `packages:
  - packages/*

catalogs:
  vue2:
    vue: npm:vue@^2.7.0
    vue-router: npm:vue-router@^3.6.0
  react17:
    react: npm:react@^17.0.0
`;
        }
        if (path === join(workspaceRoot, 'package.json')) {
          return JSON.stringify({});
        }
        throw new Error('File not found');
      });

      const aliases = await detector.findWorkspaceAliases('vue');

      expect(aliases).toHaveLength(1);
      expect(aliases[0]).toMatchObject({
        aliasName: 'vue',
        targetPackage: 'vue',
        versionSpec: '^2.7.0',
        isWorkspaceRoot: true,
      });

      const routerAliases = await detector.findWorkspaceAliases('vue-router');
      expect(routerAliases).toHaveLength(1);
      expect(routerAliases[0]).toMatchObject({
        aliasName: 'vue-router',
        targetPackage: 'vue-router',
        versionSpec: '^3.6.0',
      });
    });

    it('should find aliases in workspace root package.json', async () => {
      vi.mocked(fs.existsSync).mockImplementation(path => {
        if (path === join(workspaceRoot, 'pnpm-workspace.yaml')) return true;
        if (path === join(workspaceRoot, 'package.json')) return true;
        return false;
      });

      vi.mocked(fs.readFileSync).mockImplementation(path => {
        if (path === join(workspaceRoot, 'pnpm-workspace.yaml')) {
          return 'packages:\n  - packages/*';
        }
        if (path === join(workspaceRoot, 'package.json')) {
          return JSON.stringify({
            dependencies: {
              vue: '^3.4.0',
              'aliased-vue2': 'npm:vue@^2.7.0',
              'vue2-compat': 'npm:vue@^2.6.0',
            },
          });
        }
        throw new Error('File not found');
      });

      const aliases = await detector.findWorkspaceAliases('vue');

      expect(aliases).toHaveLength(2);
      expect(aliases[0]).toMatchObject({
        aliasName: 'aliased-vue2',
        targetPackage: 'vue',
        versionSpec: '^2.7.0',
        isWorkspaceRoot: true,
      });
      expect(aliases[1]).toMatchObject({
        aliasName: 'vue2-compat',
        targetPackage: 'vue',
        versionSpec: '^2.6.0',
        isWorkspaceRoot: true,
      });
    });

    it('should return empty array when no aliases found', async () => {
      vi.mocked(fs.existsSync).mockImplementation(path => {
        if (path === join(workspaceRoot, 'pnpm-workspace.yaml')) return true;
        if (path === join(workspaceRoot, 'package.json')) return true;
        return false;
      });

      vi.mocked(fs.readFileSync).mockImplementation(path => {
        if (path === join(workspaceRoot, 'pnpm-workspace.yaml')) {
          return 'packages:\n  - packages/*';
        }
        if (path === join(workspaceRoot, 'package.json')) {
          return JSON.stringify({
            dependencies: {
              vue: '^3.4.0',
            },
          });
        }
        throw new Error('File not found');
      });

      const aliases = await detector.findWorkspaceAliases('vue');
      expect(aliases).toHaveLength(0);
    });
  });

  describe('parseSimpleYaml', () => {
    it('should parse pnpm-workspace.yaml with quotes', async () => {
      vi.mocked(fs.existsSync).mockImplementation(path => {
        if (path === join(workspaceRoot, 'pnpm-workspace.yaml')) return true;
        return false;
      });

      vi.mocked(fs.readFileSync).mockImplementation(path => {
        if (path === join(workspaceRoot, 'pnpm-workspace.yaml')) {
          return `
packages:
  - "packages/*"
  - 'apps/*'

catalog:
  "vue": "^3.4.0"
  'react': '^18.0.0'
`;
        }
        throw new Error('File not found');
      });

      const result = await detector.detect();

      expect(result.catalog).toEqual({
        vue: '^3.4.0',
        react: '^18.0.0',
      });
    });

    it('should handle empty catalog', async () => {
      vi.mocked(fs.existsSync).mockImplementation(path => {
        if (path === join(workspaceRoot, 'pnpm-workspace.yaml')) return true;
        return false;
      });

      vi.mocked(fs.readFileSync).mockImplementation(path => {
        if (path === join(workspaceRoot, 'pnpm-workspace.yaml')) {
          return `
packages:
  - packages/*
`;
        }
        throw new Error('File not found');
      });

      const result = await detector.detect();

      expect(result.catalog).toBeUndefined();
    });
  });
});
