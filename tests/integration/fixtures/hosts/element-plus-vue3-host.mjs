import { createApp, h, onBeforeUnmount, onMounted, ref, version } from 'vue';
import ElementPlus, { ElButton, ElInput } from 'element-plus';
import { mountLegacyElementUiWidget } from 'legacy-element-ui-widget';

const hostContainer = document.createElement('div');
document.body.appendChild(hostContainer);

let app;
const testApi = {
  childUnmounted: false,
  unmount: unmountHost,
};

function unmountHost() {
  app.unmount();
  hostContainer.innerHTML = '';
}

const Host = {
  setup() {
    const childSlot = ref(null);
    let childWidget;

    onMounted(() => {
      childWidget = mountLegacyElementUiWidget(childSlot.value, {
        onUnmount: () => {
          testApi.childUnmounted = true;
        },
      });
    });

    onBeforeUnmount(() => {
      childWidget?.unmount();
    });

    return () =>
      h('main', [
        h('section', { 'data-testid': 'host-element-plus' }, [
          h('span', { 'data-testid': 'host-vue-version' }, version),
          h(ElButton, { type: 'primary' }, () => 'Host Element Plus'),
          h(ElInput, { modelValue: 'Element Plus host' }),
        ]),
        h('div', { ref: childSlot, 'data-testid': 'child-slot' }),
      ]);
  },
};

app = createApp(Host);
app.use(ElementPlus);
app.mount(hostContainer);
window.__crossVueTest = testApi;
window.__crossVueReady = true;
