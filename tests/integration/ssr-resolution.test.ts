import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, resolveConfig } from 'vite';
import { depsConflictResolverVitePlugin } from '../../src/plugins/vite';

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'deps-ssr-'));
  roots.push(root);
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'host',
      type: 'module',
      dependencies: { legacy: '1.0.0', vue: '3.0.0', vue2: 'npm:vue@2.7.16' },
    }),
  );
  for (const [alias, name, version, code, peers] of [
    ['vue', 'vue', '3.0.0', 'export const version = "3.0.0";', {}],
    ['vue2', 'vue', '2.7.16', 'export const version = "2.7.16";', {}],
    [
      'legacy',
      'legacy',
      '1.0.0',
      'import { version } from "vue"; export const runtimeVersion = version;',
      { vue: '^2.0.0' },
    ],
  ] as const) {
    const directory = join(root, 'node_modules', alias);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({
        name,
        version,
        type: 'module',
        exports: './index.js',
        peerDependencies: peers,
      }),
    );
    writeFileSync(join(directory, 'index.js'), code);
  }
  const entry = join(root, 'entry.js');
  writeFileSync(entry, 'export { runtimeVersion } from "legacy";');
  return { root, entry };
}

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

describe('SSR alias resolution', () => {
  it('bundles the affected dependencies when SSR auto mode is enabled', async () => {
    const { root, entry } = fixture();
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [
        depsConflictResolverVitePlugin({
          dependencies: ['legacy'],
          autoInstall: false,
          offline: true,
          strict: true,
          ssr: 'auto',
        }),
      ],
      build: { ssr: entry, outDir: join(root, 'dist'), minify: false },
    });
    const result = (await import(pathToFileURL(join(root, 'dist/entry.js')).href)) as {
      runtimeVersion: string;
    };
    expect(result.runtimeVersion).toBe('2.7.16');
  });

  it('preserves an existing noExternal=true configuration', async () => {
    const { root } = fixture();
    const config = await resolveConfig(
      {
        root,
        configFile: false,
        logLevel: 'silent',
        ssr: { noExternal: true },
        plugins: [
          depsConflictResolverVitePlugin({
            dependencies: ['legacy'],
            autoInstall: false,
            offline: true,
            ssr: 'auto',
          }),
        ],
      },
      'build',
    );
    expect(config.ssr.noExternal).toBe(true);
  });
});
