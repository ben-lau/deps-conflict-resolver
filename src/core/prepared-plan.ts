import { createHash, randomUUID } from 'node:crypto';
import { openSync, closeSync, fstatSync, readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { version as resolverVersion } from '../../package.json';
import type { AnalysisResult, DependencyInfo, ResolvedOptions } from '../types';
import { DependencyInputs } from '../utils/dependency-inputs';
import { packageLookupPaths } from '../utils/fs';

// Bump this when the on-disk representation or compatible input probes change.
const FORMAT = 2;
const MAX_PLAN_BYTES = 32 * 1024 * 1024;
const CHECKSUM_LENGTH = 64;

export interface PreparedPlan {
  analysis: AnalysisResult;
  inputs: DependencyInputs;
}

export interface PlanWriteFailure {
  code:
    | 'PLAN_UNSUPPORTED'
    | 'PLAN_INPUT_LIMIT'
    | 'PLAN_INPUT_CHANGED'
    | 'PLAN_WRITE_FAILED'
    | 'PLAN_VERIFICATION_FAILED';
  message: string;
  observations?: number;
  observationLimit?: number;
}

export type PlanWriteResult =
  | { file: string; failure?: never }
  | { file?: never; failure: PlanWriteFailure };

function hash(text: string | Uint8Array): string {
  return createHash('sha256').update(text).digest('hex');
}

export function preparedPlanLocation(options: ResolvedOptions, owner: string): string | undefined {
  if (process.versions.pnp) return undefined;
  const {
    projectRoot,
    packageManager,
    dependencies,
    aliasPrefix,
    includeRedirects,
    excludeRedirects,
    peerOverrides,
  } = options;
  const lookupPaths = packageLookupPaths(projectRoot);
  if (!lookupPaths) return undefined;
  const key = hash(
    JSON.stringify([
      FORMAT,
      resolverVersion,
      process.platform,
      process.arch,
      process.versions.node,
      lookupPaths,
      process.execPath,
      owner,
      projectRoot,
      packageManager,
      dependencies,
      aliasPrefix,
      includeRedirects,
      excludeRedirects,
      peerOverrides,
    ]),
  );
  return join(projectRoot, 'node_modules', '.cache', 'deps-conflict-resolver', key + '.plan');
}

export async function preparePlanDirectory(file: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
}

type StoredAnalysis = Omit<AnalysisResult, 'analyzedDependencies'> & {
  analyzedDependencies: Array<[string, DependencyInfo]>;
};

export function readPreparedPlan(file: string): PreparedPlan | undefined {
  try {
    const descriptor = openSync(file, 'r');
    let contents: Buffer;
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.size > MAX_PLAN_BYTES) return undefined;
      contents = readFileSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    if (contents.length > MAX_PLAN_BYTES || contents[CHECKSUM_LENGTH] !== 0x0a) return undefined;
    const payload = contents.subarray(CHECKSUM_LENGTH + 1);
    if (hash(payload) !== contents.toString('ascii', 0, CHECKSUM_LENGTH)) return undefined;
    const stored = JSON.parse(payload.toString('utf8')) as {
      format: number;
      file: string;
      inputs: unknown;
      analysis: StoredAnalysis;
    };
    if (stored.format !== FORMAT || stored.file !== file) return undefined;
    const { analysis } = stored;
    if (
      !analysis ||
      !Array.isArray(analysis.analyzedDependencies) ||
      !Array.isArray(analysis.aliasMappings) ||
      !Array.isArray(analysis.peerConflicts) ||
      !Array.isArray(analysis.missingFirstLevelPeers)
    )
      return undefined;
    const inputs = DependencyInputs.deserialize(stored.inputs);
    if (!inputs?.matches()) return undefined;
    return {
      inputs,
      analysis: { ...analysis, analyzedDependencies: new Map(analysis.analyzedDependencies) },
    };
  } catch {
    // Incomplete, outdated and inaccessible caches share the offline fallback.
    return undefined;
  }
}

export async function writePreparedPlan(
  file: string,
  { analysis, inputs }: PreparedPlan,
): Promise<void> {
  const payload = JSON.stringify({
    format: FORMAT,
    file,
    analysis: { ...analysis, analyzedDependencies: [...analysis.analyzedDependencies] },
    inputs: inputs.serialize(),
  });
  const contents = hash(payload) + '\n' + payload;
  if (Buffer.byteLength(contents) > MAX_PLAN_BYTES)
    throw new Error('The dependency plan exceeds the cache size limit');

  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
