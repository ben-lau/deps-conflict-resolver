import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build, createBuilder, createLogger, optimizeDeps, resolveConfig, type Plugin } from 'vite';
import plugin from '../../../src/plugins/vite';
import * as packageManager from '../../../src/core/package-manager-adapter';
import {
  getProjectPreparation,
  withProjectPreparation,
} from '../../../src/core/project-preparation';
import type { PackageJson, PluginHooks } from '../../../src/types';
import { mockRegistry } from '../../support/registry';

const roots: string[] = [];
const redirectToHostVue = (source: string) => (source === 'vue2' ? 'vue' : undefined);
function writeModule(root: string, request: string, manifest: PackageJson, source: string) {
  const directory = join(root, 'node_modules', request);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ type: 'module', main: 'index.js', ...manifest }),
  );
  writeFileSync(join(directory, 'index.js'), source);
  return directory;
}

function fixture(version: string, extraDependencies: Record<string, string> = {}) {
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
        ...extraDependencies,
      },
    }),
  );
  for (const [request, name, v, code] of [
    ['legacy', 'legacy', '1.0.0', 'export {version} from "vue";'],
    ['vue', 'vue', '3.0.0', 'export const version="3.0.0";'],
    ['vue2', 'vue', version, 'export const version=' + JSON.stringify(version) + ';'],
  ] as const) {
    writeModule(
      root,
      request,
      {
        name,
        version: v,
        peerDependencies: request === 'legacy' ? { vue: version } : {},
      },
      code,
    );
  }
  writeFileSync(join(root, 'entry.js'), 'export {version} from "legacy";');
  return root;
}
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  vi.restoreAllMocks();
});

describe('Vite final configuration', () => {
  it('rejects publication if preparation completed during a filtered strict build', async () => {
    const root = fixture('2.7.16');
    writeFileSync(join(root, 'entry.js'), 'export {version} from "./plain.js";');
    writeFileSync(join(root, 'plain.js'), 'export const version = "unrelated";');
    await expect(
      build({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [
          plugin({ dependencies: ['legacy'], offline: true, strict: true }),
          {
            name: 'change-preparation-revision',
            async transform(_code, id) {
              if (id !== join(root, 'entry.js')) return;
              await withProjectPreparation(getProjectPreparation(root), async (changed) =>
                changed(),
              );
            },
          },
        ],
        build: { write: false, lib: { entry: 'entry.js', formats: ['es'] } },
      }),
    ).rejects.toThrow('Dependencies changed during compilation');
  });

  it.each([false, true])(
    'refreshes production watch rules and cached imports (strict=%s)',
    async (strict) => {
      const root = fixture('2.7.16');
      const legacy = join(root, 'legacy');
      const linked = join(root, 'node_modules/legacy');
      renameSync(linked, legacy);
      symlinkSync(legacy, linked, 'junction');
      const peer = (range: string) =>
        writeFileSync(
          join(legacy, 'package.json'),
          JSON.stringify({
            name: 'legacy',
            type: 'module',
            version: '1.0.0',
            main: 'index.js',
            peerDependencies: { vue: range },
          }),
        );
      peer('^3');
      const output = join(root, 'dist/runtime.cjs');
      const watcher = await build({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [plugin({ dependencies: ['legacy'], offline: true, strict })],
        build: {
          lib: { entry: join(root, 'entry.js'), formats: ['cjs'], fileName: () => 'runtime.cjs' },
          watch: { chokidar: { usePolling: true, interval: 30 }, buildDelay: 20 },
        },
      });
      const require = createRequire(import.meta.url);
      if (!('on' in watcher)) throw new Error('Expected a Vite watcher');
      let edit: ReturnType<typeof setTimeout> | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const results = await new Promise<string[]>((resolve, reject) => {
          const versions: string[] = [];
          timeout = setTimeout(
            () => reject(new Error(`Watch produced ${versions.join(', ')}`)),
            3500,
          );
          watcher.on('event', (event) => {
            if (event.code === 'ERROR') return reject(event.error);
            if (event.code !== 'END') return undefined;
            delete require.cache[output];
            versions.push(require(output).version);
            if (versions.length === 3) resolve(versions);
            else edit = setTimeout(() => peer(versions.length === 1 ? '^2' : '^3'), 100);
            return undefined;
          });
        });
        expect(results).toEqual(['3.0.0', '2.7.16', '3.0.0']);
      } finally {
        clearTimeout(timeout);
        clearTimeout(edit);
        await watcher.close();
      }
    },
    6000,
  );

  it.each(['shared environments', 'custom callback'] as const)(
    'refreshes cached watch resolutions with %s',
    async (mode) => {
      const root = fixture('2.7.16');
      const legacy = join(root, 'legacy');
      const linked = join(root, 'node_modules/legacy');
      renameSync(linked, legacy);
      symlinkSync(legacy, linked, 'junction');
      const manifest = join(legacy, 'package.json');
      const writeManifest = (vue: string, target?: string) =>
        writeFileSync(
          manifest,
          JSON.stringify({
            name: 'legacy',
            type: 'module',
            version: '1.0.0',
            main: 'index.js',
            peerDependencies: { vue },
            target,
          }),
        );
      writeManifest('^3');
      writeFileSync(join(legacy, 'first.js'), 'export const version = "first";');
      writeFileSync(join(legacy, 'second.js'), 'export const version = "second";');
      let target = './first.js';
      const hooks: PluginHooks | undefined =
        mode === 'custom callback'
          ? {
              onAnalysisComplete() {
                target =
                  (JSON.parse(readFileSync(manifest, 'utf8')) as { target?: string }).target ??
                  './first.js';
              },
              beforeResolve(request, importer) {
                if (request === 'vue' && importer?.startsWith(legacy)) return target;
                return undefined;
              },
            }
          : undefined;
      const environmentBuild = (name: string, buildDelay: number) => ({
        outDir: join(root, name),
        lib: {
          entry: join(root, 'entry.js'),
          formats: ['cjs' as const],
          fileName: () => 'runtime.cjs',
        },
        watch: { buildDelay, chokidar: { usePolling: true, interval: 30 } },
      });
      const builder = await createBuilder({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [plugin({ dependencies: ['legacy'], offline: true, strict: true, hooks })],
        builder: { sharedConfigBuild: true, sharedPlugins: true },
        build: environmentBuild('unused', 20),
        environments: {
          left: { consumer: 'client', build: environmentBuild('left', 20) },
          right: { consumer: 'client', build: environmentBuild('right', 230) },
        },
      });
      const names = mode === 'shared environments' ? ['left', 'right'] : ['left'];
      const versions = names.map(() => [] as string[]);
      const watchers: Array<Extract<Awaited<ReturnType<typeof build>>, { close: unknown }>> = [];
      const require = createRequire(import.meta.url);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let edit: ReturnType<typeof setTimeout> | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Incomplete watch rebuilds: ' + JSON.stringify(versions))),
            4000,
          );
          void Promise.all(
            names.map(async (name, index) => {
              const watcher = await builder.build(builder.environments[name]!);
              if (!('on' in watcher)) throw new Error('Expected a Vite watcher');
              watchers.push(watcher);
              watcher.on('event', (event) => {
                if (event.code === 'ERROR') return reject(event.error);
                if (event.code !== 'END') return undefined;
                const output = join(root, name, 'runtime.cjs');
                delete require.cache[output];
                const values = versions[index]!;
                values.push((require(output) as { version: string }).version);
                if (!edit && versions.every((entry) => entry.length > 0)) {
                  edit = setTimeout(() => {
                    if (mode === 'shared environments') writeManifest('^2');
                    else writeManifest('^3', './second.js');
                  }, 100);
                }
                if (versions.every((entry) => entry.length > 1)) resolve();
                return undefined;
              });
            }),
          ).catch(reject);
        });
        const expected = mode === 'shared environments' ? ['3.0.0', '2.7.16'] : ['first', 'second'];
        for (const actual of versions) expect(actual).toEqual(expected);
      } finally {
        clearTimeout(edit);
        clearTimeout(timeout);
        await Promise.all(watchers.map((watcher) => watcher.close()));
      }
    },
    6000,
  );
  it('resolves hook-relative replacements from the importer in builds and pre-bundles', async () => {
    const root = fixture('2.7.16');
    const legacy = join(root, 'node_modules/legacy');
    writeFileSync(join(legacy, 'shim.js'), 'export const version = "from-importer";');
    writeFileSync(join(root, 'shim.js'), 'export const version = "from-host";');
    const options = {
      root,
      configFile: false as const,
      logLevel: 'silent' as const,
      plugins: [
        plugin({
          dependencies: ['legacy'],
          offline: true,
          strict: true,
          hooks: {
            beforeResolve: (request, importer) =>
              request === 'vue' && importer?.startsWith(legacy) ? './shim.js' : undefined,
          },
        }),
      ],
    };
    await build({
      ...options,
      build: {
        lib: { entry: join(root, 'entry.js'), formats: ['cjs'], fileName: () => 'runtime.cjs' },
      },
    });
    expect(createRequire(import.meta.url)(join(root, 'dist/runtime.cjs')).version).toBe(
      'from-importer',
    );

    const config = await resolveConfig(
      { ...options, optimizeDeps: { include: ['legacy'], noDiscovery: true } },
      'serve',
    );
    const metadata = await optimizeDeps(config, true);
    const optimized = await import(
      /* @vite-ignore */ pathToFileURL(metadata.optimized.legacy!.file).href
    );
    expect(optimized.version).toBe('from-importer');
  });
  it('honors the host log level during plugin preparation', async () => {
    const root = fixture('2.7.16');
    const logs = (['log', 'info', 'warn', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    await resolveConfig(
      {
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [
          plugin({
            dependencies: ['legacy'],
            offline: true,
            debug: true,
            hooks: { beforeResolve: redirectToHostVue },
          }),
        ],
      },
      'serve',
    );
    const messages = logs.flatMap(({ mock }) => mock.calls.map(([message]) => String(message)));
    expect(messages.filter((message) => message.includes('deps-conflict-resolver'))).toEqual([]);
  });

  it('reports preparation and pre-bundle cache hints through the host logger', async () => {
    const root = fixture('2.7.16');
    const hostLogger = createLogger('silent');
    const messages = vi.spyOn(hostLogger, 'info');
    await resolveConfig(
      {
        root,
        configFile: false,
        customLogger: hostLogger,
        plugins: [
          plugin({
            dependencies: ['legacy'],
            offline: true,
            hooks: { beforeResolve: redirectToHostVue },
          }),
        ],
      },
      'serve',
    );
    expect(messages).toHaveBeenCalledWith(expect.stringContaining('Starting dependency analysis'));
    expect(messages).toHaveBeenCalledWith(expect.stringContaining('beforeResolveCacheKey'));
  });

  it.each(['silent', 'warn'] as const)(
    'reports runtime ambiguity through the Vite logger at %s',
    async (logLevel) => {
      const root = fixture('2.7.16', { older: '1.0.0', vue26: 'npm:vue@2.6.14' });
      writeModule(
        root,
        'older',
        { name: 'older', version: '1.0.0', peerDependencies: { vue: '2.6.14' } },
        'export { version } from "vue";',
      );
      writeModule(
        root,
        'vue26',
        { name: 'vue', version: '2.6.14' },
        'export const version = "2.6.14";',
      );
      // This consumer is outside dependency analysis. Its two importers learn
      // about the tie between both aliases only during module resolution.
      const consumer = writeModule(
        root,
        'consumer',
        { name: 'consumer', version: '1.0.0' },
        'export { version } from "vue"; export { otherVersion } from "./other.js";',
      );
      writeFileSync(join(consumer, 'other.js'), 'export { version as otherVersion } from "vue";');
      const entry = join(root, 'entry.js');
      writeFileSync(entry, 'export { version, otherVersion } from "consumer";');
      const hostLogger = createLogger('silent');
      const hostWarn = vi.spyOn(hostLogger, 'warn');
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await build({
        root,
        configFile: false,
        logLevel,
        customLogger: hostLogger,
        plugins: [
          plugin({
            dependencies: ['legacy', 'older'],
            offline: true,
            includeRedirects: { vue: ['consumer'] },
          }),
        ],
        build: {
          lib: { entry, formats: ['cjs'], fileName: () => 'runtime.cjs' },
          outDir: join(root, 'dist'),
        },
      });
      const ambiguity = 'Multiple aliases match the same importer for vue';
      expect(
        consoleWarn.mock.calls.flat().some((message) => String(message).includes(ambiguity)),
      ).toBe(false);
      expect(hostWarn.mock.calls.filter(([message]) => message.includes(ambiguity))).toHaveLength(
        logLevel === 'silent' ? 0 : 1,
      );
      expect(createRequire(import.meta.url)(join(root, 'dist/runtime.cjs'))).toMatchObject({
        version: '3.0.0',
        otherVersion: '3.0.0',
      });
    },
  );

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
