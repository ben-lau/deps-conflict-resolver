import semver from 'semver';
import type { PackageJson } from '../types/index';
import { isValidVersion } from './semver';

export interface ParsedPeerOverrideKey {
  packageName: string;
  versionRange: string | null;
  exactVersion: boolean;
}

export interface EffectivePeerEntry {
  range: string;
  optional: boolean;
  overridden: boolean;
}

/**
 * Parse a `peerOverrides` key in `<packageName>` or `<packageName>@<semverRange>` form.
 * Supports scoped packages (`@scope/name` and `@scope/name@1.x`).
 * Returns `null` when the key is malformed or specifies an empty/invalid semver range.
 */
export function parsePeerOverrideKey(key: string): ParsedPeerOverrideKey | null {
  const trimmed = key.trim();
  if (!trimmed) return null;

  let atIndex: number;
  if (trimmed.startsWith('@')) {
    const slashIndex = trimmed.indexOf('/');
    if (slashIndex <= 1 || slashIndex === trimmed.length - 1) return null;
    atIndex = trimmed.indexOf('@', slashIndex + 1);
  } else {
    atIndex = trimmed.indexOf('@');
  }

  if (atIndex === -1) {
    return { packageName: trimmed, versionRange: null, exactVersion: false };
  }

  const packageName = trimmed.slice(0, atIndex);
  const versionRange = trimmed.slice(atIndex + 1).trim();
  if (!packageName || !versionRange) return null;

  try {
    if (semver.validRange(versionRange) === null) return null;
  } catch {
    return null;
  }

  return {
    packageName,
    versionRange,
    exactVersion: isValidVersion(versionRange.replace(/^=\s*/, '')),
  };
}

/**
 * Return any malformed keys in `peerOverrides` so callers can warn once.
 */
export function findInvalidPeerOverrideKeys(
  peerOverrides: Record<string, Record<string, string>> | undefined,
): string[] {
  if (!peerOverrides) return [];
  const invalid: string[] = [];
  for (const key of Object.keys(peerOverrides)) {
    if (!parsePeerOverrideKey(key)) invalid.push(key);
  }
  return invalid;
}

interface CompiledPeerOverrideEntry {
  range: semver.Range | null;
  exactVersion: boolean;
  overrides: Record<string, string>;
}

type CompiledPeerOverrides = Map<string, CompiledPeerOverrideEntry[]>;

const compiledPeerOverridesCache = new WeakMap<
  Record<string, Record<string, string>>,
  CompiledPeerOverrides
>();

function getCompiledPeerOverrides(
  peerOverrides: Record<string, Record<string, string>>,
): CompiledPeerOverrides {
  const cached = compiledPeerOverridesCache.get(peerOverrides);
  if (cached) return cached;

  const compiled: CompiledPeerOverrides = new Map();
  for (const [selector, overrides] of Object.entries(peerOverrides)) {
    if (!overrides) continue;
    const parsed = parsePeerOverrideKey(selector);
    if (!parsed) continue;

    let range: semver.Range | null = null;
    if (parsed.versionRange !== null) {
      try {
        range = new semver.Range(parsed.versionRange, { includePrerelease: true });
      } catch {
        continue;
      }
    }

    let entries = compiled.get(parsed.packageName);
    if (!entries) {
      entries = [];
      compiled.set(parsed.packageName, entries);
    }
    entries.push({
      range,
      exactVersion: parsed.exactVersion,
      overrides,
    });
  }

  compiledPeerOverridesCache.set(peerOverrides, compiled);
  return compiled;
}

function matchesCompiledRange(version: string | undefined, range: semver.Range): boolean {
  if (!version) return false;
  try {
    return range.test(version);
  } catch {
    return false;
  }
}

/**
 * Resolve merged `peerDependencies` overrides for a package name and optional version.
 *
 * Specificity (lowest to highest, merged per peer):
 * 1. Name-only selector: `pkg` / `@scope/pkg`
 * 2. Matching semver range selector: `pkg@1.x` / `@scope/pkg@^1.0.0`
 * 3. Matching exact version selector: `pkg@1.2.3` / `@scope/pkg@1.2.3`
 *
 * Within the same specificity tier, later entries in `peerOverrides` take precedence.
 */
export function resolvePeerOverrides(
  peerOverrides: Record<string, Record<string, string>> | undefined,
  packageName: string | undefined,
  version?: string,
): Record<string, string> | undefined {
  if (!peerOverrides || !packageName) return undefined;

  const entries = getCompiledPeerOverrides(peerOverrides).get(packageName);
  if (!entries) return undefined;

  let nameOnly: Record<string, string> | undefined;
  let rangeMatches: Record<string, string> | undefined;
  let exactMatches: Record<string, string> | undefined;

  for (const entry of entries) {
    if (entry.range === null) {
      nameOnly = nameOnly ? { ...nameOnly, ...entry.overrides } : { ...entry.overrides };
      continue;
    }

    if (!matchesCompiledRange(version, entry.range)) continue;

    if (entry.exactVersion) {
      exactMatches = exactMatches
        ? { ...exactMatches, ...entry.overrides }
        : { ...entry.overrides };
    } else {
      rangeMatches = rangeMatches
        ? { ...rangeMatches, ...entry.overrides }
        : { ...entry.overrides };
    }
  }

  if (!nameOnly && !rangeMatches && !exactMatches) return undefined;

  return {
    ...nameOnly,
    ...rangeMatches,
    ...exactMatches,
  };
}

/**
 * Resolve overrides when a package may be installed under a local alias name
 * that differs from its manifest `name`. Manifest-name overrides apply first,
 * with local-name overrides layered on top.
 */
export function resolvePeerOverridesForPackage(
  peerOverrides: Record<string, Record<string, string>> | undefined,
  names: { packageName?: string; manifestName?: string },
  version?: string,
): Record<string, string> | undefined {
  const { packageName, manifestName } = names;
  if (manifestName && packageName && manifestName !== packageName) {
    const manifestOverrides = resolvePeerOverrides(peerOverrides, manifestName, version);
    const localOverrides = resolvePeerOverrides(peerOverrides, packageName, version);
    if (!manifestOverrides && !localOverrides) return undefined;
    return {
      ...manifestOverrides,
      ...localOverrides,
    };
  }
  return resolvePeerOverrides(peerOverrides, packageName ?? manifestName, version);
}

/**
 * Compute the effective peerDependencies map for a package manifest after
 * applying matching `peerOverrides` (supporting `<name>` and `<name>@<range>`).
 * Explicit overrides replace declared ranges, promote optional peers to
 * required, and supply omitted peers.
 */
export function getEffectivePeerDependencies(
  manifest:
    | Pick<PackageJson, 'name' | 'version' | 'peerDependencies' | 'peerDependenciesMeta'>
    | null
    | undefined,
  lookupName?: string,
  peerOverrides?: Record<string, Record<string, string>>,
  versionOverride?: string,
): Map<string, EffectivePeerEntry> {
  const result = new Map<string, EffectivePeerEntry>();
  for (const [peerName, range] of Object.entries(manifest?.peerDependencies ?? {})) {
    if (!range) continue;
    result.set(peerName, {
      range,
      optional: Boolean(manifest?.peerDependenciesMeta?.[peerName]?.optional),
      overridden: false,
    });
  }

  const overrides = resolvePeerOverridesForPackage(
    peerOverrides,
    { packageName: lookupName, manifestName: manifest?.name },
    versionOverride ?? manifest?.version,
  );
  for (const [peerName, range] of Object.entries(overrides ?? {})) {
    if (!range) continue;
    result.set(peerName, {
      range,
      optional: false,
      overridden: true,
    });
  }

  return result;
}
