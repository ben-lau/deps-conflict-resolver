import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  realpathSync,
  renameSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResolutionError } from '../../src/core/resolution-error';
import { createResolver } from '../../src/core/resolver';
import type { PackageJson } from '../../src/types';
import { clearPackageJsonCache } from '../../src/utils/fs';
import { resetGlobalLogLevel } from '../../src/utils/logger';

const roots: string[] = [];

function project(manifest: PackageJson, prefix = 'deps-resolution-'): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'host', version: '1.0.0', ...manifest }),
  );
  return root;
}

function pkg(root: string, name: string, manifest: PackageJson): string {
  const directory = join(root, 'node_modules', name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', ...manifest }),
  );
  writeFileSync(join(directory, 'index.js'), 'export {};');
  return directory;
}

function baseOptions(root: string, dependencies = ['legacy']) {
  return {
    projectRoot: root,
    dependencies,
    autoInstall: false,
    packageManager: 'npm' as const,
    registry: 'https://registry.example.test',
  };
}

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  clearPackageJsonCache();
  resetGlobalLogLevel();
  vi.restoreAllMocks();
});

describe('diagnostics and deterministic offline operation', () => {
  function vueProject(withAlias = true) {
    const root = project({
      dependencies: {
        legacy: '1.0.0',
        vue: '3.5.0',
        ...(withAlias ? { vue2: 'npm:vue@2.7.16' } : {}),
      },
    });
    const legacy = pkg(root, 'legacy', { peerDependencies: { vue: '^2.0.0' } });
    pkg(root, 'vue', { version: '3.5.0' });
    if (withAlias) pkg(root, 'vue2', { name: 'vue', version: '2.7.16' });
    return { root, legacy };
  }

  it('runs offline without network, installation, or manifest/lockfile changes', async () => {
    const { root, legacy } = vueProject();
    const fetch = vi.spyOn(globalThis, 'fetch');
    writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}');
    const before = ['package.json', 'package-lock.json'].map((file) =>
      readFileSync(join(root, file), 'utf8'),
    );
    const resolver = await createResolver({
      ...baseOptions(root),
      autoInstall: true,
      offline: true,
      strict: true,
    });

    expect(resolver.resolveModule('vue', join(legacy, 'index.js'))).toBe('vue2');
    expect(fetch).not.toHaveBeenCalled();
    expect(resolver.getOptions().autoInstall).toBe(false);
    expect(resolver.getInstallResult()).toBeNull();
    expect(
      ['package.json', 'package-lock.json'].map((file) => readFileSync(join(root, file), 'utf8')),
    ).toEqual(before);
  });

  it('reports unresolved offline aliases and rejects them in strict mode', async () => {
    const { root } = vueProject(false);
    const fetch = vi.spyOn(globalThis, 'fetch');
    const resolver = await createResolver({ ...baseOptions(root), offline: true });
    expect(resolver.getDiagnostics()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'OFFLINE_ALIAS_MISSING', severity: 'error' }),
      ]),
    );
    await expect(
      createResolver({ ...baseOptions(root), offline: true, strict: true }),
    ).rejects.toBeInstanceOf(ResolutionError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves registry errors as diagnostics rather than reporting no conflicts', async () => {
    const { root } = vueProject(false);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 401, statusText: 'Unauthorized' }),
    );
    const resolver = await createResolver(baseOptions(root));
    expect(resolver.getDiagnostics()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'REGISTRY_ERROR',
          message: expect.stringContaining('401'),
        }),
      ]),
    );
    await expect(createResolver({ ...baseOptions(root), strict: true })).rejects.toThrow('401');
  });

  it('explains a redirection without exposing mutable cached decisions', async () => {
    const { root, legacy } = vueProject();
    const resolver = await createResolver(baseOptions(root));
    const importer = join(legacy, 'index.js');
    const explanation = resolver.explainResolution('vue?raw', importer);
    expect(explanation).toMatchObject({
      reason: 'redirected',
      resolved: 'vue2?raw',
      aliases: ['vue2'],
    });
    explanation.aliases.push('wrong');
    explanation.matchedPaths.length = 0;
    expect(resolver.explainResolution('vue?raw', importer).aliases).toEqual(['vue2']);
    expect(resolver.resolveModule('vue', importer)).toBe('vue2');
  });

  it('distinguishes a declared but uninstalled peer even if a nested copy exists', async () => {
    const root = project({ dependencies: { legacy: '1.0.0', vue: '3.5.0' } });
    const legacy = pkg(root, 'legacy', { peerDependencies: { vue: '^2.0.0' } });
    pkg(legacy, 'vue', { version: '2.7.16' });
    const resolver = await createResolver({ ...baseOptions(root), offline: true });
    expect(resolver.getDiagnostics()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'PEER_NOT_INSTALLED', packageName: 'vue' }),
      ]),
    );
    expect(resolver.getAnalysisResult()?.peerConflicts[0]?.mainProjectVersion).toBeNull();
  });

  it('reports ambiguous shared importers and rejects their resolution in strict mode', async () => {
    const root = project({
      dependencies: {
        a: '1.0.0',
        b: '1.0.0',
        vue: '3.5.0',
        vue26: 'npm:vue@2.6.14',
        vue27: 'npm:vue@2.7.16',
      },
    });
    pkg(root, 'a', { peerDependencies: { vue: '2.6.14' }, dependencies: { shared: '1.0.0' } });
    pkg(root, 'b', { peerDependencies: { vue: '2.7.16' }, dependencies: { shared: '1.0.0' } });
    const shared = pkg(root, 'shared', { peerDependencies: { vue: '>=2' } });
    pkg(root, 'vue', { version: '3.5.0' });
    pkg(root, 'vue26', { name: 'vue', version: '2.6.14' });
    pkg(root, 'vue27', { name: 'vue', version: '2.7.16' });
    const resolver = await createResolver({
      ...baseOptions(root, ['a', 'b']),
      offline: true,
      strict: true,
    });
    const importer = join(shared, 'index.js');
    expect(() => resolver.resolveModule('vue', importer)).toThrow(ResolutionError);
    expect(resolver.explainResolution('vue', importer)).toMatchObject({
      reason: 'ambiguous',
      resolved: null,
      aliases: ['vue26', 'vue27'],
    });
    expect(
      resolver.getDiagnostics().filter((diagnostic) => diagnostic.code === 'AMBIGUOUS_IMPORTER'),
    ).toHaveLength(1);
  });

  it('keeps missing-peer warnings visible when debug logging is enabled', async () => {
    const root = project({ dependencies: { legacy: '1.0.0' } });
    pkg(root, 'legacy', { peerDependencies: { absent: '^1.0.0' } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await createResolver({ ...baseOptions(root), offline: true, debug: true });
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('absent@^1.0.0'));
  });
});

describe('resolution correctness with installed packages', () => {
  it('uses the selected alias manifest for peer closure instead of the host manifest', async () => {
    const root = project({
      dependencies: {
        legacy: '1.0.0',
        renderer: '2.0.0',
        runtime: '2.0.0',
        renderer1: 'npm:renderer@1.0.0',
        runtime1: 'npm:runtime@1.0.0',
      },
    });
    pkg(root, 'legacy', { peerDependencies: { renderer: '^1.0.0', runtime: '^1.0.0' } });
    pkg(root, 'renderer', { version: '2.0.0' });
    pkg(root, 'runtime', { version: '2.0.0' });
    const renderer = pkg(root, 'renderer1', {
      name: 'renderer',
      version: '1.0.0',
      peerDependencies: { runtime: '^1.0.0' },
    });
    pkg(root, 'runtime1', { name: 'runtime', version: '1.0.0' });

    const resolver = await createResolver(baseOptions(root));
    expect(resolver.resolveModule('runtime', join(renderer, 'index.js'))).toBe('runtime1');
    expect(resolver.resolveModule('runtime', join(root, 'src/index.js'))).toBeNull();
  });

  it('links a selected alias only to a peer version satisfying its own range', async () => {
    const root = project({
      dependencies: {
        legacy: '1.0.0',
        modern: '1.0.0',
        renderer: '2.0.0',
        vue: '4.0.0',
        renderer1: 'npm:renderer@1.0.0',
        vue2: 'npm:vue@2.7.16',
        vue3: 'npm:vue@3.5.0',
      },
    });
    pkg(root, 'legacy', { peerDependencies: { renderer: '^1.0.0', vue: '^2.0.0' } });
    pkg(root, 'modern', { peerDependencies: { vue: '^3.0.0' } });
    pkg(root, 'renderer', { version: '2.0.0', peerDependencies: { vue: '*' } });
    pkg(root, 'vue', { version: '4.0.0' });
    const renderer = pkg(root, 'renderer1', {
      name: 'renderer',
      version: '1.0.0',
      peerDependencies: { vue: '^3.0.0' },
    });
    pkg(root, 'vue2', { name: 'vue', version: '2.7.16' });
    pkg(root, 'vue3', { name: 'vue', version: '3.5.0' });

    const resolver = await createResolver(baseOptions(root, ['legacy', 'modern']));
    expect(resolver.resolveModule('vue', join(renderer, 'index.js'))).toBe('vue3');
  });

  it.each(['host', 'nested'])(
    'keeps a compatible %s provider ahead of another consumer alias',
    async (provider) => {
      const root = project({
        dependencies: {
          a: '1.0.0',
          b: '1.0.0',
          renderer: '2.0.0',
          runtime: '3.0.0',
          renderer1: 'npm:renderer@1.0.0',
          runtime2: 'npm:runtime@2.0.0',
        },
      });
      const a = pkg(root, 'a', { peerDependencies: { renderer: '^1', runtime: '^3' } });
      pkg(root, 'b', { peerDependencies: { runtime: '^2' } });
      pkg(root, 'renderer', { version: '2.0.0' });
      pkg(root, 'runtime', { version: '3.0.0' });
      const renderer = pkg(root, 'renderer1', {
        name: 'renderer',
        version: '1.0.0',
        peerDependencies: { runtime: '>=2' },
      });
      pkg(root, 'runtime2', { name: 'runtime', version: '2.0.0' });
      if (provider === 'nested') pkg(renderer, 'runtime', { version: '2.5.0' });

      const resolver = await createResolver({
        ...baseOptions(root, ['a', 'b']),
        offline: true,
        strict: true,
      });
      expect(resolver.resolveModule('runtime', join(a, 'index.js'))).toBeNull();
      expect(resolver.resolveModule('runtime', join(renderer, 'index.js'))).toBeNull();
      expect(resolver.getDiagnostics()).toEqual([]);
    },
  );

  it('keeps the consumer peer alias ahead of a compatible host provider', async () => {
    const root = project({
      dependencies: {
        a: '1.0.0',
        renderer: '2.0.0',
        runtime: '3.0.0',
        renderer1: 'npm:renderer@1.0.0',
        runtime2: 'npm:runtime@2.0.0',
      },
    });
    pkg(root, 'a', { peerDependencies: { renderer: '^1', runtime: '^2' } });
    pkg(root, 'renderer', { version: '2.0.0' });
    pkg(root, 'runtime', { version: '3.0.0' });
    const renderer = pkg(root, 'renderer1', {
      name: 'renderer',
      version: '1.0.0',
      peerDependencies: { runtime: '>=2' },
    });
    pkg(root, 'runtime2', { name: 'runtime', version: '2.0.0' });

    const resolver = await createResolver({
      ...baseOptions(root, ['a']),
      offline: true,
      strict: true,
    });
    expect(resolver.resolveModule('runtime', join(renderer, 'index.js'))).toBe('runtime2');
  });

  it.each(
    ['plain', 'workspace-hidden', 'workspace-exported'].flatMap((layout) =>
      ['host', 'same-alias', 'unspecified', 'override'].map((context) => ({ layout, context })),
    ),
  )('checks every consumer of a shared alias: $context, $layout', async ({ context, layout }) => {
    const root = project({
      workspaces: layout === 'plain' ? undefined : ['packages/*'],
      dependencies: {
        a: '1.0.0',
        b: '1.0.0',
        renderer: '2.0.0',
        runtime: '3.0.0',
        renderer1: 'npm:renderer@1.0.0',
        runtime2: 'npm:runtime@2.0.0',
      },
    });
    pkg(root, 'a', { peerDependencies: { renderer: '^1', runtime: '^2' } });
    pkg(root, 'b', {
      peerDependencies: {
        renderer: '^1',
        ...(context === 'unspecified'
          ? {}
          : { runtime: context === 'host' || context === 'override' ? '^3' : '^2' }),
      },
    });
    for (const name of ['a', 'b']) {
      const directory = join(root, 'node_modules', name);
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
      manifest.exports =
        layout === 'workspace-exported'
          ? { '.': './index.js', './package.json': './package.json' }
          : './index.js';
      writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest));
      if (layout === 'plain') continue;
      const workspace = join(root, 'packages', name);
      mkdirSync(join(root, 'packages'), { recursive: true });
      renameSync(directory, workspace);
      symlinkSync(workspace, directory, process.platform === 'win32' ? 'junction' : 'dir');
    }
    pkg(root, 'renderer', { version: '2.0.0' });
    pkg(root, 'runtime', { version: '3.0.0' });
    const renderer = pkg(root, 'renderer1', {
      name: 'renderer',
      version: '1.0.0',
      peerDependencies: { runtime: '>=2' },
    });
    pkg(root, 'runtime2', { name: 'runtime', version: '2.0.0' });
    const options = {
      ...baseOptions(root, ['a', 'b']),
      offline: true,
      excludeRedirects: { runtime: context === 'override' ? ['a'] : [] },
    };
    const resolver = await createResolver(options);
    if (context === 'host') {
      expect(resolver.getDiagnostics()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'AMBIGUOUS_IMPORTER',
            severity: 'error',
            requestedBy: ['renderer1'],
          }),
        ]),
      );
      expect(resolver.resolveModule('runtime', join(renderer, 'index.js'))).toBeNull();
      await expect(createResolver({ ...options, strict: true })).rejects.toBeInstanceOf(
        ResolutionError,
      );
    } else {
      expect(resolver.getDiagnostics()).toEqual([]);
      expect(resolver.resolveModule('runtime', join(renderer, 'index.js'))).toBe(
        context === 'override' ? null : 'runtime2',
      );
    }
  });

  it.each(['valid', 'compatible-version', 'missing', 'wrong-name', 'out-of-range'])(
    'reuses workspace optional aliases offline only when verified: %s',
    async (installed) => {
      const root = project({
        workspaces: ['packages/*'],
        dependencies: { vue: '3.5.0' },
        optionalDependencies: { vue2: 'npm:vue@2.7.16' },
      });
      const app = join(root, 'packages/app');
      mkdirSync(app, { recursive: true });
      writeFileSync(
        join(app, 'package.json'),
        JSON.stringify({ name: 'app', dependencies: { legacy: '1.0.0' } }),
      );
      const legacy = pkg(app, 'legacy', { peerDependencies: { vue: '^2' } });
      pkg(root, 'vue', { version: '3.5.0' });
      if (installed !== 'missing')
        pkg(root, 'vue2', {
          name: installed === 'wrong-name' ? 'other' : 'vue',
          version:
            installed === 'out-of-range'
              ? '3.5.0'
              : installed === 'compatible-version'
                ? '2.6.14'
                : '2.7.16',
        });
      const fetch = vi.spyOn(globalThis, 'fetch');
      const resolver = await createResolver({ ...baseOptions(app), offline: true });
      if (installed === 'valid' || installed === 'compatible-version') {
        expect(resolver.getDiagnostics()).toEqual([]);
        expect(resolver.resolveModule('vue', join(legacy, 'index.js'))).toBe('vue2');
        await expect(
          createResolver({ ...baseOptions(app), offline: true, strict: true }),
        ).resolves.toBeDefined();
      } else {
        expect(resolver.getDiagnostics()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: 'OFFLINE_ALIAS_MISSING', severity: 'error' }),
          ]),
        );
      }
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('keeps host and dependency scopes separate when the project root contains a hash', async () => {
    const root = project(
      { dependencies: { legacy: '1.0.0', vue: '3.5.0', vue2: 'npm:vue@2.7.16' } },
      'deps-resolution-#',
    );
    const legacy = pkg(root, 'legacy', { peerDependencies: { vue: '^2' } });
    pkg(root, 'vue', { version: '3.5.0' });
    pkg(root, 'vue2', { name: 'vue', version: '2.7.16' });
    const resolver = await createResolver({ ...baseOptions(root), offline: true, strict: true });
    expect(resolver.resolveModule('vue', join(root, 'src/app.js'))).toBeNull();
    expect(resolver.resolveModule('vue?raw', join(legacy, 'index.js') + '?vue&type=script')).toBe(
      'vue2?raw',
    );
  });

  it('includes installed optional runtime dependencies and host optional declarations', async () => {
    const root = project({
      dependencies: { legacy: '1.0.0', vue2: 'npm:vue@2.7.16' },
      optionalDependencies: { vue: '3.5.0' },
    });
    pkg(root, 'legacy', {
      peerDependencies: { vue: '^2.0.0' },
      optionalDependencies: { helper: '1.0.0' },
    });
    pkg(root, 'vue', { version: '3.5.0' });
    pkg(root, 'vue2', { name: 'vue', version: '2.7.16' });
    const helper = pkg(root, 'helper', { peerDependencies: { vue: '^2.0.0' } });

    const resolver = await createResolver(baseOptions(root));
    expect(resolver.getAnalysisResult()?.analyzedDependencies.has('helper')).toBe(true);
    expect(resolver.resolveModule('vue', join(helper, 'index.js'))).toBe('vue2');
  });

  it('refreshes peer scopes when installed metadata changes after analysis', async () => {
    const root = project({
      dependencies: {
        legacy: '1.0.0',
        modern: '1.0.0',
        renderer: '2.0.0',
        vue: '4.0.0',
        renderer1: 'npm:renderer@1.0.0',
        vue2: 'npm:vue@2.7.16',
        vue3: 'npm:vue@3.5.0',
      },
    });
    pkg(root, 'legacy', { peerDependencies: { renderer: '^1.0.0', vue: '^2.0.0' } });
    pkg(root, 'modern', { peerDependencies: { vue: '^3.0.0' } });
    pkg(root, 'renderer', { version: '2.0.0' });
    pkg(root, 'vue', { version: '4.0.0' });
    const renderer = pkg(root, 'renderer1', {
      name: 'renderer',
      version: '1.0.0',
      peerDependencies: { vue: '^2.0.0' },
    });
    pkg(root, 'vue2', { name: 'vue', version: '2.7.16' });
    pkg(root, 'vue3', { name: 'vue', version: '3.5.0' });
    const resolver = await createResolver(
      { ...baseOptions(root, ['legacy', 'modern']), autoInstall: true, strict: true },
      {
        onAnalysisComplete: () => {
          writeFileSync(
            join(renderer, 'package.json'),
            JSON.stringify({
              name: 'renderer',
              version: '1.0.0',
              peerDependencies: { vue: '^3.0.0' },
            }),
          );
        },
      },
    );
    expect(resolver.resolveModule('vue', join(renderer, 'index.js'))).toBe('vue3');
    expect(resolver.getDiagnostics()).toEqual([]);
  });
});
