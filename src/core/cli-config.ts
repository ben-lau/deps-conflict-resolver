import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DepsConflictResolverOptions } from '../types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPackageList(value: unknown): boolean {
  return Array.isArray(value) && value.every((name) => typeof name === 'string' && name.trim());
}

const validators = {
  dependencies: isPackageList,
  includeRedirects: (value) => isRecord(value) && Object.values(value).every(isPackageList),
  excludeRedirects: (value) => isRecord(value) && Object.values(value).every(isPackageList),
  peerOverrides: (value) =>
    isRecord(value) &&
    Object.values(value).every(
      (overrides) =>
        isRecord(overrides) && Object.values(overrides).every((range) => typeof range === 'string'),
    ),
  aliasPrefix: (value) => typeof value === 'string',
  registry: (value) => typeof value === 'string',
  projectRoot: (value) => typeof value === 'string' && value.trim().length > 0,
  packageManager: (value) =>
    typeof value === 'string' && ['auto', 'npm', 'pnpm', 'yarn'].includes(value),
  autoInstall: (value) => typeof value === 'boolean',
  offline: (value) => typeof value === 'boolean',
  strict: (value) => typeof value === 'boolean',
  debug: (value) => typeof value === 'boolean',
} satisfies Record<keyof DepsConflictResolverOptions, (value: unknown) => boolean>;

export async function loadCliConfig(path: string): Promise<Partial<DepsConflictResolverOptions>> {
  const file = resolve(path);
  const extension = extname(file);
  try {
    const parsed: unknown =
      extension === '.json'
        ? JSON.parse(await readFile(file, 'utf8'))
        : ((await import(pathToFileURL(file).href)) as { default?: unknown }).default;
    if (!isRecord(parsed)) throw new Error('expected a resolver options object');
    for (const [key, validate] of Object.entries(validators)) {
      if (!Object.hasOwn(parsed, key)) continue;
      const value = parsed[key];
      if (value !== undefined && !validate(value)) {
        throw new Error(`invalid ${key} setting`);
      }
    }
    return parsed as Partial<DepsConflictResolverOptions>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const needsTypeScriptLoader =
      /^\.[cm]?ts$/.test(extension) &&
      error instanceof Error &&
      'code' in error &&
      error.code === 'ERR_UNKNOWN_FILE_EXTENSION';
    const hint = needsTypeScriptLoader
      ? ' Use a .cjs, .mjs, or .json options file or a Node.js runtime with TypeScript loading enabled.'
      : '';
    throw new Error(`Cannot load resolver options from ${file}: ${message}${hint}`, {
      cause: error,
    });
  }
}
