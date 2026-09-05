import { createApp, h, onBeforeUnmount, onMounted, ref, version, watch } from 'vue';
import { mountLegacyWidget } from 'legacy-vue2-widget';

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
    const count = ref(0);
    const childSlot = ref(null);
    const lastChildEvent = ref('');
    let childWidget;

    onMounted(() => {
      childWidget = mountLegacyWidget(childSlot.value, {
        externalValue: count.value,
        onChange: (value) => {
          lastChildEvent.value = value;
        },
        onUnmount: () => {
          testApi.childUnmounted = true;
        },
      });
    });

    watch(count, (value) => {
      if (childWidget) childWidget.setExternalValue(value);
    });

    onBeforeUnmount(() => {
      if (childWidget) childWidget.unmount();
    });

    return () =>
      h('div', [
        h('span', { 'data-testid': 'host-vue-version' }, version),
        h('span', { 'data-testid': 'host-count' }, String(count.value)),
        h(
          'button',
          { 'data-testid': 'host-increment', onClick: () => (count.value += 1) },
          'Increment host',
        ),
        h('div', { ref: childSlot, 'data-testid': 'child-slot' }),
        h('span', { 'data-testid': 'last-child-event' }, String(lastChildEvent.value)),
        h('button', { 'data-testid': 'host-unmount', onClick: unmountHost }, 'Unmount host'),
      ]);
  },
};

app = createApp(Host);
app.mount(hostContainer);
window.__crossVueTest = testApi;
window.__crossVueReady = true;
