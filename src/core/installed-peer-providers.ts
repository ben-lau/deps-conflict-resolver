import type { AliasMapping, PeerConflict, ResolvedOptions, ResolverDiagnostic } from '../types';
import { isValidRange, isValidVersion, satisfies } from '../utils/semver';
import { resolveDependencyRequirement, type VersionSpecResolver } from '../utils/version-spec';
import { createDirectoryScopeMatcher } from './scope-paths';
import type { InstalledDependencyGraph, InstalledPackageNode } from './dependency-graph';

type ResolveAlias = (peer: string, importerPath: string) => AliasMapping | undefined;

/** Check the installed peer requests whose providers can be determined from the graph. */
export function validateInstalledPeerProviders(
  graph: InstalledDependencyGraph,
  conflicts: readonly PeerConflict[],
  mappings: AliasMapping[],
  options: ResolvedOptions,
  detector: VersionSpecResolver,
  diagnostics: ResolverDiagnostic[],
): void {
  const candidates = mappings.filter(({ installSpec }) => !installSpec || options.autoInstall);
  const originals = new Set(candidates.map(({ originalName }) => originalName));
  const byAlias = new Map(candidates.map((mapping) => [mapping.aliasName, mapping]));
  let matcher: ReturnType<typeof createDirectoryScopeMatcher> | undefined;
  const resolveAlias: ResolveAlias = (peer, importerPath) => {
    if (!originals.has(peer)) return undefined;
    matcher ??= createDirectoryScopeMatcher(candidates, options);
    const { resolved: alias } = matcher(peer, importerPath);
    return alias ? byAlias.get(alias) : undefined;
  };

  validateShadowedHostPeers(graph, conflicts, detector, diagnostics, resolveAlias);
  validateDirectTransitivePeers(graph, detector, diagnostics, resolveAlias);
  validateOptionalPeers(graph, detector, diagnostics, resolveAlias);
}

function validateOptionalPeers(
  graph: InstalledDependencyGraph,
  detector: VersionSpecResolver,
  diagnostics: ResolverDiagnostic[],
  resolveAlias: ResolveAlias,
): void {
  const consumers = new Set(graph.roots);
  for (const id of graph.roots) {
    const root = graph.nodes.get(id);
    const runtime = { ...root?.manifest.dependencies, ...root?.manifest.optionalDependencies };
    for (const name of Object.keys(runtime)) {
      const child = root?.resolvedChildren.get(name);
      if (child) consumers.add(child);
    }
  }
  const reported = new Set<string>();
  for (const id of consumers) {
    const node = graph.nodes.get(id);
    if (!node) continue;
    for (const [requester, peers] of node.peerDependenciesByName) {
      for (const [peer, entry] of peers) {
        if (!entry.optional) continue;
        const expected = resolveDependencyRequirement(peer, entry.range, detector);
        if (!isValidRange(expected.range)) continue;
        const alias = resolveAlias(peer, node.packagePath);
        // Final analysis after installation checks the actual provider. Avoid
        // warning about the host during a preparation that plans to replace it.
        if (
          alias?.originalName === expected.name &&
          satisfies(alias.resolvedVersion, expected.range)
        )
          continue;
        const actual = installedProvider(graph, node, peer);
        const activeAlias = alias?.installSpec === '' ? alias : undefined;
        const version = activeAlias?.resolvedVersion ?? actual?.version;
        if (!version || !isValidVersion(version)) continue;
        const name = activeAlias?.originalName ?? actual?.manifest.name;
        if (name === expected.name && satisfies(version, expected.range)) continue;
        const key = JSON.stringify([node.id, peer, expected.name, expected.range]);
        if (reported.has(key)) continue;
        reported.add(key);
        diagnostics.push({
          code: 'OPTIONAL_PEER_MISMATCH',
          severity: 'warning',
          packageName: peer,
          requestedBy: [requester],
          importerPaths: [node.packagePath],
          message: `${requester} optionally requires ${expected.name}@${expected.range} but resolves to ${name ?? '(unnamed package)'}@${version}`,
        });
      }
    }
  }
}

function installedProvider(
  graph: InstalledDependencyGraph,
  importer: InstalledPackageNode | undefined,
  peer: string,
): InstalledPackageNode | undefined {
  const providerId = importer?.resolvedChildren.get(peer);
  return providerId ? graph.nodes.get(providerId) : undefined;
}

function validateShadowedHostPeers(
  graph: InstalledDependencyGraph,
  conflicts: readonly PeerConflict[],
  detector: VersionSpecResolver,
  diagnostics: ResolverDiagnostic[],
  resolveAlias: ResolveAlias,
): void {
  for (const { packageName, mainProjectVersion, requestedBy } of conflicts) {
    if (!mainProjectVersion) continue;
    for (const request of requestedBy) {
      if (!request.packagePath) continue;
      const { name, range } = resolveDependencyRequirement(
        packageName,
        request.requiredRange,
        detector,
      );
      if (!satisfies(mainProjectVersion, range)) continue;
      const provider = installedProvider(graph, graph.nodes.get(request.packagePath), packageName);
      if (!provider || !isValidVersion(provider.version)) continue;
      if (provider.manifest.name === name && satisfies(provider.version, range)) continue;
      const alias = resolveAlias(packageName, request.packagePath);
      if (alias?.originalName === name && satisfies(alias.resolvedVersion, range)) continue;
      const requester = request.path.join('>');
      const providerName = provider.manifest.name ?? packageName;
      diagnostics.push({
        code: 'PEER_PROVIDER_MISMATCH',
        severity: 'error',
        packageName,
        requestedBy: [requester],
        importerPaths: [request.packagePath],
        message: `${requester} requires ${name}@${range} but resolves to ${providerName}@${provider.version} at ${provider.packagePath}`,
      });
    }
  }
}

function validateDirectTransitivePeers(
  graph: InstalledDependencyGraph,
  detector: VersionSpecResolver,
  diagnostics: ResolverDiagnostic[],
  resolveAlias: ResolveAlias,
): void {
  const configured = new Set(graph.roots);
  const reported = new Set<string>();
  for (const [name, instances] of graph.rootRequests) {
    for (const [rootId, requests] of instances) {
      const root = graph.nodes.get(rootId);
      const request = requests[0];
      if (!root || !request) continue;
      const rootPeers = root.peerDependenciesByName.get(name);
      const dependencies = { ...root.manifest.dependencies, ...root.manifest.optionalDependencies };
      for (const dependency of Object.keys(dependencies)) {
        const child = installedProvider(graph, root, dependency);
        if (!child || configured.has(child.id)) continue;
        for (const [peer, entry] of child.peerDependenciesByName.get(dependency) ?? []) {
          if (entry.optional || rootPeers?.has(peer)) continue;
          const { name: expected, range } = resolveDependencyRequirement(
            peer,
            entry.range,
            detector,
          );
          const actual = installedProvider(graph, child, peer);
          const alias = resolveAlias(peer, child.packagePath);
          const version = alias?.resolvedVersion ?? actual?.version;
          const providerName = alias?.originalName ?? actual?.manifest.name ?? peer;
          if (!version || !isValidVersion(version)) continue;
          if (providerName === expected && satisfies(version, range)) continue;
          const key = JSON.stringify([rootId, child.id, peer, range]);
          if (reported.has(key)) continue;
          reported.add(key);
          const requester = [...request.path, dependency].join('>');
          diagnostics.push({
            code: 'TRANSITIVE_PEER_CONFLICT',
            severity: 'warning',
            packageName: peer,
            requestedBy: [requester],
            importerPaths: [child.packagePath],
            message: `${requester} requires ${expected}@${range} but resolves to ${providerName}@${version}. Configure ${dependency} as an entry or declare its peer constraint with peerOverrides.`,
          });
        }
      }
    }
  }
}
