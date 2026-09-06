import { mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  materializePackageTree,
  materializeVue3RuntimeDependencies,
  resolveInstalledPackage,
} from './real-element-packages';

describe('real Element package materialization', () => {
  it('keeps real UI packages and their conflicting dependencies in owner scopes', async () => {
    const elementPlus = resolveInstalledPackage('element-plus');
    const elementUi = resolveInstalledPackage('element-ui');
    const vue3 = resolveInstalledPackage('vue');
    const projectRoot = await mkdtemp(join(tmpdir(), 'deps-conflict-resolver-packages-'));
    const rootNodeModules = join(projectRoot, 'node_modules');
    const childCoreNodeModules = join(
      rootNodeModules,
      'legacy-element-ui-widget-core',
      'node_modules',
    );

    try {
      await mkdir(rootNodeModules, { recursive: true });
      await mkdir(childCoreNodeModules, { recursive: true });

      await materializePackageTree('element-plus', elementPlus, rootNodeModules);
      await materializePackageTree('element-ui', elementUi, childCoreNodeModules);

      expect(elementPlus.version).toBe('2.14.5');
      expect(elementUi.version).toBe('2.15.14');
      expect(vue3.version).toBe('3.5.42');
      expect(await realpath(join(rootNodeModules, 'element-plus'))).toBe(
        await realpath(elementPlus.path),
      );
      expect(await realpath(join(childCoreNodeModules, 'element-ui'))).toBe(
        await realpath(elementUi.path),
      );
      expect(await readPackageVersion(join(rootNodeModules, 'async-validator'))).toBe('4.2.5');
      expect(await readPackageVersion(join(childCoreNodeModules, 'async-validator'))).toBe('1.8.5');
      expect(await realpath(join(rootNodeModules, '@element-plus', 'icons-vue'))).toContain(
        '@element-plus+icons-vue@2.3.2',
      );
      expect(await pathExists(join(rootNodeModules, 'vue'))).toBe(false);
      expect(await pathExists(join(childCoreNodeModules, 'vue'))).toBe(false);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('materializes the Vue 3 runtime packages with scoped names', async () => {
    const vue3 = resolveInstalledPackage('vue');
    const projectRoot = await mkdtemp(join(tmpdir(), 'deps-conflict-resolver-vue-runtime-'));
    const nodeModules = join(projectRoot, 'node_modules');

    try {
      await mkdir(nodeModules, { recursive: true });
      await materializeVue3RuntimeDependencies(vue3.path, nodeModules);

      for (const packageName of [
        '@vue/runtime-dom',
        '@vue/runtime-core',
        '@vue/reactivity',
        '@vue/shared',
      ]) {
        expect(await readPackageVersion(join(nodeModules, packageName))).toBe('3.5.42');
      }
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('reports the missing package and the install remedy', () => {
    expect(() => resolveInstalledPackage('@not-installed/real-element-package')).toThrow(
      /@not-installed\/real-element-package.*pnpm install/i,
    );
  });
});

async function readPackageVersion(packagePath: string): Promise<string> {
  const manifest = JSON.parse(await readFile(join(packagePath, 'package.json'), 'utf8')) as {
    version?: unknown;
  };
  if (typeof manifest.version !== 'string') {
    throw new Error(`Missing package version at ${packagePath}`);
  }
  return manifest.version;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await realpath(path);
    return true;
  } catch {
    return false;
  }
}
