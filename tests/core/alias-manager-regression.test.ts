import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AliasManager } from '../../src/core/alias-manager';
import type { AliasMapping, ResolvedOptions } from '../../src/types';
import { clearPackageJsonCache } from '../../src/utils/fs';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, realpathSync: vi.fn(actual.realpathSync) };
});

function mapping(aliasName: string, importerPaths: string[]): AliasMapping {
  return {
    originalName: 'vue',
    aliasName,
    installSpec: '',
    resolvedVersion: '2.7.16',
    usedBy: ['legacy'],
    allDependents: ['legacy', 'shared', 'excluded'],
    importerPaths,
  };
}

describe('alias resolution across installation layouts', () => {
  let root: string;
  let options: ResolvedOptions;

  function writePackage(relativePath: string, name: string): string {
    const directory = join(root, relativePath);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
    writeFileSync(join(directory, 'index.js'), 'export {};');
    return directory;
  }

  function manager(mappings: AliasMapping[]): AliasManager {
    const instance = new AliasManager(options);
    instance.initFromAnalysisResult({
      analyzedDependencies: new Map(),
      peerConflicts: [],
      aliasMappings: mappings,
      missingFirstLevelPeers: [],
    });
    return instance;
  }

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'deps-alias-layout-')));
    options = {
      projectRoot: root,
      dependencies: ['legacy'],
      autoInstall: false,
      packageManager: 'npm',
      registry: 'https://registry.example.test',
      debug: false,
      aliasPrefix: 'aliased-',
      includeRedirects: {},
      excludeRedirects: {},
    };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    clearPackageJsonCache();
    vi.clearAllMocks();
  });

  it('redirects both workspace real paths and node_modules symlinks', () => {
    const workspace = writePackage('packages/legacy', 'legacy');
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    const linked = join(root, 'node_modules/legacy');
    symlinkSync(workspace, linked, process.platform === 'win32' ? 'junction' : 'dir');
    const instance = manager([mapping('vue2', [workspace])]);

    expect(instance.resolveModule({ request: 'vue', importer: join(workspace, 'index.js') })).toBe(
      'vue2',
    );
    expect(instance.resolveModule({ request: 'vue', importer: join(linked, 'index.js') })).toBe(
      'vue2',
    );
    expect(
      instance.resolveModule({ request: 'vue', importer: join(root, 'src/index.js') }),
    ).toBeNull();
  });

  it('honors an excluded workspace package and its nested subtree', () => {
    options.excludeRedirects = { vue: ['excluded'] };
    const excluded = writePackage('packages/excluded', 'excluded');
    const nested = writePackage('packages/excluded/node_modules/child', 'child');
    const instance = manager([mapping('vue2', [excluded, nested])]);

    expect(
      instance.resolveModule({ request: 'vue', importer: join(excluded, 'index.js') }),
    ).toBeNull();
    expect(
      instance.resolveModule({ request: 'vue', importer: join(nested, 'index.js') }),
    ).toBeNull();
  });

  it('preserves query and hash suffixes on package roots and subpaths', () => {
    const legacy = writePackage('node_modules/legacy', 'legacy');
    const instance = manager([mapping('vue2', [legacy])]);
    const importer = join(legacy, 'index.js');

    for (const suffix of ['?raw', '#fragment', '/dist/index.js?raw#fragment']) {
      expect(instance.resolveModule({ request: `vue${suffix}`, importer })).toBe(`vue2${suffix}`);
    }
  });

  it('does not choose an arbitrary version for an ambiguous physical importer', () => {
    const shared = writePackage('node_modules/shared', 'shared');
    const instance = manager([mapping('vue26', [shared]), mapping('vue27', [shared])]);

    expect(
      instance.resolveModule({ request: 'vue', importer: join(shared, 'index.js') }),
    ).toBeNull();
  });

  it('performs no realpath calls for repeated warm resolutions', () => {
    const paths = Array.from({ length: 101 }, (_, index) =>
      writePackage(`node_modules/child-${index}`, `child-${index}`),
    );
    const instance = manager([mapping('vue2', paths)]);
    const importer = join(paths[100]!, 'index.js');
    expect(instance.resolveModule({ request: 'vue', importer })).toBe('vue2');
    const calls = vi.mocked(realpathSync).mock.calls.length;

    for (let index = 0; index < 200; index++) {
      expect(instance.resolveModule({ request: 'vue', importer })).toBe('vue2');
    }
    expect(vi.mocked(realpathSync).mock.calls.length).toBe(calls);
  });

  it('drops cached decisions when a generation is replaced or cleared', () => {
    const legacy = writePackage('node_modules/legacy', 'legacy');
    const instance = manager([mapping('vue2', [legacy])]);
    const context = { request: 'vue', importer: join(legacy, 'index.js') };
    expect(instance.resolveModule(context)).toBe('vue2');
    instance.initFromAnalysisResult({
      analyzedDependencies: new Map(),
      peerConflicts: [],
      aliasMappings: [mapping('vue3', [legacy])],
      missingFirstLevelPeers: [],
    });
    expect(instance.resolveModule(context)).toBe('vue3');
    instance.clear();
    expect(instance.resolveModule(context)).toBeNull();
  });

  it('ranks scopes by proximity when a long symlink points to a shorter real path', () => {
    const workspace = writePackage('w', 'legacy');
    const child = writePackage('w/node_modules/child', 'child');
    const linked = join(root, 'node_modules', 'a-very-long-symlinked-workspace-package-name');
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    symlinkSync(workspace, linked, process.platform === 'win32' ? 'junction' : 'dir');
    const instance = manager([mapping('vue2', [linked]), mapping('vue3', [child])]);
    expect(
      instance.resolveModule({
        request: 'vue',
        importer: join(linked, 'node_modules/child/index.js'),
      }),
    ).toBe('vue3');
  });

  it('does not allow a more specific rule to escape an excluded ancestor', () => {
    options.excludeRedirects = { vue: ['excluded'] };
    const excluded = writePackage('node_modules/excluded', 'excluded');
    const child = writePackage('node_modules/excluded/node_modules/child', 'child');
    const instance = manager([mapping('vue2', [excluded]), mapping('vue3', [child])]);
    expect(
      instance.resolveModule({ request: 'vue', importer: join(child, 'index.js') }),
    ).toBeNull();
  });
});
