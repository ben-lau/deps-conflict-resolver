import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { findPackagePath, readPackageJsonCached } from '../utils/fs';

export interface InstalledPackageNode {
  id: string;
  name: string;
  version: string;
  packagePath: string;
  parentId: string | null;
  dependencyNames: string[];
  peerDependencyNames: string[];
  /** Resolved dependency and peer edges, including edges to shared nodes. */
  resolvedChildren: Map<string, string>;
}

export interface InstalledDependencyGraph {
  nodes: Map<string, InstalledPackageNode>;
  roots: string[];
  /** Logical root requests remain distinct even when they share one instance. */
  rootRequests: Map<string, string>;
}

function normalizePackagePath(packagePath: string): string {
  try {
    return realpathSync(packagePath);
  } catch {
    return resolve(packagePath);
  }
}

/**
 * Traverse installed packages while preserving each package directory as the
 * identity of a node. Package resolution for a child starts at its parent's
 * directory, so nested duplicate package names remain distinct nodes.
 */
export function buildInstalledDependencyGraph(
  packageNames: string[],
  projectRoot: string,
): InstalledDependencyGraph {
  const nodes = new Map<string, InstalledPackageNode>();
  const roots: string[] = [];
  const rootRequests = new Map<string, string>();
  const stack: Array<{ name: string; baseDir: string; parentId: string | null; root: boolean }> =
    [];
  for (let index = packageNames.length - 1; index >= 0; index--) {
    const name = packageNames[index];
    if (name) stack.push({ name, baseDir: projectRoot, parentId: null, root: true });
  }

  while (stack.length > 0) {
    const item = stack.pop();
    if (!item) continue;

    const packagePath = findPackagePath(item.name, item.baseDir);
    if (!packagePath) continue;

    const normalizedPath = normalizePackagePath(packagePath);
    if (item.root) rootRequests.set(item.name, normalizedPath);
    if (item.parentId) nodes.get(item.parentId)?.resolvedChildren.set(item.name, normalizedPath);
    const existingNode = nodes.get(normalizedPath);
    if (existingNode) {
      if (item.root) {
        // A root request can resolve to a package already discovered through a
        // dependency edge. The physical package is still root-visible, so
        // remove the incidental parent edge before recording the root.
        existingNode.parentId = null;
      }
      if (item.root && !roots.includes(normalizedPath)) {
        roots.push(normalizedPath);
      }
      continue;
    }

    const packageJson = readPackageJsonCached(normalizedPath);
    if (!packageJson) continue;

    const dependencyNames = Object.keys({
      ...packageJson.dependencies,
      ...packageJson.optionalDependencies,
    });
    const peerDependencyNames = Object.keys(packageJson.peerDependencies ?? {});
    const node: InstalledPackageNode = {
      id: normalizedPath,
      name: item.name,
      version: packageJson.version ?? 'unknown',
      packagePath: normalizedPath,
      parentId: item.parentId,
      dependencyNames,
      peerDependencyNames,
      resolvedChildren: new Map(),
    };

    nodes.set(normalizedPath, node);
    if (item.root) roots.push(normalizedPath);

    const childNames = [...dependencyNames, ...peerDependencyNames];
    for (let index = childNames.length - 1; index >= 0; index--) {
      const childName = childNames[index];
      if (childName) {
        stack.push({
          name: childName,
          baseDir: normalizedPath,
          parentId: normalizedPath,
          root: false,
        });
      }
    }
  }

  return { nodes, roots, rootRequests };
}
