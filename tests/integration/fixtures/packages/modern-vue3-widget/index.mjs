import { createApp, computed, h, onUnmounted, ref, version, watch } from 'vue';
import { createModernRuntimeProbe, getModernRuntimeVersion } from 'modern-vue3-widget-core';

const ModernWidget = {
  props: {
    externalValue: { type: Number, default: 0 },
    onChange: { type: Function, default: null },
    onUnmount: { type: Function, default: null },
  },
  setup(props) {
    const count = ref(0);
    const latestExternalValue = ref(props.externalValue);
    const coreProbe = createModernRuntimeProbe();
    const summary = computed(
      () =>
        coreProbe.summary.value +
        ' child=' +
        count.value +
        ' external=' +
        latestExternalValue.value,
    );

    watch(
      () => props.externalValue,
      (value) => {
        latestExternalValue.value = value;
      },
    );

    function increment() {
      const nextCount = count.value + 1;
      count.value = nextCount;
      if (props.onChange) props.onChange(nextCount);
    }

    onUnmounted(() => {
      if (props.onUnmount) props.onUnmount();
    });

    return () =>
      h('div', [
        h('span', { 'data-testid': 'child-runtime-version' }, version),
        h('span', { 'data-testid': 'child-core-runtime-version' }, getModernRuntimeVersion()),
        h('span', { 'data-testid': 'child-count' }, String(count.value)),
        h('span', { 'data-testid': 'child-external' }, String(latestExternalValue.value)),
        h('button', { 'data-testid': 'child-increment', onClick: increment }, 'Increment child'),
        h('span', { 'data-testid': 'child-summary' }, summary.value),
      ]);
  },
};

export function mountModernWidget(container, options = {}) {
  const externalValue = ref(options.externalValue ?? 0);
  const childContainer = container.ownerDocument.createElement('div');
  container.appendChild(childContainer);
  const app = createApp({
    setup() {
      return () =>
        h(ModernWidget, {
          externalValue: externalValue.value,
          onChange: options.onChange,
          onUnmount: options.onUnmount,
        });
    },
  });

  app.mount(childContainer);

  return {
    setExternalValue(value) {
      externalValue.value = value;
    },
    unmount() {
      app.unmount();
      container.innerHTML = '';
    },
  };
}
