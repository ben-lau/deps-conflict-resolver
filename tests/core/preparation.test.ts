import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResolver } from '../../src/core/resolver';
import { npmRegistryClient } from '../../src/core/registry-client';
import * as packageManager from '../../src/core/package-manager-adapter';
import { clearPackageJsonCache } from '../../src/utils/fs';
import { resetGlobalLogLevel } from '../../src/utils/logger';
import type { PackageJson } from '../../src/types';

const roots: string[] = [];
const success = { success: true, exitCode: 0, stdout: '', stderr: '', timedOut: false };

function manifest(directory: string, value: PackageJson): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify(value));
  writeFileSync(join(directory, 'index.js'), 'export {};');
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'deps-prepare-')));
  roots.push(root);
  manifest(root, { name: 'host', dependencies: { a: '1', b: '1', vue: '3' } });
  manifest(join(root, 'node_modules/vue'), { name: 'vue', version: '3.0.0' });
  for (const [name, version] of [
    ['a', '2.6.14'],
    ['b', '2.7.16'],
  ]) {
    manifest(join(root, 'node_modules', name!), {
      name,
      version: '1.0.0',
      peerDependencies: { vue: version! },
    });
  }
  vi.spyOn(npmRegistryClient, 'fetchAllVersions').mockResolvedValue(['2.6.14', '2.7.16']);
  vi.spyOn(npmRegistryClient, 'fetchPackageManifest').mockImplementation(async (name, version) => ({
    name,
    version,
  }));
  const install = vi.fn(async (specs: string[]) => {
    for (const spec of specs) {
      const [alias, target] = spec.split('@npm:');
      const separator = target!.lastIndexOf('@');
      const name = target!.slice(0, separator);
      const version = target!.slice(separator + 1);
      manifest(join(root, 'node_modules', alias!), { name, version });
      const file = join(root, 'package.json');
      const host = JSON.parse(readFileSync(file, 'utf8')) as PackageJson;
      host.dependencies = { ...host.dependencies, [alias!]: 'npm:' + name + '@' + version };
      writeFileSync(file, JSON.stringify(host));
    }
    return success;
  });
  vi.spyOn(packageManager, 'createPackageManagerAdapter').mockReturnValue({ install });
  const options = {
    projectRoot: root,
    dependencies: ['a'],
    packageManager: 'npm' as const,
    registry: 'https://unused.invalid',
    autoInstall: true,
    strict: true,
  };
  return { root, install, options };
}

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  vi.restoreAllMocks();
  clearPackageJsonCache();
  resetGlobalLogLevel();
});

describe('project preparation and published rules', () => {
  it.each([false, true])(
    'preserves both concurrent resolver targets: sameVersion=%s',
    async (sameVersion) => {
      const { root, install, options } = fixture();
      if (sameVersion)
        manifest(join(root, 'node_modules/b'), {
          name: 'b',
          version: '1.0.0',
          peerDependencies: { vue: '2.6.14' },
        });
      const perform = install.getMockImplementation()!;
      let release!: () => void;
      let started!: () => void;
      const firstStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let firstWrite: Promise<typeof success>;
      install.mockImplementation((specs) => {
        if (!firstWrite) {
          started();
          firstWrite = gate.then(() => perform(specs));
          return firstWrite;
        }
        return firstWrite.then(() => perform(specs));
      });
      const first = createResolver(options);
      await firstStarted;
      const second = createResolver({ ...options, dependencies: ['b'] });
      await new Promise<void>((resolve) => setImmediate(resolve));
      release();
      const [a, b] = await Promise.all([first, second]);
      const aAlias = a.resolveModule('vue', join(root, 'node_modules/a/index.js'))!;
      const bAlias = b.resolveModule('vue', join(root, 'node_modules/b/index.js'))!;
      const version = (name: string) =>
        JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version;
      expect(version(aAlias)).toBe('2.6.14');
      expect(version(bAlias)).toBe(sameVersion ? '2.6.14' : '2.7.16');
      expect(install).toHaveBeenCalledTimes(sameVersion ? 1 : 2);
      expect(a.getDiagnostics()).toEqual([]);
      expect(b.getDiagnostics()).toEqual([]);
    },
  );

  it.each([false, true])(
    'replans scopes after installation: changedPeer=%s',
    async (changedPeer) => {
      const { root, install, options } = fixture();
      const old = join(root, 'node_modules/a');
      const current = join(root, 'packages/current');
      renameSync(old, join(root, 'old-consumer'));
      symlinkSync(join(root, 'old-consumer'), old, 'junction');
      const perform = install.getMockImplementation()!;
      install.mockImplementation(async (specs) => {
        const result = await perform(specs);
        manifest(current, {
          name: 'a',
          version: '1.0.0',
          peerDependencies: { vue: changedPeer ? '2.7.16' : '2.6.14' },
        });
        if (install.mock.calls.length === 1) {
          unlinkSync(old);
          symlinkSync(current, old, 'junction');
        }
        return result;
      });
      const resolver = await createResolver(options);
      const alias = resolver.resolveModule('vue', join(current, 'index.js'));
      expect(alias).not.toBeNull();
      expect(
        JSON.parse(readFileSync(join(root, 'node_modules', alias!, 'package.json'), 'utf8'))
          .version,
      ).toBe(changedPeer ? '2.7.16' : '2.6.14');
      expect(resolver.resolveModule('vue', join(root, 'old-consumer/index.js'))).toBeNull();
      expect(install).toHaveBeenCalledTimes(changedPeer ? 2 : 1);
      expect(resolver.getDiagnostics()).toEqual([]);
    },
  );

  it('refreshes an explicit install plan after its consumer changes', async () => {
    const { root, options, install } = fixture();
    const resolver = await createResolver({ ...options, autoInstall: false, strict: false });
    manifest(join(root, 'node_modules/a'), {
      name: 'a',
      version: '1.0.0',
      peerDependencies: { vue: '2.7.16' },
    });
    await resolver.installDependencies();
    const alias = resolver.resolveModule('vue', join(root, 'node_modules/a/index.js'))!;
    expect(
      JSON.parse(readFileSync(join(root, 'node_modules', alias, 'package.json'), 'utf8')).version,
    ).toBe('2.7.16');
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('publishes an explicit strict installation before notifying its hook', async () => {
    const { root, options } = fixture();
    manifest(root, { name: 'host', dependencies: { a: '1', vue: '3', vue2: 'npm:vue@2.6.14' } });
    manifest(join(root, 'node_modules/vue2'), { name: 'vue', version: '2.6.14' });
    let resolver: Awaited<ReturnType<typeof createResolver>>;
    const onInstallComplete = vi.fn(() => {
      expect(resolver.getAliasPathMappings()).toHaveLength(1);
      expect(resolver.getDiagnostics()).toEqual([]);
    });
    resolver = await createResolver({ ...options, autoInstall: false }, { onInstallComplete });
    manifest(join(root, 'node_modules/a'), {
      name: 'a',
      version: '1.0.0',
      peerDependencies: { vue: '2.7.16' },
    });
    await resolver.installDependencies();
    expect(onInstallComplete).toHaveBeenCalledTimes(1);
    expect(resolver.getAnalysisResult()?.aliasMappings[0]?.resolvedVersion).toBe('2.7.16');
  });

  it('does not deadlock an analysis hook that initializes another resolver', async () => {
    const { options } = fixture();
    const onAnalysisComplete = vi.fn(async () => {
      await createResolver({ ...options, dependencies: [], offline: true });
    });
    await createResolver(options, { onAnalysisComplete });
    expect(onAnalysisComplete).toHaveBeenCalledTimes(1);
  });

  it('bounds corrective installations when peer inputs keep changing', async () => {
    const { root, options, install } = fixture();
    vi.spyOn(npmRegistryClient, 'fetchAllVersions').mockResolvedValue([
      '2.6.14',
      '2.7.16',
      '4.0.0',
    ]);
    const perform = install.getMockImplementation()!;
    install.mockImplementation(async (specs) => {
      const result = await perform(specs);
      manifest(join(root, 'node_modules/a'), {
        name: 'a',
        version: '1.0.0',
        peerDependencies: { vue: install.mock.calls.length === 1 ? '2.7.16' : '4.0.0' },
      });
      return result;
    });
    await expect(createResolver(options)).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'PROJECT_STATE_CHANGED' }),
      ]),
    });
    expect(install).toHaveBeenCalledTimes(2);
  });

  it('invalidates an existing strict snapshot when another install changes its provider', async () => {
    const { root, options, install } = fixture();
    manifest(root, {
      name: 'host',
      dependencies: { a: '1', b: '1', vue: '3', vue2: 'npm:vue@2.6.14', renderer: '2' },
    });
    manifest(join(root, 'node_modules/vue2'), { name: 'vue', version: '2.6.14' });
    manifest(join(root, 'node_modules/b'), {
      name: 'b',
      version: '1.0.0',
      peerDependencies: { renderer: '^1' },
    });
    manifest(join(root, 'node_modules/renderer'), { name: 'renderer', version: '2.0.0' });
    const a = await createResolver({ ...options, offline: true });
    vi.spyOn(npmRegistryClient, 'fetchAllVersions').mockResolvedValue(['1.0.0']);
    const perform = install.getMockImplementation()!;
    install.mockImplementation(async (specs) => {
      const result = await perform(specs);
      manifest(join(root, 'node_modules/vue2'), { name: 'vue', version: '2.7.16' });
      return result;
    });
    await createResolver({ ...options, dependencies: ['b'] });
    expect(() => a.resolveModule('vue', join(root, 'node_modules/a/index.js'))).toThrow();
    expect(a.getDiagnostics()).toEqual(
      expect.arrayContaining([expect.objectContaining({ severity: 'error' })]),
    );
  });

  it.each(['generation', 'install'] as const)(
    'revalidates moved providers after recovery through %s',
    async (recovery) => {
      const { root, options, install } = fixture();
      manifest(root, {
        name: 'host',
        dependencies: { a: '1', b: '1', vue: '3', vue2: 'npm:vue@2.6.14', renderer: '2' },
      });
      const alias = join(root, 'node_modules/vue2');
      manifest(alias, { name: 'vue', version: '2.6.14' });
      manifest(join(root, 'node_modules/b'), {
        name: 'b',
        version: '1.0.0',
        peerDependencies: { renderer: '^1' },
      });
      manifest(join(root, 'node_modules/renderer'), { name: 'renderer', version: '2.0.0' });
      const a = await createResolver({ ...options, offline: true });
      vi.spyOn(npmRegistryClient, 'fetchAllVersions').mockResolvedValue(['1.0.0', '3.0.0']);
      const perform = install.getMockImplementation()!;
      install.mockImplementation(async (specs) => {
        const result = await perform(specs);
        const current = join(root, 'current-provider-' + install.mock.calls.length);
        manifest(current, { name: 'vue', version: '2.6.14' });
        if (install.mock.calls.length === 1) renameSync(alias, join(root, 'previous-provider'));
        else unlinkSync(alias);
        symlinkSync(current, alias, 'junction');
        return result;
      });
      await createResolver({ ...options, dependencies: ['b'] });
      await expect(a.initialize()).rejects.toMatchObject({
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: 'PROJECT_STATE_CHANGED' }),
        ]),
      });
      if (recovery === 'generation') {
        a.invalidate();
        await a.initialize();
      } else await a.installDependencies();
      expect(a.resolveModule('vue', join(root, 'node_modules/a/index.js'))).toBe('vue2');
      expect(a.getDiagnostics()).toEqual([]);
      manifest(join(root, 'node_modules/b'), {
        name: 'b',
        version: '1.0.0',
        peerDependencies: { renderer: '^3' },
      });
      await createResolver({ ...options, dependencies: ['b'] });
      expect(() => a.resolveModule('vue', join(root, 'node_modules/a/index.js'))).toThrow();
    },
  );
});
