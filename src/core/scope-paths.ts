import { posix } from 'node:path';
import type { AliasMapping, ResolvedOptions } from '../types';
import { canonicalPath, readPackageJsonCached, type FileSystemCache } from '../utils/fs';
import { NO_RULE, ScopeMatcher, type Decision, type ImporterInfo } from './scope-matcher';

export function normalizePath(path: string): string {
  const normalized = posix.normalize(path.replace(/\\/g, '/'));
  return normalized.length <= 1 ? normalized : normalized.replace(/\/+$/, '');
}

/** Extract lexical package instances, including nested and scoped packages. */
function packageInstances(path: string): ImporterInfo['instances'] {
  const parts = path.split('/');
  const instances: ImporterInfo['instances'] = [];
  for (let index = 0; index < parts.length - 1; index++) {
    if (parts[index] !== 'node_modules') continue;
    const name = parts[index + 1];
    if (!name || name.startsWith('.')) continue;
    const scopedName = name.startsWith('@') ? parts[index + 2] : undefined;
    if (name.startsWith('@') && !scopedName) continue;
    const end = scopedName ? index + 3 : index + 2;
    instances.push({
      name: scopedName ? name + '/' + scopedName : name,
      path: parts.slice(0, end).join('/'),
    });
  }
  return instances;
}

export function describeImporter(paths: string[], cache?: FileSystemCache): ImporterInfo {
  const instances = paths.flatMap(packageInstances);
  if (instances.length === 0) {
    // Workspace sources have no node_modules segment. Find their owner
    // once so explicit include/exclude rules work for real paths, too.
    for (const path of paths) {
      let directory = path;
      while (true) {
        const manifest = readPackageJsonCached(directory, cache);
        if (manifest?.name) {
          instances.push({ name: manifest.name, path: directory });
          break;
        }
        const parent = posix.dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
  }
  return { paths, instances };
}

export function describeScope(path: string, paths: string[], cache?: FileSystemCache) {
  const name =
    packageInstances(normalizePath(path)).at(-1)?.name ?? readPackageJsonCached(path, cache)?.name;
  return paths.map((candidate) => ({ path: candidate, name }));
}

function directoryPaths(directory: string): string[] {
  const literal = normalizePath(directory);
  const physical = normalizePath(canonicalPath(directory));
  return literal === physical ? [literal] : [literal, physical];
}

/** Analysis already owns package directories, so it can bypass module-ID probing. */
export function createDirectoryScopeMatcher(
  mappings: readonly AliasMapping[],
  options: ResolvedOptions,
): (packageName: string, directory: string) => Decision {
  const scopes = new ScopeMatcher(mappings, options, (path) =>
    describeScope(path, directoryPaths(path)),
  );
  const directories = new Map<string, ImporterInfo>();
  return (packageName, directory) => {
    if (!scopes.hasRules(packageName)) return NO_RULE;
    let info = directories.get(directory);
    if (!info) directories.set(directory, (info = describeImporter(directoryPaths(directory))));
    return scopes.match(packageName, info);
  };
}
