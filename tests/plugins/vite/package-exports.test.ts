import { cp, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveConfig } from 'vite';
import { createViteAliases } from '../../../src/plugins/vite';

const fixturePackagePath = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/exports-package',
);
const temporaryRoots: string[] = [];

describe('Vite package exports', () => {
  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it('resolves an aliased subpath through package exports instead of its physical path', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'deps-conflict-vite-'));
    temporaryRoots.push(projectRoot);
    const aliasPackagePath = join(projectRoot, 'node_modules', 'aliased-exports-package');
    await mkdir(dirname(aliasPackagePath), { recursive: true });
    await cp(fixturePackagePath, aliasPackagePath, { recursive: true });
    const resolvedAliasPackagePath = await realpath(aliasPackagePath);

    const config = await resolveConfig(
      {
        root: projectRoot,
        resolve: {
          alias: createViteAliases([
            {
              aliasName: 'aliased-exports-package',
              originalName: 'original-package',
              path: aliasPackagePath,
            },
          ]),
        },
      },
      'build',
    );

    const resolved = await config.createResolver()('aliased-exports-package/feature', undefined);

    expect(resolved).toBe(join(resolvedAliasPackagePath, 'exports/feature.js'));
    expect(resolved).not.toBe(join(resolvedAliasPackagePath, 'feature.js'));
  });

  it('honors root conditional exports ahead of module and main fields', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'deps-conflict-vite-'));
    temporaryRoots.push(projectRoot);
    const aliasPackagePath = join(projectRoot, 'node_modules', 'aliased-package');
    await mkdir(aliasPackagePath, { recursive: true });
    await writeFile(
      join(projectRoot, 'package.json'),
      JSON.stringify({ name: 'host', type: 'module' }),
    );
    await writeFile(
      join(aliasPackagePath, 'package.json'),
      JSON.stringify({
        name: 'original-package',
        version: '1.0.0',
        type: 'module',
        main: './fallback.cjs',
        module: './fallback.js',
        exports: { '.': { import: './entry.js', require: './entry.cjs' } },
      }),
    );
    await Promise.all(
      ['fallback.cjs', 'fallback.js', 'entry.js', 'entry.cjs'].map((file) =>
        writeFile(join(aliasPackagePath, file), ''),
      ),
    );
    const config = await resolveConfig(
      {
        root: projectRoot,
        configFile: false,
        resolve: {
          alias: createViteAliases(
            [
              {
                aliasName: 'aliased-package',
                originalName: 'original-package',
                path: aliasPackagePath,
              },
            ],
            projectRoot,
          ),
        },
      },
      'build',
    );
    const importEntry = await config.createResolver()('aliased-package', undefined);
    const requireEntry = await config.createResolver({ isRequire: true })(
      'aliased-package',
      undefined,
    );
    expect(importEntry).toBe(join(await realpath(aliasPackagePath), 'entry.js'));
    expect(requireEntry).toBe(join(await realpath(aliasPackagePath), 'entry.cjs'));
  });
});
