import {
  mkdirSync,
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
  private revision = 0;
  private interval?: number;
  private readonly fallbackInterval: number;
  private readonly watchDirectory: typeof watch;

  constructor(
    options: { usePolling?: boolean; interval?: number; watchDirectory?: typeof watch } = {},
  ) {
    this.watchDirectory = options.watchDirectory ?? watch;
    const configured = process.env.CHOKIDAR_INTERVAL
      ? Number.parseInt(process.env.CHOKIDAR_INTERVAL, 10)
      : (options.interval ?? 100);
    this.fallbackInterval = Number.isFinite(configured) && configured > 0 ? configured : 100;
    const setting = process.env.CHOKIDAR_USEPOLLING?.toLowerCase();
    const polling =
      setting === undefined
        ? options.usePolling === true
        : setting !== '' && setting !== 'false' && setting !== '0';
    if (polling) this.interval = this.fallbackInterval;
  }

  update(files: Iterable<string>): string | undefined {
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
      try {
        this.directory = realpathSync(mkdtempSync(join(tmpdir(), 'deps-vite-watch-')));
        this.marker = join(this.directory, 'revision');
        writeFileSync(this.marker, '0');
      } catch {
        this.directory = undefined;
        this.marker = undefined;
      }
    }
    this.syncDirectories();
    this.syncTimer();
    return this.marker;
  }

  close(): void {
    clearInterval(this.timer);
    clearTimeout(this.pending);
    this.timer = undefined;
    this.pending = undefined;
    this.slots.clear();
    const entries = [...this.directories.values()];
    this.directories.clear();
    for (const entry of entries) entry.watcher?.close();
    this.marker = undefined;
    if (this.directory) {
      try {
        rmSync(this.directory, { recursive: true, force: true, maxRetries: 2 });
      } catch {
        // Windows watchers may release directory handles asynchronously.
      }
    }
    this.directory = undefined;
  }

  private syncTimer(): void {
    if (this.slots.size > 0 && this.marker && this.interval !== undefined) {
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
  }

  private fallbackToPolling(): void {
    this.interval ??= this.fallbackInterval;
    for (const entry of this.directories.values()) {
      entry.watcher?.close();
      entry.watcher = undefined;
    }
    this.syncTimer();
    this.schedule();
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
      try {
        const watcher = this.watchDirectory(path, { persistent: false }, (_event, filename) => {
          const changed = filename ? join(path, filename.toString()) : undefined;
          if (!changed || this.slots.has(changed) || this.directories.has(changed)) this.schedule();
        });
        entry.watcher = watcher;
        watcher.on('error', () => {
          if (this.directories.get(path) !== entry || entry.watcher !== watcher) return;
          watcher.close();
          entry.watcher = undefined;
          if (directoryState(path)?.identity !== entry.identity) this.schedule();
          else this.fallbackToPolling();
        });
      } catch {
        if (directoryState(path)?.identity !== entry.identity) this.schedule();
        else this.fallbackToPolling();
      }
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
    this.syncDirectories();
    let moved = false;
    for (const [slot, previous] of this.slots) {
      const target = targetOf(slot);
      if (target === previous) continue;
      this.slots.set(slot, target);
      moved = true;
    }
    if (moved) this.signal();
  }

  private signal(): void {
    if (!this.marker) return;
    const next = String(++this.revision);
    try {
      writeFileSync(this.marker, next);
    } catch {
      try {
        if (this.directory) mkdirSync(this.directory, { recursive: true });
        writeFileSync(this.marker, next);
      } catch {
        // Keep Rollup's own watcher running if the temporary directory is unavailable.
      }
    }
  }
}
