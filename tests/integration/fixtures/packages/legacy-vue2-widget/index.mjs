import Vue from 'vue';
import { getLegacyRuntimeVersion } from 'legacy-vue2-widget-core';

const LegacyWidget = {
  props: {
    externalValue: { type: Number, default: 0 },
    onChange: { type: Function, default: null },
    onUnmount: { type: Function, default: null },
  },
  data() {
    return {
      count: 0,
      latestExternalValue: this.externalValue,
    };
  },
  computed: {
    summary() {
      return 'child=' + this.count + ' external=' + this.latestExternalValue;
    },
  },
  watch: {
    externalValue(value) {
      this.latestExternalValue = value;
    },
  },
  methods: {
    increment() {
      const nextCount = this.count + 1;
      this.count = nextCount;
      if (this.onChange) this.onChange(nextCount);
    },
  },
  destroyed() {
    if (this.onUnmount) this.onUnmount();
  },
  render(h) {
    return h('div', [
      h('span', { attrs: { 'data-testid': 'child-runtime-version' } }, [Vue.version]),
      h('span', { attrs: { 'data-testid': 'child-core-runtime-version' } }, [
        getLegacyRuntimeVersion(),
      ]),
      h('span', { attrs: { 'data-testid': 'child-count' } }, [String(this.count)]),
      h('span', { attrs: { 'data-testid': 'child-external' } }, [String(this.latestExternalValue)]),
      h('button', { attrs: { 'data-testid': 'child-increment' }, on: { click: this.increment } }, [
        'Increment child',
      ]),
      h('span', { attrs: { 'data-testid': 'child-summary' } }, [this.summary]),
    ]);
  },
};

export function mountLegacyWidget(container, options = {}) {
  const childContainer = container.ownerDocument.createElement('div');
  container.appendChild(childContainer);

  const bridgeRoot = new Vue({
    data() {
      return {
        externalValue: options.externalValue ?? 0,
      };
    },
    render(h) {
      return h(LegacyWidget, {
        props: {
          externalValue: this.externalValue,
          onChange: options.onChange,
          onUnmount: options.onUnmount,
        },
      });
    },
  });

  bridgeRoot.$mount(childContainer);

  return {
    setExternalValue(value) {
      bridgeRoot.externalValue = value;
    },
    unmount() {
      bridgeRoot.$destroy();
      container.innerHTML = '';
    },
  };
}
