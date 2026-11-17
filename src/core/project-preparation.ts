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
  // Zero publishes the choosing phase; positive tickets order contenders.
  ticket: number;
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
      'ticket' in value &&
      Number.isInteger(value.pid) &&
      Number(value.pid) > 0 &&
      typeof value.host === 'string' &&
      typeof value.token === 'string' &&
      Number.isSafeInteger(value.ticket) &&
      Number(value.ticket) >= 0
    ) {
      return value as LockOwner;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  // Committed records are always complete. Never discard an unknown owner.
  throw new Error('Invalid dependency preparation lock record: ' + path);
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

async function removeRecord(path: string): Promise<void> {
  await fs.unlink(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
}

async function readContenders(directory: string, token: string): Promise<LockOwner[]> {
  const contenders: LockOwner[] = [];
  for (const name of await fs.readdir(directory)) {
    if (!name.endsWith('.json') || name === token + '.json') continue;
    const path = join(directory, name);
    const owner = await readOwner(path);
    if (!owner) continue;
    if (owner.token + '.json' !== name)
      throw new Error('Invalid dependency preparation lock identity: ' + path);
    if (exited(owner)) {
      // Each contender has a unique, never-reused path. Concurrent cleaners
      // can remove it without a recovery mutex or touching a successor's lock.
      await removeRecord(path);
    } else contenders.push(owner);
  }
  return contenders;
}

async function acquireLock(owner: string): Promise<() => Promise<void>> {
  // A private lock directory must not make another OS user's projects fail
  // with EACCES when /tmp is shared (as it is on Linux).
  const user =
    typeof process.getuid === 'function'
      ? String(process.getuid())
      : createHash('sha256').update(userInfo().username).digest('hex');
  const key = createHash('sha256').update(owner).digest('hex');
  const directory = join(tmpdir(), 'deps-conflict-resolver-locks-' + user, key + '.queue');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const path = join(directory, token + '.json');
  const candidate = join(directory, token + '.tmp');
  const record: LockOwner = { pid: process.pid, host: hostname(), token, ticket: 0 };
  const deadline = performance.now() + 300_000;
  let published = false;
  try {
    // Lamport's bakery doorway: publish choosing before reading any tickets,
    // then atomically replace it with a complete numbered record. Unpublished
    // .tmp files and empty directories never confer ownership.
    // https://lamport.azurewebsites.net/pubs/bakery.pdf
    await fs.writeFile(candidate, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    await fs.link(candidate, path);
    published = true;
    await removeRecord(candidate);
    record.ticket =
      1 +
      (await readContenders(directory, token)).reduce(
        (max, other) => Math.max(max, other.ticket),
        0,
      );
    if (!Number.isSafeInteger(record.ticket))
      throw new Error('Dependency preparation ticket limit exceeded in ' + owner);
    await fs.writeFile(candidate, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    await fs.rename(candidate, path);
    while (true) {
      const blocked = (await readContenders(directory, token)).some(
        (other) =>
          other.ticket === 0 ||
          other.ticket < record.ticket ||
          (other.ticket === record.ticket && other.token < token),
      );
      if (!blocked) return () => removeRecord(path);
      if (performance.now() >= deadline)
        throw new Error(
          'Timed out waiting for dependency preparation in ' + owner + ' (lock: ' + path + ')',
        );
      await new Promise<void>((done) => setTimeout(done, 25));
    }
  } catch (error) {
    try {
      await removeRecord(candidate);
    } finally {
      if (published) await removeRecord(path);
    }
    throw error;
  }
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
