import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  AnalysisResult,
  DepsConflictResolverOptions,
  PackageJson,
  ResolverDiagnostic,
} from '../types';
import { findPackagePath, readPackageJsonCached } from '../utils/fs';
import { isValidVersion, rangesIntersect, satisfies } from '../utils/semver';

const prepare =
  'Run deps-conflict-resolver prepare --strict --write-plan with the same entry packages or configuration.';
const actions: Partial<Record<ResolverDiagnostic['code'], string>> = {
  PROJECT_STATE_CHANGED: 'Wait for the current dependency preparation to finish, then retry.',
  DEPENDENCY_NOT_FOUND:
    'Install the project dependencies and check the entry package name and project root.',
  PEER_NOT_DECLARED:
    'Declare a compatible peer in the host manifest, or verify the entry package’s peer range.',
  PEER_NOT_INSTALLED:
    'Install the host dependencies with its package manager and repeat the check.',
  PEER_PROVIDER_MISMATCH:
    'Inspect the reported nested provider and align its installed name and version with the consumer’s peer declaration.',
  REGISTRY_ERROR:
    'Check the registry for this package, including its @scope:registry and registry-scoped token in .npmrc.',
  NO_MATCHING_VERSION:
    'Inspect the declared peer ranges and narrow inaccurate ranges with peerOverrides.',
  OFFLINE_ALIAS_MISSING: prepare,
  ALIAS_NOT_INSTALLED: prepare,
  ALIAS_INSTALL_FAILED:
    'Resolve the package manager error, then rerun prepare with the same options.',
  ALIAS_SEARCH_LIMIT:
    'Reduce the candidate versions with verified peerOverrides or preinstall compatible exact alias versions.',
  ALIAS_PEER_UNSATISFIED:
    'Inspect the peers of both the alias and its consumers. Install versions that satisfy both requirements.',
  ALIAS_PEER_CANDIDATES_UNCHECKED:
    'Run deps-conflict-resolver prepare with the same entries in online mode. Omit --offline and set offline: false and preparedPlan: false in any shared config.',
  ALIAS_METADATA_UNAVAILABLE: 'Check access to the alias manifest, then rerun prepare online.',
  TRANSITIVE_PEER_CONFLICT:
    'Verify the reported consumer’s peer range. Add it as an entry if visible from the host, or correct its declaration with peerOverrides.',
  OPTIONAL_PEER_MISMATCH:
    'If this consumer uses the optional integration, install a compatible visible peer or adjust its configuration.',
  SHARED_PEER_CONTEXT:
    'Inspect both consumers’ providers. Use excludeRedirects only where the original provider already satisfies the consumer.',
  AMBIGUOUS_ALIAS_SCOPE:
    'Keep a single host-visible declaration for this alias and align the workspace manifest.',
  AMBIGUOUS_IMPORTER:
    'Give each importer one compatible provider. Review overlapping includeRedirects and the reported physical paths.',
};

export function diagnoseNextSteps(diagnostics: readonly ResolverDiagnostic[]) {
  return diagnostics.flatMap(({ code, packageName }) => {
    const message = actions[code];
    return message ? [{ code, packageName, message }] : [];
  });
}

export function suggestEntryPackages(analysis: AnalysisResult, entries: string[]): string[] {
  const names = new Set(entries);
  const suggested = new Set<string>();
  for (const { conflictingRanges } of analysis.peerConflicts) {
    for (const { path } of conflictingRanges) {
      if (path[0] && names.has(path[0])) suggested.add(path[0]);
    }
  }
  for (const { requestedBy } of analysis.missingFirstLevelPeers) {
    const name = requestedBy.split('>', 1)[0];
    if (name && names.has(name)) suggested.add(name);
  }
  for (const diagnostic of analysis.diagnostics ?? []) {
    if (
      diagnostic.code !== 'TRANSITIVE_PEER_CONFLICT' &&
      diagnostic.code !== 'PEER_PROVIDER_MISMATCH'
    )
      continue;
    for (const requester of diagnostic.requestedBy ?? []) {
      const name = requester.split('>', 1)[0];
      if (name && names.has(name)) suggested.add(name);
    }
  }
  return [...suggested].sort();
}

interface SourceHint {
  packageName: string;
  message: string;
  config: Pick<DepsConflictResolverOptions, 'dependencies' | 'peerOverrides'>;
}

type EntryManifest = PackageJson & { exports?: unknown; module?: unknown; main?: unknown };

function sourceEntries(manifest: EntryManifest): Set<string> {
  const entries = new Set<string>();
  if (manifest.exports === undefined) {
    for (const value of [manifest.module, manifest.main ?? 'index.js']) {
      if (typeof value === 'string') entries.add(value);
    }
    return entries;
  }
  const exported = manifest.exports;
  const conditions = ['import', 'require', 'browser', 'node', 'default'];
  const root =
    exported &&
    typeof exported === 'object' &&
    !Array.isArray(exported) &&
    Object.keys(exported).some((key) => key.startsWith('.'))
      ? (exported as Record<string, unknown>)['.']
      : exported;
  // Look at public root entries from common export conditions. Bound the
  // inspection even when a package publishes a large conditional export map.
  const candidates: unknown[] = [root];
  for (let i = 0; i < candidates.length && i < 16 && entries.size < 4; i++) {
    const target = candidates[i];
    if (typeof target === 'string' && target.startsWith('./')) entries.add(target);
    else if (Array.isArray(target)) candidates.push(...target.slice(0, 4));
    else if (target && typeof target === 'object') {
      const branches = target as Record<string, unknown>;
      for (const condition of conditions) {
        if (Object.hasOwn(branches, condition)) candidates.push(branches[condition]);
      }
    }
  }
  return entries;
}

async function readEntry(directory: string, entry: string): Promise<string> {
  try {
    const file = await realpath(resolve(directory, entry));
    const location = relative(directory, file);
    if (!location || isAbsolute(location) || location.startsWith('..' + sep) || location === '..')
      return '';
    if (!/\.[cm]?js$/i.test(file) || !(await stat(file)).isFile()) return '';
    const handle = await open(file);
    try {
      const bytes = Buffer.alloc(128 * 1024);
      const { bytesRead } = await handle.read(bytes);
      return bytes.toString('utf8', 0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    return '';
  }
}

/** Advisory checks on direct Vue consumers. Never contributes to resolver rules. */
export async function findSourceHints(
  projectRoot: string,
  entries: string[],
): Promise<SourceHint[]> {
  const vuePath = findPackagePath('vue', projectRoot);
  const vue = vuePath ? readPackageJsonCached(vuePath) : null;
  if (vue?.name !== 'vue' || !vue.version || !satisfies(vue.version, '^3')) return [];
  const hints: SourceHint[] = [];
  for (const packageName of entries) {
    const path = findPackagePath(packageName, projectRoot);
    if (!path) continue;
    const manifest = readPackageJsonCached(path) as EntryManifest | null;
    if (!manifest?.version || !isValidVersion(manifest.version)) continue;
    const range = manifest.peerDependencies?.vue;
    if (range && (!satisfies(vue.version, range) || !rangesIntersect(range, '^2'))) continue;
    let vue2 = false;
    let vue3 = false;
    for (const entry of sourceEntries(manifest)) {
      const source = await readEntry(path, entry);
      vue2 ||= /\b(?:Vue\.extend\s*\(|_vm\.(?:_self\._c|\$createElement|_c)\b)/.test(source);
      vue3 ||= /\b(?:openBlock|createElementVNode|createVNode)\b/.test(source);
    }
    if (!vue2 || vue3) continue;
    hints.push({
      packageName,
      message:
        'The installed entry contains Vue 2 render patterns. Verify the supported Vue range before applying this override.',
      config: {
        dependencies: [packageName],
        peerOverrides: { [packageName + '@' + manifest.version]: { vue: '^2' } },
      },
    });
  }
  return hints;
}
