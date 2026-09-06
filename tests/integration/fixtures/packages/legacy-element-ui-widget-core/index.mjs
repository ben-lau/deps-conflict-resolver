import Vue from 'vue';
import ElementUI from 'element-ui';

Vue.use(ElementUI);

export const LegacyElementButton = ElementUI.Button;
export const LegacyElementInput = ElementUI.Input;

export function getLegacyElementUiRuntimeVersion() {
  return Vue.version;
}
