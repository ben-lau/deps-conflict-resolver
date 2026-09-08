import { spawn } from 'child_process';
import type { PackageManagerType, ResolvedOptions } from '../types';
import { createLogger } from '../utils/logger';

const logger = createLogger('package-manager-adapter');

export interface PackageManagerRunResult {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface PackageManagerAdapter {
  install(specs: string[]): Promise<PackageManagerRunResult>;
}

interface PackageManagerTiming {
  timeoutMs: number;
  terminateGraceMs: number;
}

const DEFAULT_TIMING: PackageManagerTiming = {
  timeoutMs: 120_000,
  terminateGraceMs: 5_000,
};

export function createPackageManagerAdapter(
  options: Pick<ResolvedOptions, 'packageManager' | 'projectRoot' | 'registry'>,
  timing: PackageManagerTiming = DEFAULT_TIMING,
): PackageManagerAdapter {
  return {
    install: async (specs: string[]): Promise<PackageManagerRunResult> => {
      const { command, args } = buildCommand(options.packageManager, specs);
      const env = registryEnvironment(options.packageManager, options.registry);

      if (specs.length === 0) {
        return {
          success: true,
          exitCode: 0,
          stdout: '',
          stderr: '',
          timedOut: false,
        };
      }

      logger.info(`Running: ${command} ${args.map((arg) => JSON.stringify(arg)).join(' ')}`);

      const child = spawn(command, args, {
        cwd: options.projectRoot,
        env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(process.platform === 'win32' ? {} : { detached: true }),
      });

      return new Promise<PackageManagerRunResult>((resolve) => {
        let stdout = '';
        let stderr = '';
        let terminalError: Error | undefined;
        let timedOut = false;
        let settled = false;
        let closeSeen = false;
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        let graceId: ReturnType<typeof setTimeout> | undefined;

        const clearTimers = (): void => {
          if (timeoutId !== undefined) {
            clearTimeout(timeoutId);
          }
          if (graceId !== undefined) {
            clearTimeout(graceId);
          }
        };

        const finish = (exitCode: number | null): void => {
          if (settled) {
            return;
          }

          settled = true;
          clearTimers();
          resolve({
            success: !timedOut && !terminalError && exitCode === 0,
            exitCode,
            stdout,
            stderr: stderr || (terminalError?.message ?? ''),
            timedOut,
          });
        };

        child.stdout?.on('data', (data: Buffer | string) => {
          stdout += data.toString();
        });
        child.stderr?.on('data', (data: Buffer | string) => {
          stderr += data.toString();
        });

        child.on('error', (error) => {
          terminalError = error;
          if (!timedOut) {
            finish(null);
          }
        });

        child.on('close', (exitCode) => {
          closeSeen = true;
          finish(exitCode);
        });

        timeoutId = setTimeout(() => {
          if (settled || closeSeen) {
            return;
          }

          timedOut = true;
          logger.error(`Install timeout after ${timing.timeoutMs / 1000}s`);
          sendTerminationSignal(child, 'SIGTERM');

          graceId = setTimeout(() => {
            if (!settled && !closeSeen) {
              terminateProcessTree(child);
            }
          }, timing.terminateGraceMs);
        }, timing.timeoutMs);
      });
    },
  };
}

function buildCommand(
  packageManager: PackageManagerType,
  specs: string[],
): { command: string; args: string[] } {
  switch (packageManager) {
    case 'pnpm':
      return { command: 'pnpm', args: ['add', ...specs] };
    case 'yarn':
      return { command: 'yarn', args: ['add', ...specs] };
    case 'npm':
      return { command: 'npm', args: ['install', '--legacy-peer-deps', ...specs] };
  }

  throw new Error(`Unsupported package manager: ${String(packageManager)}`);
}

function registryEnvironment(
  packageManager: PackageManagerType,
  registry: string,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(packageManager === 'yarn'
      ? { YARN_NPM_REGISTRY_SERVER: registry }
      : { npm_config_registry: registry }),
  };
}

function sendTerminationSignal(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      logger.debug(`Failed to signal package-manager process group: ${String(error)}`);
    }
  }

  try {
    child.kill(signal);
  } catch (error) {
    logger.debug(`Failed to signal package-manager process: ${String(error)}`);
  }
}

function terminateProcessTree(child: ReturnType<typeof spawn>): void {
  if (process.platform === 'win32') {
    if (!child.pid) {
      try {
        child.kill('SIGKILL');
      } catch (error) {
        logger.debug(`Failed to terminate package-manager process: ${String(error)}`);
      }
      return;
    }

    const taskkill = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      shell: false,
      stdio: 'ignore',
    });
    taskkill.on('error', (error) => {
      logger.debug(`Failed to terminate package-manager process tree: ${error.message}`);
    });
    return;
  }

  if (child.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch (error) {
      logger.debug(`Failed to terminate package-manager process group: ${String(error)}`);
    }
  }

  try {
    child.kill('SIGKILL');
  } catch (error) {
    logger.debug(`Failed to terminate package-manager process: ${String(error)}`);
  }
}
