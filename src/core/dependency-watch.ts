import { dirname, isAbsolute, join } from 'node:path';
import { LOCK_FILE_MAP } from '../constants';
import type { AliasMapping, AnalysisResult } from '../types';
import {
  observeLockfile,
  observedLookupDirectory,
  type DependencyInputs,
} from '../utils/dependency-inputs';
import {
  canonicalPath,
  fileExists,
  findPackagePath,
  findProjectRoot,
  iterateParentDirs,
  readPackageJsonCached,
  type PackageLookupTrace,
} from '../utils/fs';
import { parseNpmAlias } from '../utils/version-spec';
import { getProjectPreparation } from './project-preparation';

export interface WatchChanges {
  modifiedFiles?: ReadonlySet<string>;
  removedFiles?: ReadonlySet<string>;
}

export interface WatchedFiles {
  existing: Set<string>;
  missing: Set<string>;
  providerFiles: Set<string>;
  missingProviderParents: Map<string, string>;
  selectedPackages: Map<string, { manifest?: string; path: string | null }>;
}

export function observeProjectLockfiles(projectRoot: string, owner: string) {
  const existing = new Set<string>();
  const missing = new Set<string>();
  let inPreparationOwner = true;
  for (const directory of iterateParentDirs(projectRoot)) {
    for (const name of Object.keys(LOCK_FILE_MAP)) {
      const file = join(directory, name);
      if (observeLockfile(file)) existing.add(file);
      else if (inPreparationOwner) missing.add(file);
    }
    if (directory === owner) inPreparationOwner = false;
  }
  return { existing, missing };
}

function watchFiles(projectRoot: string, owner: string): WatchedFiles {
  return {
    ...observeProjectLockfiles(projectRoot, owner),
    providerFiles: new Set(),
    missingProviderParents: new Map(),
    selectedPackages: new Map(),
  };
}

export interface AnalysisSnapshot {
  result: AnalysisResult;
  revision: number;
  key: string;
  inputs: DependencyInputs;
}

/** Tracks dependency observations and recovery files across watch compilations. */
export class DependencyWatch {
  snapshot?: AnalysisSnapshot;
  files?: WatchedFiles;

  candidate(
    key: string | undefined,
    { modifiedFiles, removedFiles }: WatchChanges,
  ): AnalysisSnapshot | undefined {
    const previous = this.snapshot;
    return previous?.inputs.reusable &&
      previous.key === key &&
      [...(modifiedFiles ?? []), ...(removedFiles ?? [])].every(
        (file) => isAbsolute(file) && !previous.inputs.includes(file),
      )
      ? previous
      : undefined;
  }

  close(): void {
    this.snapshot = undefined;
    this.files = undefined;
  }

  recordFiles(
    projectRoot: string,
    owner: string,
    analysis: AnalysisResult | null,
    entries: readonly string[],
    activeAliases: readonly AliasMapping[],
    failed: boolean,
  ): void {
    const watched = watchFiles(projectRoot, owner);
    const manifestFiles = analysis?.watchFiles ?? [];
    if (failed) {
      this.addRecoveryWatchFiles(watched, this.files, manifestFiles);
    } else {
      for (const file of manifestFiles) watched.existing.add(file);
    }
    const hostDirectories = new Set([...iterateParentDirs(projectRoot), owner]);
    const observed = new Set<string>();
    const watchProvider = (base: string, name: string, selected = true) => {
      const key = base + '\0' + name;
      if (observed.has(key)) return;
      observed.add(key);
      const trace: PackageLookupTrace = { missing: new Map() };
      const path = findPackagePath(name, base, undefined, trace);
      if (selected) watched.selectedPackages.set(key, { manifest: trace.manifest, path });
      if (trace.manifest && path) {
        watched.providerFiles.add(trace.manifest);
        watched.existing.add(trace.manifest);
        watched.existing.add(join(path, 'package.json'));
        const installed = dirname(trace.manifest);
        if (installed !== path) watched.existing.add(installed);
      }
      for (const [file, directory] of trace.missing) {
        watched.providerFiles.add(file);
        watched.missing.add(file);
        let parent = dirname(file);
        const boundary = dirname(directory);
        while (parent !== boundary && !observedLookupDirectory(parent)) parent = dirname(parent);
        // An existing linked consumer can anchor its own missing node_modules.
        // Avoid recursively watching the host or workspace root for this.
        const linkedConsumer =
          parent === base && directory === join(base, 'node_modules') && !hostDirectories.has(base);
        if (
          (linkedConsumer || /[/\\]node_modules(?:[/\\]|$)/.test(parent)) &&
          observedLookupDirectory(parent)
        ) {
          watched.missingProviderParents.set(file, parent);
        }
      }
    };
    for (const name of entries) watchProvider(projectRoot, name);
    for (const mapping of activeAliases) watchProvider(projectRoot, mapping.aliasName);
    const peers = new Set<string>();
    for (const conflict of analysis?.peerConflicts ?? []) {
      peers.add(conflict.packageName);
      watchProvider(projectRoot, conflict.packageName);
      for (const request of conflict.requestedBy) {
        if (request.packagePath) watchProvider(request.packagePath, conflict.packageName);
      }
    }
    // Rollup builds its Chokidar ignore patterns once. Include relevant
    // declared alias slots even when the first analysis needs no redirect.
    if (peers.size > 0) {
      for (const base of new Set([projectRoot, owner])) {
        const manifest = readPackageJsonCached(base);
        const declarations = {
          ...manifest?.dependencies,
          ...manifest?.devDependencies,
          ...manifest?.optionalDependencies,
        };
        for (const [name, spec] of Object.entries(declarations)) {
          const alias = typeof spec === 'string' && parseNpmAlias(spec);
          if (alias && peers.has(alias[0])) watchProvider(projectRoot, name, false);
        }
      }
    }
    this.files = watched;
  }

  recover(
    requestedRoot: string,
    previous: WatchedFiles | undefined,
    partial: readonly string[] = [],
  ): void {
    const root = canonicalPath(findProjectRoot(requestedRoot) ?? requestedRoot);
    const owner = getProjectPreparation(root).owner;
    const watched = watchFiles(root, owner);
    // These paths only wake up a later compilation. The failed generation
    // cannot supply a reusable analysis snapshot.
    this.addRecoveryWatchFiles(watched, previous, [
      join(requestedRoot, 'package.json'),
      join(root, 'package.json'),
      join(owner, 'package.json'),
      ...partial,
    ]);
    this.files = watched;
  }

  private addRecoveryWatchFiles(
    watched: WatchedFiles,
    previous: WatchedFiles | undefined,
    files: readonly string[],
  ): void {
    for (const file of new Set([
      ...(previous?.existing ?? []),
      ...(previous?.missing ?? []),
      ...files,
    ])) {
      if (watched.existing.has(file) || watched.missing.has(file)) continue;
      (fileExists(file) ? watched.existing : watched.missing).add(file);
    }
    for (const [file, parent] of previous?.missingProviderParents ?? []) {
      if (watched.missing.has(file) && observedLookupDirectory(parent))
        watched.missingProviderParents.set(file, parent);
    }
  }
}
