import Vue from 'vue';
import { mountModernWidget } from 'modern-vue3-widget';

const hostContainer = document.createElement('div');
const mountPoint = document.createElement('div');
hostContainer.appendChild(mountPoint);
document.body.appendChild(hostContainer);

let host;

const testApi = {
  childUnmounted: false,
  unmount: unmountHost,
};

function unmountHost() {
  host.$destroy();
  hostContainer.innerHTML = '';
}

const Host = Vue.extend({
  data() {
    return {
      count: 0,
      childWidget: null,
      lastChildEvent: '',
    };
  },
  computed: {
    hostVueVersion() {
      return Vue.version;
    },
  },
  watch: {
    count(value) {
      if (this.childWidget) this.childWidget.setExternalValue(value);
    },
  },
  mounted() {
    this.childWidget = mountModernWidget(this.$refs.childSlot, {
      externalValue: this.count,
      onChange: (value) => {
        this.lastChildEvent = value;
      },
      onUnmount: () => {
        testApi.childUnmounted = true;
      },
    });
  },
  beforeDestroy() {
    if (this.childWidget) this.childWidget.unmount();
  },
  methods: {
    increment() {
      this.count += 1;
    },
  },
  render(h) {
    return h('div', [
      h('span', { attrs: { 'data-testid': 'host-vue-version' } }, [this.hostVueVersion]),
      h('span', { attrs: { 'data-testid': 'host-count' } }, [String(this.count)]),
      h('button', { attrs: { 'data-testid': 'host-increment' }, on: { click: this.increment } }, [
        'Increment host',
      ]),
      h('div', { ref: 'childSlot', attrs: { 'data-testid': 'child-slot' } }),
      h('span', { attrs: { 'data-testid': 'last-child-event' } }, [String(this.lastChildEvent)]),
      h('button', { attrs: { 'data-testid': 'host-unmount' }, on: { click: unmountHost } }, [
        'Unmount host',
      ]),
    ]);
  },
});

host = new Host();
host.$mount(mountPoint);
window.__crossVueTest = testApi;
window.__crossVueReady = true;
