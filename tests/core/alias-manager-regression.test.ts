import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
  readdirSync,
  lstatSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AliasManager } from '../../src/core/alias-manager';
import type { AliasMapping, ResolvedOptions } from '../../src/types';
import { clearPackageJsonCache } from '../../src/utils/fs';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    realpathSync: Object.assign(vi.fn(actual.realpathSync), {
      native: vi.fn(actual.realpathSync.native),
    }),
    readdirSync: vi.fn(actual.readdirSync),
    lstatSync: vi.fn(actual.lstatSync),
    statSync: vi.fn(actual.statSync),
  };
});

function mapping(
  aliasName: string,
  importerPaths: string[],
  excludedImporterPaths?: string[],
): AliasMapping {
  return {
    originalName: 'vue',
    aliasName,
    installSpec: '',
    resolvedVersion: '2.7.16',
    usedBy: ['legacy'],
    allDependents: ['legacy', 'shared', 'excluded'],
    importerPaths,
    ...(excludedImporterPaths ? { excludedImporterPaths } : {}),
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

    for (const suffix of ['', '?raw#fragment']) {
      expect(
        instance.resolveModule({ request: 'vue', importer: join(workspace, 'index.js') + suffix }),
      ).toBe('vue2');
      expect(
        instance.resolveModule({ request: 'vue', importer: join(linked, 'index.js') + suffix }),
      ).toBe('vue2');
    }
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

  it.skipIf(process.platform === 'win32')(
    'preserves the Node resolution of parent segments inside a directory link',
    () => {
      const lexical = writePackage('node_modules/pkg', 'pkg');
      const physical = writePackage('node_modules/store/pkg', 'pkg');
      const installed = dirname(lexical);
      mkdirSync(join(installed, 'store/inside'));
      symlinkSync('store/inside', join(installed, 'jump'), 'dir');
      const linked = join(installed, 'linked');
      symlinkSync('jump/../pkg', linked, 'dir');

      const resolver = manager([mapping('vue2', [lexical]), mapping('vue3', [physical])]);
      expect(resolver.resolveModule({ request: 'vue', importer: join(linked, 'index.js') })).toBe(
        'vue2',
      );
    },
  );

  it('shares a decision across installed files and resolves a file symlink independently', () => {
    const legacy = writePackage('node_modules/legacy', 'legacy');
    const target = writePackage('node_modules/target', 'target');
    const source = join(legacy, 'src');
    mkdirSync(source);
    const files = Array.from({ length: 20 }, (_, index) => join(source, 'entry-' + index + '.js'));
    for (const file of files) writeFileSync(file, '');
    const linkedFile = join(source, 'linked.js');
    if (process.platform !== 'win32') symlinkSync(join(target, 'index.js'), linkedFile, 'file');

    const resolver = manager([mapping('vue2', [legacy]), mapping('vue3', [target])]);
    vi.clearAllMocks();
    for (const importer of files)
      expect(resolver.resolveModule({ request: 'vue', importer })).toBe('vue2');
    expect(readdirSync).not.toHaveBeenCalled();
    expect(realpathSync.native).not.toHaveBeenCalled();
    expect(vi.mocked(realpathSync).mock.calls.length).toBeLessThanOrEqual(4);
    if (process.platform !== 'win32') {
      expect(resolver.resolveModule({ request: 'vue', importer: linkedFile })).toBe('vue3');
      expect(resolver.resolveModule({ request: 'vue', importer: linkedFile + '?raw' })).toBe(
        'vue3',
      );
    }
  });

  it.skipIf(process.platform === 'win32')(
    'checks file type on the first request after warming its directory',
    () => {
      const legacy = writePackage('node_modules/legacy', 'legacy');
      const target = writePackage('node_modules/target', 'target');
      const source = join(legacy, 'src');
      mkdirSync(source);
      const files = Array.from({ length: 6 }, (_, index) => join(source, `entry-${index}.js`));
      for (const file of files) writeFileSync(file, '');
      const resolver = manager([mapping('vue2', [legacy]), mapping('vue3', [target])]);
      for (const importer of files.slice(0, -1)) {
        expect(resolver.resolveModule({ request: 'vue', importer })).toBe('vue2');
      }

      const replaced = files.at(-1)!;
      unlinkSync(replaced);
      symlinkSync(join(target, 'index.js'), replaced, 'file');
      expect(resolver.resolveModule({ request: 'vue', importer: replaced })).toBe('vue3');
    },
  );

  it('only probes requested files in a directory with sparse imports', () => {
    const legacy = writePackage('node_modules/legacy', 'legacy');
    const files = Array.from({ length: 1024 }, (_, index) => join(legacy, `entry-${index}.js`));
    for (const file of files) writeFileSync(file, '');
    const resolver = manager([mapping('vue2', [legacy])]);
    vi.clearAllMocks();

    for (const importer of files.slice(0, 2)) {
      expect(resolver.resolveModule({ request: 'vue', importer })).toBe('vue2');
    }
    expect(readdirSync).not.toHaveBeenCalled();
    expect(lstatSync).not.toHaveBeenCalled();
    expect(vi.mocked(realpathSync).mock.calls.length).toBeLessThanOrEqual(2);
  });

  it.each(['', '?vue&type=script'])(
    'keeps distributed importer paths warm across multiple alias targets (%s)',
    (suffix) => {
      const legacy = writePackage('node_modules/legacy', 'legacy');
      const files: string[] = [];
      for (let index = 0; index < 1_300; index++) {
        const directory = join(legacy, `component-${index}`);
        mkdirSync(directory);
        for (const name of ['first.js', 'second.js']) {
          const importer = join(directory, name);
          writeFileSync(importer, '');
          files.push(importer + suffix);
        }
      }
      const resolver = manager([
        mapping('vue2', [legacy]),
        { ...mapping('renderer1', [legacy]), originalName: 'renderer' },
      ]);
      const resolveAll = () => {
        for (const importer of files) {
          expect(resolver.resolveModule({ request: 'vue', importer })).toBe('vue2');
          expect(resolver.resolveModule({ request: 'renderer', importer })).toBe('renderer1');
        }
      };
      resolveAll();
      vi.clearAllMocks();
      resolveAll();
      expect(vi.mocked(readdirSync).mock.calls).toHaveLength(0);
      expect(vi.mocked(lstatSync).mock.calls).toHaveLength(0);
      expect(vi.mocked(realpathSync).mock.calls).toHaveLength(0);
      expect(vi.mocked(realpathSync.native).mock.calls).toHaveLength(0);
    },
  );

  it('keeps active directory decisions warm during a sweep of small component directories', () => {
    const legacy = writePackage('node_modules/legacy', 'legacy');
    const hotDirectory = join(legacy, 'common');
    mkdirSync(hotDirectory);
    const importers: string[] = [];
    for (let index = 0; index < 1_100; index++) {
      const directory = index % 16 === 0 ? hotDirectory : join(legacy, 'component-' + index);
      if (directory !== hotDirectory) mkdirSync(directory);
      for (let file = 0; file < 3; file++) {
        const importer = join(directory, `module-${index}-${file}.mjs`);
        writeFileSync(importer, '');
        importers.push(importer);
      }
    }

    const resolver = manager([mapping('vue2', [legacy])]);
    vi.clearAllMocks();
    for (const importer of importers)
      expect(resolver.resolveModule({ request: 'vue', importer })).toBe('vue2');
    expect(
      vi.mocked(realpathSync).mock.calls.filter(([directory]) => directory === hotDirectory),
    ).toHaveLength(1);

    vi.clearAllMocks();
    for (const importer of importers)
      expect(resolver.resolveModule({ request: 'vue', importer })).toBe('vue2');
    expect(readdirSync).not.toHaveBeenCalled();
    expect(lstatSync).not.toHaveBeenCalled();
    expect(realpathSync).not.toHaveBeenCalled();
    expect(realpathSync.native).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')(
    'keeps file-level matching for literal backslashes in a filename',
    () => {
      const legacy = writePackage('node_modules/legacy', 'legacy');
      const sibling = join(legacy, 'sibling.mjs');
      const escaped = join(legacy, 'node_modules\\excluded\\entry.mjs');
      writeFileSync(sibling, '');
      writeFileSync(escaped, '');
      options.excludeRedirects = { vue: ['excluded'] };
      const resolver = manager([mapping('vue2', [legacy])]);

      for (const importer of [join(legacy, 'index.js'), sibling])
        expect(resolver.resolveModule({ request: 'vue', importer })).toBe('vue2');
      expect(resolver.resolveModule({ request: 'vue', importer: escaped })).toBeNull();
    },
  );

  it.each(['', '?raw#fragment'])(
    'performs no filesystem calls for repeated warm resolutions: %s',
    (suffix) => {
      const paths = Array.from({ length: 101 }, (_, index) =>
        writePackage(`node_modules/child-${index}`, `child-${index}`),
      );
      const instance = manager([mapping('vue2', paths)]);
      const importer = join(paths[100]!, 'index.js') + suffix;
      expect(instance.resolveModule({ request: 'vue', importer })).toBe('vue2');
      const calls = vi.mocked(realpathSync).mock.calls.length;
      const statCalls = vi.mocked(statSync).mock.calls.length;

      for (let index = 0; index < 200; index++) {
        expect(instance.resolveModule({ request: 'vue', importer })).toBe('vue2');
      }
      expect(vi.mocked(realpathSync).mock.calls.length).toBe(calls);
      expect(vi.mocked(statSync).mock.calls.length).toBe(statCalls);
      expect(realpathSync.native).not.toHaveBeenCalled();
      expect(readdirSync).not.toHaveBeenCalled();
      expect(lstatSync).not.toHaveBeenCalled();
    },
  );

  it.each(process.platform === 'win32' ? ['#'] : ['#', '?'])(
    'keeps literal %s characters in project paths separate from module suffixes',
    (character) => {
      const legacy = writePackage(`project${character}demo/node_modules/legacy`, 'legacy');
      const host = writePackage(`project${character}demo/src`, 'host');
      const instance = manager([mapping('vue2', [legacy])]);
      for (const suffix of ['', '?raw', '#fragment', '?vue&type=script#fragment']) {
        expect(
          instance.resolveModule({ request: 'vue', importer: join(host, 'index.js') + suffix }),
        ).toBeNull();
        expect(
          instance.resolveModule({ request: 'vue', importer: join(legacy, 'index.js') + suffix }),
        ).toBe('vue2');
      }
    },
  );

  it('reuses the confirmed file path for different queries on the same importer', () => {
    const legacy = writePackage('node_modules/legacy', 'legacy');
    const importer = join(legacy, 'Comp.vue');
    writeFileSync(importer, '');
    const resolver = manager([mapping('vue2', [legacy])]);
    vi.clearAllMocks();

    for (const suffix of ['?vue&type=script', '?vue&type=template', '?vue&type=style']) {
      expect(resolver.resolveModule({ request: 'vue', importer: importer + suffix })).toBe('vue2');
    }
    expect(vi.mocked(realpathSync).mock.calls.filter(([path]) => path === importer)).toHaveLength(
      1,
    );
  });

  it.skipIf(process.platform === 'win32').each(['#', '?'])(
    'uses the literal importer file when its name contains %s',
    (marker) => {
      const legacy = writePackage('node_modules/legacy', 'legacy');
      const target = writePackage('node_modules/target', 'target');
      const source = join(legacy, 'src');
      mkdirSync(source);
      const importer = join(source, 'Comp.vue');
      const literal = importer + marker + 'literal';
      writeFileSync(importer, '');
      symlinkSync(join(target, 'index.js'), literal, 'file');
      const resolver = manager([mapping('vue2', [legacy]), mapping('vue3', [target])]);

      expect(resolver.resolveModule({ request: 'vue', importer: literal })).toBe('vue3');
      expect(resolver.resolveModule({ request: 'vue', importer: literal + '?raw' })).toBe('vue3');
    },
  );

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

  it('keeps only the closest pruned boundary when includeRedirects sits between nested pruned scopes', () => {
    options.includeRedirects = { vue: ['forced-mid', 'forced-leaf'] };
    const legacy = writePackage('node_modules/legacy', 'legacy');
    const prunedOuter = writePackage(
      'node_modules/legacy/node_modules/pruned-outer',
      'pruned-outer',
    );
    const forcedMid = writePackage(
      'node_modules/legacy/node_modules/pruned-outer/node_modules/forced-mid',
      'forced-mid',
    );
    const prunedInner = writePackage(
      'node_modules/legacy/node_modules/pruned-outer/node_modules/forced-mid/node_modules/pruned-inner',
      'pruned-inner',
    );
    const forcedLeaf = writePackage(
      'node_modules/legacy/node_modules/pruned-outer/node_modules/forced-mid/node_modules/pruned-inner/node_modules/forced-leaf',
      'forced-leaf',
    );
    const instance = manager([mapping('vue2', [legacy], [prunedOuter, prunedInner])]);

    expect(
      instance.resolveModule({ request: 'vue', importer: join(prunedOuter, 'index.js') }),
    ).toBeNull();
    expect(instance.resolveModule({ request: 'vue', importer: join(forcedMid, 'index.js') })).toBe(
      'vue2',
    );
    expect(
      instance.resolveModule({ request: 'vue', importer: join(prunedInner, 'index.js') }),
    ).toBeNull();
    expect(instance.resolveModule({ request: 'vue', importer: join(forcedLeaf, 'index.js') })).toBe(
      'vue2',
    );
  });
});
