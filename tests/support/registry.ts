import { vi } from 'vitest';
import type { PackageJson } from '../../src/types';

type RegistryManifest = PackageJson & { name: string; version: string };

export function mockRegistry(...manifests: RegistryManifest[]) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const address = typeof url === 'string' || url instanceof URL ? url : url.url;
    const name = decodeURIComponent(new URL(address).pathname.split('/').at(-1) ?? '');
    const matches = manifests.filter((manifest) => manifest.name === name);
    const versions = Object.fromEntries(matches.map((manifest) => [manifest.version, manifest]));
    return matches.length
      ? new Response(JSON.stringify({ name, versions }))
      : new Response(null, { status: 404 });
  });
}
