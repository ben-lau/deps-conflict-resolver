import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLocalVueRegistry } from './support/cross-vue-fixture';
import { runRealElementScenario, type RealElementScenario } from './support/real-element-fixture';

const REAL_ELEMENT_TEST_TIMEOUT = 60_000;

const vue3HostWithVue2ElementUiChild: RealElementScenario = {
  bundler: 'vite',
  hostMajor: 3,
  widgetMajor: 2,
  hostUi: 'element-plus',
  widgetUi: 'element-ui',
  hostFixture: 'element-plus-vue3-host.mjs',
  widgetPackage: 'legacy-element-ui-widget',
  widgetCorePackage: 'legacy-element-ui-widget-core',
  aliasName: 'aliased-vue2',
};

const vue2HostWithVue3ElementPlusChild: RealElementScenario = {
  bundler: 'vite',
  hostMajor: 2,
  widgetMajor: 3,
  hostUi: 'element-ui',
  widgetUi: 'element-plus',
  hostFixture: 'element-ui-vue2-host.mjs',
  widgetPackage: 'modern-element-plus-widget',
  widgetCorePackage: 'modern-element-plus-widget-core',
  aliasName: 'aliased-vue3',
};

const realElementScenarios: Array<{ name: string; scenario: RealElementScenario }> = [
  {
    name: 'Vite: Vue 2 Element UI inside a Vue 3 Element Plus host',
    scenario: vue3HostWithVue2ElementUiChild,
  },
  {
    name: 'Vite: Vue 3 Element Plus inside a Vue 2 Element UI host',
    scenario: vue2HostWithVue3ElementPlusChild,
  },
  {
    name: 'Webpack: Vue 2 Element UI inside a Vue 3 Element Plus host',
    scenario: { ...vue3HostWithVue2ElementUiChild, bundler: 'webpack' },
  },
  {
    name: 'Webpack: Vue 3 Element Plus inside a Vue 2 Element UI host',
    scenario: { ...vue2HostWithVue3ElementPlusChild, bundler: 'webpack' },
  },
];

function assertRealElementRendering(
  result: Awaited<ReturnType<typeof runRealElementScenario>>,
  scenario: RealElementScenario,
): void {
  expect(result.runtimeErrors).toEqual([]);
  const vueAlias = result.analysisResult.aliasMappings.find(
    (mapping) => mapping.originalName === 'vue',
  );
  expect(vueAlias).toEqual(
    expect.objectContaining({
      aliasName: scenario.aliasName,
      installSpec: '',
    }),
  );
  expect(vueAlias?.resolvedVersion).toMatch(new RegExp(`^${scenario.widgetMajor}\\.`));
  expect(vueAlias?.allDependents).toEqual(
    expect.arrayContaining([scenario.widgetPackage, scenario.widgetCorePackage, scenario.widgetUi]),
  );
  const hostMarker = result.dom.querySelector(`[data-testid="host-${scenario.hostUi}"]`);
  const childMarker = result.dom.querySelector(`[data-testid="child-${scenario.widgetUi}"]`);
  const hostLabel = scenario.hostUi === 'element-plus' ? 'Host Element Plus' : 'Host Element UI';

  expect(hostMarker).not.toBeNull();
  expect(hostMarker?.textContent).toContain(hostLabel);
  expect(
    result.dom.querySelector(`[data-testid="host-${scenario.hostUi}"] .el-button`),
  ).not.toBeNull();
  expect(
    result.dom.querySelector(`[data-testid="host-${scenario.hostUi}"] .el-input`),
  ).not.toBeNull();
  expect(childMarker).not.toBeNull();
  expect(
    result.dom.querySelector(`[data-testid="child-${scenario.widgetUi}"] .el-button`),
  ).not.toBeNull();
  expect(
    result.dom.querySelector(`[data-testid="child-${scenario.widgetUi}"] .el-input`),
  ).not.toBeNull();
  expect(result.dom.querySelector('[data-testid="child-vue-version"]')?.textContent).toMatch(
    new RegExp(`^${scenario.widgetMajor}\\.`),
  );
  expect(result.dom.querySelector('[data-testid="child-core-vue-version"]')?.textContent).toMatch(
    new RegExp(`^${scenario.widgetMajor}\\.`),
  );

  const testApi = result.window.__crossVueTest;
  expect(testApi).toBeDefined();
  testApi?.unmount();
  expect(testApi?.childUnmounted).toBe(true);
  expect(result.dom.querySelector(`[data-testid="host-${scenario.hostUi}"]`)).toBeNull();
  expect(result.dom.querySelector(`[data-testid="child-${scenario.widgetUi}"]`)).toBeNull();
}

describe.sequential('real Element UI cross-Vue embedding', () => {
  let registry: Awaited<ReturnType<typeof createLocalVueRegistry>>;

  beforeAll(async () => {
    registry = await createLocalVueRegistry();
  }, REAL_ELEMENT_TEST_TIMEOUT);

  afterAll(async () => {
    await registry.close();
  });

  for (const { name, scenario } of realElementScenarios) {
    it(
      name,
      async () => {
        const result = await runRealElementScenario(scenario, registry.url);

        try {
          assertRealElementRendering(result, scenario);
        } finally {
          await result.dispose();
        }
      },
      REAL_ELEMENT_TEST_TIMEOUT,
    );
  }
});
