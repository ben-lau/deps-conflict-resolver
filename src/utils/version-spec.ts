import type { PackageJson } from '../types';
import { satisfies } from './semver';

/**
 * 版本规格/协议相关的小工具
 */

/** 匹配 npm:package@version 格式（支持 scoped package） */
const NPM_ALIAS_PATTERN = /^npm:(@?[^@]+)@(.+)$/;

/**
 * 解析 npm 别名格式 (npm:package@version)
 * @returns [targetPackage, versionSpec] 或 null
 */
export function parseNpmAlias(versionSpec: string): [string, string] | null {
  const match = versionSpec.match(NPM_ALIAS_PATTERN);
  if (match?.[1] && match?.[2]) {
    return [match[1], match[2]];
  }
  return null;
}

export function getRuntimeDependencySpec(
  manifest: Pick<PackageJson, 'dependencies' | 'optionalDependencies'> | null | undefined,
  name: string,
): string | undefined {
  return manifest?.optionalDependencies?.[name] ?? manifest?.dependencies?.[name];
}

export interface DependencyRequirement {
  name: string;
  range: string;
  optional: boolean;
}

export interface VersionSpecResolver {
  resolveVersionSpec(name: string, spec: string): string | null;
}

export function matchesProvider(
  manifest: Pick<PackageJson, 'name' | 'version'> | null | undefined,
  name: string,
  range: string,
): manifest is { name: string; version: string } {
  return manifest?.name === name && Boolean(manifest.version && satisfies(manifest.version, range));
}

export function resolveDependencyRequirement(
  name: string,
  spec: string,
  workspace: VersionSpecResolver,
  optional = false,
): DependencyRequirement {
  const range = workspace.resolveVersionSpec(name, spec) ?? spec;
  const alias = parseNpmAlias(spec.startsWith('npm:') ? spec : range);
  return { name: alias?.[0] ?? name, range: alias?.[1] ?? range, optional };
}

export function getDependencyRequirement(
  manifest: Pick<PackageJson, 'dependencies' | 'optionalDependencies'> | null | undefined,
  name: string,
  peer: { range: string; optional: boolean } | undefined,
  workspace: VersionSpecResolver,
): DependencyRequirement | undefined {
  const spec = peer?.range ?? getRuntimeDependencySpec(manifest, name);
  if (!spec) return undefined;
  const optional = peer?.optional ?? manifest?.optionalDependencies?.[name] !== undefined;
  return resolveDependencyRequirement(name, spec, workspace, optional);
}
