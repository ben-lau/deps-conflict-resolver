import { createHash, randomUUID } from 'node:crypto';
import { openSync, closeSync, fstatSync, readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { version as resolverVersion } from '../../package.json';
import type { AnalysisResult, DependencyInfo, ResolvedOptions } from '../types';
import { DependencyInputs } from '../utils/dependency-inputs';

// Bump this when the on-disk representation or compatible input probes change.
const FORMAT = 1;
const MAX_PLAN_BYTES = 32 * 1024 * 1024;

export interface PreparedPlan {
  analysis: AnalysisResult;
  inputs: DependencyInputs;
}

function hash(text: string): string {
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
  const key = hash(
    JSON.stringify([
      FORMAT,
      resolverVersion,
      process.platform,
      process.arch,
      process.versions.node,
      process.env.NODE_PATH,
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
  return join(projectRoot, 'node_modules', '.cache', 'deps-conflict-resolver', key + '.json');
}

type StoredAnalysis = Omit<AnalysisResult, 'analyzedDependencies'> & {
  analyzedDependencies: Array<[string, DependencyInfo]>;
};

export function readPreparedPlan(file: string): PreparedPlan | undefined {
  try {
    const descriptor = openSync(file, 'r');
    let text: string;
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.size > MAX_PLAN_BYTES) return undefined;
      text = readFileSync(descriptor, 'utf8');
    } finally {
      closeSync(descriptor);
    }
    const envelope = JSON.parse(text) as { payload?: string; checksum?: string };
    if (typeof envelope?.payload !== 'string' || envelope.checksum !== hash(envelope.payload))
      return undefined;
    const stored = JSON.parse(envelope.payload) as {
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
  const contents = JSON.stringify({ payload, checksum: hash(payload) });
  if (Buffer.byteLength(contents) > MAX_PLAN_BYTES)
    throw new Error('The dependency plan exceeds the cache size limit');

  await mkdir(dirname(file), { recursive: true });
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
