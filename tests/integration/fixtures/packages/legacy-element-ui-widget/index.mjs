import Vue from 'vue';
import {
  getLegacyElementUiRuntimeVersion,
  LegacyElementButton,
  LegacyElementInput,
} from 'legacy-element-ui-widget-core';

export function mountLegacyElementUiWidget(container, options = {}) {
  const childContainer = container.ownerDocument.createElement('div');
  container.appendChild(childContainer);
  let unmounted = false;

  const Widget = Vue.extend({
    destroyed() {
      if (!unmounted) {
        unmounted = true;
        options.onUnmount?.();
      }
    },
    render(h) {
      return h('section', { attrs: { 'data-testid': 'child-element-ui' } }, [
        h('span', { attrs: { 'data-testid': 'child-vue-version' } }, [Vue.version]),
        h('span', { attrs: { 'data-testid': 'child-core-vue-version' } }, [
          getLegacyElementUiRuntimeVersion(),
        ]),
        h(LegacyElementButton, { props: { type: 'primary' } }, ['Element UI child']),
        h(LegacyElementInput, { props: { value: 'Element UI child' } }),
      ]);
    },
  });

  const app = new Widget();
  app.$mount(childContainer);

  return {
    unmount() {
      if (unmounted) return;
      app.$destroy();
      container.innerHTML = '';
    },
  };
}
