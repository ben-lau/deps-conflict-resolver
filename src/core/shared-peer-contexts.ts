import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { AliasMapping, PackageJson, ResolvedOptions, ResolverDiagnostic } from '../types';
import type { InstalledDependencyGraph } from './dependency-graph';
import { AliasManager } from './alias-manager';
import { findPackagePath, readPackageJsonCached } from '../utils/fs';
import { resolvePeerOverridesForPackage } from '../utils/peer-overrides';
import { satisfies } from '../utils/semver';

interface Provider {
  path: string;
  version: string;
  label: string;
}

function canonical(directory: string): string {
  try {
    return realpathSync(directory);
  } catch {
    return directory;
  }
}

/**
 * Warn about different incoming runtime contexts in the configured graph.
 * A broad peer range alone cannot prove that mixing runtimes is an error, so
 * this advisory does not reject strict initialization or invent new instances.
 */
export function validateSharedPeerContexts(
  graph: InstalledDependencyGraph,
  mappings: AliasMapping[],
  options: ResolvedOptions,
  diagnostics: ResolverDiagnostic[],
  watchFiles?: Set<string>,
): void {
  if (mappings.length === 0 || graph.roots.length < 2) return;
  const readManifest = (directory: string): PackageJson | null => {
    watchFiles?.add(join(directory, 'package.json'));
    return readPackageJsonCached(directory);
  };
  const aliases = new Map<string, Provider>();
  const installedMappings = mappings.filter((mapping) => {
    const path = findPackagePath(mapping.aliasName, options.projectRoot);
    if (!path) return false;
    const physical = canonical(path);
    const manifest = readManifest(physical);
    if (
      manifest?.name !== mapping.originalName ||
      !manifest.version ||
      !satisfies(manifest.version, mapping.resolvedVersion)
    )
      return false;
    aliases.set(mapping.aliasName, {
      path: physical,
      version: manifest.version,
      label: mapping.aliasName + '@' + manifest.version,
    });
    return true;
  });
  if (installedMappings.length === 0) return;
  const resolver = new AliasManager({ ...options, strict: false });
  resolver.initFromAnalysisResult({
    aliasMappings: installedMappings,
    analyzedDependencies: new Map(),
    peerConflicts: [],
    missingFirstLevelPeers: [],
  });
  const aliasPaths = new Set([...aliases.values()].map((provider) => provider.path));
  const originals = new Set(installedMappings.map((mapping) => mapping.originalName));
  const requests: Array<[string, string[]]> = [];
  for (const instances of graph.rootRequests.values()) {
    for (const request of instances) requests.push(request);
  }

  for (const peer of originals) {
    const hasExclusions = (options.excludeRedirects[peer]?.length ?? 0) > 0;
    const roots: Array<{ nodeId: string; consumer: string; provider: Provider }> = [];
    for (const [nodeId, requestPath] of requests) {
      const node = graph.nodes.get(nodeId);
      if (!node) continue;
      const manifest = readManifest(node.packagePath);
      const overrideRange = resolvePeerOverridesForPackage(
        options.peerOverrides,
        { packageName: node.name, manifestName: manifest?.name },
        manifest?.version ?? node.version,
      )?.[peer];
      const range = overrideRange ?? manifest?.peerDependencies?.[peer];
      if (!range || (!overrideRange && manifest?.peerDependenciesMeta?.[peer]?.optional)) continue;
      const decision = resolver.explainResolution(
        peer,
        join(node.packagePath, '__peer_context__.js'),
      );
      if (decision.reason === 'ambiguous') continue;
      let provider = decision.resolved ? aliases.get(decision.aliases[0]!) : undefined;
      if (!decision.resolved) {
        const path = findPackagePath(peer, node.packagePath);
        const natural = path ? readManifest(canonical(path)) : null;
        if (path && natural?.version)
          provider = {
            path: canonical(path),
            version: natural.version,
            label: peer + '@' + natural.version,
          };
      }
      if (provider && satisfies(provider.version, range))
        roots.push({ nodeId, consumer: requestPath.join('>'), provider });
    }
    if (new Set(roots.map(({ provider }) => provider.path)).size < 2) continue;

    // Process each (physical node, provider) once. Shared nodes keep all
    // incoming providers without repeating traversal for every root name.
    const visited = new Set<string>();
    const contexts = new Map<string, Map<string, { consumer: string; provider: Provider }>>();
    const pending = [...roots];
    while (pending.length > 0) {
      const context = pending.pop()!;
      const key = context.nodeId + '\0' + context.provider.path;
      if (visited.has(key)) continue;
      visited.add(key);
      const node = graph.nodes.get(context.nodeId);
      if (!node || originals.has(node.name)) continue;
      if (
        hasExclusions &&
        resolver.explainResolution(peer, join(node.packagePath, '__peer_context__.js')).reason ===
          'excluded'
      )
        continue;
      const manifest = readManifest(node.packagePath);
      const overrideRange = resolvePeerOverridesForPackage(
        options.peerOverrides,
        { packageName: node.name, manifestName: manifest?.name },
        manifest?.version ?? node.version,
      )?.[peer];
      const range = overrideRange ?? manifest?.peerDependencies?.[peer];
      if (range && !satisfies(context.provider.version, range)) continue;
      if (
        range &&
        (overrideRange !== undefined || !manifest?.peerDependenciesMeta?.[peer]?.optional) &&
        !aliasPaths.has(node.packagePath) &&
        !options.includeRedirects[peer]?.includes(node.name)
      ) {
        let incoming = contexts.get(node.id);
        if (!incoming) contexts.set(node.id, (incoming = new Map()));
        incoming.set(context.provider.path, context);
      }
      for (const child of node.resolvedChildren.values())
        pending.push({ ...context, nodeId: child });
    }

    for (const [nodeId, incoming] of contexts) {
      if (incoming.size < 2) continue;
      const node = graph.nodes.get(nodeId)!;
      diagnostics.push({
        code: 'SHARED_PEER_CONTEXT',
        severity: 'warning',
        packageName: peer,
        requestedBy: [...new Set([...incoming.values()].map(({ consumer }) => consumer))],
        importerPaths: [node.packagePath],
        message:
          'Shared package ' +
          node.name +
          ' has different incoming peer contexts: ' +
          [...incoming.values()]
            .map(({ consumer, provider }) => consumer + ' -> ' + provider.label)
            .join('; ') +
          '. A single physical instance cannot inherit both providers. Isolate the package or explicitly configure its redirect scope.',
      });
    }
  }
}
