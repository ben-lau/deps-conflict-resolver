import { createApp, h, onUnmounted, version } from 'vue';
import {
  getModernElementPlusRuntimeVersion,
  installModernElementPlus,
  ModernElementButton,
  ModernElementInput,
} from 'modern-element-plus-widget-core';

export function mountModernElementPlusWidget(container, options = {}) {
  const childContainer = container.ownerDocument.createElement('div');
  container.appendChild(childContainer);
  let notified = false;

  function notifyUnmounted() {
    if (notified) return;
    notified = true;
    options.onUnmount?.();
  }

  const app = createApp({
    setup() {
      onUnmounted(notifyUnmounted);

      return () =>
        h('section', { 'data-testid': 'child-element-plus' }, [
          h('span', { 'data-testid': 'child-vue-version' }, version),
          h(
            'span',
            { 'data-testid': 'child-core-vue-version' },
            getModernElementPlusRuntimeVersion(),
          ),
          h(ModernElementButton, { type: 'primary' }, () => 'Element Plus child'),
          h(ModernElementInput, { modelValue: 'Element Plus child' }),
        ]);
    },
  });

  installModernElementPlus(app);
  app.mount(childContainer);

  return {
    unmount() {
      if (notified) return;
      app.unmount();
      container.innerHTML = '';
    },
  };
}
