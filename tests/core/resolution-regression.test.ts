import { afterEach, describe, expect, it, vi } from 'vitest';
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
import { resolveConfig } from 'vite';
import { createRequire } from 'node:module';
import { createResolver } from '../../src/core/resolver';
import { ResolutionError } from '../../src/core/resolution-error';
import { npmRegistryClient } from '../../src/core/registry-client';
import { depsConflictResolverVitePlugin } from '../../src/plugins/vite';
import { clearPackageJsonCache } from '../../src/utils/fs';
import { resetGlobalLogLevel } from '../../src/utils/logger';
import type { AnalysisResult, PackageJson } from '../../src/types';

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

function pkg(root: string, name: string, manifest: PackageJson & Record<string, unknown>): string {
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

  it.each([
    { workspace: false, sameResolver: true },
    { workspace: false, sameResolver: false },
    { workspace: true, sameResolver: true },
    { workspace: true, sameResolver: false },
  ])(
    'reads current declarations before a new generation: workspace=$workspace, sameResolver=$sameResolver',
    async ({ workspace, sameResolver }) => {
      const { root } = vueProject();
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      let projectRoot = root;
      if (workspace) {
        manifest.workspaces = ['packages/*'];
        writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
        projectRoot = join(root, 'packages/app');
        mkdirSync(projectRoot, { recursive: true });
        writeFileSync(
          join(projectRoot, 'package.json'),
          JSON.stringify({ name: 'app', dependencies: { legacy: '1.0.0' } }),
        );
      }
      const options = { ...baseOptions(projectRoot), autoInstall: true, strict: true };
      const resolver = await createResolver(options);
      delete manifest.dependencies.vue;
      writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
      if (sameResolver) resolver.invalidate();
      await expect(
        sameResolver ? resolver.initialize() : createResolver(options),
      ).rejects.toMatchObject({
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: 'PEER_NOT_DECLARED', packageName: 'vue' }),
        ]),
      });
      manifest.dependencies.vue = '3.5.0';
      writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
      if (sameResolver) await resolver.initialize();
      const recovered = sameResolver ? resolver : await createResolver(options);
      expect(recovered.getDiagnostics()).toEqual([]);
    },
  );

  it.each([false, true])(
    'rejects the wrong installed package regardless of graph traversal: visited=%s',
    async (graphVisitsAlias) => {
      const { root } = vueProject();
      pkg(root, 'vue2', { name: 'unrelated-package', version: '2.7.16' });
      pkg(root, 'legacy', {
        peerDependencies: { vue: '^2' },
        ...(graphVisitsAlias ? { dependencies: { vue2: 'npm:vue@2.7.16' } } : {}),
      });
      await expect(
        createResolver({ ...baseOptions(root), offline: true, strict: true }),
      ).rejects.toMatchObject({
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: 'OFFLINE_ALIAS_MISSING' }),
        ]),
      });
    },
  );

  it('assigns distinct aliases to scoped and unscoped packages with the same normalized name', async () => {
    const root = project({
      dependencies: { consumer: '1.0.0', '@scope/foo': '2.0.0', 'scope-foo': '2.0.0' },
    });
    pkg(root, 'consumer', { peerDependencies: { '@scope/foo': '^1', 'scope-foo': '^1' } });
    for (const name of ['@scope/foo', 'scope-foo']) pkg(root, name, { version: '2.0.0' });
    vi.spyOn(npmRegistryClient, 'fetchAllVersions').mockResolvedValue(['1.0.0', '2.0.0']);
    vi.spyOn(npmRegistryClient, 'fetchPackageManifest').mockImplementation(
      async (name, version) => ({ name, version }),
    );
    const resolver = await createResolver(baseOptions(root, ['consumer']));
    const mappings = resolver.getAnalysisResult()!.aliasMappings;
    expect(mappings).toHaveLength(2);
    expect(new Set(mappings.map((mapping) => mapping.aliasName)).size).toBe(2);
    expect(mappings.map((mapping) => mapping.originalName)).toEqual(['@scope/foo', 'scope-foo']);
  });

  it('recognizes local and workspace aliases that link to the same physical package', async () => {
    const root = project({
      workspaces: ['packages/*'],
      dependencies: { vue: '3.5.0', vue2: 'npm:vue@2.7.16' },
    });
    const app = join(root, 'packages/app');
    mkdirSync(join(app, 'node_modules'), { recursive: true });
    writeFileSync(
      join(app, 'package.json'),
      JSON.stringify({ name: 'app', dependencies: { legacy: '1.0.0', vue2: 'npm:vue@2.7.16' } }),
    );
    const physical = pkg(root, 'vue-store', {
      name: 'vue',
      version: '2.7.16',
      exports: './index.js',
    });
    pkg(root, 'vue', { version: '3.5.0' });
    const legacy = pkg(app, 'legacy', { peerDependencies: { vue: '^2' } });
    symlinkSync(physical, join(root, 'node_modules/vue2'), 'junction');
    symlinkSync(physical, join(app, 'node_modules/vue2'), 'junction');
    const resolver = await createResolver({ ...baseOptions(app), offline: true, strict: true });
    expect(resolver.getDiagnostics()).toEqual([]);
    expect(resolver.resolveModule('vue', join(legacy, 'index.js'))).toBe('vue2');
  });

  it.each(['wrong-name', 'wrong-version', 'compatible-override', 'none'])(
    'validates workspace alias reuse from its host-visible location: %s',
    async (shadow) => {
      const root = project({
        workspaces: ['packages/*'],
        dependencies: { 'renderer-b': '2.0.0', compat: 'npm:renderer-b@1.0.0' },
      });
      pkg(root, 'renderer-b', { version: '2.0.0' });
      pkg(root, 'compat', { name: 'renderer-b', version: '1.0.0' });
      const app = join(root, 'packages/app');
      mkdirSync(app, { recursive: true });
      writeFileSync(
        join(app, 'package.json'),
        JSON.stringify({
          name: 'app',
          dependencies: {
            consumer: '1.0.0',
            ...(shadow === 'none'
              ? {}
              : { compat: shadow === 'wrong-name' ? 'npm:renderer-a@1.0.0' : 'file:./compat' }),
          },
        }),
      );
      const consumer = pkg(app, 'consumer', { peerDependencies: { 'renderer-b': '^1' } });
      if (shadow !== 'none')
        pkg(app, 'compat', {
          name: shadow === 'wrong-name' ? 'renderer-a' : 'renderer-b',
          version:
            shadow === 'wrong-version'
              ? '2.0.0'
              : shadow === 'compatible-override'
                ? '1.1.0'
                : '1.0.0',
        });
      const initializing = createResolver({
        ...baseOptions(app, ['consumer']),
        offline: true,
        strict: true,
      });
      if (shadow === 'wrong-name' || shadow === 'wrong-version') {
        await expect(initializing).rejects.toMatchObject({
          diagnostics: expect.arrayContaining([
            expect.objectContaining({ code: 'OFFLINE_ALIAS_MISSING' }),
          ]),
        });
      } else {
        const resolver = await initializing;
        expect(resolver.getDiagnostics()).toEqual([]);
        expect(resolver.getAnalysisResult()!.aliasMappings[0]!.resolvedVersion).toBe(
          shadow === 'none' ? '1.0.0' : '1.1.0',
        );
        expect(resolver.resolveModule('renderer-b', join(consumer, 'index.js'))).toBe('compat');
        const active = resolver.getAliasPathMappings()[0]!;
        expect(JSON.parse(readFileSync(join(active.path, 'package.json'), 'utf8')).name).toBe(
          'renderer-b',
        );
      }
    },
  );

  it('keeps both configured names when roots share one physical package', async () => {
    const root = project({
      dependencies: {
        a: 'npm:legacy@1.0.0',
        b: 'npm:legacy@1.0.0',
        vue: '3.5.0',
        vue2: 'npm:vue@2.7.16',
      },
    });
    const physical = pkg(root, 'legacy-store', { name: 'legacy', peerDependencies: { vue: '^2' } });
    pkg(root, 'vue', { version: '3.5.0' });
    pkg(root, 'vue2', { name: 'vue', version: '2.7.16' });
    for (const name of ['a', 'b'])
      symlinkSync(physical, join(root, 'node_modules', name), 'junction');
    const resolver = await createResolver({
      ...baseOptions(root, ['a', 'b']),
      offline: true,
      strict: true,
    });
    expect(resolver.getDiagnostics()).toEqual([]);
    expect(resolver.getAnalysisResult()!.aliasMappings[0]!.usedBy).toEqual(['a', 'b']);
    expect(resolver.resolveModule('vue', join(physical, 'index.js'))).toBe('vue2');
  });

  it('reuses the current hoisted alias target on the first offline refresh', async () => {
    const root = project({
      workspaces: ['packages/*'],
      dependencies: { legacy: '1.0.0', vue: '3.5.0', vue2: 'npm:vue@^2' },
    });
    const legacy = pkg(root, 'legacy', { peerDependencies: { vue: '^2' } });
    pkg(root, 'vue', { version: '3.5.0' });
    const old = pkg(root, 'store-old', { name: 'vue', version: '2.6.14' });
    const fresh = pkg(root, 'store-new', { name: 'vue', version: '2.7.16' });
    const link = join(root, 'node_modules/vue2');
    symlinkSync(old, link, 'junction');
    const app = join(root, 'packages/app');
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app' }));
    createRequire(join(app, 'package.json')).resolve('vue2/package.json');
    const resolver = await createResolver({ ...baseOptions(app), offline: true, strict: true });
    expect(resolver.getAnalysisResult()!.aliasMappings[0]!.resolvedVersion).toBe('2.6.14');
    rmSync(link);
    symlinkSync(fresh, link, 'junction');
    resolver.invalidate();
    await resolver.initialize();
    expect(resolver.getAnalysisResult()!.aliasMappings[0]!.resolvedVersion).toBe('2.7.16');
    expect(resolver.getAliasPathMappings()[0]!.path).toBe(fresh);
    expect(resolver.resolveModule('vue', join(legacy, 'index.js'))).toBe('vue2');
  });

  it.each([
    'mixed',
    'same-provider',
    'no-peer',
    'optional-peer',
    'excluded',
    'included',
    'isolated',
    'outside-roots',
  ])(
    'diagnoses shared peer contexts without rejecting intentional or independent sharing: %s',
    async (kind) => {
      const root = project({
        dependencies: { legacy: '1.0.0', modern: '1.0.0', vue: '3.5.0', vue2: 'npm:vue@2.7.16' },
      });
      const legacy = pkg(root, 'legacy', {
        peerDependencies: { vue: '^2' },
        dependencies: { shared: '1.0.0' },
      });
      const modern = pkg(root, 'modern', {
        peerDependencies: { vue: kind === 'same-provider' ? '^2' : '^3' },
        dependencies: { shared: '1.0.0' },
      });
      const sharedManifest = {
        ...(kind === 'no-peer' ? {} : { peerDependencies: { vue: '>=2' } }),
        ...(kind === 'optional-peer' ? { peerDependenciesMeta: { vue: { optional: true } } } : {}),
      };
      pkg(root, 'shared', sharedManifest);
      if (kind === 'isolated') {
        pkg(legacy, 'shared', sharedManifest);
        pkg(modern, 'shared', sharedManifest);
      }
      pkg(root, 'vue', { version: '3.5.0' });
      pkg(root, 'vue2', { name: 'vue', version: '2.7.16' });
      const resolver = await createResolver({
        ...baseOptions(root, kind === 'outside-roots' ? ['legacy'] : ['legacy', 'modern']),
        offline: true,
        strict: true,
        ...(kind === 'excluded' ? { excludeRedirects: { vue: ['shared'] } } : {}),
        ...(kind === 'included' ? { includeRedirects: { vue: ['modern'] } } : {}),
      });
      const diagnostics = resolver
        .getDiagnostics()
        .filter((diagnostic) => diagnostic.code === 'SHARED_PEER_CONTEXT');
      expect(diagnostics).toHaveLength(kind === 'mixed' ? 1 : 0);
      if (kind === 'mixed')
        expect(diagnostics[0]).toMatchObject({
          severity: 'warning',
          packageName: 'vue',
          requestedBy: expect.arrayContaining(['legacy', 'modern']),
          message: expect.stringContaining('shared'),
        });
    },
  );

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
  it('discovers workspace-only configured instances through installed runtime links', async () => {
    const root = project({ name: 'workspace', workspaces: ['apps/*', 'packages/*'] });
    function writeWorkspacePackage(directory: string, manifest: PackageJson): string {
      const path = join(root, directory);
      mkdirSync(join(path, 'node_modules'), { recursive: true });
      writeFileSync(join(path, 'package.json'), JSON.stringify(manifest));
      return path;
    }
    const app = writeWorkspacePackage('apps/host', {
      name: 'host',
      dependencies: { vue: '3.5.0', vue26: 'npm:vue@2.6.14', vue27: 'npm:vue@2.7.16' },
      optionalDependencies: { bridge: 'workspace:*', 'missing-bridge': 'workspace:*' },
    });
    const bridge = writeWorkspacePackage('packages/bridge', {
      name: 'bridge',
      dependencies: { ui: 'workspace:*' },
    });
    const ui = writeWorkspacePackage('packages/ui', {
      name: 'ui',
      dependencies: { bridge: 'workspace:*', legacy: '1.0.0' },
    });
    const sibling = writeWorkspacePackage('packages/unused', {
      name: 'unused',
      dependencies: { legacy: '1.0.0' },
    });
    symlinkSync(bridge, join(app, 'node_modules/bridge'), 'junction');
    symlinkSync(ui, join(bridge, 'node_modules/ui'), 'junction');
    symlinkSync(bridge, join(ui, 'node_modules/bridge'), 'junction');
    const legacy = pkg(ui, 'legacy', { peerDependencies: { vue: '2.7.16' } });
    const unused = pkg(sibling, 'legacy', { peerDependencies: { vue: '2.6.14' } });
    pkg(app, 'vue', { version: '3.5.0' });
    pkg(app, 'vue26', { name: 'vue', version: '2.6.14' });
    pkg(app, 'vue27', { name: 'vue', version: '2.7.16' });

    const resolver = await createResolver({ ...baseOptions(app), offline: true, strict: true });
    expect(resolver.resolveModule('vue', join(legacy, 'index.js'))).toBe('vue27');
    expect(resolver.resolveModule('vue', join(unused, 'index.js'))).toBeNull();
    expect(resolver.getAnalysisResult()?.aliasMappings.map(({ usedBy }) => usedBy)).toEqual([
      ['bridge>ui>legacy'],
    ]);
    expect(resolver.getAnalysisResult()?.watchFiles).toEqual(
      expect.arrayContaining([bridge, ui, legacy].map((path) => join(path, 'package.json'))),
    );

    writeFileSync(
      join(legacy, 'package.json'),
      JSON.stringify({ name: 'legacy', version: '1.0.0', peerDependencies: { vue: '2.6.14' } }),
    );
    resolver.invalidate();
    await resolver.initialize();
    expect(resolver.resolveModule('vue', join(legacy, 'index.js'))).toBe('vue26');
  });

  it('applies peerOverrides to trigger conflict resolution and redirect the full physical subtree', async () => {
    const root = project({
      dependencies: { 'broad-legacy': '1.0.0', vue: '3.5.0', vue2: 'npm:vue@2.6.14' },
    });
    const broad = pkg(root, 'broad-legacy', {
      dependencies: { 'legacy-child': '1.0.0', 'modern-icons': '1.0.0' },
      peerDependencies: { vue: '>=2.5.17' },
    });
    const child = pkg(root, 'legacy-child', {
      peerDependencies: { vue: '>=2.5.0' },
    });
    const modernIcons = pkg(root, 'modern-icons', {
      peerDependencies: { vue: '3.x' },
    });
    pkg(root, 'vue', { version: '3.5.0' });
    pkg(root, 'vue2', { name: 'vue', version: '2.6.14' });

    // Without peerOverrides, vue@3.5.0 satisfies >=2.5.17 so no conflict is detected.
    const withoutOverride = await createResolver({
      ...baseOptions(root, ['broad-legacy']),
      offline: true,
      strict: true,
    });
    expect(withoutOverride.getAnalysisResult()?.aliasMappings).toEqual([]);

    // With peerOverrides, conflict detection and path-scoped subtree collection run normally,
    // while still skipping host-only descendants like modern-icons.
    const withOverride = await createResolver({
      ...baseOptions(root, ['broad-legacy']),
      peerOverrides: { 'broad-legacy': { vue: '>=2.5.17 <3' } },
      offline: true,
      strict: true,
    });
    expect(withOverride.resolveModule('vue', join(broad, 'index.js'))).toBe('vue2');
    expect(withOverride.resolveModule('vue', join(child, 'index.js'))).toBe('vue2');
    expect(withOverride.resolveModule('vue', join(modernIcons, 'index.js'))).toBeNull();
    expect(withOverride.resolveModule('vue', join(root, 'src/index.js'))).toBeNull();
  });

  it('allows peerOverrides to promote optional or omitted peers without ambiguity across multiple aliases', async () => {
    const root = project({
      dependencies: {
        'optional-legacy': '1.0.0',
        'omitted-legacy': '1.0.0',
        vue: '3.5.0',
        vue26: 'npm:vue@2.6.14',
        vue27: 'npm:vue@2.7.16',
      },
    });
    const optionalLegacy = pkg(root, 'optional-legacy', {
      peerDependencies: { vue: '>=2.5.0' },
      peerDependenciesMeta: { vue: { optional: true } },
    });
    const omittedLegacy = pkg(root, 'omitted-legacy', {});
    pkg(root, 'vue', { version: '3.5.0' });
    pkg(root, 'vue26', { name: 'vue', version: '2.6.14' });
    pkg(root, 'vue27', { name: 'vue', version: '2.7.16' });

    const resolver = await createResolver({
      ...baseOptions(root, ['optional-legacy', 'omitted-legacy']),
      peerOverrides: {
        'optional-legacy': { vue: '^2.6.0 <2.7.0' },
        'omitted-legacy': { vue: '^2.7.0' },
      },
      offline: true,
      strict: true,
    });
    expect(resolver.resolveModule('vue', join(optionalLegacy, 'index.js'))).toBe('vue26');
    expect(resolver.resolveModule('vue', join(omittedLegacy, 'index.js'))).toBe('vue27');
  });

  it('scopes versioned peerOverrides to matching package majors without redirecting newer coexisting versions', async () => {
    const workspace = project({
      name: 'ws-versioned-peer-overrides',
      workspaces: ['packages/*'],
    });
    const app = join(workspace, 'packages', 'app');
    const legacyBridge = join(workspace, 'packages', 'legacy-bridge');
    mkdirSync(join(app, 'node_modules'), { recursive: true });
    mkdirSync(legacyBridge, { recursive: true });
    writeFileSync(
      join(app, 'package.json'),
      JSON.stringify({
        name: 'app',
        version: '1.0.0',
        dependencies: {
          '@scope/ui': '2.1.0',
          'legacy-bridge': 'workspace:*',
          vue: '3.5.0',
          vue2: 'npm:vue@2.6.14',
        },
      }),
    );
    writeFileSync(
      join(legacyBridge, 'package.json'),
      JSON.stringify({
        name: 'legacy-bridge',
        version: '1.0.0',
        dependencies: { '@scope/ui': '1.16.220-feat-kso.417' },
      }),
    );
    symlinkSync(legacyBridge, join(app, 'node_modules', 'legacy-bridge'), 'dir');

    const uiV2 = pkg(app, '@scope/ui', {
      version: '2.1.0',
      dependencies: { 'ui-helper': '2.0.0' },
      peerDependencies: { vue: '>=2.5.17' },
    });
    const uiV2Helper = pkg(uiV2, 'ui-helper', {
      version: '2.0.0',
      peerDependencies: { vue: '>=2.5.0' },
    });
    const uiV1 = pkg(legacyBridge, '@scope/ui', {
      version: '1.16.220-feat-kso.417',
      dependencies: { 'ui-helper': '1.0.0' },
      peerDependencies: { vue: '>=2.5.17' },
    });
    const uiV1Helper = pkg(uiV1, 'ui-helper', {
      version: '1.0.0',
      peerDependencies: { vue: '>=2.5.0' },
    });
    pkg(app, 'vue', { version: '3.5.0' });
    pkg(app, 'vue2', { name: 'vue', version: '2.6.14' });

    const resolver = await createResolver({
      ...baseOptions(app, ['@scope/ui']),
      peerOverrides: {
        '@scope/ui@1.x': { vue: '>=2.5.17 <3' },
      },
      offline: true,
      strict: true,
    });

    expect(resolver.resolveModule('vue', join(uiV1, 'index.js'))).toBe('vue2');
    expect(resolver.resolveModule('vue', join(uiV1Helper, 'index.js'))).toBe('vue2');
    expect(resolver.resolveModule('vue', join(uiV2, 'index.js'))).toBeNull();
    expect(resolver.resolveModule('vue', join(uiV2Helper, 'index.js'))).toBeNull();
    expect(resolver.resolveModule('vue', join(app, 'src/index.js'))).toBeNull();
  });

  it('applies versioned peerOverrides to descendant pruning and installed alias peer linking', async () => {
    const root = project({
      dependencies: {
        legacy: '1.0.0',
        vue: '3.5.0',
        vue2: 'npm:vue@2.6.14',
        'vue-router': '4.5.0',
        router3: 'npm:vue-router@3.6.5',
      },
    });
    const legacy = pkg(root, 'legacy', {
      dependencies: { 'child-v1': '1.0.0', 'child-v2': '2.0.0' },
      peerDependencies: { vue: '^2.6.0', 'vue-router': '^3.6.0' },
    });
    const childV1 = pkg(root, 'child-v1', {
      name: 'shared-child',
      version: '1.2.0',
      peerDependencies: { vue: '>=2.5.0' },
    });
    const childV2 = pkg(root, 'child-v2', {
      name: 'shared-child',
      version: '2.0.0',
      peerDependencies: { vue: '>=2.5.0' },
    });
    pkg(root, 'vue', { version: '3.5.0' });
    pkg(root, 'vue2', { name: 'vue', version: '2.6.14' });
    pkg(root, 'vue-router', { version: '4.5.0' });
    const router3 = pkg(root, 'router3', {
      name: 'vue-router',
      version: '3.6.5',
      // Overly broad peer on the alias package itself: without peerOverrides,
      // linkAliasPeers would accept host vue@3.5.0 instead of linking vue2.
      peerDependencies: { vue: '>=2.5.0' },
    });

    const resolver = await createResolver({
      ...baseOptions(root, ['legacy']),
      peerOverrides: {
        'shared-child@2.x': { vue: '^3.0.0' },
        'vue-router@3.x': { vue: '^2.6.0' },
      },
      offline: true,
      strict: true,
    });

    expect(resolver.resolveModule('vue', join(legacy, 'index.js'))).toBe('vue2');
    expect(resolver.resolveModule('vue', join(childV1, 'index.js'))).toBe('vue2');
    expect(resolver.resolveModule('vue', join(childV2, 'index.js'))).toBeNull();
    expect(resolver.resolveModule('vue', join(router3, 'index.js'))).toBe('vue2');
  });

  it('skips host-only descendants that conflict with the selected alias while preserving compatible and shared subtrees', async () => {
    const root = project({
      dependencies: { legacy: '1.0.0', vue: '3.5.0', vue2: 'npm:vue@2.6.14' },
    });
    const legacy = pkg(root, 'legacy', {
      dependencies: { 'legacy-core': '1.0.0', 'modern-icons': '1.0.0', 'shared-util': '1.0.0' },
      peerDependencies: { vue: '>=2.5.0 <2.7.0' },
    });
    const legacyCore = pkg(root, 'legacy-core', {
      peerDependencies: { vue: '*' },
    });
    const modernIcons = pkg(root, 'modern-icons', {
      dependencies: { 'modern-helper': '1.0.0', 'shared-util': '1.0.0' },
      peerDependencies: { vue: '3.x' },
    });
    const modernHelper = pkg(root, 'modern-helper', {});
    const sharedUtil = pkg(root, 'shared-util', {});
    pkg(root, 'vue', { version: '3.5.0' });
    pkg(root, 'vue2', { name: 'vue', version: '2.6.14' });

    const resolver = await createResolver({ ...baseOptions(root), offline: true, strict: true });
    expect(resolver.resolveModule('vue', join(legacy, 'index.js'))).toBe('vue2');
    expect(resolver.resolveModule('vue', join(legacyCore, 'index.js'))).toBe('vue2');
    expect(resolver.resolveModule('vue', join(sharedUtil, 'index.js'))).toBe('vue2');
    expect(resolver.resolveModule('vue', join(modernIcons, 'index.js'))).toBeNull();
    expect(resolver.resolveModule('vue', join(modernHelper, 'index.js'))).toBeNull();
    const mapping = resolver.getAnalysisResult()?.aliasMappings[0];
    expect(mapping?.allDependents).toContain('legacy');
    expect(mapping?.allDependents).toContain('legacy-core');
    expect(mapping?.allDependents).toContain('shared-util');
    expect(mapping?.allDependents).not.toContain('modern-icons');
    expect(mapping?.allDependents).not.toContain('modern-helper');
  });

  it('preserves all workspace entry paths sharing a hoisted physical package for Vite SSR and uses shortest BFS paths', async () => {
    const workspace = project({
      name: 'ws-hoisted-shared-root',
      workspaces: ['packages/*'],
    });
    const app = join(workspace, 'packages', 'app');
    const wsA = join(workspace, 'packages', 'ws-a');
    const wsB = join(workspace, 'packages', 'ws-b');
    mkdirSync(join(app, 'node_modules'), { recursive: true });
    mkdirSync(join(wsA, 'node_modules'), { recursive: true });
    mkdirSync(join(wsB, 'node_modules'), { recursive: true });

    writeFileSync(
      join(app, 'package.json'),
      JSON.stringify({
        name: 'app',
        version: '1.0.0',
        dependencies: {
          legacy: '1.0.0',
          // Put ws-a before ws-b to verify BFS picks shortest path ws-b>legacy over ws-a>ws-b>legacy
          'ws-a': 'workspace:*',
          'ws-b': 'workspace:*',
          vue: '3.5.0',
          vue2: 'npm:vue@2.6.14',
        },
      }),
    );
    writeFileSync(
      join(wsA, 'package.json'),
      JSON.stringify({
        name: 'ws-a',
        version: '1.0.0',
        dependencies: { 'ws-b': 'workspace:*' },
      }),
    );
    writeFileSync(
      join(wsB, 'package.json'),
      JSON.stringify({
        name: 'ws-b',
        version: '1.0.0',
        dependencies: { legacy: '1.0.0' },
      }),
    );

    // Single hoisted physical directory shared by app and ws-b
    pkg(workspace, 'legacy', { peerDependencies: { vue: '^2.6.0' } });
    pkg(workspace, 'vue', { version: '3.5.0' });
    pkg(workspace, 'vue2', { name: 'vue', version: '2.6.14' });
    symlinkSync(
      wsA,
      join(app, 'node_modules', 'ws-a'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    symlinkSync(
      wsB,
      join(app, 'node_modules', 'ws-b'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    symlinkSync(
      wsB,
      join(wsA, 'node_modules', 'ws-b'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const resolver = await createResolver({
      ...baseOptions(app, ['legacy']),
      offline: true,
      strict: true,
    });
    const usedBy = resolver.getAnalysisResult()?.aliasMappings[0]?.usedBy ?? [];
    expect(usedBy).toContain('legacy');
    expect(usedBy).toContain('ws-b>legacy');
    expect(usedBy).not.toContain('ws-a>ws-b>legacy');

    const ssrConfig = await resolveConfig(
      {
        root: app,
        configFile: false,
        logLevel: 'silent',
        plugins: [
          depsConflictResolverVitePlugin({
            dependencies: ['legacy'],
            ssr: 'auto',
            offline: true,
            strict: true,
          }),
        ],
      },
      'serve',
    );
    expect(ssrConfig.ssr.noExternal).toEqual(expect.arrayContaining(['ws-b', 'legacy', 'vue2']));
    expect(ssrConfig.ssr.optimizeDeps?.include).toEqual(
      expect.arrayContaining(['legacy', 'ws-b > legacy', 'vue2']),
    );

    // When ssr.external=true and only the bridge package ws-b is in noExternal,
    // the external target leaf "legacy" must not be forced into ssr.optimizeDeps.include.
    const externalLeafConfig = await resolveConfig(
      {
        root: app,
        configFile: false,
        logLevel: 'silent',
        ssr: { external: true, noExternal: ['ws-b'] },
        plugins: [
          depsConflictResolverVitePlugin({
            dependencies: ['legacy'],
            ssr: 'auto',
            offline: true,
            strict: true,
          }),
        ],
      },
      'serve',
    );
    expect(externalLeafConfig.ssr.optimizeDeps?.include).not.toContain('ws-b > legacy');
  });

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

  it('inherits the Vite root when no plugin projectRoot is supplied', async () => {
    const root = project({
      dependencies: { legacy: '1.0.0', vue: '3.5.0', vue2: 'npm:vue@2.7.16' },
    });
    pkg(root, 'legacy', { peerDependencies: { vue: '^2.0.0' } });
    pkg(root, 'vue', { version: '3.5.0' });
    pkg(root, 'vue2', { name: 'vue', version: '2.7.16' });
    let analysis: AnalysisResult | undefined;
    const plugin = depsConflictResolverVitePlugin({
      dependencies: ['legacy'],
      autoInstall: false,
      hooks: {
        onAnalysisComplete: (result) => {
          analysis = result;
        },
      },
    });
    await resolveConfig(
      { root, configFile: false, logLevel: 'silent', plugins: [plugin] },
      'build',
    );

    expect(analysis?.aliasMappings.map((mapping) => mapping.aliasName)).toEqual(['vue2']);
  });
});
