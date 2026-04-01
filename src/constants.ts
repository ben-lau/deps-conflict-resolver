import type { PackageManagerType } from './types/index';

/**
 * 默认的 NPM registry 地址
 */
export const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org';

/**
 * Lock 文件与包管理器的映射
 */
export const LOCK_FILE_MAP = {
  'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'yarn',
  'package-lock.json': 'npm',
  'npm-shrinkwrap.json': 'npm',
} as const satisfies Record<string, PackageManagerType>;

/**
 * NPM registry 请求默认超时时间（毫秒）
 */
export const DEFAULT_NPM_REGISTRY_TIMEOUT_MS = 10000;
