import Vue from 'vue';
import ElementUI from 'element-ui';
import { mountModernElementPlusWidget } from 'modern-element-plus-widget';

Vue.use(ElementUI);

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
      childWidget: null,
    };
  },
  mounted() {
    this.childWidget = mountModernElementPlusWidget(this.$refs.childSlot, {
      onUnmount: () => {
        testApi.childUnmounted = true;
      },
    });
  },
  beforeDestroy() {
    this.childWidget?.unmount();
  },
  render(h) {
    return h('main', [
      h('section', { attrs: { 'data-testid': 'host-element-ui' } }, [
        h('span', { attrs: { 'data-testid': 'host-vue-version' } }, [Vue.version]),
        h('el-button', { props: { type: 'primary' } }, ['Host Element UI']),
        h('el-input', { props: { value: 'Element UI host' } }),
      ]),
      h('div', { ref: 'childSlot', attrs: { 'data-testid': 'child-slot' } }),
    ]);
  },
});

host = new Host();
host.$mount(mountPoint);
window.__crossVueTest = testApi;
window.__crossVueReady = true;
