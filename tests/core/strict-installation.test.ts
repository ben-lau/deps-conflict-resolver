import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResolver } from '../../src/core/resolver';
import { ResolutionError } from '../../src/core/resolution-error';
import { npmRegistryClient } from '../../src/core/registry-client';
import * as packageManager from '../../src/core/package-manager-adapter';
import { clearPackageJsonCache } from '../../src/utils/fs';
import { resetGlobalLogLevel } from '../../src/utils/logger';
import type { PackageJson } from '../../src/types';

const roots: string[] = [];

function writePackage(directory: string, manifest: PackageJson): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest));
}

function fixture(withNestedProvider: boolean, peerRange = '^1') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'deps-strict-install-')));
  roots.push(root);
  writePackage(root, {
    name: 'host',
    dependencies: { consumer: '1.0.0', renderer: '2.0.0', runtime: '2.0.0' },
  });
  writePackage(join(root, 'node_modules/consumer'), {
    name: 'consumer',
    version: '1.0.0',
    peerDependencies: { renderer: '^1' },
  });
  writePackage(join(root, 'node_modules/renderer'), { name: 'renderer', version: '2.0.0' });
  writePackage(join(root, 'node_modules/runtime'), { name: 'runtime', version: '2.0.0' });
  const selected = {
    name: 'renderer',
    version: '1.0.0',
    dependencies: { runtime: '^1' },
    peerDependencies: { runtime: peerRange },
  };
  vi.spyOn(npmRegistryClient, 'fetchAllVersions').mockResolvedValue(['1.0.0', '2.0.0']);
  vi.spyOn(npmRegistryClient, 'fetchPackageManifest').mockResolvedValue(selected);
  const install = vi.fn(async (specs: string[]) => {
    for (const spec of specs) {
      const alias = spec.slice(0, spec.indexOf('@npm:'));
      const directory = join(root, 'node_modules', alias);
      writePackage(directory, selected);
      if (withNestedProvider) {
        writePackage(join(directory, 'node_modules/runtime'), {
          name: 'runtime',
          version: '1.0.0',
        });
      }
    }
    return { success: true, exitCode: 0, stdout: '', stderr: '', timedOut: false };
  });
  vi.spyOn(packageManager, 'createPackageManagerAdapter').mockReturnValue({ install });
  return { root, install };
}

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  vi.restoreAllMocks();
  clearPackageJsonCache();
  resetGlobalLogLevel();
});

describe('strict peer validation across installation', () => {
  it.each([false, true])(
    'does not publish a reused alias reconciled to a different version: strict=%s',
    async (strict) => {
      const { root, install } = fixture(true);
      writePackage(root, {
        name: 'host',
        dependencies: {
          consumer: '1.0.0',
          renderer: '2.0.0',
          runtime: '2.0.0',
          vue: '3.0.0',
          vue2: 'npm:vue@2.7.16',
        },
      });
      writePackage(join(root, 'node_modules/consumer'), {
        name: 'consumer',
        version: '1.0.0',
        peerDependencies: { renderer: '^1', vue: '2.6.14' },
      });
      writePackage(join(root, 'node_modules/vue'), { name: 'vue', version: '3.0.0' });
      writePackage(join(root, 'node_modules/vue2'), { name: 'vue', version: '2.6.14' });
      const performInstall = install.getMockImplementation()!;
      install.mockImplementation(async (specs) => {
        const result = await performInstall(specs);
        writePackage(join(root, 'node_modules/vue2'), { name: 'vue', version: '2.7.16' });
        return result;
      });
      const onInstallComplete = vi.fn();
      const initializing = createResolver(
        {
          projectRoot: root,
          dependencies: ['consumer'],
          packageManager: 'npm',
          autoInstall: true,
          strict,
        },
        { onInstallComplete },
      );
      if (strict) {
        await expect(initializing).rejects.toMatchObject({
          diagnostics: expect.arrayContaining([
            expect.objectContaining({ code: 'ALIAS_INSTALL_FAILED', aliases: ['vue2'] }),
          ]),
        });
      } else {
        const resolver = await initializing;
        expect(resolver.getInstallResult()).toMatchObject({
          success: false,
          reused: [],
          failed: ['vue2'],
        });
        expect(resolver.getAliasPathMappings().map((mapping) => mapping.aliasName)).toEqual([
          'aliased-renderer1',
        ]);
        expect(
          resolver.resolveModule('vue', join(root, 'node_modules/consumer/index.js')),
        ).toBeNull();
      }
      expect(
        onInstallComplete.mock.calls[0]![0].map(
          (mapping: { aliasName: string }) => mapping.aliasName,
        ),
      ).toEqual(['aliased-renderer1']);
    },
  );

  it('checks shared contexts after installation has supplied a new alias', async () => {
    const { root, install } = fixture(true);
    writePackage(root, {
      name: 'host',
      dependencies: { consumer: '1.0.0', modern: '1.0.0', renderer: '2.0.0', runtime: '2.0.0' },
    });
    writePackage(join(root, 'node_modules/consumer'), {
      name: 'consumer',
      version: '1.0.0',
      peerDependencies: { renderer: '^1' },
      dependencies: { shared: '1.0.0' },
    });
    writePackage(join(root, 'node_modules/modern'), {
      name: 'modern',
      version: '1.0.0',
      peerDependencies: { renderer: '^2' },
      dependencies: { shared: '1.0.0' },
    });
    writePackage(join(root, 'node_modules/shared'), {
      name: 'shared',
      version: '1.0.0',
      peerDependencies: { renderer: '>=1' },
    });
    const resolver = await createResolver({
      projectRoot: root,
      dependencies: ['consumer', 'modern'],
      packageManager: 'npm',
      autoInstall: true,
      strict: true,
    });
    expect(install).toHaveBeenCalledTimes(1);
    expect(resolver.getDiagnostics()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'SHARED_PEER_CONTEXT', severity: 'warning' }),
      ]),
    );
  });

  it('does not allow invalidation while a manual installation is pending', async () => {
    const { root, install } = fixture(true);
    const resolver = await createResolver({
      projectRoot: root,
      dependencies: ['consumer'],
      packageManager: 'npm',
      autoInstall: false,
    });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const performInstall = install.getMockImplementation()!;
    install.mockImplementation(async (specs) => {
      await pending;
      return performInstall(specs);
    });
    const installing = resolver.installDependencies();
    try {
      expect(() => resolver.invalidate()).toThrow(
        'Cannot invalidate while installation is in progress',
      );
    } finally {
      release();
      await installing.catch(() => undefined);
    }
    expect(resolver.getAliasPathMappings()).toHaveLength(1);
    resolver.invalidate();
    await resolver.initialize();
    await resolver.installDependencies();
    expect(resolver.getAliasPathMappings()).toHaveLength(1);
  });

  it('shares a pending manual installation between concurrent callers', async () => {
    const { root, install } = fixture(true);
    const resolver = await createResolver({
      projectRoot: root,
      dependencies: ['consumer'],
      packageManager: 'npm',
      autoInstall: false,
    });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const performInstall = install.getMockImplementation()!;
    install.mockImplementation(async (specs) => {
      await pending;
      return performInstall(specs);
    });
    const first = resolver.installDependencies();
    const second = resolver.installDependencies();
    release();
    await Promise.all([first, second]);
    expect(install).toHaveBeenCalledTimes(1);
    expect(resolver.getInstallResult()?.success).toBe(true);
  });

  it('allows installation to supply the selected alias own compatible nested peer', async () => {
    const { root, install } = fixture(true);
    const resolver = await createResolver({
      projectRoot: root,
      dependencies: ['consumer'],
      packageManager: 'npm',
      autoInstall: true,
      strict: true,
    });
    expect(install).toHaveBeenCalledTimes(1);
    expect(resolver.getDiagnostics()).toEqual([]);
    expect(resolver.getAliasPathMappings()).toHaveLength(1);
  });

  it('still rejects an unsatisfied peer after the installer reports success', async () => {
    const { root, install } = fixture(false);
    await expect(
      createResolver({
        projectRoot: root,
        dependencies: ['consumer'],
        packageManager: 'npm',
        autoInstall: true,
        strict: true,
      }),
    ).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'ALIAS_PEER_UNSATISFIED', severity: 'error' }),
      ]),
    });
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('keeps genuine analysis errors fatal before installation', async () => {
    const { root, install } = fixture(true);
    await expect(
      createResolver({
        projectRoot: root,
        dependencies: ['missing'],
        packageManager: 'npm',
        autoInstall: true,
        strict: true,
      }),
    ).rejects.toBeInstanceOf(ResolutionError);
    expect(install).not.toHaveBeenCalled();
  });

  it('rechecks provisional ambiguity against the alias installed nested provider', async () => {
    const { root, install } = fixture(true, '>=1 <4');
    writePackage(root, {
      name: 'host',
      dependencies: {
        consumer: '1.0.0',
        b: '1.0.0',
        c: '1.0.0',
        renderer: '2.0.0',
        runtime: '4.0.0',
        runtime2: 'npm:runtime@2.0.0',
        runtime3: 'npm:runtime@3.0.0',
      },
    });
    writePackage(join(root, 'node_modules/runtime'), { name: 'runtime', version: '4.0.0' });
    for (const [name, version] of [
      ['b', '2.0.0'],
      ['c', '3.0.0'],
    ]) {
      writePackage(join(root, 'node_modules', name!), {
        name,
        version: '1.0.0',
        peerDependencies: { runtime: version! },
      });
      writePackage(join(root, 'node_modules/runtime' + version![0]), { name: 'runtime', version });
    }
    const resolver = await createResolver({
      projectRoot: root,
      dependencies: ['consumer', 'b', 'c'],
      packageManager: 'npm',
      autoInstall: true,
      strict: true,
    });
    expect(install).toHaveBeenCalledTimes(1);
    expect(resolver.getDiagnostics()).toEqual([]);
    expect(
      resolver.resolveModule('runtime', join(root, 'node_modules/aliased-renderer1/index.js')),
    ).toBeNull();
  });

  it('keeps an installed alias unsatisfied peer fatal before installation', async () => {
    const { root, install } = fixture(false);
    writePackage(root, {
      name: 'host',
      dependencies: {
        consumer: '1.0.0',
        renderer: '2.0.0',
        runtime: '2.0.0',
        renderer1: 'npm:renderer@1.0.0',
      },
    });
    writePackage(join(root, 'node_modules/renderer1'), {
      name: 'renderer',
      version: '1.0.0',
      peerDependencies: { runtime: '^1' },
    });
    await expect(
      createResolver({
        projectRoot: root,
        dependencies: ['consumer'],
        packageManager: 'npm',
        autoInstall: true,
        strict: true,
      }),
    ).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'ALIAS_PEER_UNSATISFIED', severity: 'error' }),
      ]),
    });
    expect(install).not.toHaveBeenCalled();
  });
});
