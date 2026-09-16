import { DEFAULT_NPM_REGISTRY } from '../constants';
import { npmRegistryClient } from './registry-client';

export { npmRegistryClient, clearNpmRegistryCache } from './registry-client';

/**
 * 获取包的所有可用版本
 */
export async function fetchAllVersions(
  packageName: string,
  registry = DEFAULT_NPM_REGISTRY,
): Promise<string[]> {
  return npmRegistryClient.fetchAllVersions(packageName, registry);
}
