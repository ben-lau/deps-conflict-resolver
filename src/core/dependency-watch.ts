import { isAbsolute, join } from 'node:path';
import { LOCK_FILE_MAP } from '../constants';
import type { AnalysisResult } from '../types';
import { observeLockfile, type DependencyInputs } from '../utils/dependency-inputs';
import { canonicalPath, fileExists, findProjectRoot, iterateParentDirs } from '../utils/fs';
import { getProjectPreparation } from './project-preparation';

export interface WatchChanges {
  modifiedFiles?: ReadonlySet<string>;
  removedFiles?: ReadonlySet<string>;
}

export interface WatchedFiles {
  existing: Set<string>;
  missing: Set<string>;
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

  private collectLockfiles(projectRoot: string, owner: string): WatchedFiles {
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

  recordFiles(
    projectRoot: string,
    owner: string,
    manifestFiles: readonly string[],
    failed: boolean,
  ): void {
    const watched = this.collectLockfiles(projectRoot, owner);
    if (failed) {
      this.addRecoveryWatchFiles(watched, this.files, manifestFiles);
    } else {
      for (const file of manifestFiles) watched.existing.add(file);
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
    const watched = this.collectLockfiles(root, owner);
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
  }
}
