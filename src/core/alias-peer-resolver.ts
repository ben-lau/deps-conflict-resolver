import { join } from 'node:path';
import type {
  AliasMapping,
  DependencyPath,
  PackageJson,
  PeerConflict,
  ResolvedOptions,
  ResolverDiagnostic,
} from '../types';
import { canonicalPath, findPackagePath, readPackageJsonCached } from '../utils/fs';
import { getEffectivePeerDependencies } from '../utils/peer-overrides';
import { satisfies } from '../utils/semver';
import { matchesProvider, resolveDependencyRequirement } from '../utils/version-spec';
import { createWorkspaceDetector } from './workspace-detector';
import type { RegistryClient } from './registry-client';
import { createDirectoryScopeMatcher } from './scope-paths';

export interface PlannedAlias {
  mapping: AliasMapping;
  consumers: readonly DependencyPath[];
  inheritedMismatches?: readonly string[];
}

interface ConsumerPeerContext {
  consumer: string;
  directory: string;
  redirects: AliasMapping[];
}

export type ConsumerPeerLookup = (plan: PlannedAlias, peerName: string) => ConsumerPeerContext[];

export interface AliasPeerLinks {
  diagnostics: ResolverDiagnostic[];
  consumerMismatches: ReadonlySet<PlannedAlias>;
  conflictingAliases: ReadonlySet<string>;
  publish(): void;
}

export function samePeerConsumer(a: DependencyPath, b: DependencyPath): boolean {
  return a.packagePath && b.packagePath
    ? a.packagePath === b.packagePath
    : a.path.join('>') === b.path.join('>');
}

export function peerConsumerDirectory(request: DependencyPath, projectRoot: string): string | null {
  if (request.packagePath) return request.packagePath;
  let directory = projectRoot;
  for (const name of request.path) {
    const path = findPackagePath(name, directory);
    if (!path) return null;
    directory = canonicalPath(path);
  }
  return directory;
}

/** Match the consumer against the same scopes used by the runtime resolver. */
export function createConsumerPeerLookup(
  plans: readonly PlannedAlias[],
  options: ResolvedOptions,
  conflicts: readonly PeerConflict[],
): ConsumerPeerLookup {
  const requestsByPeer = new Map(
    conflicts.map(({ packageName, requestedBy }) => [packageName, requestedBy]),
  );
  const mappings = plans.map(({ mapping }) => mapping);
  const aliases = new Map(mappings.map((mapping) => [mapping.aliasName, mapping]));
  let matchDirectory: ReturnType<typeof createDirectoryScopeMatcher> | undefined;

  return ({ mapping, consumers }, peerName) => {
    const requests = requestsByPeer.get(peerName);
    if (!requests) return [];
    const contexts: ConsumerPeerContext[] = [];
    for (const owner of consumers) {
      if (!requests.some((request) => samePeerConsumer(owner, request))) continue;
      const directory = peerConsumerDirectory(owner, options.projectRoot);
      if (!directory) continue;
      matchDirectory ??= createDirectoryScopeMatcher(mappings, options);
      const alias = matchDirectory(mapping.originalName, directory);
      if (alias.reason === 'excluded' || !alias.aliases.includes(mapping.aliasName)) continue;
      const peer = matchDirectory(peerName, directory);
      const redirects =
        peer.reason === 'redirected' || peer.reason === 'ambiguous'
          ? peer.aliases.map((name) => aliases.get(name)!)
          : [];
      contexts.push({ consumer: owner.path.join('>'), directory, redirects });
    }
    return contexts;
  };
}

/**
 * Link the peers of the selected versions, never those of the host versions.
 * Installed aliases work offline; only new aliases need registry manifests.
 */
export async function planAliasPeerLinks(
  plans: readonly PlannedAlias[],
  options: ResolvedOptions,
  registry: RegistryClient,
  lookupConsumers: ConsumerPeerLookup,
  watchFiles?: Set<string>,
): Promise<AliasPeerLinks> {
  const diagnostics: ResolverDiagnostic[] = [];
  const consumerMismatches = new Set<PlannedAlias>();
  const conflictingAliases = new Set<string>();
  const mappings = plans.map(({ mapping }) => mapping);
  const readManifest = (directory: string) => {
    watchFiles?.add(join(canonicalPath(directory), 'package.json'));
    return readPackageJsonCached(directory);
  };
  const workspace = createWorkspaceDetector(options.projectRoot);
  const workspaceRoot = workspace.getWorkspaceRoot();
  const manifests = new Map<AliasMapping, PackageJson>();
  const installedPaths = new Map<AliasMapping, string>();
  const links: Array<{ provider: AliasMapping; importer: string; paths: string[] }> = [];

  for (const mapping of mappings) {
    const installedPath = findPackagePath(mapping.aliasName, options.projectRoot);
    const installed = installedPath ? readManifest(installedPath) : null;
    if (
      installedPath &&
      matchesProvider(installed, mapping.originalName, mapping.resolvedVersion)
    ) {
      manifests.set(mapping, installed);
      installedPaths.set(mapping, installedPath);
      continue;
    }
    if (mapping.installSpec && !options.offline && registry.fetchPackageManifest) {
      try {
        const manifest = await registry.fetchPackageManifest(
          mapping.originalName,
          mapping.resolvedVersion,
          options.registry,
        );
        manifests.set(mapping, manifest);
      } catch (error) {
        diagnostics.push({
          code: 'ALIAS_METADATA_UNAVAILABLE',
          severity: 'error',
          packageName: mapping.originalName,
          aliases: [mapping.aliasName],
          message:
            'Cannot inspect selected version ' +
            mapping.originalName +
            '@' +
            mapping.resolvedVersion +
            ': ' +
            String(error),
        });
      }
    }
  }

  for (const plan of plans) {
    const { mapping: importer } = plan;
    const manifest = manifests.get(importer);
    if (!manifest) continue;
    const importerPaths = new Set([
      join(options.projectRoot, 'node_modules', importer.aliasName),
      join(canonicalPath(options.projectRoot), 'node_modules', importer.aliasName),
    ]);
    if (workspaceRoot) importerPaths.add(join(workspaceRoot, 'node_modules', importer.aliasName));
    const installedPath = installedPaths.get(importer);
    if (installedPath) importerPaths.add(canonicalPath(installedPath));
    // Registry manifests describe peers, but only installation establishes
    // nested providers. Do not reject an install that can supply those peers.
    const pendingInstallation = !installedPath && options.autoInstall && importer.installSpec;

    const effectivePeers = getEffectivePeerDependencies(
      manifest.name ? manifest : { ...manifest, name: importer.originalName },
      importer.aliasName,
      options.peerOverrides,
      manifest.version ?? importer.resolvedVersion,
    );

    for (const [peerName, { range: spec, optional }] of effectivePeers) {
      if (optional) continue;
      const { name, range } = resolveDependencyRequirement(peerName, spec, workspace);
      // A shared physical alias cannot change runtime according to its caller.
      // Include consumers satisfied by the host; they have no alias mapping.
      const providers = new Map<string, string[]>();
      const providerAliases = new Set<string>();
      const conflicts = new Set<string>();
      const redirectAllowed = !options.excludeRedirects[peerName]?.includes(importer.aliasName);
      if (redirectAllowed) {
        for (const { consumer, directory, redirects } of lookupConsumers(plan, peerName)) {
          if (redirects.length > 0) {
            for (const mapping of redirects) {
              const label = consumer + ' -> ' + mapping.aliasName + '@' + mapping.resolvedVersion;
              if (mapping.originalName !== name || !satisfies(mapping.resolvedVersion, range)) {
                conflicts.add(label);
                conflictingAliases.add(importer.aliasName);
                conflictingAliases.add(mapping.aliasName);
                continue;
              }
              const path = canonicalPath(
                findPackagePath(mapping.aliasName, options.projectRoot) ??
                  join(options.projectRoot, 'node_modules', mapping.aliasName),
              );
              providers.set(path, [...(providers.get(path) ?? []), label]);
              providerAliases.add(mapping.aliasName);
            }
          } else {
            const path = findPackagePath(peerName, directory);
            const provider = path ? readManifest(path) : null;
            if (path && matchesProvider(provider, name, range)) {
              const identity = canonicalPath(path);
              providers.set(identity, [
                ...(providers.get(identity) ?? []),
                consumer + ' -> ' + peerName + '@' + provider.version,
              ]);
            }
          }
        }
      }
      if (conflicts.size > 0) {
        consumerMismatches.add(plan);
        diagnostics.push({
          code: 'ALIAS_PEER_UNSATISFIED',
          severity: 'error',
          packageName: peerName,
          aliases: [importer.aliasName],
          requestedBy: [importer.aliasName],
          importerPaths: [...importerPaths],
          message: `${importer.aliasName} requires ${name}@${range}, but its consumers redirect to ${[...conflicts].join(', ')}`,
        });
      }
      if (providers.size > 1) {
        diagnostics.push({
          code: 'AMBIGUOUS_IMPORTER',
          severity: 'error',
          packageName: peerName,
          aliases: [...providerAliases].sort(),
          requestedBy: [importer.aliasName],
          importerPaths: [...importerPaths],
          message:
            'Conflicting consumer peer contexts for ' +
            importer.aliasName +
            ': ' +
            [...providers.values()].flat().join('; '),
        });
        continue;
      }
      const plannedProviders = redirectAllowed
        ? mappings.filter(
            (mapping) =>
              mapping !== importer &&
              mapping.originalName === peerName &&
              mapping.originalName === name,
          )
        : [];
      let candidates = plannedProviders.filter((mapping) =>
        satisfies(mapping.resolvedVersion, range),
      );
      const sharedContexts = candidates.filter((candidate) =>
        providerAliases.has(candidate.aliasName),
      );
      if (sharedContexts.length > 0) {
        candidates = sharedContexts;
      } else {
        // A foreign consumer's alias is only a fallback. Preserve a compatible
        // provider visible from this package instead of crossing peer contexts.
        const naturalPath = findPackagePath(peerName, installedPath ?? options.projectRoot);
        const natural = naturalPath ? readManifest(naturalPath) : null;
        if (matchesProvider(natural, name, range)) continue;
      }

      if (candidates.length === 1) {
        const peer = candidates[0]!;
        if (peer.importerPaths === undefined) continue;
        links.push({ provider: peer, importer: importer.aliasName, paths: [...importerPaths] });
        continue;
      }

      if (candidates.length > 1) {
        diagnostics.push({
          code: 'AMBIGUOUS_IMPORTER',
          severity: pendingInstallation ? 'warning' : 'error',
          packageName: peerName,
          aliases: candidates.map((candidate) => candidate.aliasName).sort(),
          requestedBy: [importer.aliasName],
          importerPaths: [...importerPaths],
          message:
            'Multiple peer contexts for ' +
            importer.aliasName +
            ' requiring ' +
            peerName +
            '@' +
            range,
        });
        continue;
      }

      if (conflicts.size > 0) continue;
      // Independent entry packages can require a common provider even when
      // the consumers of this alias never redirect this peer themselves.
      if (!pendingInstallation && plannedProviders.length > 0) {
        conflictingAliases.add(importer.aliasName);
        for (const provider of plannedProviders) conflictingAliases.add(provider.aliasName);
      }
      diagnostics.push({
        code: 'ALIAS_PEER_UNSATISFIED',
        severity: pendingInstallation ? 'warning' : 'error',
        packageName: peerName,
        requestedBy: [importer.aliasName],
        message:
          importer.aliasName +
          ' requires ' +
          peerName +
          '@' +
          range +
          (pendingInstallation
            ? '; provider availability will be checked after installation'
            : ', but no compatible alias or installed provider is available'),
      });
    }
  }

  return {
    diagnostics,
    consumerMismatches,
    conflictingAliases,
    publish() {
      for (const mapping of mappings) mapping.peerImporterPaths = {};
      for (const { provider, importer, paths } of links) {
        const pathSet = new Set(paths);
        provider.importerPaths = [...new Set([...(provider.importerPaths ?? []), ...paths])];
        if (provider.excludedImporterPaths?.length) {
          provider.excludedImporterPaths = provider.excludedImporterPaths.filter(
            (excludedPath) => !pathSet.has(excludedPath),
          );
        }
        provider.peerImporterPaths = { ...provider.peerImporterPaths, [importer]: paths };
      }
    },
  };
}
