import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { build, resolveConfig, type Plugin } from 'vite';
import plugin from '../../../src/plugins/vite';
import * as packageManager from '../../../src/core/package-manager-adapter';
import type { PluginHooks } from '../../../src/types';
import { mockRegistry } from '../../support/registry';

const roots: string[] = [];
const redirectToHostVue = (source: string) => (source === 'vue2' ? 'vue' : undefined);
function fixture(version: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'deps-vite-lifecycle-')));
  roots.push(root);
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'host',
      dependencies: {
        legacy: '1.0.0',
        vue: '3.0.0',
        vue2: 'npm:vue@' + version,
      },
    }),
  );
  for (const [request, name, v, code] of [
    ['legacy', 'legacy', '1.0.0', 'export {version} from "vue";'],
    ['vue', 'vue', '3.0.0', 'export const version="3.0.0";'],
    ['vue2', 'vue', version, 'export const version=' + JSON.stringify(version) + ';'],
  ]) {
    const directory = join(root, 'node_modules', request!);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({
        name,
        version: v,
        type: 'module',
        main: 'index.js',
        peerDependencies: request === 'legacy' ? { vue: version } : {},
      }),
    );
    writeFileSync(join(directory, 'index.js'), code!);
  }
  writeFileSync(join(root, 'entry.js'), 'export {version} from "legacy";');
  return root;
}
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  vi.restoreAllMocks();
});

describe('Vite final configuration', () => {
  it.each(['analysis', 'build'] as const)(
    'honors a hook registered during analysis or delegated during build (%s)',
    async (phase) => {
      const root = fixture('2.7.16');
      const entry = join(root, 'entry.js');
      writeFileSync(entry, 'export {version} from "vue2";');
      const hooks: PluginHooks = {};
      let delegate: PluginHooks['beforeResolve'];
      const register = () => {
        if (phase === 'analysis') hooks.beforeResolve = redirectToHostVue;
        else delegate = redirectToHostVue;
      };
      if (phase === 'analysis') hooks.onAnalysisComplete = register;
      else hooks.beforeResolve = (source, importer) => delegate?.(source, importer);
      await build({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [
          plugin({ dependencies: phase === 'analysis' ? [] : ['legacy'], offline: true, hooks }),
          ...(phase === 'build' ? [{ name: 'register-resolver', buildStart: register }] : []),
        ],
        build: {
          lib: { entry, formats: ['cjs'], fileName: () => 'result.cjs' },
          outDir: join(root, 'dist'),
        },
      });
      expect(createRequire(import.meta.url)(join(root, 'dist/result.cjs')).version).toBe('3.0.0');
    },
  );

  it.each([false, true])(
    'initializes a Worker-only instance when a main instance is also present: %s',
    async (withMain) => {
      const root = fixture('2.7.16');
      writeFileSync(
        join(root, 'entry.js'),
        'new Worker(new URL("./worker.js", import.meta.url), {type:"module"});',
      );
      writeFileSync(
        join(root, 'worker.js'),
        'import {version} from "legacy";self.postMessage(version);',
      );
      const analyzed = vi.fn();
      const result = await build({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: withMain
          ? [plugin({ dependencies: ['legacy'], offline: true, strict: true })]
          : [],
        worker: {
          plugins: () => [
            plugin({
              dependencies: ['legacy'],
              offline: true,
              strict: true,
              hooks: { onAnalysisComplete: analyzed },
            }),
          ],
        },
        build: {
          write: false,
          minify: false,
          rollupOptions: { input: join(root, 'entry.js') },
        },
      });
      const outputs = (Array.isArray(result) ? result : [result]).flatMap((output) =>
        'output' in output ? output.output : [],
      );
      const worker = outputs.find(
        (output) => output.type === 'asset' && output.fileName.endsWith('.js'),
      );
      expect(worker?.type).toBe('asset');
      if (worker?.type !== 'asset') throw new Error('Worker asset is missing');
      const messages: unknown[] = [];
      runInNewContext(String(worker.source), {
        self: { postMessage: (value: unknown) => messages.push(value) },
      });
      expect(messages).toEqual(['2.7.16']);
      expect(analyzed).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects a strict Worker build when its required alias is missing', async () => {
    const root = fixture('2.7.16');
    rmSync(join(root, 'node_modules/vue2'), { recursive: true });
    writeFileSync(
      join(root, 'entry.js'),
      'new Worker(new URL("./worker.js", import.meta.url), {type:"module"});',
    );
    writeFileSync(
      join(root, 'worker.js'),
      'import {version} from "legacy";self.postMessage(version);',
    );
    await expect(
      build({
        root,
        configFile: false,
        logLevel: 'silent',
        worker: {
          plugins: () => [plugin({ dependencies: ['legacy'], offline: true, strict: true })],
        },
        build: { write: false, rollupOptions: { input: join(root, 'entry.js') } },
      }),
    ).rejects.toThrow('[OFFLINE_ALIAS_MISSING]');
  });

  it.each(['normal', 'post'] as const)(
    'uses the root selected by a later %s config hook',
    async (order) => {
      const a = fixture('2.6.14');
      const b = fixture('2.7.16');
      const adjust: Plugin = {
        name: 'framework-root',
        ...(order === 'post' ? { enforce: 'post' as const } : {}),
        config:
          order === 'post' ? { order: 'post', handler: () => ({ root: b }) } : () => ({ root: b }),
      };
      await build({
        root: a,
        configFile: false,
        logLevel: 'silent',
        plugins: [plugin({ dependencies: ['legacy'], offline: true, strict: true }), adjust],
        build: {
          lib: { entry: join(b, 'entry.js'), formats: ['cjs'], fileName: () => 'result.cjs' },
          outDir: join(b, 'dist'),
          minify: false,
        },
      });
      expect(createRequire(import.meta.url)(join(b, 'dist/result.cjs')).version).toBe('2.7.16');
    },
  );

  it('does not query or install for an abandoned implicit root', async () => {
    const a = fixture('2.6.14');
    const b = fixture('2.7.16');
    rmSync(join(a, 'node_modules/vue2'), { recursive: true });
    const fetch = mockRegistry({ name: 'vue', version: '2.6.14' });
    const install = vi.fn().mockResolvedValue({
      success: false,
      exitCode: 1,
      stdout: '',
      stderr: 'wrong project',
      timedOut: false,
    });
    vi.spyOn(packageManager, 'createPackageManagerAdapter').mockReturnValue({ install });
    const config = await resolveConfig(
      {
        root: a,
        configFile: false,
        logLevel: 'silent',
        plugins: [
          plugin({ dependencies: ['legacy'], autoInstall: true, strict: true }),
          { name: 'framework-root', config: () => ({ root: b }) },
        ],
      },
      'serve',
    );
    expect(config.root).toBe(b);
    expect(config.optimizeDeps.include).toContain('vue2');
    expect(fetch).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it('continues to honor an explicitly selected projectRoot', async () => {
    const a = fixture('2.6.14');
    const b = fixture('2.7.16');
    let selected: string[] = [];
    await resolveConfig(
      {
        root: b,
        configFile: false,
        logLevel: 'silent',
        plugins: [
          plugin({
            dependencies: ['legacy'],
            projectRoot: a,
            offline: true,
            strict: true,
            hooks: {
              onAnalysisComplete: (result) => {
                selected = result.aliasMappings.map((mapping) => mapping.resolvedVersion);
              },
            },
          }),
        ],
      },
      'build',
    );
    expect(selected).toEqual(['2.6.14']);
  });
});
