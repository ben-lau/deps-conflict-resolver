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
import { join } from 'node:path';
import { PackageInstaller } from '../../src/core/package-installer';
import { clearPackageJsonCache } from '../../src/utils/fs';
import type { AliasMapping } from '../../src/types';

const roots: string[] = [];
function pkg(directory: string, name: string, version: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version }));
}
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  clearPackageJsonCache();
});

it.each([
  { change: 'version', success: true },
  { change: 'package', success: true },
  { change: 'removed', success: true },
  { change: 'local-shadow', success: true },
  { change: 'same-target', success: true },
  { change: 'version', success: false },
])(
  'verifies the currently visible hoisted alias after installation: $change, success=$success',
  async ({ change, success }) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'deps-hoisted-alias-')));
    roots.push(root);
    const app = join(root, 'packages/app');
    const old = join(root, 'store/old');
    const fresh = join(root, 'store/new');
    pkg(app, 'app', '1.0.0');
    pkg(old, 'vue', '2.6.14');
    pkg(fresh, change === 'package' ? 'unrelated' : 'vue', '2.7.16');
    mkdirSync(join(root, 'node_modules'));
    const link = join(root, 'node_modules/vue2');
    symlinkSync(old, link, 'junction');
    const nativeRequire = createRequire(join(app, 'package.json'));
    expect(nativeRequire.resolve('vue2/package.json')).toBe(join(old, 'package.json'));
    const mappings: AliasMapping[] = [
      {
        originalName: 'vue',
        aliasName: 'vue2',
        resolvedVersion: '2.6.14',
        installSpec: '',
        usedBy: ['legacy'],
        allDependents: ['legacy'],
      },
      {
        originalName: 'renderer',
        aliasName: 'renderer1',
        resolvedVersion: '1.0.0',
        installSpec: 'renderer1@npm:renderer@1.0.0',
        usedBy: ['legacy'],
        allDependents: ['legacy'],
      },
    ];
    const installer = new PackageInstaller(
      {
        projectRoot: app,
        dependencies: ['legacy'],
        packageManager: 'pnpm',
        registry: 'https://invalid.example',
        autoInstall: true,
        debug: false,
        aliasPrefix: 'aliased-',
        includeRedirects: {},
        excludeRedirects: {},
      },
      {
        async install() {
          pkg(join(app, 'node_modules/renderer1'), 'renderer', '1.0.0');
          if (change === 'local-shadow') {
            symlinkSync(fresh, join(app, 'node_modules/vue2'), 'junction');
          } else {
            unlinkSync(link);
            if (change !== 'removed')
              symlinkSync(change === 'same-target' ? old : fresh, link, 'junction');
          }
          return {
            success,
            exitCode: success ? 0 : 1,
            stdout: '',
            stderr: success ? '' : 'install failed',
            timedOut: false,
          };
        },
      },
    );
    const result = await installer.installAliases(mappings);
    expect(result.success).toBe(change === 'same-target' && success);
    expect(result.reused).toEqual(change === 'same-target' ? ['vue2'] : []);
    expect(result.failed.includes('vue2')).toBe(change !== 'same-target');
    expect(result.installed).toEqual(success ? ['renderer1'] : []);
  },
);
