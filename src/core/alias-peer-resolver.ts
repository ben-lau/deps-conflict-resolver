import { join } from 'node:path';
import type {
  AliasMapping,
  PackageJson,
  PeerConflict,
  ResolvedOptions,
  ResolverDiagnostic,
} from '../types';
import { canonicalPath, findPackagePath, readPackageJsonCached } from '../utils/fs';
import { getEffectivePeerDependencies } from '../utils/peer-overrides';
import { satisfies } from '../utils/semver';
import { createWorkspaceDetector } from './workspace-detector';
import type { RegistryClient } from './registry-client';
import { AliasManager } from './alias-manager';

/**
 * Link the peers of the selected versions, never those of the host versions.
 * Installed aliases work offline; only new aliases need registry manifests.
 */
export async function linkAliasPeers(
  mappings: AliasMapping[],
  options: ResolvedOptions,
  registry: RegistryClient,
  diagnostics: ResolverDiagnostic[],
  peerConflicts: readonly PeerConflict[] = [],
  watchFiles?: Set<string>,
): Promise<void> {
  if (mappings.length === 0) return;
  const readManifest = (directory: string) => {
    watchFiles?.add(join(canonicalPath(directory), 'package.json'));
    return readPackageJsonCached(directory);
  };
  // Rebuild derived peer edges after installation or manifest changes. Keeping
  // the previous edges would give one importer two providers after a refresh.
  for (const mapping of mappings) {
    const previousPaths = new Set(Object.values(mapping.peerImporterPaths ?? {}).flat());
    if (mapping.importerPaths && previousPaths.size > 0) {
      mapping.importerPaths = mapping.importerPaths.filter((path) => !previousPaths.has(path));
    }
    mapping.peerImporterPaths = {};
  }
  const workspaceRoot = createWorkspaceDetector(options.projectRoot).getWorkspaceRoot();
  const manifests = new Map<AliasMapping, PackageJson>();
  const installedPaths = new Map<AliasMapping, string>();
  const consumerRequests = new Map(
    peerConflicts.map((conflict) => [conflict.packageName, conflict.requestedBy]),
  );
  let contextResolver: AliasManager | undefined;

  for (const mapping of mappings) {
    const installedPath = findPackagePath(mapping.aliasName, options.projectRoot);
    const installed = installedPath ? readManifest(installedPath) : null;
    if (
      installed?.name === mapping.originalName &&
      installed.version &&
      satisfies(installed.version, mapping.resolvedVersion)
    ) {
      manifests.set(mapping, installed);
      installedPaths.set(mapping, installedPath!);
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

  for (const [importer, manifest] of manifests) {
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
      manifest,
      importer.originalName,
      options.peerOverrides,
      manifest.version ?? importer.resolvedVersion,
    );

    for (const [peerName, { range, optional }] of effectivePeers) {
      if (optional) continue;
      // A shared physical alias cannot change runtime according to its caller.
      // Include consumers satisfied by the host; they have no alias mapping.
      const providers = new Map<string, string[]>();
      const providerAliases = new Set<string>();
      const checkContexts = importer.usedBy.length > 1 && consumerRequests.has(peerName);
      if (checkContexts) {
        for (const consumer of importer.usedBy) {
          const request = consumerRequests
            .get(peerName)
            ?.find((entry) => entry.path.join('>') === consumer);
          if (!request) continue;
          let directory: string | null = request.packagePath ?? options.projectRoot;
          if (!request.packagePath) {
            for (const name of request.path) {
              const packageDirectory = findPackagePath(name, directory);
              // Normalize legacy requests before probing a synthetic importer.
              directory = packageDirectory ? canonicalPath(packageDirectory) : null;
              if (!directory) break;
            }
          }
          if (!directory) continue;
          if (!contextResolver) {
            // Reuse the runtime matcher so include/exclude overrides and path
            // specificity have identical meaning during context validation.
            contextResolver = new AliasManager({ ...options, strict: false });
            contextResolver.initFromAnalysisResult({
              aliasMappings: mappings,
              peerConflicts: [...peerConflicts],
              analyzedDependencies: new Map(),
              missingFirstLevelPeers: [],
            });
          }
          const decision = contextResolver.explainResolution(
            peerName,
            join(directory, '__peer_context__.js'),
          );
          const selected =
            decision.reason === 'redirected' || decision.reason === 'ambiguous'
              ? mappings.filter((mapping) => decision.aliases.includes(mapping.aliasName))
              : [];
          if (selected.length > 0) {
            for (const mapping of selected) {
              if (!satisfies(mapping.resolvedVersion, range)) continue;
              const path = canonicalPath(
                findPackagePath(mapping.aliasName, options.projectRoot) ??
                  join(options.projectRoot, 'node_modules', mapping.aliasName),
              );
              providers.set(path, [
                ...(providers.get(path) ?? []),
                consumer + ' -> ' + mapping.aliasName + '@' + mapping.resolvedVersion,
              ]);
              providerAliases.add(mapping.aliasName);
            }
          } else {
            const path = findPackagePath(peerName, directory);
            const provider = path ? readManifest(path) : null;
            if (path && provider?.version && satisfies(provider.version, range)) {
              const identity = canonicalPath(path);
              providers.set(identity, [
                ...(providers.get(identity) ?? []),
                consumer + ' -> ' + peerName + '@' + provider.version,
              ]);
            }
          }
        }
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
      let candidates = mappings.filter(
        (mapping) =>
          mapping !== importer &&
          mapping.originalName === peerName &&
          satisfies(mapping.resolvedVersion, range),
      );
      const sharedContexts = candidates.filter((candidate) =>
        checkContexts
          ? providerAliases.has(candidate.aliasName)
          : candidate.usedBy.some((consumer) => importer.usedBy.includes(consumer)),
      );
      if (sharedContexts.length > 0) {
        candidates = sharedContexts;
      } else {
        // A foreign consumer's alias is only a fallback. Preserve a compatible
        // provider visible from this package instead of crossing peer contexts.
        const naturalPath = findPackagePath(peerName, installedPath ?? options.projectRoot);
        const natural = naturalPath ? readManifest(naturalPath) : null;
        if (natural?.version && satisfies(natural.version, range)) continue;
      }

      if (candidates.length === 1) {
        const peer = candidates[0]!;
        if (peer.importerPaths === undefined) continue;
        const paths = [...importerPaths];
        const pathSet = new Set(paths);
        peer.importerPaths = [...new Set([...peer.importerPaths, ...paths])];
        if (peer.excludedImporterPaths?.length) {
          peer.excludedImporterPaths = peer.excludedImporterPaths.filter(
            (excludedPath) => !pathSet.has(excludedPath),
          );
        }
        peer.peerImporterPaths = {
          ...peer.peerImporterPaths,
          [importer.aliasName]: paths,
        };
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
}
