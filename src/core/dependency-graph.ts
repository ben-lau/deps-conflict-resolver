import { isAbsolute, join, relative, sep } from 'node:path';
import type { DependencyPath } from '../types';
import { canonicalPath, findPackagePath, readPackageJsonCached } from '../utils/fs';
import { getEffectivePeerDependencies } from '../utils/peer-overrides';

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
  /** Configured name -> physical package directory -> requests from reachable owners. */
  rootRequests: Map<string, Map<string, RootRequest[]>>;
  workspaceParents: Map<string, WorkspaceLink[]>;
}

interface RootRequest {
  path: string[];
  ownerPath: string;
}

interface WorkspaceLink {
  from: string;
  name: string;
}

interface PackageRequest {
  name: string;
  baseDir: string;
  parentId: string | null;
  rootPath?: string[];
}

function findRootRequests(
  packageNames: string[],
  projectRoot: string,
  workspaceRoot: string | null,
  watchFiles?: Set<string>,
): { requests: PackageRequest[]; workspaceParents: Map<string, WorkspaceLink[]> } {
  const names = new Set(packageNames.filter(Boolean));
  const workspaceParents = new Map<string, WorkspaceLink[]>();
  const requests: PackageRequest[] = [...names].map((name) => ({
    name,
    baseDir: projectRoot,
    parentId: null,
    rootPath: [name],
  }));
  if (!workspaceRoot || names.size === 0) return { requests, workspaceParents };

  const workspace = canonicalPath(workspaceRoot);
  const host = canonicalPath(projectRoot);
  const pending: Array<{ directory: string; path: string[] }> = [{ directory: host, path: [] }];
  const visited = new Set<string>();
  for (let index = 0; index < pending.length; index++) {
    const { directory, path } = pending[index]!;
    if (visited.has(directory)) continue;
    visited.add(directory);
    watchFiles?.add(join(directory, 'package.json'));
    const manifest = readPackageJsonCached(directory);
    if (!manifest) continue;

    const dependencies = { ...manifest.dependencies, ...manifest.optionalDependencies };
    for (const [name, spec] of Object.entries(dependencies)) {
      const dependencyPath = findPackagePath(name, directory);
      if (!dependencyPath) continue;
      const dependency = canonicalPath(dependencyPath);
      const requestPath = [...path, name];
      if (path.length > 0 && names.has(name)) {
        requests.push({ name, baseDir: directory, parentId: null, rootPath: requestPath });
      }

      // Follow installed workspace links. Explicit workspace dependencies can
      // also be injected copies under node_modules.
      const location = relative(workspace, dependency);
      if (dependency === host) continue;
      if (isAbsolute(location) || location === '..' || location.startsWith('..' + sep)) continue;
      const workspaceSpec = typeof spec === 'string' && spec.startsWith('workspace:');
      if (location.split(sep).includes('node_modules') && !workspaceSpec) {
        continue;
      }
      const parents = workspaceParents.get(dependency) ?? [];
      parents.push({ from: directory, name });
      workspaceParents.set(dependency, parents);
      pending.push({ directory: dependency, path: requestPath });
    }
  }

  return { requests, workspaceParents };
}

/** Find all workspace imports that can reach one of the selected entry owners. */
export function collectWorkspaceEntryNames(
  graph: InstalledDependencyGraph,
  requests: readonly DependencyPath[],
): string[] {
  if (graph.workspaceParents.size === 0) return [];

  const pending: string[] = [];
  const seenRequests = new Set<RootRequest[]>();
  for (const { packagePath, path } of requests) {
    const name = path.at(-1);
    if (!name || !packagePath) continue;
    const owners = graph.rootRequests.get(name)?.get(packagePath);
    if (!owners || seenRequests.has(owners)) continue;
    seenRequests.add(owners);
    for (const { ownerPath } of owners) {
      pending.push(ownerPath);
    }
  }

  // A physical package can have many incoming routes. Keep their edge names
  // without enumerating paths or replacing the representative paths in usedBy.
  const names = new Set<string>();
  const visited = new Set<string>();
  while (pending.length > 0) {
    const directory = pending.pop()!;
    if (visited.has(directory)) continue;
    visited.add(directory);
    for (const { from, name } of graph.workspaceParents.get(directory) ?? []) {
      names.add(name);
      pending.push(from);
    }
  }
  return [...names];
}

/**
 * Traverse installed packages while preserving each package directory as the
 * identity of a node. Package resolution for a child starts at its parent's
 * directory, so nested duplicate package names remain distinct nodes.
 */
export function buildInstalledDependencyGraph(
  packageNames: string[],
  projectRoot: string,
  workspaceRoot: string | null = null,
  watchFiles?: Set<string>,
  peerOverrides?: Record<string, Record<string, string>>,
): InstalledDependencyGraph {
  const nodes = new Map<string, InstalledPackageNode>();
  const roots = new Set<string>();
  const rootRequests = new Map<string, Map<string, RootRequest[]>>();
  const { requests, workspaceParents } = findRootRequests(
    packageNames,
    projectRoot,
    workspaceRoot,
    watchFiles,
  );
  const stack: PackageRequest[] = [];
  for (let index = requests.length - 1; index >= 0; index--) stack.push(requests[index]!);

  while (stack.length > 0) {
    const item = stack.pop();
    if (!item) continue;

    const packagePath = findPackagePath(item.name, item.baseDir);
    if (!packagePath) continue;

    const normalizedPath = canonicalPath(packagePath);
    const existingNode = nodes.get(normalizedPath);
    const packageJson = existingNode ? null : readPackageJsonCached(normalizedPath);
    if (!existingNode && !packageJson) continue;
    if (item.parentId) nodes.get(item.parentId)?.resolvedChildren.set(item.name, normalizedPath);
    if (item.rootPath) {
      const instances = rootRequests.get(item.name) ?? new Map<string, RootRequest[]>();
      const owners = instances.get(normalizedPath) ?? [];
      owners.push({ path: item.rootPath, ownerPath: item.baseDir });
      instances.set(normalizedPath, owners);
      rootRequests.set(item.name, instances);
      roots.add(normalizedPath);
      if (existingNode) existingNode.parentId = null;
    }

    if (!packageJson) continue;

    const dependencyNames = Object.keys({
      ...packageJson.dependencies,
      ...packageJson.optionalDependencies,
    });
    const peerDependencyNames = [
      ...getEffectivePeerDependencies(packageJson, item.name, peerOverrides).keys(),
    ];
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

    const childNames = [...dependencyNames, ...peerDependencyNames];
    for (let index = childNames.length - 1; index >= 0; index--) {
      const childName = childNames[index];
      if (childName) {
        stack.push({
          name: childName,
          baseDir: normalizedPath,
          parentId: normalizedPath,
        });
      }
    }
  }

  return { nodes, roots: [...roots], rootRequests, workspaceParents };
}
