import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { build as viteBuild } from 'vite';
import webpack from 'webpack';
import type { Compiler } from 'webpack';
import { depsConflictResolverVitePlugin } from '../../../src/plugins/vite';
import { DepsConflictResolverWebpackPlugin } from '../../../src/plugins/webpack';
import type { AnalysisResult } from '../../../src/types';
import type { Bundler, ScenarioResult, VueMajor } from './cross-vue-fixture';
import {
  linkDirectory,
  materializePackageTree,
  materializeVue3RuntimeDependencies,
  resolveInstalledPackage,
} from './real-element-packages';

export type RealElementUi = 'element-ui' | 'element-plus';

export interface RealElementScenario {
  bundler: Bundler;
  hostMajor: VueMajor;
  widgetMajor: VueMajor;
  hostUi: RealElementUi;
  widgetUi: RealElementUi;
  hostFixture: 'element-plus-vue3-host.mjs' | 'element-ui-vue2-host.mjs';
  widgetPackage: 'legacy-element-ui-widget' | 'modern-element-plus-widget';
  widgetCorePackage: 'legacy-element-ui-widget-core' | 'modern-element-plus-widget-core';
  aliasName: 'aliased-vue2' | 'aliased-vue3';
}

export async function runRealElementScenario(
  scenario: RealElementScenario,
  registryUrl: string,
): Promise<ScenarioResult> {
  const packageRequire = createRequire(import.meta.url);
  const vue3 = readVuePackage(packageRequire, 'vue');
  const vue2 = readVuePackage(packageRequire, 'vue2');
  const hostVue = scenario.hostMajor === 3 ? vue3 : vue2;
  const childVue = scenario.widgetMajor === 3 ? vue3 : vue2;
  const hostUi = resolveInstalledPackage(scenario.hostUi);
  const childUi = resolveInstalledPackage(scenario.widgetUi);
  const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
  const projectRoot = await mkdtemp(join(tmpdir(), 'deps-conflict-resolver-real-element-'));
  const nodeModules = join(projectRoot, 'node_modules');
  const outDir = join(projectRoot, 'dist');
  let dom: JSDOM | undefined;
  let keepProject = false;

  try {
    await mkdir(nodeModules, { recursive: true });
    await writeFile(
      join(projectRoot, 'package.json'),
      JSON.stringify(
        {
          name: 'real-element-cross-vue-scenario',
          version: '1.0.0',
          private: true,
          type: 'module',
          dependencies: {
            vue: `^${hostVue.version}`,
            [scenario.aliasName]: `npm:vue@${childVue.version}`,
            [scenario.hostUi]: `^${hostUi.version}`,
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
      join(fixtureRoot, 'packages', scenario.widgetCorePackage),
      join(nodeModules, scenario.widgetCorePackage),
      { recursive: true },
    );

    const hostEntry = join(projectRoot, 'hosts', 'entry.mjs');
    await mkdir(dirname(hostEntry), { recursive: true });
    await cp(join(fixtureRoot, 'hosts', scenario.hostFixture), hostEntry);

    await linkDirectory(hostVue.path, join(nodeModules, 'vue'));
    await linkDirectory(childVue.path, join(nodeModules, scenario.aliasName));
    await materializePackageTree(scenario.hostUi, hostUi, nodeModules, {
      stripNestedNodeModules: true,
    });
    await materializePackageTree(
      scenario.widgetUi,
      childUi,
      join(nodeModules, scenario.widgetCorePackage, 'node_modules'),
      { stripNestedNodeModules: true },
    );
    await materializeVue3RuntimeDependencies(vue3.path, nodeModules);

    let analysisResult: AnalysisResult | undefined;
    const resolverOptions = {
      dependencies: [scenario.widgetPackage],
      projectRoot,
      autoInstall: false as const,
      packageManager: 'pnpm' as const,
      registry: registryUrl,
      hooks: {
        onAnalysisComplete: (result: AnalysisResult) => {
          analysisResult = result;
        },
      },
    };

    const bundle = await buildScenarioBundle(
      scenario.bundler,
      projectRoot,
      hostEntry,
      outDir,
      resolverOptions,
    );

    if (!analysisResult) {
      throw new Error(`${scenario.bundler} dependency analysis did not produce a result`);
    }

    const runtimeErrors: string[] = [];
    dom = new JSDOM('<!doctype html><html><body></body></html>', {
      runScripts: 'outside-only',
      pretendToBeVisual: true,
      url: 'http://real-element-cross-vue.test/',
    });
    const { window } = dom;
    Object.defineProperty(window, 'process', {
      value: { env: { NODE_ENV: 'production' } },
      configurable: true,
    });
    installBrowserShims(window);
    window.console.error = (...messages: unknown[]) => {
      runtimeErrors.push(messages.map(describeError).join(' '));
    };
    window.addEventListener('error', (event) => {
      runtimeErrors.push(describeError(event.error ?? event.message));
    });
    window.addEventListener('unhandledrejection', (event) => {
      runtimeErrors.push(`Unhandled rejection: ${describeError(event.reason)}`);
    });
    dom.virtualConsole.on('jsdomError', (error) => {
      runtimeErrors.push(describeError(error));
    });
    dom.virtualConsole.on('error', (...messages) => {
      runtimeErrors.push(messages.map(describeError).join(' '));
    });

    try {
      window.eval(bundle);
    } catch (error) {
      throw new Error(`Real Element cross-Vue bundle evaluation failed: ${describeError(error)}`, {
        cause: error,
      });
    }

    await waitForReady(window, runtimeErrors);
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
            throw new Error(`Real Element cross-Vue runtime errors: ${runtimeErrors.join('; ')}`);
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

async function buildScenarioBundle(
  bundler: Bundler,
  projectRoot: string,
  hostEntry: string,
  outDir: string,
  resolverOptions: {
    dependencies: string[];
    projectRoot: string;
    autoInstall: false;
    packageManager: 'pnpm';
    registry: string;
    hooks: { onAnalysisComplete(result: AnalysisResult): void };
  },
): Promise<string> {
  if (bundler === 'vite') {
    await viteBuild({
      root: projectRoot,
      configFile: false,
      plugins: [depsConflictResolverVitePlugin(resolverOptions)],
      build: {
        outDir,
        emptyOutDir: true,
        lib: {
          entry: hostEntry,
          formats: ['iife'],
          name: 'RealElementCrossVueHost',
          fileName: 'real-element-cross-vue',
        },
        rollupOptions: { external: [] },
        minify: false,
      },
    });

    const bundleFile = (await readdir(outDir)).find((file) => file.endsWith('.js'));
    if (!bundleFile) {
      throw new Error('Vite did not emit a real Element JavaScript bundle');
    }
    return readFile(join(outDir, bundleFile), 'utf8');
  }

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
      filename: 'real-element-cross-vue.js',
      iife: true,
      globalObject: 'globalThis',
    },
    optimization: { minimize: false },
    plugins: [new DepsConflictResolverWebpackPlugin(resolverOptions)],
  });

  await runAndCloseWebpackCompiler(compiler);
  return readFile(join(outDir, 'real-element-cross-vue.js'), 'utf8');
}

function readVuePackage(
  packageRequire: NodeRequire,
  packageName: 'vue' | 'vue2',
): { path: string; version: string } {
  const packageJsonPath = packageRequire.resolve(`${packageName}/package.json`);
  return {
    path: dirname(packageJsonPath),
    version: readPackageVersion(packageJsonPath),
  };
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

function installBrowserShims(window: ScenarioResult['window']): void {
  if (typeof window.matchMedia !== 'function') {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (media: string) => ({
        matches: false,
        media,
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() {
          return false;
        },
      }),
    });
  }

  if (typeof window.HTMLElement.prototype.scrollIntoView !== 'function') {
    window.HTMLElement.prototype.scrollIntoView = () => undefined;
  }
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
        reject(new Error('Webpack did not return real Element compilation stats'));
        return;
      }
      if (stats.hasErrors()) {
        reject(
          new Error(
            `Webpack real Element build failed:\n${stats.toString({ all: false, errors: true, warnings: true })}`,
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

async function waitForReady(
  window: ScenarioResult['window'],
  runtimeErrors: string[],
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!window.__crossVueReady) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Real Element cross-Vue bundle did not become ready within 5 seconds. Runtime errors: ${runtimeErrors.join('; ') || 'none'}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
