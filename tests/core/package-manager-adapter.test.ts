import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { execFile, spawn } from 'child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPackageManagerAdapter,
  resolvePackageManagerInvocation,
} from '../../src/core/package-manager-adapter';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
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

  it.skipIf(process.platform === 'win32').each([
    ['npm', 'npm', ['install', '--legacy-peer-deps', '--save-exact']],
    ['pnpm', 'pnpm', ['add', '--save-exact']],
    ['yarn', 'yarn', ['add', '--exact']],
  ] as const)(
    'passes %s specs as literal child-process arguments on POSIX',
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
        env: expect.objectContaining({
          npm_config_registry: 'https://registry.example.test',
          ...(packageManager === 'yarn'
            ? { YARN_NPM_REGISTRY_SERVER: 'https://registry.example.test' }
            : {}),
        }),
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(process.platform === 'win32' ? {} : { detached: true }),
      });
    },
  );

  it.skipIf(process.platform === 'win32').each([
    ['"https://scoped.example.test/"', false],
    ['null', true],
    ['"https://registry.example.test/"', true],
  ])('honors a scoped Yarn registry check returning %s', async (registry, success) => {
    const root = await mkdtemp(join(tmpdir(), 'deps-yarn-scoped-registry-'));
    try {
      await writeFile(join(root, 'package.json'), '{"packageManager":"yarn@4.6.0"}');
      vi.mocked(execFile).mockImplementationOnce((...args) => {
        const callback = args.at(-1) as (error: null, stdout: string, stderr: string) => void;
        callback(null, registry, '');
        return {} as ReturnType<typeof execFile>;
      });
      vi.mocked(spawn).mockImplementation(() => createChildProcess(0) as never);
      const adapter = createPackageManagerAdapter({
        ...options,
        projectRoot: root,
        packageManager: 'yarn',
      });
      const result = await adapter.install(['runtime@npm:@upstream/runtime@2.7.16']);
      expect(result.success).toBe(success);
      expect(vi.mocked(spawn)).toHaveBeenCalledTimes(success ? 1 : 0);
      expect(vi.mocked(execFile).mock.calls[0]?.[1]).toEqual([
        'config',
        'get',
        'npmScopes["upstream"].npmRegistryServer',
        '--json',
      ]);
      if (!success) expect(result.stderr).toContain('Yarn npmScopes for @upstream');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32').each([
    ['npm', '--'],
    ['pnpm', '--config.'],
  ] as const)(
    'passes %s an exact registry option for the original package scope',
    async (packageManager, flagPrefix) => {
      vi.mocked(spawn).mockReturnValue(createChildProcess(0) as never);
      const adapter = createPackageManagerAdapter({ ...options, packageManager });
      await expect(
        adapter.install(['@local/runtime@npm:@upstream_team/runtime@2.7.16']),
      ).resolves.toMatchObject({ success: true });
      const [, args, child] = vi.mocked(spawn).mock.lastCall!;
      expect(args.filter((arg) => arg.includes(':registry='))).toEqual([
        flagPrefix + '@upstream_team:registry=' + options.registry,
      ]);
      expect(child?.env?.['npm_config_@upstream_team:registry']).toBeUndefined();
    },
  );

  it.skipIf(process.platform === 'win32').each([
    ['pnpm', '10.7.1', ['--save-exact', '-w']],
    ['yarn', '1.22.22', ['--exact', '-W']],
    ['yarn', '4.6.0', ['--exact']],
  ] as const)('targets the workspace root with %s %s', async (packageManager, version, flags) => {
    const root = await mkdtemp(join(tmpdir(), 'deps-package-manager-workspace-'));
    try {
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({
          private: true,
          packageManager: packageManager + '@' + version,
          workspaces: ['packages/*', 'apps/*'],
        }),
      );
      if (packageManager === 'pnpm')
        await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages: [packages/*, apps/*]\n');
      vi.mocked(spawn).mockReturnValue(createChildProcess(0) as never);
      const spec = 'vue2@npm:vue@2.7.16';
      const adapter = createPackageManagerAdapter({
        ...options,
        projectRoot: root,
        packageManager,
      });
      await expect(adapter.install([spec])).resolves.toMatchObject({ success: true });
      const [command, args, childOptions] = vi.mocked(spawn).mock.calls[0]!;
      expect([command, args, childOptions?.cwd]).toEqual([
        packageManager,
        ['add', ...flags, spec],
        root,
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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

  it.each([
    [
      'npm',
      'NPM_CLI_JS',
      'node_modules\\npm\\bin\\npm-cli.js',
      'NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js',
    ],
    ['pnpm', 'PNPM_CLI_JS', 'pnpm.cjs', 'PNPM_CLI_JS=%~dp0\\pnpm.cjs'],
    [
      'yarn',
      'YARN_CLI_JS',
      'node_modules\\yarn\\bin\\yarn.js',
      'YARN_CLI_JS=%~dp0\\node_modules\\yarn\\bin\\yarn.js',
    ],
  ] as const)(
    'resolves the variable-referenced %s Windows shim entrypoint',
    async (packageManager, variable, relativeTarget, assignment) => {
      const root = await mkdtemp(join(tmpdir(), 'package-manager-shim-'));
      const shimPath = join(root, `${packageManager}.cmd`);
      await writeFile(shimPath, `@SET "${assignment}"\r\n"%~dp0\\node.exe" "%${variable}%" %*\r\n`);

      try {
        expect(
          resolvePackageManagerInvocation(packageManager, 'win32', {
            npm_execpath: shimPath,
          }),
        ).toEqual({
          command: process.execPath,
          argsPrefix: [win32.resolve(win32.dirname(shimPath), relativeTarget)],
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('prefers npm-cli.js when the standard npm shim defines prefix and cli variables', async () => {
    const root = await mkdtemp(join(tmpdir(), 'package-manager-shim-'));
    const shimPath = join(root, 'npm.cmd');
    await writeFile(
      shimPath,
      [
        '@SET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"',
        '@SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"',
        '"%~dp0\\node.exe" "%NPM_PREFIX_JS%" %*',
        '"%~dp0\\node.exe" "%NPM_CLI_JS%" %*',
      ].join('\r\n'),
    );

    try {
      expect(
        resolvePackageManagerInvocation('npm', 'win32', {
          npm_execpath: shimPath,
        }),
      ).toEqual({
        command: process.execPath,
        argsPrefix: [win32.resolve(win32.dirname(shimPath), 'node_modules\\npm\\bin\\npm-cli.js')],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an unknown npm shim variable pointing to a JavaScript file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'package-manager-shim-'));
    const shimPath = join(root, 'npm.cmd');
    await writeFile(
      shimPath,
      ['@SET "UNTRUSTED_JS=%~dp0\\payload.js"', '"%~dp0\\node.exe" "%UNTRUSTED_JS%" %*'].join(
        '\r\n',
      ),
    );

    try {
      expect(() =>
        resolvePackageManagerInvocation('npm', 'win32', {
          npm_execpath: shimPath,
        }),
      ).toThrow('Could not resolve a Node entrypoint for npm');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an unrecognized Windows package-manager shim', async () => {
    const root = await mkdtemp(join(tmpdir(), 'package-manager-shim-'));
    const shimPath = join(root, 'npm.cmd');
    await writeFile(shimPath, '@ECHO off\r\nECHO not a package manager shim\r\n');

    try {
      expect(() =>
        resolvePackageManagerInvocation('npm', 'win32', {
          npm_execpath: shimPath,
        }),
      ).toThrow('Could not resolve a Node entrypoint for npm');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
