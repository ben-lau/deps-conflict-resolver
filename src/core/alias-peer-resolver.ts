import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { AliasMapping, PackageJson, ResolverDiagnostic } from '../types';
import { findPackagePath, readPackageJsonCached } from '../utils/fs';
import { satisfies } from '../utils/semver';
import { createWorkspaceDetector } from './workspace-detector';
import type { RegistryClient } from './registry-client';

interface PeerLinkOptions {
  projectRoot: string;
  registry: string;
  offline?: boolean;
}

function actualPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Link the peers of the selected versions, never those of the host versions.
 * Installed aliases work offline; only new aliases need registry manifests.
 */
export async function linkAliasPeers(
  mappings: AliasMapping[],
  options: PeerLinkOptions,
  registry: RegistryClient,
  diagnostics: ResolverDiagnostic[],
): Promise<void> {
  if (mappings.length === 0) return;
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

  for (const mapping of mappings) {
    const installedPath = findPackagePath(mapping.aliasName, options.projectRoot);
    const installed = installedPath ? readPackageJsonCached(installedPath) : null;
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
      join(actualPath(options.projectRoot), 'node_modules', importer.aliasName),
    ]);
    if (workspaceRoot) importerPaths.add(join(workspaceRoot, 'node_modules', importer.aliasName));
    const installedPath = installedPaths.get(importer);
    if (installedPath) importerPaths.add(actualPath(installedPath));

    for (const [peerName, range] of Object.entries(manifest.peerDependencies ?? {})) {
      if (manifest.peerDependenciesMeta?.[peerName]?.optional) continue;
      let candidates = mappings.filter(
        (mapping) =>
          mapping !== importer &&
          mapping.originalName === peerName &&
          satisfies(mapping.resolvedVersion, range),
      );
      const sharedContexts = candidates.filter((candidate) =>
        candidate.usedBy.some((consumer) => importer.usedBy.includes(consumer)),
      );
      if (sharedContexts.length > 0) candidates = sharedContexts;

      if (candidates.length === 1) {
        const peer = candidates[0]!;
        if (peer.importerPaths === undefined) continue;
        const paths = [...importerPaths];
        peer.importerPaths = [...new Set([...peer.importerPaths, ...paths])];
        peer.peerImporterPaths = {
          ...peer.peerImporterPaths,
          [importer.aliasName]: paths,
        };
        continue;
      }

      if (candidates.length > 1) {
        diagnostics.push({
          code: 'AMBIGUOUS_IMPORTER',
          severity: 'error',
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

      const naturalPath = findPackagePath(peerName, installedPath ?? options.projectRoot);
      const natural = naturalPath ? readPackageJsonCached(naturalPath) : null;
      if (!natural?.version || !satisfies(natural.version, range)) {
        diagnostics.push({
          code: 'ALIAS_PEER_UNSATISFIED',
          severity: 'error',
          packageName: peerName,
          requestedBy: [importer.aliasName],
          message:
            importer.aliasName +
            ' requires ' +
            peerName +
            '@' +
            range +
            ', but no compatible alias or installed provider is available',
        });
      }
    }
  }
}
