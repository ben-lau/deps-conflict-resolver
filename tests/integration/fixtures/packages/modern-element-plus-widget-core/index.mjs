import { version } from 'vue';
import ElementPlus, { ElButton, ElInput } from 'element-plus';

export function installModernElementPlus(app) {
  app.use(ElementPlus);
}

export const ModernElementButton = ElButton;
export const ModernElementInput = ElInput;

export function getModernElementPlusRuntimeVersion() {
  return version;
}
