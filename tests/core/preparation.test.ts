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
import { createResolver, getResolverBuild } from '../../src/core/resolver';
import { getProjectPreparation, withProjectPreparation } from '../../src/core/project-preparation';
import { mockRegistry } from '../support/registry';
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
  const fetch = mockRegistry(
    { name: 'vue', version: '2.6.14' },
    { name: 'vue', version: '2.7.16' },
  );
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
  return { root, install, options, fetch };
}

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  vi.restoreAllMocks();
  clearPackageJsonCache();
  resetGlobalLogLevel();
});

describe('project preparation and published rules', () => {
  it('reports a failed explicit refresh and refuses to resolve to a removed alias', async () => {
    const { root, options, install, fetch } = fixture();
    const alias = join(root, 'node_modules/vue2');
    const importer = join(root, 'node_modules/a/index.js');
    manifest(root, { name: 'host', dependencies: { a: '1', vue: '3', vue2: 'npm:vue@2.6.14' } });
    manifest(alias, { name: 'vue', version: '2.6.14' });
    const resolver = await createResolver({ ...options, offline: true });
    expect(resolver.resolveModule('vue', importer)).toBe('vue2');

    rmSync(alias, { recursive: true });
    const missing = expect.objectContaining({ code: 'OFFLINE_ALIAS_MISSING' });
    await expect(resolver.installDependencies()).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([missing]),
      preparation: { diagnostics: expect.arrayContaining([missing]), installation: null },
    });
    expect(resolver.getDiagnostics()).toContainEqual(missing);
    expect(() => resolver.resolveModule('vue', importer)).toThrow('OFFLINE_ALIAS_MISSING');

    manifest(alias, { name: 'vue', version: '2.6.14' });
    await resolver.installDependencies();
    expect(resolver.getDiagnostics()).toEqual([]);
    expect(resolver.resolveModule('vue', importer)).toBe('vue2');
    expect(install).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('omits the previous install from an error raised before installation', async () => {
    const { root, options, install } = fixture();
    const resolver = await createResolver(options);
    const previous = resolver.getInstallResult();
    expect(previous).toMatchObject({ success: true, installed: [expect.any(String)] });

    rmSync(join(root, 'node_modules/a'), { recursive: true });
    await expect(resolver.installDependencies()).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'DEPENDENCY_NOT_FOUND' }),
      ]),
      preparation: { installation: null },
    });
    expect(install).toHaveBeenCalledTimes(1);
    expect(resolver.getInstallResult()).toEqual(previous);
  });

  it('drops resolved installation diagnostics after another resolver repairs the project', async () => {
    const { root, options, install } = fixture();
    const reader = await createResolver({ ...options, autoInstall: false, strict: false });
    expect(reader.getDiagnostics()).toContainEqual(
      expect.objectContaining({ code: 'ALIAS_NOT_INSTALLED' }),
    );
    const importer = join(root, 'node_modules/a/index.js');
    expect(reader.resolveModule('vue', importer)).toBeNull();

    const perform = install.getMockImplementation()!;
    install.mockImplementation(async (specs) => {
      const result = await perform(specs);
      manifest(join(root, 'node_modules/a'), {
        name: 'a',
        version: '1.0.0',
        peerDependencies: { vue: '^3' },
      });
      return result;
    });
    await createResolver({ ...options, dependencies: ['b'] });
    expect(install).toHaveBeenCalledTimes(1);
    expect(reader.getDiagnostics()).toEqual([]);
    expect(reader.resolveModule('vue', importer)).toBeNull();
    expect(reader.getInstallResult()).toBeNull();
  });

  it('invalidates a build guard when an offline refresh changes redirects without a writer', async () => {
    const { root, options, install } = fixture();
    manifest(root, { name: 'host', dependencies: { a: '1', vue: '3', vue2: 'npm:vue@2.6.14' } });
    manifest(join(root, 'node_modules/vue2'), { name: 'vue', version: '2.6.14' });
    const resolver = await createResolver({ ...options, offline: true });
    const verify = getResolverBuild(resolver).guardGeneration();
    const importer = join(root, 'node_modules/a/index.js');
    expect(resolver.resolveModule('vue', importer)).toBe('vue2');

    manifest(join(root, 'node_modules/a'), {
      name: 'a',
      version: '1.0.0',
      peerDependencies: { vue: '^3' },
    });
    await resolver.installDependencies();
    expect(resolver.resolveModule('vue', importer)).toBeNull();
    expect(install).not.toHaveBeenCalled();
    expect(verify).toThrow('Dependencies changed during compilation');
  });

  it.each(process.platform === 'win32' ? [false] : [false, true])(
    'uses hoisted metadata past a leftover directory: symlink=%s',
    async (symlink) => {
      const { root, options } = fixture();
      const app = join(root, 'apps', 'client');
      manifest(root, {
        name: 'workspace',
        workspaces: ['apps/*'],
        dependencies: { a: '1', vue: '3', vue2: 'npm:vue@2.6.14' },
      });
      manifest(app, { name: 'client', dependencies: { a: '1' } });
      manifest(join(root, 'node_modules/vue2'), { name: 'vue', version: '2.6.14' });
      const leftover = join(app, 'node_modules/a');
      mkdirSync(join(leftover, '.cache'), { recursive: true });

      const resolver = await createResolver({ ...options, projectRoot: app, offline: true });
      expect(resolver.resolveModule('vue', join(root, 'node_modules/a/index.js'))).toBe('vue2');

      // A present but invalid manifest still belongs to the nearest package.
      const nearestManifest = join(leftover, 'package.json');
      if (symlink) symlinkSync('package.json', nearestManifest, 'file');
      else writeFileSync(nearestManifest, '{');
      resolver.invalidate();
      await expect(resolver.initialize()).rejects.toMatchObject({
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: 'DEPENDENCY_NOT_FOUND' }),
        ]),
      });
    },
  );

  it('waits for an earlier online preparation before checking aliases offline', async () => {
    const { root, options, install, fetch } = fixture();
    let started!: () => void;
    let release!: () => void;
    const registryStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const registryResponse = new Promise<void>((resolve) => {
      release = resolve;
    });
    const version = '2.6.14';
    fetch.mockImplementation(async () => {
      started();
      await registryResponse;
      return new Response(
        JSON.stringify({ name: 'vue', versions: { [version]: { name: 'vue', version } } }),
      );
    });
    const online = createResolver(options);
    await registryStarted;
    const offline = createResolver({ ...options, offline: true });
    const prepared = Promise.allSettled([online, offline]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    await prepared;
    const [writer, reader] = await Promise.all([online, offline]);
    expect(fetch).toHaveBeenCalledExactlyOnceWith('https://unused.invalid/vue', expect.anything());
    expect(install).toHaveBeenCalledTimes(1);
    const [alias] = writer.getInstallResult()!.installed;
    expect(alias).toBeDefined();
    expect(reader.resolveModule('vue', join(root, 'node_modules/a/index.js'))).toBe(alias);
  });

  it('keeps registry metadata for corrective installation while another project prepares', async () => {
    const { root, options, install, fetch } = fixture();
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'deps-prepare-other-')));
    roots.push(other);
    manifest(other, { name: 'other' });
    const versions = Object.fromEntries(
      ['2.6.14', '2.7.16'].map((version) => [version, { name: 'vue', version }]),
    );
    fetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: 'vue', versions })))
      .mockRejectedValue(new Error('Registry became unavailable'));
    const perform = install.getMockImplementation()!;
    install.mockImplementationOnce(async (specs) => {
      const result = await perform(specs);
      manifest(join(root, 'node_modules/a'), {
        name: 'a',
        version: '1.0.0',
        peerDependencies: { vue: '2.7.16' },
      });
      await createResolver({ ...options, projectRoot: other, dependencies: [], offline: true });
      return result;
    });

    const resolver = await createResolver(options);
    expect(resolver.getAnalysisResult()?.aliasMappings[0]?.resolvedVersion).toBe('2.7.16');
    expect(install).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

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

  it('waits for a writer started by an installation notification before returning', async () => {
    const { root, options, install } = fixture();
    manifest(root, {
      name: 'host',
      dependencies: { a: '1', b: '1', vue: '3', vue2: 'npm:vue@2.6.14' },
    });
    manifest(join(root, 'node_modules/vue2'), { name: 'vue', version: '2.6.14' });
    let started!: () => void;
    let resume!: () => void;
    const startedWriting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const finishWriting = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const perform = install.getMockImplementation()!;
    install.mockImplementation(async (specs) => {
      started();
      await finishWriting;
      return perform(specs);
    });
    let writer: ReturnType<typeof createResolver> | undefined;
    const reader = createResolver(options, {
      async onInstallComplete() {
        writer = createResolver({ ...options, dependencies: ['b'] });
        await startedWriting;
      },
    });

    await startedWriting;
    const completedBeforeWrite = await Promise.race([
      reader.then(() => true),
      new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
    ]);
    resume();
    const [resolver] = await Promise.all([reader, writer]);

    expect(completedBeforeWrite).toBe(false);
    expect(resolver.resolveModule('vue', join(root, 'node_modules/a/index.js'))).toBe('vue2');
  });

  it.each([false, true])(
    'replans a new alias once when the initial graph changes: repeated=%s',
    async (repeated) => {
      const { root, options, install, fetch } = fixture();
      manifest(root, { name: 'host', dependencies: { a: '1', vue: '3', vue2: 'npm:vue@2.6.14' } });
      manifest(join(root, 'node_modules/vue2'), { name: 'vue', version: '2.6.14' });
      const consumer = join(root, 'node_modules/a');
      const onAnalysisComplete = vi.fn();
      const preparation = getProjectPreparation(root);
      const changePeer = (vue: string) =>
        withProjectPreparation(preparation, async (markChanged) => {
          markChanged();
          manifest(consumer, {
            name: 'a',
            version: '1.0.0',
            peerDependencies: { vue },
          });
        });
      const onInstallComplete = vi.fn(() => changePeer('2.7.16'));
      let nextChange: Promise<void> | undefined;
      if (repeated) {
        const perform = install.getMockImplementation()!;
        install.mockImplementationOnce(async (specs) => {
          const result = await perform(specs);
          nextChange = changePeer('4.0.0');
          return result;
        });
      }

      const pending = createResolver(options, { onAnalysisComplete, onInstallComplete });
      if (repeated) {
        await expect(pending).rejects.toMatchObject({
          diagnostics: [expect.objectContaining({ code: 'PROJECT_STATE_CHANGED' })],
        });
        await nextChange;
      } else {
        const resolver = await pending;
        expect(resolver.getDiagnostics()).toEqual([]);
        expect(resolver.getAnalysisResult()?.aliasMappings[0]?.resolvedVersion).toBe('2.7.16');
        expect(resolver.resolveModule('vue', join(consumer, 'index.js'))).toBe(
          resolver.getInstallResult()?.installed[0],
        );
      }
      expect(install).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(onAnalysisComplete).toHaveBeenCalledTimes(1);
      expect(onInstallComplete).toHaveBeenCalledTimes(1);
    },
  );

  it('does not deadlock an analysis hook that initializes another resolver', async () => {
    const { options } = fixture();
    const onAnalysisComplete = vi.fn(async () => {
      await createResolver({ ...options, dependencies: [], offline: true });
    });
    await createResolver(options, { onAnalysisComplete });
    expect(onAnalysisComplete).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'keeps the candidate private and honors hook config changes=%s',
    async (changeConfig) => {
      const { root, options } = fixture();
      manifest(root, {
        name: 'host',
        dependencies: { a: '1', b: '1', vue: '3', vue2: 'npm:vue@2.6.14' },
      });
      manifest(join(root, 'node_modules/vue2'), { name: 'vue', version: '2.6.14' });
      manifest(join(root, 'node_modules/b'), {
        name: 'b',
        version: '1.0.0',
        peerDependencies: { vue: '2.6.14' },
      });
      const resolver = await createResolver(
        { ...options, offline: true },
        {
          onAnalysisComplete(result) {
            result.aliasMappings.length = 0;
            if (changeConfig) options.dependencies.push('b');
          },
        },
      );
      expect(resolver.resolveModule('vue', join(root, 'node_modules/a/index.js'))).toBe('vue2');
      expect(resolver.resolveModule('vue', join(root, 'node_modules/b/index.js'))).toBe(
        changeConfig ? 'vue2' : null,
      );
    },
  );

  it('bounds corrective installations when peer inputs keep changing', async () => {
    const { root, options, install } = fixture();
    mockRegistry(
      { name: 'vue', version: '2.6.14' },
      { name: 'vue', version: '2.7.16' },
      { name: 'vue', version: '4.0.0' },
    );
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
    mockRegistry({ name: 'renderer', version: '1.0.0' });
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
      mockRegistry({ name: 'renderer', version: '1.0.0' }, { name: 'renderer', version: '3.0.0' });
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
