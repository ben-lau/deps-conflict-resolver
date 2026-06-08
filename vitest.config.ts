import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      enabled: false, // 使用 --coverage 标志时启用
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/types/**', 'src/**/*.test.ts', 'src/**/__tests__/**'],
      thresholds: {
        lines: 70,
        functions: 75,
        branches: 60,
        statements: 70,
      },
      // 清除之前的覆盖率数据
      clean: true,
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
