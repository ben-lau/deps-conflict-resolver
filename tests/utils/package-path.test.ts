import { afterEach, expect, it } from 'vitest';
import {
  chmodSync,
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
import { DependencyInputs } from '../../src/utils/dependency-inputs';
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

it('checks a newly created lookup directory for a different package outside preparation', () => {
  const directory = root();
  pkg(directory, { name: 'host' });
  expect(findPackagePath('first', directory)).toBeNull();

  const provider = join(directory, 'node_modules', 'second');
  pkg(provider, { name: 'second', version: '1.0.0' });
  expect(findPackagePath('second', directory)).toBe(provider);
});

it.runIf(process.platform !== 'win32')(
  'skips a looping package directory when looking for metadata',
  () => {
    const workspace = root();
    const app = join(workspace, 'app');
    const hoisted = join(workspace, 'node_modules/provider');
    pkg(app, { name: 'app' });
    pkg(hoisted, { name: 'provider' });
    mkdirSync(join(app, 'node_modules'));
    symlinkSync('provider', join(app, 'node_modules/provider'), 'dir');

    const inputs = new DependencyInputs();
    expect(inputs.record(() => findPackagePath('provider', app))).toBe(hoisted);
    expect(inputs.reusable).toBe(false);
  },
);

it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
  'does not claim a manifest in an inaccessible lookup directory',
  () => {
    const workspace = root();
    const app = join(workspace, 'app');
    const modules = join(app, 'node_modules');
    const hoisted = join(workspace, 'node_modules/provider');
    pkg(app, { name: 'app' });
    pkg(hoisted, { name: 'provider' });
    pkg(join(modules, 'provider'), { name: 'provider' });

    chmodSync(modules, 0o600);
    try {
      expect(findPackagePath('provider', app)).toBe(hoisted);
      expect(findPackagePath('missing-provider', app)).toBeNull();
    } finally {
      chmodSync(modules, 0o700);
    }
  },
);

it('skips a directory named package.json even if it belongs to a nearer package directory', () => {
  const workspace = root();
  const app = join(workspace, 'app');
  const hoisted = join(workspace, 'node_modules/provider');
  pkg(app, { name: 'app' });
  pkg(hoisted, { name: 'provider' });
  mkdirSync(join(app, 'node_modules/provider/package.json'), { recursive: true });

  expect(findPackagePath('provider', app)).toBe(hoisted);
});

it.runIf(process.platform !== 'win32')(
  'revalidates a previously absent manifest that now has a broken link',
  () => {
    const workspace = root();
    const app = join(workspace, 'app');
    const hoisted = join(workspace, 'node_modules/provider');
    const nearer = join(app, 'node_modules/provider');
    pkg(app, { name: 'app' });
    pkg(hoisted, { name: 'provider' });
    mkdirSync(nearer, { recursive: true });

    const inputs = new DependencyInputs();
    expect(inputs.record(() => findPackagePath('provider', app))).toBe(hoisted);
    expect(inputs.matches()).toBe(true);

    symlinkSync('package.json', join(nearer, 'package.json'), 'file');
    expect(inputs.matches()).toBe(false);
    expect(findPackagePath('provider', app)).toBe(nearer);
  },
);
