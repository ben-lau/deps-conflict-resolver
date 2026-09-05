import { computed, ref, version } from 'vue';

export function createModernRuntimeProbe() {
  const count = ref(0);
  const summary = computed(() => 'vue3:' + count.value);
  return { count, summary };
}

export function getModernRuntimeVersion() {
  return version;
}
