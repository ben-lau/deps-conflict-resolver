import { lstatSync, readlinkSync } from 'node:fs';
import { dirname, normalize, resolve } from 'node:path';

function isPhysicalDirectory(path: string, verified: Map<string, boolean>): boolean {
  const cached = verified.get(path);
  if (cached !== undefined) return cached;
  const parent = dirname(path);
  const result =
    (parent === path || isPhysicalDirectory(parent, verified)) &&
    lstatSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
  verified.set(path, result);
  return result;
}

export function directPathMatches(
  path: string,
  expected: string | boolean | undefined,
  verified: Map<string, boolean>,
): boolean {
  if (process.platform === 'win32' || resolve(path) !== path) return false;
  try {
    if (expected === undefined) {
      return (
        isPhysicalDirectory(dirname(path), verified) &&
        lstatSync(path, { throwIfNoEntry: false }) === undefined
      );
    }
    if (typeof expected !== 'string' || !isPhysicalDirectory(expected, verified)) return false;
    if (path === expected) return true;
    if (!isPhysicalDirectory(dirname(path), verified)) return false;

    // Verified directory paths have no intermediate symlinks. Other layouts
    // use Node's full realpath semantics in the caller.
    const target = readlinkSync(path);
    return normalize(target) === target && resolve(dirname(path), target) === expected;
  } catch {
    return false;
  }
}
