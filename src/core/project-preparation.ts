import { createHash, randomUUID } from 'node:crypto';
import { promises as fs, realpathSync, existsSync } from 'node:fs';
import { hostname, tmpdir, userInfo } from 'node:os';
import { performance } from 'node:perf_hooks';
import { join, resolve } from 'node:path';
import { createWorkspaceDetector } from './workspace-detector';
import { iterateParentDirs } from '../utils/fs';
import { LOCK_FILE_MAP } from '../constants';

export interface PreparationObserver {
  refresh(): Promise<void>;
}

export interface ProjectPreparation {
  owner: string;
  revision: number;
  writing: boolean;
  tail: Promise<void>;
  observers: Set<WeakRef<PreparationObserver>>;
}

// Separate entry bundles (including CJS + ESM) must coordinate the same tree.
const registryKey = Symbol.for('deps-conflict-resolver.project-preparation.v1');
const registry = globalThis as typeof globalThis & {
  [registryKey]?: Map<string, WeakRef<ProjectPreparation>>;
};
const projects = (registry[registryKey] ??= new Map());
const collectedProjects = new FinalizationRegistry<{
  owner: string;
  ref: WeakRef<ProjectPreparation>;
}>(({ owner, ref }) => {
  if (projects.get(owner) === ref) projects.delete(owner);
});

export function getProjectPreparation(projectRoot: string): ProjectPreparation {
  // A link outside the workspace must still identify its physical workspace.
  // Normalize before walking ancestors, not after choosing an owner.
  try {
    projectRoot = realpathSync(projectRoot);
  } catch {
    projectRoot = resolve(projectRoot);
  }
  let owner = createWorkspaceDetector(projectRoot).getWorkspaceRoot() ?? projectRoot;
  if (owner === projectRoot) {
    for (const directory of iterateParentDirs(projectRoot)) {
      if (Object.keys(LOCK_FILE_MAP).some((file) => existsSync(join(directory, file)))) {
        owner = directory;
        break;
      }
    }
  }
  try {
    owner = realpathSync(owner);
  } catch {
    owner = resolve(owner);
  }
  let state = projects.get(owner)?.deref();
  if (!state) {
    state = { owner, revision: 0, writing: false, tail: Promise.resolve(), observers: new Set() };
    const ref = new WeakRef(state);
    projects.set(owner, ref);
    collectedProjects.register(state, { owner, ref });
  }
  return state;
}

interface LockOwner {
  pid: number;
  host: string;
  token: string;
}

async function readOwner(path: string): Promise<LockOwner | null> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(path, 'utf8'));
    if (
      value &&
      typeof value === 'object' &&
      'pid' in value &&
      'host' in value &&
      'token' in value &&
      Number.isInteger(value.pid) &&
      Number(value.pid) > 0 &&
      typeof value.host === 'string' &&
      typeof value.token === 'string'
    ) {
      return value as LockOwner;
    }
  } catch {
    /* An unknown owner must never be treated as a dead owner. */
  }
  return null;
}

function exited(owner: LockOwner): boolean {
  if (owner.host !== hostname()) return false;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
  return false;
}

/** Only one contender may remove a dead owner's lock. Never expire a live lock. */
async function recoverExitedOwner(path: string): Promise<void> {
  const recovery = path + '.recovery';
  try {
    await fs.mkdir(recovery);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
    throw error;
  }
  try {
    const owner = await readOwner(path);
    if (owner && exited(owner))
      await fs.unlink(path).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
  } finally {
    await fs.rmdir(recovery);
  }
}

async function acquireLock(owner: string): Promise<() => Promise<void>> {
  // A private lock directory must not make another OS user's projects fail
  // with EACCES when /tmp is shared (as it is on Linux).
  const user =
    typeof process.getuid === 'function'
      ? String(process.getuid())
      : createHash('sha256').update(userInfo().username).digest('hex');
  const directory = join(tmpdir(), 'deps-conflict-resolver-locks-' + user);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const key = createHash('sha256').update(owner).digest('hex');
  const path = join(directory, key + '.lock');
  const token = randomUUID();
  const candidate = path + '.' + token;
  // Publish a fully written owner record atomically. A killed process cannot
  // leave an empty lock between exclusive creation and writing its PID.
  await fs.writeFile(candidate, JSON.stringify({ pid: process.pid, host: hostname(), token }), {
    flag: 'wx',
    mode: 0o600,
  });
  const deadline = performance.now() + 300_000;
  try {
    while (true) {
      try {
        await fs.link(candidate, path);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (performance.now() >= deadline)
          throw new Error(
            'Timed out waiting for dependency preparation in ' + owner + ' (lock: ' + path + ')',
            { cause: error },
          );
        const current = await readOwner(path);
        if (current && exited(current)) await recoverExitedOwner(path);
        await new Promise<void>((done) => setTimeout(done, 25));
      }
    }
  } finally {
    await fs.unlink(candidate);
  }
  return async () => {
    if ((await readOwner(path))?.token === token) await fs.unlink(path);
  };
}

/** The task owns analysis through publication; user callbacks run outside it. */
export async function withProjectPreparation<T>(
  state: ProjectPreparation,
  task: (markChanged: () => void) => Promise<T>,
  current?: PreparationObserver,
): Promise<T> {
  const previous = state.tail;
  let finish!: () => void;
  state.tail = new Promise<void>((done) => {
    finish = done;
  });
  await previous;
  let unlock: (() => Promise<void>) | undefined;
  let changed = false;
  try {
    unlock = await acquireLock(state.owner);
    return await task(() => {
      if (!changed) {
        state.revision++;
        changed = true;
      }
      state.writing = true;
    });
  } finally {
    try {
      if (changed) {
        for (const ref of state.observers) {
          const observer = ref.deref();
          if (!observer) state.observers.delete(ref);
          else if (observer !== current) await observer.refresh();
        }
      }
    } finally {
      state.writing = false;
      try {
        await unlock?.();
      } finally {
        finish();
      }
    }
  }
}

/** Wait until all preparations already queued for this owner have settled. */
export async function waitForProjectPreparation(state: ProjectPreparation): Promise<void> {
  while (true) {
    const ready = state.tail;
    await ready;
    if (ready === state.tail) return;
  }
}
