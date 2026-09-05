import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { version as installedVue3Version } from 'vue';
import {
  createLocalVueRegistry,
  runCrossVueScenario,
  type ScenarioResult,
} from './support/cross-vue-fixture';

interface ModernRuntimeVersionProbe {
  getModernRuntimeVersion(runtime?: { version: string }): string;
}

function text(result: ScenarioResult, testId: string): string {
  return result.dom.querySelector('[data-testid="' + testId + '"]')?.textContent ?? '';
}

function click(result: ScenarioResult, testId: string): void {
  const element = result.dom.querySelector('[data-testid="' + testId + '"]');
  if (!element) throw new Error('Missing test element: ' + testId);
  element.dispatchEvent(new result.window.MouseEvent('click', { bubbles: true, cancelable: true }));
}

async function flushVueUpdates(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

it('reports the Vue 3 runtime identity from the core bare import', async () => {
  const coreUrl = new URL('./fixtures/packages/modern-vue3-widget-core/index.mjs', import.meta.url);
  const core = (await import(coreUrl.href)) as ModernRuntimeVersionProbe;

  expect(core.getModernRuntimeVersion({ version: 'parent-supplied' })).toBe(installedVue3Version);
});

async function assertCrossVueInteraction(
  result: ScenarioResult,
  hostMajor: 2 | 3,
  childMajor: 2 | 3,
) {
  expect(result.runtimeErrors).toEqual([]);
  expect(text(result, 'host-vue-version')).toMatch(new RegExp('^' + hostMajor + '\\.'));
  expect(text(result, 'child-runtime-version')).toMatch(new RegExp('^' + childMajor + '\\.'));
  expect(text(result, 'child-core-runtime-version')).toMatch(new RegExp('^' + childMajor + '\\.'));
  expect(text(result, 'host-count')).toBe('0');
  expect(text(result, 'child-count')).toBe('0');
  expect(text(result, 'child-external')).toBe('0');

  click(result, 'host-increment');
  await flushVueUpdates();
  expect(text(result, 'host-count')).toBe('1');
  expect(text(result, 'child-count')).toBe('0');
  expect(text(result, 'child-external')).toBe('1');

  click(result, 'child-increment');
  await flushVueUpdates();
  expect(text(result, 'host-count')).toBe('1');
  expect(text(result, 'child-count')).toBe('1');
  expect(text(result, 'last-child-event')).toBe('1');
  expect(text(result, 'child-summary')).toContain('child=1');
  expect(text(result, 'child-summary')).toContain('external=1');

  const testApi = result.window.__crossVueTest;
  if (!testApi) throw new Error('Missing cross-Vue test API');
  testApi.unmount();
  await flushVueUpdates();
  expect(text(result, 'child-slot')).toBe('');
  expect(testApi.childUnmounted).toBe(true);
}

describe.sequential('cross-vue embedding', () => {
  let registry: Awaited<ReturnType<typeof createLocalVueRegistry>>;

  beforeAll(async () => {
    registry = await createLocalVueRegistry();
  });

  afterAll(async () => {
    await registry.close();
  });

  it('Vue 3 host embeds Vue 2 widget with Vite', async () => {
    const result = await runCrossVueScenario(
      {
        bundler: 'vite',
        hostMajor: 3,
        widgetMajor: 2,
        widgetPackage: 'legacy-vue2-widget',
        aliasName: 'aliased-vue2',
      },
      registry.url,
    );

    try {
      expect(result.analysisResult.aliasMappings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            originalName: 'vue',
            aliasName: 'aliased-vue2',
            installSpec: '',
            allDependents: expect.arrayContaining([
              'legacy-vue2-widget',
              'legacy-vue2-widget-core',
            ]),
          }),
        ]),
      );
      await assertCrossVueInteraction(result, 3, 2);
    } finally {
      await result.dispose();
    }
  });

  it('Vue 2 host embeds Vue 3 widget with Vite', async () => {
    const result = await runCrossVueScenario(
      {
        bundler: 'vite',
        hostMajor: 2,
        widgetMajor: 3,
        widgetPackage: 'modern-vue3-widget',
        aliasName: 'aliased-vue3',
      },
      registry.url,
    );

    try {
      expect(result.analysisResult.aliasMappings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            originalName: 'vue',
            aliasName: 'aliased-vue3',
            installSpec: '',
            allDependents: expect.arrayContaining([
              'modern-vue3-widget',
              'modern-vue3-widget-core',
            ]),
          }),
        ]),
      );
      await assertCrossVueInteraction(result, 2, 3);
    } finally {
      await result.dispose();
    }
  });

  it('Vue 3 host embeds Vue 2 widget with Webpack', async () => {
    const result = await runCrossVueScenario(
      {
        bundler: 'webpack',
        hostMajor: 3,
        widgetMajor: 2,
        widgetPackage: 'legacy-vue2-widget',
        aliasName: 'aliased-vue2',
      },
      registry.url,
    );

    try {
      expect(result.analysisResult.aliasMappings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            originalName: 'vue',
            aliasName: 'aliased-vue2',
            installSpec: '',
            allDependents: expect.arrayContaining([
              'legacy-vue2-widget',
              'legacy-vue2-widget-core',
            ]),
          }),
        ]),
      );
      await assertCrossVueInteraction(result, 3, 2);
    } finally {
      await result.dispose();
    }
  });

  it('Vue 2 host embeds Vue 3 widget with Webpack', async () => {
    const result = await runCrossVueScenario(
      {
        bundler: 'webpack',
        hostMajor: 2,
        widgetMajor: 3,
        widgetPackage: 'modern-vue3-widget',
        aliasName: 'aliased-vue3',
      },
      registry.url,
    );

    try {
      expect(result.analysisResult.aliasMappings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            originalName: 'vue',
            aliasName: 'aliased-vue3',
            installSpec: '',
            allDependents: expect.arrayContaining([
              'modern-vue3-widget',
              'modern-vue3-widget-core',
            ]),
          }),
        ]),
      );
      await assertCrossVueInteraction(result, 2, 3);
    } finally {
      await result.dispose();
    }
  });

  it('reports late console errors from memoized disposal', async () => {
    const result = await runCrossVueScenario(
      {
        bundler: 'vite',
        hostMajor: 3,
        widgetMajor: 2,
        widgetPackage: 'legacy-vue2-widget',
        aliasName: 'aliased-vue2',
      },
      registry.url,
    );

    try {
      result.window.console.error('late cross-vue runtime error');

      await expect(result.dispose()).rejects.toThrow('late cross-vue runtime error');
      await expect(result.dispose()).rejects.toThrow('late cross-vue runtime error');
    } finally {
      await result.dispose().catch(() => undefined);
    }
  });
});
