import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, promises, readFileSync, realpathSync, statSync } from 'node:fs';
import { directPathMatches } from './dependency-input-paths';
import { isAbsolute } from 'node:path';

type Value = string | boolean | undefined;
type Probe = (path: string) => Value;

const recording = new AsyncLocalStorage<DependencyInputs>();
const MAX_INPUTS = 65_536;

export class DependencyInputs {
  private values = new Map<Probe, Map<string, Value>>();
  private size = 0;
  private stable = true;

  record<T>(task: () => T): T {
    return recording.run(this, task);
  }

  add(probe: Probe, path: string, value: Value): void {
    if (!this.stable) return;
    let values = this.values.get(probe);
    if (!values) this.values.set(probe, (values = new Map()));
    if (values.has(path)) {
      if (values.get(path) !== value) this.invalidate();
      return;
    }
    if (++this.size > MAX_INPUTS) this.invalidate();
    else values.set(path, value);
  }

  invalidate(): void {
    this.stable = false;
    this.values.clear();
  }

  get reusable(): boolean {
    return this.stable;
  }

  merge(other: DependencyInputs): void {
    for (const [probe, values] of other.values) {
      for (const [path, value] of values) this.add(probe, path, value);
    }
  }

  serialize(): unknown {
    if (!this.stable) return undefined;
    return Object.entries(probes).flatMap(([name, probe]) => {
      const values = this.values.get(probe);
      return values ? [[name, [...values].map(([path, value]) => [path, value ?? null])]] : [];
    });
  }

  static deserialize(data: unknown): DependencyInputs | undefined {
    if (!Array.isArray(data) || data.length === 0) return undefined;
    const inputs = new DependencyInputs();
    const seen = new Set<string>();
    let count = 0;
    for (const group of data) {
      if (!Array.isArray(group) || group.length !== 2) return undefined;
      const [name, values] = group;
      if (typeof name !== 'string' || !Object.hasOwn(probes, name) || seen.has(name))
        return undefined;
      if (!Array.isArray(values)) return undefined;
      seen.add(name);
      const probe = probes[name as keyof typeof probes];
      for (const entry of values) {
        if (!Array.isArray(entry) || entry.length !== 2 || ++count > MAX_INPUTS) return undefined;
        const [path, value] = entry;
        if (
          typeof path !== 'string' ||
          !isAbsolute(path) ||
          !(value === null || typeof value === 'string' || typeof value === 'boolean')
        )
          return undefined;
        inputs.add(probe, path, value ?? undefined);
      }
    }
    return count > 0 && inputs.reusable ? inputs : undefined;
  }

  includes(path: string): boolean {
    for (const values of this.values.values()) {
      if (values.has(path)) return true;
    }
    return false;
  }

  matches(): boolean {
    if (!this.stable) return false;
    for (const [probe, values] of this.values) {
      const directories = new Map<string, boolean>();
      for (const [path, expected] of values) {
        try {
          if (probe === realPath && directPathMatches(path, expected, directories)) continue;
          if (probe(path) !== expected) return false;
        } catch (error) {
          if (expected !== undefined || !isMissing(error)) return false;
        }
      }
    }
    return true;
  }
}

export function currentDependencyInputs(): DependencyInputs | undefined {
  return recording.getStore();
}

export function withoutDependencyInputs<T>(task: () => T): T {
  return recording.getStore() ? recording.exit(task) : task();
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function observe<T extends Value>(
  path: string,
  read: (path: string) => T,
  probe: Probe = read,
  value: (result: T) => Value = identity,
): T {
  const inputs = currentDependencyInputs();
  if (!inputs) return read(path);
  try {
    const result = read(path);
    inputs.add(probe, path, value(result));
    return result;
  } catch (error) {
    if (isMissing(error)) inputs.add(probe, path, undefined);
    else inputs.invalidate();
    throw error;
  }
}

function identity(value: Value): Value {
  return value;
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function readText(path: string): string {
  return readFileSync(path, 'utf-8');
}

function hashFile(path: string): string {
  return hash(readText(path));
}

function hashRegularFile(path: string): string | undefined {
  return isFile(path) ? hashFile(path) : undefined;
}

export function observedExists(path: string): boolean {
  return observe(path, existsSync);
}

function lookupStat(path: string) {
  try {
    return statSync(path, { throwIfNoEntry: false });
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function isLookupDirectory(path: string): boolean {
  return lookupStat(path)?.isDirectory() === true;
}

function isLookupManifest(path: string): boolean {
  return lookupStat(path)?.isFile() === true;
}

export function observedLookupDirectory(path: string): boolean {
  try {
    return observe(path, isLookupDirectory);
  } catch {
    // Still try the manifest when directory metadata could not be read.
    return true;
  }
}

export function observedLookupManifest(path: string): boolean {
  try {
    return observe(path, isLookupManifest);
  } catch {
    // Preserve a known nearest manifest even if following its link fails.
    // If an ancestor is inaccessible, lstat cannot confirm the entry either.
    try {
      const entry = lstatSync(path, { throwIfNoEntry: false });
      return entry?.isSymbolicLink() === true || entry?.isFile() === true;
    } catch {
      return false;
    }
  }
}

function realPath(path: string): string {
  return realpathSync(path);
}

export function observedRealpath(path: string): string {
  return observe(path, realPath);
}

export function observedReadText(path: string): string {
  return observe(path, readText, hashFile, hash);
}

export async function observedReadTextAsync(path: string): Promise<string> {
  const inputs = currentDependencyInputs();
  try {
    const text = await promises.readFile(path, 'utf-8');
    if (inputs) inputs.add(hashRegularFile, path, hash(text));
    return text;
  } catch (error) {
    if (inputs) {
      if (isMissing(error)) inputs.add(hashRegularFile, path, undefined);
      else inputs.invalidate();
    }
    throw error;
  }
}

function isFile(path: string): boolean {
  return statSync(path).isFile();
}

function isRegularFile(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false })?.isFile() === true;
}

export function observedIsFile(path: string): boolean {
  return observe(path, isFile);
}

export function observedIsRegularFile(path: string): boolean {
  return observe(path, isRegularFile);
}

function fileMetadata(path: string): string | undefined {
  const stat = statSync(path, { bigint: true, throwIfNoEntry: false });
  return stat && [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

export function observeLockfile(path: string): boolean {
  try {
    return observe(path, fileMetadata) !== undefined;
  } catch {
    return false;
  }
}

const probes = {
  exists: existsSync,
  lookupDirectory: isLookupDirectory,
  lookupManifest: isLookupManifest,
  realpath: realPath,
  textHash: hashFile,
  regularFileHash: hashRegularFile,
  file: isFile,
  regularFile: isRegularFile,
  metadata: fileMetadata,
};
