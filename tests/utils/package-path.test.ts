import { afterEach, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { clearPackageJsonCache, findPackagePath } from '../../src/utils/fs';

const roots: string[] = [];
function root(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'deps-package-path-')));
  roots.push(directory);
  return directory;
}
function pkg(directory: string, data: object): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify(data));
}
afterEach(() => {
  roots.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
  clearPackageJsonCache();
});

it('preserves package self-reference ahead of another installed package with the same name', () => {
  const directory = root();
  pkg(directory, { name: 'provider', exports: { './package.json': './package.json' } });
  pkg(join(directory, 'node_modules/provider'), { name: 'provider', version: '2.0.0' });
  mkdirSync(join(directory, 'src'));
  expect(findPackagePath('provider', join(directory, 'src'))).toBe(directory);
});

it.each([false, true])(
  'uses Node lookup order instead of nested node_modules/node_modules: hiddenManifest=%s',
  (hiddenManifest) => {
    const directory = root();
    const consumer = join(directory, 'node_modules/consumer');
    pkg(consumer, { name: 'consumer' });
    const provider = join(directory, 'node_modules/provider');
    pkg(provider, { name: 'provider', ...(hiddenManifest ? { exports: './index.js' } : {}) });
    pkg(join(directory, 'node_modules/node_modules/provider'), { name: 'wrong-provider' });
    expect(findPackagePath('provider', consumer)).toBe(provider);
  },
);

it('refreshes a scoped alias after relinking even when Node has resolved its old target', () => {
  const directory = root();
  pkg(directory, { name: 'host' });
  const old = join(directory, 'store/old');
  const fresh = join(directory, 'store/fresh');
  pkg(old, { name: 'provider', version: '1.0.0' });
  pkg(fresh, { name: 'provider', version: '2.0.0' });
  const link = join(directory, 'node_modules/@compat/provider');
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(old, link, 'junction');
  createRequire(join(directory, 'package.json')).resolve('@compat/provider/package.json');
  expect(findPackagePath('@compat/provider', directory)).toBe(old);
  unlinkSync(link);
  symlinkSync(fresh, link, 'junction');
  clearPackageJsonCache();
  expect(findPackagePath('@compat/provider', directory)).toBe(fresh);
});
