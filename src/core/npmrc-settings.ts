import { join, resolve } from 'node:path';
import type { PackageManagerType } from '../types';
import { observedReadTextAsync } from '../utils/dependency-inputs';
import { fileExists, iterateParentDirs } from '../utils/fs';

function readValue(value: string): string {
  let quote: string | undefined;
  let end = value.length;
  for (let i = 0; i < value.length; i++) {
    const character = value[i]!;
    if (character === '\\') {
      i++;
    } else if (quote) {
      if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '#' || character === ';') {
      end = i;
      break;
    }
  }
  return value
    .slice(0, end)
    .trim()
    .replace(/^(["'])(.*)\1$/, '$2');
}

function registryKey(key: string): string | undefined {
  if (/^(?:@[^\s:]+:)?registry$/i.test(key)) return key.replace(/registry$/i, 'registry');
  const auth = /^(\/\/[^/\s]+)([^\s]*?):_authToken$/i.exec(key);
  if (auth) return auth[1]!.toLowerCase() + auth[2] + ':_authToken';
  return undefined;
}

export async function readNpmrcSettings(file: string): Promise<ReadonlyMap<string, string>> {
  const entries = new Map<string, string>();
  if (!fileExists(file)) return entries;
  try {
    for (const line of (await observedReadTextAsync(file)).split(/\r?\n/)) {
      const match = /^\s*([^#;=\s][^=]*?)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match) continue;
      const key = registryKey(match[1]!);
      if (!key) continue;
      const value = readValue(match[2]!);
      let defined = true;
      const expanded = value.replace(/\$\{([^}]+)\}/g, (_expression, variable: string) => {
        const replacement = process.env[variable];
        if (replacement === undefined) defined = false;
        return replacement ?? '';
      });
      entries.set(key, defined ? expanded : '');
    }
  } catch {
    // The package manager owns installation and handles its own config errors.
  }
  return entries;
}

export function npmrcFiles(projectRoot: string, packageManager: PackageManagerType): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  const user = process.env.npm_config_userconfig ?? process.env.NPM_CONFIG_USERCONFIG;
  const global = process.env.npm_config_globalconfig ?? process.env.NPM_CONFIG_GLOBALCONFIG;
  const files = [...iterateParentDirs(projectRoot)].map((dir) => join(dir, '.npmrc'));
  if (user) files.push(resolve(user));
  else if (home) files.push(join(home, '.npmrc'));
  if (home && packageManager === 'pnpm') files.push(join(home, '.pnpmrc'));
  if (global) files.push(resolve(global));
  return [...new Set(files)];
}

export async function loadNpmrcSettings(projectRoot: string, packageManager: PackageManagerType) {
  const configs = await Promise.all(npmrcFiles(projectRoot, packageManager).map(readNpmrcSettings));
  const result = new Map<string, string>();
  for (const config of configs) {
    for (const [key, value] of config) {
      if (!result.has(key)) result.set(key, value);
    }
  }
  return result;
}

export function registryToken(url: URL, settings: ReadonlyMap<string, string>): string | undefined {
  // npm's registry-specific keys omit the scheme and match path boundaries.
  let key = `//${url.host}${url.pathname}`;
  while (key.length > 2) {
    const token = settings.get(key + ':_authToken');
    if (token && /^[\x21-\x7e]+$/.test(token)) return token;
    key = key.replace(/([^/]+|\/)$/, '');
  }
  return undefined;
}
