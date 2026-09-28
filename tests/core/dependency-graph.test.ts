import { describe, expect, it } from 'vitest';
import { realpathSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInstalledDependencyGraph } from '../../src/core/dependency-graph';

async function writePackage(
  parentDir: string,
  name: string,
  packageJson: Record<string, unknown>,
): Promise<string> {
  const packagePath = join(parentDir, 'node_modules', name);
  await fs.mkdir(packagePath, { recursive: true });
  await fs.writeFile(
    join(packagePath, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', ...packageJson }, null, 2),
    'utf8',
  );
  return packagePath;
}

describe('buildInstalledDependencyGraph', () => {
  it('keeps duplicate nested package instances and resolves their children from each owner', async () => {
    const projectRoot = await fs.mkdtemp(join(tmpdir(), 'deps-conflict-graph-'));

    try {
      await fs.writeFile(
        join(projectRoot, 'package.json'),
        JSON.stringify({ name: 'fixture', version: '1.0.0' }),
        'utf8',
      );

      const legacyPath = await writePackage(projectRoot, 'legacy-widget', {
        version: '1.0.0',
        dependencies: { 'shared-core': '^1.0.0' },
      });
      const modernPath = await writePackage(projectRoot, 'modern-widget', {
        version: '2.0.0',
        dependencies: { 'shared-core': '^2.0.0' },
      });

      const legacyCorePath = await writePackage(legacyPath, 'shared-core', {
        version: '1.4.0',
        dependencies: { 'legacy-leaf': '^1.0.0' },
      });
      const modernCorePath = await writePackage(modernPath, 'shared-core', {
        version: '2.4.0',
        dependencies: { 'modern-leaf': '^1.0.0' },
      });

      await writePackage(legacyCorePath, 'legacy-leaf', { version: '1.1.0' });
      await writePackage(modernCorePath, 'modern-leaf', { version: '1.1.0' });

      const graph = buildInstalledDependencyGraph(['legacy-widget', 'modern-widget'], projectRoot);
      const sharedNodes = [...graph.nodes.values()].filter((node) => node.name === 'shared-core');

      expect(sharedNodes).toHaveLength(2);
      expect(new Set(sharedNodes.map((node) => node.version))).toEqual(new Set(['1.4.0', '2.4.0']));
      expect(new Set(sharedNodes.map((node) => node.id))).toEqual(
        new Set(sharedNodes.map((node) => node.packagePath)),
      );

      const legacyNode = sharedNodes.find((node) => node.version === '1.4.0');
      const modernNode = sharedNodes.find((node) => node.version === '2.4.0');
      expect(legacyNode).toBeDefined();
      expect(modernNode).toBeDefined();

      const legacyWidget = [...graph.nodes.values()].find((node) => node.name === 'legacy-widget');
      const modernWidget = [...graph.nodes.values()].find((node) => node.name === 'modern-widget');
      expect(legacyNode?.parentId).toBe(legacyWidget?.id);
      expect(modernNode?.parentId).toBe(modernWidget?.id);

      const leafVersions = [...graph.nodes.values()]
        .filter((node) => node.name.endsWith('-leaf'))
        .map((node) => [node.name, node.parentId]);
      expect(leafVersions).toEqual(
        expect.arrayContaining([
          ['legacy-leaf', legacyNode?.id],
          ['modern-leaf', modernNode?.id],
        ]),
      );
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('clears a nested parent when the same physical package is also a graph root', async () => {
    const projectRoot = await fs.mkdtemp(join(tmpdir(), 'deps-conflict-graph-root-hit-'));

    try {
      await fs.writeFile(
        join(projectRoot, 'package.json'),
        JSON.stringify({ name: 'fixture', version: '1.0.0' }),
        'utf8',
      );

      await writePackage(projectRoot, 'root-consumer', {
        dependencies: { shared: '^1.0.0' },
      });
      const rootSharedPath = await writePackage(projectRoot, 'shared', {
        version: '1.2.0',
      });

      const graph = buildInstalledDependencyGraph(['root-consumer', 'shared'], projectRoot);
      const sharedNode = graph.nodes.get(realpathSync(rootSharedPath));

      expect(sharedNode).toBeDefined();
      expect(sharedNode?.parentId).toBeNull();
      expect(graph.roots).toContain(sharedNode?.id);
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });
});
