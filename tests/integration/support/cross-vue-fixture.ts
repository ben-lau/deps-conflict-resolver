import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { build as viteBuild } from 'vite';
import webpack from 'webpack';
import type { Compiler } from 'webpack';
import { depsConflictResolverVitePlugin } from '../../../src/plugins/vite';
import { DepsConflictResolverWebpackPlugin } from '../../../src/plugins/webpack';
import type { AnalysisResult } from '../../../src/types';

export type Bundler = 'vite' | 'webpack';
export type VueMajor = 2 | 3;

export interface CrossVueScenario {
  bundler: Bundler;
  hostMajor: VueMajor;
  widgetMajor: VueMajor;
  widgetPackage: 'legacy-vue2-widget' | 'modern-vue3-widget';
  aliasName: 'aliased-vue2' | 'aliased-vue3';
}

export interface LocalRegistry {
  url: string;
  close(): Promise<void>;
}

export interface ScenarioResult {
  analysisResult: AnalysisResult;
  dom: JSDOM['window']['document'];
  window: JSDOM['window'] & {
    __crossVueReady?: boolean;
    __crossVueTest?: { childUnmounted: boolean; unmount(): void };
  };
  runtimeErrors: string[];
  dispose(): Promise<void>;
}

export async function createLocalVueRegistry(): Promise<LocalRegistry> {
  const require = createRequire(import.meta.url);
  const vue3Version = readPackageVersion(require.resolve('vue/package.json'));
  const vue2Version = readPackageVersion(require.resolve('vue2/package.json'));
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/vue') {
      response.statusCode = 404;
      response.end();
      return;
    }

    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        name: 'vue',
        versions: {
          [vue2Version]: {},
          [vue3Version]: {},
        },
        'dist-tags': { latest: vue3Version },
      }),
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    throw new Error('Local Vue registry did not expose a TCP address');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export async function runCrossVueScenario(
  scenario: CrossVueScenario,
  registryUrl: string,
): Promise<ScenarioResult> {
  const require = createRequire(import.meta.url);
  const vue3 = readVuePackage(require, 'vue');
  const vue2 = readVuePackage(require, 'vue2');
  const hostVue = scenario.hostMajor === 3 ? vue3 : vue2;
  const childVue = scenario.widgetMajor === 3 ? vue3 : vue2;
  const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
  const widgetCorePackage = `${scenario.widgetPackage}-core`;
  const hostFixture = join(
    fixtureRoot,
    'hosts',
    scenario.hostMajor === 3 ? 'vue3-host.mjs' : 'vue2-host.mjs',
  );
  const projectRoot = await mkdtemp(join(tmpdir(), 'deps-conflict-resolver-cross-vue-'));
  const nodeModules = join(projectRoot, 'node_modules');
  const outDir = join(projectRoot, 'dist');
  let dom: JSDOM | undefined;
  let keepProject = false;

  try {
    await mkdir(nodeModules);
    await writeFile(
      join(projectRoot, 'package.json'),
      JSON.stringify(
        {
          name: 'cross-vue-scenario',
          version: '1.0.0',
          private: true,
          type: 'module',
          dependencies: {
            vue: `^${hostVue.version}`,
            [scenario.aliasName]: `npm:vue@${childVue.version}`,
            [scenario.widgetPackage]: '1.0.0',
          },
        },
        null,
        2,
      ),
    );
    await cp(
      join(fixtureRoot, 'packages', scenario.widgetPackage),
      join(nodeModules, scenario.widgetPackage),
      { recursive: true },
    );
    await cp(
      join(fixtureRoot, 'packages', widgetCorePackage),
      join(nodeModules, widgetCorePackage),
      { recursive: true },
    );
    const hostEntry = join(projectRoot, 'hosts', 'entry.mjs');
    await mkdir(dirname(hostEntry), { recursive: true });
    await cp(hostFixture, hostEntry);
    await linkDirectory(hostVue.path, join(nodeModules, 'vue'));
    await linkDirectory(childVue.path, join(nodeModules, scenario.aliasName));
    await materializeVue3RuntimeDependencies(vue3.path, nodeModules);

    let analysisResult: AnalysisResult | undefined;
    const options = {
      dependencies: [scenario.widgetPackage],
      projectRoot,
      autoInstall: false,
      packageManager: 'pnpm' as const,
      registry: registryUrl,
      hooks: {
        onAnalysisComplete: (result: AnalysisResult) => {
          analysisResult = result;
        },
      },
    };

    let bundle: string;
    if (scenario.bundler === 'vite') {
      await viteBuild({
        root: projectRoot,
        configFile: false,
        plugins: [depsConflictResolverVitePlugin(options)],
        build: {
          outDir,
          emptyOutDir: true,
          lib: {
            entry: hostEntry,
            formats: ['iife'],
            name: 'CrossVueHost',
            fileName: 'cross-vue-app',
          },
          rollupOptions: { external: [] },
          minify: false,
        },
      });

      const bundleFile = (await readdir(outDir)).find((file) => file.endsWith('.js'));
      if (!bundleFile) {
        throw new Error('Vite did not emit a JavaScript bundle');
      }
      bundle = await readFile(join(outDir, bundleFile), 'utf8');
    } else {
      const compiler = webpack({
        context: projectRoot,
        mode: 'production',
        target: 'web',
        entry: hostEntry,
        resolve: {
          extensions: ['.mjs', '.js'],
          symlinks: false,
        },
        output: {
          path: outDir,
          filename: 'cross-vue-app.js',
          iife: true,
          globalObject: 'globalThis',
        },
        optimization: { minimize: false },
        plugins: [new DepsConflictResolverWebpackPlugin(options)],
      });

      await runAndCloseWebpackCompiler(compiler);

      bundle = await readFile(join(outDir, 'cross-vue-app.js'), 'utf8');
    }

    if (!analysisResult) {
      throw new Error(`${scenario.bundler} dependency analysis did not produce a result`);
    }
    const runtimeErrors: string[] = [];
    dom = new JSDOM('<!doctype html><html><body></body></html>', {
      runScripts: 'outside-only',
      pretendToBeVisual: true,
      url: 'http://cross-vue.test/',
    });
    const { window } = dom;
    Object.defineProperty(window, 'process', {
      value: { env: { NODE_ENV: 'production' } },
      configurable: true,
    });
    window.addEventListener('error', (event) => {
      runtimeErrors.push(describeError(event.error ?? event.message));
    });
    dom.virtualConsole.on('jsdomError', (error) => runtimeErrors.push(describeError(error)));
    dom.virtualConsole.on('error', (...messages) => {
      runtimeErrors.push(messages.map(describeError).join(' '));
    });

    try {
      window.eval(bundle);
    } catch (error) {
      throw new Error(`Cross-Vue bundle evaluation failed: ${describeError(error)}`, {
        cause: error,
      });
    }

    await waitForCrossVueReady(window, runtimeErrors);

    let disposal: Promise<void> | undefined;
    keepProject = true;
    return {
      analysisResult,
      dom: window.document,
      window,
      runtimeErrors,
      dispose() {
        disposal ??= (async () => {
          window.close();
          await rm(projectRoot, { recursive: true, force: true });
          if (runtimeErrors.length > 0) {
            throw new Error(`Cross-Vue runtime errors: ${runtimeErrors.join('; ')}`);
          }
        })();
        return disposal;
      },
    };
  } finally {
    if (!keepProject) {
      dom?.window.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  }
}

function readVuePackage(require: NodeRequire, packageName: 'vue' | 'vue2') {
  const packageJsonPath = require.resolve(`${packageName}/package.json`);
  return {
    path: dirname(packageJsonPath),
    version: readPackageVersion(packageJsonPath),
  };
}

async function materializeVue3RuntimeDependencies(
  vue3Path: string,
  nodeModules: string,
): Promise<void> {
  const vue3Require = createRequire(join(vue3Path, 'package.json'));
  const runtimeDomPath = dirname(vue3Require.resolve('@vue/runtime-dom/package.json'));
  const runtimeDomRequire = createRequire(join(runtimeDomPath, 'package.json'));
  const runtimePackagePaths = [
    runtimeDomPath,
    dirname(runtimeDomRequire.resolve('@vue/runtime-core/package.json')),
    dirname(runtimeDomRequire.resolve('@vue/reactivity/package.json')),
    dirname(runtimeDomRequire.resolve('@vue/shared/package.json')),
  ];

  await mkdir(join(nodeModules, '@vue'));
  await Promise.all(
    runtimePackagePaths.map((packagePath) =>
      linkDirectory(packagePath, join(nodeModules, '@vue', basename(packagePath))),
    ),
  );
}

async function linkDirectory(target: string, path: string): Promise<void> {
  if (process.platform === 'win32') {
    await symlink(target, path, 'junction');
    return;
  }
  await symlink(target, path);
}

async function runAndCloseWebpackCompiler(compiler: Compiler): Promise<void> {
  try {
    await runWebpackCompiler(compiler);
  } catch (error) {
    await closeWebpackCompiler(compiler).catch(() => undefined);
    throw error;
  }
  await closeWebpackCompiler(compiler);
}

async function runWebpackCompiler(compiler: Compiler): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    compiler.run((error, stats) => {
      if (error) {
        reject(error);
        return;
      }
      if (!stats) {
        reject(new Error('Webpack did not return compilation stats'));
        return;
      }
      if (stats.hasErrors()) {
        reject(
          new Error(
            `Webpack build failed:\n${stats.toString({ all: false, errors: true, warnings: true })}`,
          ),
        );
        return;
      }
      resolve();
    });
  });
}

async function closeWebpackCompiler(compiler: Compiler): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    compiler.close((error) => (error ? reject(error) : resolve()));
  });
}

function readPackageVersion(packageJsonPath: string): string {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    version?: unknown;
  };
  if (typeof packageJson.version !== 'string') {
    throw new Error(`Package at ${packageJsonPath} does not declare a version`);
  }
  return packageJson.version;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForCrossVueReady(
  window: ScenarioResult['window'],
  runtimeErrors: string[],
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!window.__crossVueReady) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Cross-Vue bundle did not become ready within 5 seconds. Runtime errors: ${runtimeErrors.join('; ') || 'none'}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
