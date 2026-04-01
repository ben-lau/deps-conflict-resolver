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
      reporter: ['text'], // 只输出到终端，不生成文件
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/types/**', 'src/**/*.test.ts', 'src/**/__tests__/**'],
      // 覆盖率阈值（可根据需要逐步提升）
      thresholds: {
        lines: 30,
        functions: 40,
        branches: 20,
        statements: 30,
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
