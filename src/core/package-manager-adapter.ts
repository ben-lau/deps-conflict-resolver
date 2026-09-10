import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { posix, win32 } from 'path';
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

export interface PackageManagerInvocation {
  command: string;
  argsPrefix: string[];
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

      const { command, args } = buildCommand(options.packageManager, specs, env);

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
  environment: NodeJS.ProcessEnv,
): { command: string; args: string[] } {
  const invocation = resolvePackageManagerInvocation(packageManager, process.platform, environment);

  switch (packageManager) {
    case 'pnpm':
      return {
        command: invocation.command,
        args: [...invocation.argsPrefix, 'add', ...specs],
      };
    case 'yarn':
      return {
        command: invocation.command,
        args: [...invocation.argsPrefix, 'add', ...specs],
      };
    case 'npm':
      return {
        command: invocation.command,
        args: [...invocation.argsPrefix, 'install', '--legacy-peer-deps', ...specs],
      };
  }

  throw new Error(`Unsupported package manager: ${String(packageManager)}`);
}

export function resolvePackageManagerCommand(
  packageManager: PackageManagerType,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'win32' ? `${packageManager}.cmd` : packageManager;
}

export function resolvePackageManagerInvocation(
  packageManager: PackageManagerType,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): PackageManagerInvocation {
  if (platform !== 'win32') {
    return {
      command: resolvePackageManagerCommand(packageManager, platform),
      argsPrefix: [],
    };
  }

  const windowsInvocation = resolveWindowsPackageManagerInvocation(packageManager, environment);
  if (!windowsInvocation) {
    throw new Error(`Could not resolve a Node entrypoint for ${packageManager}`);
  }

  return windowsInvocation;
}

function resolveWindowsPackageManagerInvocation(
  packageManager: PackageManagerType,
  environment: NodeJS.ProcessEnv,
): PackageManagerInvocation | undefined {
  const npmExecPath = getEnvironmentValue(environment, 'npm_execpath');
  if (npmExecPath && matchesPackageManagerPath(packageManager, npmExecPath, 'win32')) {
    const invocation = invocationFromPackageManagerPath(packageManager, npmExecPath, 'win32');
    if (invocation) {
      return invocation;
    }
  }

  const pathValue = getEnvironmentValue(environment, 'PATH');
  if (!pathValue) {
    return undefined;
  }

  for (const directory of pathValue.split(';')) {
    if (!directory) {
      continue;
    }

    const shimPath = win32.join(directory, `${packageManager}.cmd`);
    if (existsSync(shimPath)) {
      const invocation = invocationFromPackageManagerPath(packageManager, shimPath, 'win32');
      if (invocation) {
        return invocation;
      }
    }

    const executablePath = win32.join(directory, `${packageManager}.exe`);
    if (existsSync(executablePath)) {
      return { command: executablePath, argsPrefix: [] };
    }
  }

  return undefined;
}

function invocationFromPackageManagerPath(
  packageManager: PackageManagerType,
  packageManagerPath: string,
  platform: NodeJS.Platform,
): PackageManagerInvocation | undefined {
  const lowerPath = packageManagerPath.toLowerCase();
  if (lowerPath.endsWith('.exe')) {
    return { command: packageManagerPath, argsPrefix: [] };
  }

  if (lowerPath.endsWith('.cmd') || lowerPath.endsWith('.bat')) {
    const entrypoint = parseWindowsShimEntrypoint(packageManager, packageManagerPath, platform);
    if (!entrypoint) {
      return undefined;
    }
    return { command: process.execPath, argsPrefix: [entrypoint] };
  }

  if (isJavaScriptEntrypoint(packageManagerPath)) {
    return { command: process.execPath, argsPrefix: [packageManagerPath] };
  }

  return undefined;
}

function parseWindowsShimEntrypoint(
  packageManager: PackageManagerType,
  shimPath: string,
  platform: NodeJS.Platform,
): string | undefined {
  let shimContents: string;
  try {
    shimContents = readFileSync(shimPath, 'utf8');
  } catch (error) {
    logger.debug(`Failed to read ${packageManager} shim: ${String(error)}`);
    return undefined;
  }

  const targetMatch = shimContents.match(/"((?:%~dp0|%dp0%)[\\/][^"\r\n]+\.(?:js|cjs|mjs))"/i);
  if (!targetMatch?.[1]) {
    const absoluteMatch = shimContents.match(/"([A-Za-z]:[\\/][^"\r\n]+\.(?:js|cjs|mjs))"/i);
    return absoluteMatch?.[1];
  }

  const target = targetMatch[1];
  const markerMatch = target.match(/^%(?:~dp0|dp0%)[\\/](.*)$/i);
  if (!markerMatch?.[1]) {
    return undefined;
  }

  const pathModule = platform === 'win32' ? win32 : posix;
  return pathModule.resolve(pathModule.dirname(shimPath), markerMatch[1]);
}

function matchesPackageManagerPath(
  packageManager: PackageManagerType,
  packageManagerPath: string,
  platform: NodeJS.Platform,
): boolean {
  const pathModule = platform === 'win32' ? win32 : posix;
  const fileName = pathModule.basename(packageManagerPath).toLowerCase();
  switch (packageManager) {
    case 'npm':
      return fileName === 'npm' || fileName === 'npm.cmd' || fileName === 'npm-cli.js';
    case 'pnpm':
      return fileName === 'pnpm' || fileName === 'pnpm.cmd' || fileName.startsWith('pnpm.');
    case 'yarn':
      return fileName === 'yarn' || fileName === 'yarn.cmd' || fileName.startsWith('yarn.');
  }

  return false;
}

function isJavaScriptEntrypoint(filePath: string): boolean {
  return /\.(?:js|cjs|mjs)$/i.test(filePath);
}

function getEnvironmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const exactValue = environment[name];
  if (exactValue !== undefined) {
    return exactValue;
  }

  const lowerName = name.toLowerCase();
  const key = Object.keys(environment).find((candidate) => candidate.toLowerCase() === lowerName);
  return key ? environment[key] : undefined;
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
