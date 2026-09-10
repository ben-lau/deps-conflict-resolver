import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPackageManagerAdapter,
  resolvePackageManagerInvocation,
} from '../../src/core/package-manager-adapter';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

const options = {
  packageManager: 'npm',
  projectRoot: '/test/project',
  registry: 'https://registry.example.test',
} as const;

describe('createPackageManagerAdapter', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['npm', 'npm', ['install', '--legacy-peer-deps']],
    ['pnpm', 'pnpm', ['add']],
    ['yarn', 'yarn', ['add']],
  ] as const)(
    'passes %s specs as literal child-process arguments',
    async (packageManager, command, prefix) => {
      const child = createChildProcess(0);
      vi.mocked(spawn).mockReturnValue(child as never);

      const spec = 'aliased-vue@npm:vue@2.7.0;touch injected';
      const adapter = createPackageManagerAdapter({ ...options, packageManager });

      const result = await adapter.install([spec]);

      expect(result).toMatchObject({
        success: true,
        exitCode: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
      });
      expect(spawn).toHaveBeenCalledWith(command, [...prefix, spec], {
        cwd: '/test/project',
        env: expect.objectContaining(
          packageManager === 'yarn'
            ? { YARN_NPM_REGISTRY_SERVER: 'https://registry.example.test' }
            : { npm_config_registry: 'https://registry.example.test' },
        ),
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(process.platform === 'win32' ? {} : { detached: true }),
      });
    },
  );

  it.each([
    ['npm', 'C:\\node\\node_modules\\npm\\bin\\npm-cli.js'],
    ['pnpm', 'C:\\node\\pnpm.cjs'],
    ['yarn', 'C:\\node\\yarn.js'],
  ] as const)('selects a Node entrypoint for Windows %s', (packageManager, entrypoint) => {
    expect(
      resolvePackageManagerInvocation(packageManager, 'win32', {
        npm_execpath: entrypoint,
      }),
    ).toEqual({
      command: process.execPath,
      argsPrefix: [entrypoint],
    });
  });

  it.each(['npm', 'pnpm', 'yarn'] as const)(
    'keeps the direct executable for POSIX %s',
    (packageManager) => {
      expect(resolvePackageManagerInvocation(packageManager, 'darwin', {})).toEqual({
        command: packageManager,
        argsPrefix: [],
      });
    },
  );

  it('waits for close after a non-timeout process error', async () => {
    const child = createChildProcess();
    vi.mocked(spawn).mockReturnValue(child as never);

    const adapter = createPackageManagerAdapter(options);
    const installation = adapter.install(['missing-command']);
    child.emit('error', new Error('Command not found'));

    const state = await Promise.race([
      installation.then(() => 'settled' as const),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 20)),
    ]);
    expect(state).toBe('pending');

    child.emit('close', null);
    await expect(installation).resolves.toEqual({
      success: false,
      exitCode: null,
      stdout: '',
      stderr: 'Command not found',
      timedOut: false,
    });
  });

  it.skipIf(process.platform === 'win32')(
    'waits for close after terminating a process that ignores SIGTERM',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'package-manager-adapter-'));
      const bin = join(root, 'bin');
      const executable = join(bin, 'npm');
      const previousPath = process.env.PATH;

      await mkdir(bin);
      await writeFile(
        executable,
        '#!/usr/bin/env node\nprocess.on("SIGTERM", () => {}); setInterval(() => {}, 1000);\n',
      );
      await chmod(executable, 0o755);
      process.env.PATH = `${bin}:${previousPath ?? ''}`;

      const actualChildProcess =
        await vi.importActual<typeof import('child_process')>('child_process');
      vi.mocked(spawn).mockImplementation(actualChildProcess.spawn);

      const adapter = createPackageManagerAdapter(
        {
          ...options,
          packageManager: 'npm',
          projectRoot: root,
        },
        { timeoutMs: 50, terminateGraceMs: 50 },
      );
      const installation = adapter.install(['ignored-spec']);
      const result = await Promise.race([
        installation,
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 250)),
      ]);

      try {
        const child = vi.mocked(spawn).mock.results[0]?.value as { pid?: number } | undefined;
        const pid = child?.pid;
        expect(pid).toBeTypeOf('number');
        expect(result).toMatchObject({
          success: false,
          exitCode: null,
          timedOut: true,
        });
        expect(() => process.kill(pid as number, 0)).toThrow();
      } finally {
        const child = vi.mocked(spawn).mock.results[0]?.value as { pid?: number } | undefined;
        if (child?.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            try {
              process.kill(child.pid, 'SIGKILL');
            } catch {
              // The adapter already terminated the process.
            }
          }
        }
        await installation;
        process.env.PATH = previousPath;
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

function createChildProcess(exitCode?: number): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  if (exitCode !== undefined) {
    queueMicrotask(() => child.emit('close', exitCode));
  }
  return child;
}
