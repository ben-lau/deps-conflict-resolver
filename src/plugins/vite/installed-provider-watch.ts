import {
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

function targetOf(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function directoryState(path: string) {
  try {
    const stat = statSync(path, { bigint: true });
    const identity = stat.dev + ':' + stat.ino;
    return { identity, stamp: identity + ':' + stat.mtimeNs + ':' + stat.ctimeNs };
  } catch {
    return undefined;
  }
}

interface DirectoryWatch {
  identity?: string;
  stamp?: string;
  watcher?: FSWatcher;
}

/** Observes installation directory entries without following their link targets. */
export class InstalledProviderWatch {
  private slots = new Map<string, string | undefined>();
  private directories = new Map<string, DirectoryWatch>();
  private directory?: string;
  private marker?: string;
  private timer?: ReturnType<typeof setInterval>;
  private pending?: ReturnType<typeof setTimeout>;
  private failure?: Error;
  private revision = 0;
  private readonly interval?: number;

  constructor(options: { usePolling?: boolean; interval?: number } = {}) {
    const setting = process.env.CHOKIDAR_USEPOLLING?.toLowerCase();
    const polling =
      setting === undefined
        ? options.usePolling === true
        : setting !== '' && setting !== 'false' && setting !== '0';
    if (polling) {
      const interval = process.env.CHOKIDAR_INTERVAL
        ? Number.parseInt(process.env.CHOKIDAR_INTERVAL, 10)
        : (options.interval ?? 100);
      this.interval = Number.isFinite(interval) && interval > 0 ? interval : 100;
    }
  }

  update(files: Iterable<string>): string | undefined {
    if (this.failure) throw this.failure;
    const previous = this.slots;
    this.slots = new Map();
    for (const file of files) {
      if (basename(file) !== 'package.json') continue;
      const slot = resolve(dirname(file));
      const target = targetOf(slot);
      if ((!target || target === slot) && !previous.has(slot)) continue;
      this.slots.set(slot, target);
    }
    if (this.slots.size > 0 && !this.marker) {
      // Rollup has no plugin-context invalidation method. A watched marker
      // wakes this environment without changing its source or dependency files.
      this.directory = realpathSync(mkdtempSync(join(tmpdir(), 'deps-vite-watch-')));
      this.marker = join(this.directory, 'revision');
      writeFileSync(this.marker, '0');
    }
    this.syncDirectories();
    if (this.slots.size > 0 && this.interval !== undefined) {
      this.timer ??= setInterval(() => {
        for (const [path, entry] of this.directories) {
          if (directoryState(path)?.stamp === entry.stamp) continue;
          this.inspect();
          break;
        }
      }, this.interval).unref();
    } else {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    return this.marker;
  }

  close(): void {
    clearInterval(this.timer);
    clearTimeout(this.pending);
    this.timer = undefined;
    this.pending = undefined;
    this.slots.clear();
    for (const entry of this.directories.values()) entry.watcher?.close();
    this.directories.clear();
    this.marker = undefined;
    if (this.directory) rmSync(this.directory, { recursive: true, force: true });
    this.directory = undefined;
  }

  private syncDirectories(): void {
    const wanted = new Set<string>();
    for (const slot of this.slots.keys()) {
      let path = dirname(slot);
      wanted.add(path);
      // Existing ancestors also detect replacement of node_modules or a scope
      // directory, so subscriptions can move to the new directory inode.
      while (/[/\\]node_modules(?:[/\\]|$)/.test(path)) {
        path = dirname(path);
        wanted.add(path);
      }
    }
    for (const [path, entry] of this.directories) {
      if (wanted.has(path)) continue;
      entry.watcher?.close();
      this.directories.delete(path);
    }
    for (const path of wanted) {
      const current = directoryState(path);
      const entry = this.directories.get(path) ?? {};
      this.directories.set(path, entry);
      entry.stamp = current?.stamp;
      if (entry.identity !== current?.identity) {
        entry.watcher?.close();
        entry.watcher = undefined;
        entry.identity = current?.identity;
      }
      if (this.interval !== undefined || !current || entry.watcher) continue;
      const watcher = watch(path, { persistent: false }, (_event, filename) => {
        const changed = filename ? join(path, filename.toString()) : undefined;
        if (!changed || this.slots.has(changed) || this.directories.has(changed)) this.schedule();
      });
      entry.watcher = watcher;
      watcher.on('error', (error) => {
        if (this.directories.get(path) !== entry || entry.watcher !== watcher) return;
        watcher.close();
        entry.watcher = undefined;
        if (directoryState(path)?.identity !== entry.identity) this.schedule();
        else this.fail(error);
      });
    }
  }

  private schedule(): void {
    if (!this.marker || this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = undefined;
      this.inspect();
    }, 10).unref();
  }

  private inspect(): void {
    try {
      this.syncDirectories();
      let moved = false;
      for (const [slot, previous] of this.slots) {
        const target = targetOf(slot);
        if (target === previous) continue;
        this.slots.set(slot, target);
        moved = true;
      }
      if (moved) this.signal();
    } catch (error) {
      this.fail(error as Error);
    }
  }

  private fail(error: Error): void {
    this.failure = new Error('Cannot observe installed dependency links: ' + error.message, {
      cause: error,
    });
    clearInterval(this.timer);
    this.timer = undefined;
    this.signal();
  }

  private signal(): void {
    if (this.marker) writeFileSync(this.marker, String(++this.revision));
  }
}
