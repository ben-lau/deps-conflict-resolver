import { describe, it, expect, vi } from 'vitest';
import { DependencyAnalyzer } from '../../src/core/dependency-analyzer';
import type { ResolvedOptions, PackageJson } from '../../src/types';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

async function writeTestPackage(
  parentDir: string,
  name: string,
  packageJson: Record<string, unknown>,
): Promise<string> {
  const packagePath = join(parentDir, 'node_modules', name);
  await fs.mkdir(packagePath, { recursive: true });
  await fs.writeFile(
    join(packagePath, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', ...packageJson }),
    'utf8',
  );
  return packagePath;
}

describe('DependencyAnalyzer alias ownership', () => {
  it('reserves project and workspace dependency keys before generating aliases', async () => {
    const workspaceRoot = await fs.mkdtemp(
      join(tmpdir(), 'deps-conflict-resolver-alias-ownership-'),
    );
    const projectRoot = join(workspaceRoot, 'packages', 'app');
    const consumerPackage = 'legacy-vue-consumer';
    const registryClient = {
      fetchAllVersions: vi.fn().mockResolvedValue(['2.7.16']),
    };

    try {
      await fs.mkdir(projectRoot, { recursive: true });
      await fs.writeFile(join(workspaceRoot, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
      await fs.writeFile(
        join(workspaceRoot, 'package.json'),
        JSON.stringify({
          name: 'alias-ownership-workspace',
          version: '1.0.0',
          dependencies: { 'aliased-vue2': '1.0.0' },
          devDependencies: { 'aliased-vue-2-7-16': '1.0.0' },
        }),
        'utf8',
      );
      const mainPackageJson: PackageJson = {
        name: 'alias-ownership-app',
        version: '1.0.0',
        dependencies: {
          [consumerPackage]: '1.0.0',
          vue: '^3.0.0',
        },
      };
      await fs.writeFile(
        join(projectRoot, 'package.json'),
        JSON.stringify(mainPackageJson),
        'utf8',
      );

      await writeTestPackage(workspaceRoot, 'aliased-vue2', { version: '1.0.0' });
      await writeTestPackage(workspaceRoot, consumerPackage, {
        peerDependencies: { vue: '^2.7.0' },
      });
      await writeTestPackage(workspaceRoot, 'vue', { version: '3.5.0' });

      const options: ResolvedOptions = {
        dependencies: [consumerPackage],
        projectRoot,
        autoInstall: true,
        packageManager: 'pnpm',
        registry: 'https://registry.example.test',
        debug: false,
        aliasPrefix: 'aliased-',
        excludeRedirects: {},
        includeRedirects: {},
      };

      const result = await new DependencyAnalyzer(
        options,
        mainPackageJson,
        undefined,
        registryClient,
      ).analyze();

      expect(result.aliasMappings).toContainEqual(
        expect.objectContaining({
          originalName: 'vue',
          aliasName: 'aliased-vue2-2',
          installSpec: 'aliased-vue2-2@npm:vue@2.7.16',
        }),
      );
      expect(result.aliasMappings).not.toContainEqual(
        expect.objectContaining({ aliasName: 'aliased-vue2' }),
      );
      expect(result.aliasMappings).not.toContainEqual(
        expect.objectContaining({ aliasName: 'aliased-vue-2-7-16' }),
      );
      expect(
        JSON.parse(
          await fs.readFile(join(workspaceRoot, 'node_modules/aliased-vue2/package.json'), 'utf8'),
        ),
      ).toEqual(expect.objectContaining({ name: 'aliased-vue2', version: '1.0.0' }));
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
