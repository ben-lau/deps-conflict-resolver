import { join } from 'node:path';
import type { AliasMapping, PackageJson, ResolvedOptions, ResolverDiagnostic } from '../types';
import {
  getInstalledDependencyRequirements,
  type InstalledDependencyGraph,
  type InstalledPackageNode,
} from './dependency-graph';
import { createDirectoryScopeMatcher } from './scope-paths';
import { createWorkspaceDetector, type WorkspaceDetector } from './workspace-detector';
import { canonicalPath, findPackagePath, readPackageJsonCached } from '../utils/fs';
import { getEffectivePeerDependencies } from '../utils/peer-overrides';
import { isValidRange, satisfies } from '../utils/semver';
import { resolveDependencyRequirement, type VersionSpecResolver } from '../utils/version-spec';

interface Provider {
  path: string;
  version: string;
  label: string;
}

interface ConfiguredPeerRequest {
  nodeId: string;
  nodeName: string;
  manifestName?: string;
  packagePath: string;
  requestPath: string[];
  range: string;
}

interface PeerValidation {
  graph: InstalledDependencyGraph;
  options: ResolvedOptions;
  diagnostics: ResolverDiagnostic[];
  detector: VersionSpecResolver;
  aliases: ReadonlyMap<string, Provider>;
  aliasPaths: ReadonlySet<string>;
  originals: ReadonlySet<string>;
  readManifest: (directory: string) => PackageJson | null;
  getMatcher: () => ReturnType<typeof createDirectoryScopeMatcher>;
}

function matchesPackageName(node: InstalledPackageNode, names: readonly string[] = []): boolean {
  return names.some((name) => name === node.manifest.name || node.peerDependenciesByName.has(name));
}

/**
 * Validate provider selection for configured entries and pruned descendants.
 * Shared contexts and descendant manifest mismatches are advisory before actual
 * imports are known. Conflicting overrides on one configured importer are errors.
 */
export function validateSharedPeerContexts(
  graph: InstalledDependencyGraph,
  mappings: AliasMapping[],
  options: ResolvedOptions,
  diagnostics: ResolverDiagnostic[],
  watchFiles?: Set<string>,
  workspaceDetector?: Pick<WorkspaceDetector, 'resolveVersionSpec'>,
  inheritedMismatchesByAlias?: ReadonlyMap<string, readonly string[]>,
): void {
  if (mappings.length === 0) return;
  const host = readPackageJsonCached(options.projectRoot);
  const hostConsumers = findHostConsumers(graph, host, options.projectRoot);
  if (
    graph.roots.length < 2 &&
    graph.rootRequests.size < 2 &&
    hostConsumers.length === 0 &&
    !inheritedMismatchesByAlias?.size &&
    !mappings.some((mapping) => mapping.excludedImporterPaths?.length)
  ) {
    return;
  }
  const detector = workspaceDetector ?? createWorkspaceDetector(options.projectRoot);
  const readManifest = (directory: string): PackageJson | null => {
    watchFiles?.add(join(directory, 'package.json'));
    return readPackageJsonCached(directory);
  };
  const aliases = new Map<string, Provider>();
  const installedMappings = mappings.filter((mapping) => {
    if (mapping.installSpec) return false;
    const path = findPackagePath(mapping.aliasName, options.projectRoot);
    if (!path) return false;
    const physical = canonicalPath(path);
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
  const aliasPaths = new Set([...aliases.values()].map((provider) => provider.path));
  const originals = new Set(installedMappings.map((mapping) => mapping.originalName));
  const requests: Array<[string, string[]]> = [];
  for (const instances of graph.rootRequests.values()) {
    for (const [nodeId, rootRequests] of instances) {
      for (const { path } of rootRequests) requests.push([nodeId, path]);
    }
  }

  let matchDirectory: ReturnType<typeof createDirectoryScopeMatcher> | undefined;
  const getMatcher = () =>
    (matchDirectory ??= createDirectoryScopeMatcher(installedMappings, options));

  const installationPending =
    options.autoInstall && !options.offline && mappings.some((mapping) => mapping.installSpec);
  const validation: PeerValidation = {
    graph,
    options,
    diagnostics,
    detector,
    aliases,
    aliasPaths,
    originals,
    readManifest,
    getMatcher,
  };
  if (!installationPending) {
    validateDescendantProviders(validation, installedMappings, inheritedMismatchesByAlias);
    validateHostConsumers(
      validation,
      installedMappings,
      host?.name ?? options.projectRoot,
      hostConsumers,
    );
  }

  for (const peer of originals) {
    const candidateRoots: ConfiguredPeerRequest[] = [];
    for (const [nodeId, requestPath] of requests) {
      const node = graph.nodes.get(nodeId);
      if (!node) continue;
      const name = requestPath.at(-1) ?? node.name;
      const effectivePeer = node.peerDependenciesByName.get(name)?.get(peer);
      if (!effectivePeer || effectivePeer.optional) continue;
      candidateRoots.push({
        nodeId,
        nodeName: name,
        manifestName: node.manifest.name,
        packagePath: node.packagePath,
        requestPath,
        range: resolveDependencyRequirement(peer, effectivePeer.range, detector).range,
      });
    }
    if (!installationPending && graph.rootRequests.size > 1) {
      validateConfiguredImporterAliases(validation, peer, candidateRoots);
    }
    validateSharedContexts(validation, peer, candidateRoots, installedMappings);
  }
}

function findHostConsumers(
  graph: InstalledDependencyGraph,
  host: PackageJson | null,
  root: string,
): Array<{ node: InstalledPackageNode; request: string }> {
  const dependencies = { ...host?.dependencies, ...host?.optionalDependencies };
  const roots = new Set(graph.roots);
  const consumers: Array<{ node: InstalledPackageNode; request: string }> = [];
  for (const request of Object.keys(dependencies)) {
    const installed = findPackagePath(request, root);
    const node = installed ? graph.nodes.get(canonicalPath(installed)) : undefined;
    if (node && !roots.has(node.id)) consumers.push({ node, request });
  }
  return consumers;
}

function validateHostConsumers(
  validation: PeerValidation,
  mappings: readonly AliasMapping[],
  host: string,
  consumers: Array<{ node: InstalledPackageNode; request: string }>,
): void {
  const { graph, options, diagnostics, detector, aliases, originals, getMatcher } = validation;
  for (const { node, request } of consumers) {
    const requirements =
      node.peerDependenciesByName.get(request) ??
      getEffectivePeerDependencies(node.manifest, request, options.peerOverrides);
    for (const peer of originals) {
      if (matchesPackageName(node, options.includeRedirects[peer])) continue;
      const requirement = requirements.get(peer);
      if (!requirement || requirement.optional) continue;
      const providerId = node.resolvedChildren.get(peer);
      const natural = providerId ? graph.nodes.get(providerId) : undefined;
      const { range, name } = resolveDependencyRequirement(peer, requirement.range, detector);
      if (!natural || natural.manifest.name !== name || !satisfies(natural.version, range))
        continue;
      const { resolved } = getMatcher()(peer, node.packagePath);
      const alias = resolved ? aliases.get(resolved) : undefined;
      if (!alias || alias.path === natural.id) continue;
      const mapping = mappings.find(({ aliasName }) => aliasName === resolved);
      diagnostics.push({
        code: 'SHARED_PEER_CONTEXT',
        severity: 'warning',
        packageName: peer,
        requestedBy: [host + '>' + request, ...(mapping?.usedBy ?? [])],
        importerPaths: [node.packagePath],
        message: `Host dependency ${request} shares an installed instance with a redirected subtree. The ${peer} provider changes from ${natural.version} to ${alias.label}. Isolate the package or configure its redirect scope.`,
      });
    }
  }
}

function validateDescendantProviders(
  validation: PeerValidation,
  installedMappings: readonly AliasMapping[],
  inheritedMismatchesByAlias: ReadonlyMap<string, readonly string[]> | undefined,
): void {
  const { graph, options, diagnostics, detector, aliases, getMatcher } = validation;
  const pathsByPeer = new Map<string, Map<string, 'pruned' | 'inherited'>>();
  for (const mapping of installedMappings) {
    const inherited = inheritedMismatchesByAlias?.get(mapping.aliasName) ?? [];
    const pruned = mapping.excludedImporterPaths ?? [];
    if (!inherited.length && !pruned.length) continue;
    let paths = pathsByPeer.get(mapping.originalName);
    if (!paths) pathsByPeer.set(mapping.originalName, (paths = new Map()));
    for (const path of pruned) {
      if (!paths.has(path)) paths.set(path, 'pruned');
    }
    for (const path of inherited) paths.set(path, 'inherited');
  }
  for (const [peer, paths] of pathsByPeer) {
    const singleAlias =
      installedMappings.filter((mapping) => mapping.originalName === peer).length === 1;
    const explicit = [
      ...(options.includeRedirects[peer] ?? []),
      ...(options.excludeRedirects[peer] ?? []),
    ];
    for (const [path, kind] of paths) {
      const node = graph.nodes.get(path);
      if (!node || matchesPackageName(node, explicit)) {
        continue;
      }

      const requirements = getInstalledDependencyRequirements(node, peer, detector).filter(
        (requirement) =>
          !requirement.optional && requirement.name === peer && isValidRange(requirement.range),
      );
      if (requirements.length === 0) continue;

      const providerId = node.resolvedChildren.get(peer);
      const natural = providerId ? graph.nodes.get(providerId)?.manifest : undefined;
      const naturalVersion = natural?.version;
      const naturalMatches =
        naturalVersion &&
        (!natural?.name || natural.name === peer) &&
        requirements.every(({ range }) => satisfies(naturalVersion, range));
      if (naturalMatches && singleAlias && kind === 'pruned') continue;

      const decision = getMatcher()(peer, path);
      if (decision.reason === 'excluded' || decision.reason === 'ambiguous') continue;
      const provider = decision.resolved ? aliases.get(decision.resolved) : undefined;
      if (
        decision.resolved
          ? provider && requirements.every(({ range }) => satisfies(provider.version, range))
          : naturalMatches
      ) {
        continue;
      }

      const ranges = [...new Set(requirements.map(({ range }) => range))];
      diagnostics.push({
        code: 'ALIAS_PEER_UNSATISFIED',
        // A manifest can declare a peer that is bundled internally or unused.
        severity: 'warning',
        packageName: peer,
        requestedBy: [node.name],
        importerPaths: [path],
        message: `${node.name} requires ${peer} (${ranges.join(', ')}), but no compatible provider is available in its redirect scope or installed dependencies`,
      });
    }
  }
}

function validateConfiguredImporterAliases(
  validation: PeerValidation,
  peer: string,
  candidateRoots: ConfiguredPeerRequest[],
): void {
  const { diagnostics, aliases, getMatcher } = validation;
  const requestsByPath = new Map<string, typeof candidateRoots>();
  for (const request of candidateRoots) {
    const matching = requestsByPath.get(request.packagePath) ?? [];
    matching.push(request);
    requestsByPath.set(request.packagePath, matching);
  }
  for (const [path, matching] of requestsByPath) {
    const names = new Set(matching.map(({ nodeName }) => nodeName));
    const ranges = new Set(matching.map(({ range }) => range).filter(isValidRange));
    if (names.size < 2) continue;

    const decision = getMatcher()(peer, path);
    const provider = decision.resolved ? aliases.get(decision.resolved) : undefined;
    if (
      decision.reason !== 'ambiguous' &&
      (!provider ||
        ranges.size < 2 ||
        [...ranges].every((range) => satisfies(provider.version, range)))
    )
      continue;

    diagnostics.push({
      code: 'AMBIGUOUS_IMPORTER',
      severity: 'error',
      packageName: peer,
      requestedBy: [...names].sort(),
      aliases: decision.aliases,
      importerPaths: [path],
      message: provider
        ? `One physical importer is configured under multiple names with ${peer} requirements that the selected ${provider.label} cannot satisfy (${[...ranges].join(', ')})`
        : `Multiple ${peer} aliases match the same configured importer: ${decision.aliases.join(', ')}`,
    });
  }
}

function validateSharedContexts(
  validation: PeerValidation,
  peer: string,
  candidateRoots: ConfiguredPeerRequest[],
  installedMappings: readonly AliasMapping[],
): void {
  const { graph, options, diagnostics, detector, aliases, aliasPaths, originals, readManifest } =
    validation;
  const excludedForPeer = options.excludeRedirects[peer] ?? [];
  const hasExclusions = excludedForPeer.length > 0;
  if (new Set(candidateRoots.map((entry) => entry.nodeId)).size < 2) return;

  // Fast path: if only one installed alias exists for this peer and every
  // candidate root is directly covered by that alias without being excluded,
  // all roots are guaranteed to share the same provider.
  const peerMappings = installedMappings.filter((mapping) => mapping.originalName === peer);
  if (peerMappings.length === 1 && peerMappings[0]!.importerPaths) {
    const aliasProvider = aliases.get(peerMappings[0]!.aliasName);
    const positivePaths = new Set(peerMappings[0]!.importerPaths);
    const prunedPaths = new Set(peerMappings[0]!.excludedImporterPaths ?? []);
    const isRootExcluded = (name: string, manifestName: string | undefined, packagePath: string) =>
      excludedForPeer.some(
        (excluded) =>
          excluded === name ||
          (manifestName !== undefined && excluded === manifestName) ||
          packagePath.replace(/\\/g, '/').includes('/node_modules/' + excluded + '/'),
      );
    if (
      aliasProvider &&
      candidateRoots.every(
        ({ nodeName, manifestName, packagePath, range }) =>
          positivePaths.has(packagePath) &&
          !prunedPaths.has(packagePath) &&
          !isRootExcluded(nodeName, manifestName, packagePath) &&
          satisfies(aliasProvider.version, range),
      )
    ) {
      return;
    }
  }

  const match = validation.getMatcher();
  const roots: Array<{ nodeId: string; consumer: string; provider: Provider }> = [];
  for (const { nodeId, packagePath, requestPath, range } of candidateRoots) {
    const decision = match(peer, packagePath);
    if (decision.reason === 'ambiguous') continue;
    let provider = decision.resolved ? aliases.get(decision.resolved) : undefined;
    if (!decision.resolved) {
      const path = findPackagePath(peer, packagePath);
      const natural = path ? readManifest(canonicalPath(path)) : null;
      if (path && natural?.version)
        provider = {
          path: canonicalPath(path),
          version: natural.version,
          label: peer + '@' + natural.version,
        };
    }
    if (provider && satisfies(provider.version, range))
      roots.push({ nodeId, consumer: requestPath.join('>'), provider });
  }
  if (new Set(roots.map(({ provider }) => provider.path)).size < 2) return;

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
      aliasPaths.has(context.provider.path) &&
      match(peer, node.packagePath).reason === 'excluded'
    )
      continue;
    const requirements = getInstalledDependencyRequirements(node, peer, detector);
    if (
      requirements.some(
        ({ name, range }) => name !== peer || !satisfies(context.provider.version, range),
      )
    ) {
      continue;
    }
    if (
      [...node.peerDependenciesByName.values()].some(
        (peers) => peers.get(peer)?.optional === false,
      ) &&
      !aliasPaths.has(node.packagePath) &&
      !matchesPackageName(node, options.includeRedirects[peer])
    ) {
      let incoming = contexts.get(node.id);
      if (!incoming) contexts.set(node.id, (incoming = new Map()));
      incoming.set(context.provider.path, context);
    }
    for (const child of node.resolvedChildren.values()) pending.push({ ...context, nodeId: child });
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
