import { execFile, spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { posix, win32 } from 'path';
import type { PackageManagerType, ResolvedOptions } from '../types';
import { createLogger } from '../utils/logger';
import { readPackageJsonCached } from '../utils/fs';
import { createWorkspaceDetector } from './workspace-detector';
import { parseNpmAlias } from '../utils/version-spec';

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

interface PackageManagerEntrypointRule {
  cliVariables: readonly string[];
  cliBasenames: readonly string[];
}

const PACKAGE_MANAGER_ENTRYPOINT_RULES: Record<PackageManagerType, PackageManagerEntrypointRule> = {
  npm: {
    cliVariables: ['NPM_CLI_JS'],
    cliBasenames: ['npm-cli.js', 'npm.js'],
  },
  pnpm: {
    cliVariables: ['PNPM_CLI_JS'],
    cliBasenames: ['pnpm.cjs', 'pnpm.js'],
  },
  yarn: {
    cliVariables: ['YARN_CLI_JS'],
    cliBasenames: ['yarn.js', 'yarn.cjs'],
  },
};

const DEFAULT_TIMING: PackageManagerTiming = {
  timeoutMs: 120_000,
  terminateGraceMs: 5_000,
};

export function createPackageManagerAdapter(
  options: Pick<ResolvedOptions, 'packageManager' | 'projectRoot'> & { registry?: string },
  timing: PackageManagerTiming = DEFAULT_TIMING,
): PackageManagerAdapter {
  return {
    install: async (specs: string[]): Promise<PackageManagerRunResult> => {
      if (specs.length === 0) {
        return {
          success: true,
          exitCode: 0,
          stdout: '',
          stderr: '',
          timedOut: false,
        };
      }
      const scopes = new Set<string>();
      if (options.registry) {
        for (const spec of specs) {
          const alias = spec.indexOf('@npm:');
          const name = alias < 0 ? undefined : parseNpmAlias(spec.slice(alias + 1))?.[0];
          if (name?.startsWith('@')) scopes.add(name.split('/', 1)[0]!);
        }
      }
      const env = registryEnvironment(options.packageManager, options.registry, scopes);

      const invocation = resolvePackageManagerInvocation(
        options.packageManager,
        process.platform,
        env,
      );
      let rootFlag: '-w' | '-W' | undefined;
      if (options.packageManager !== 'npm') {
        const workspace = createWorkspaceDetector(options.projectRoot).detect();
        const atWorkspaceRoot = workspace.workspaceRoot === options.projectRoot;
        if (
          options.packageManager === 'pnpm' &&
          atWorkspaceRoot &&
          workspace.workspaceType === 'pnpm'
        ) {
          rootFlag = '-w';
        } else if (options.packageManager === 'yarn') {
          const manifest = readPackageJsonCached(options.projectRoot);
          const scopedOverride = options.registry && scopes.size > 0;
          if (scopedOverride || (atWorkspaceRoot && manifest?.workspaces)) {
            const pinnedManager =
              manifest?.packageManager ??
              (workspace.workspaceRoot &&
                readPackageJsonCached(workspace.workspaceRoot)?.packageManager);
            const pinnedMajor = pinnedManager?.match(/^yarn@(\d+)(?:\.|$)/)?.[1];
            const classic = pinnedMajor
              ? pinnedMajor === '1'
              : await isYarnClassic(invocation, options.projectRoot, env);
            if (classic && atWorkspaceRoot && manifest?.workspaces) rootFlag = '-W';
            if (!classic && scopedOverride) {
              const problem = await checkYarnRegistry(
                invocation,
                options.projectRoot,
                env,
                scopes,
                options.registry!,
              );
              if (problem)
                return {
                  success: false,
                  exitCode: null,
                  stdout: '',
                  stderr: problem,
                  timedOut: false,
                };
            }
          }
        }
      }
      const { command, args } = buildCommand(options.packageManager, specs, invocation, rootFlag);

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
  invocation: PackageManagerInvocation,
  rootFlag?: '-w' | '-W',
): { command: string; args: string[] } {
  const { command, argsPrefix } = invocation;
  const rootArgs = rootFlag ? [rootFlag] : [];
  switch (packageManager) {
    case 'pnpm':
      return { command, args: [...argsPrefix, 'add', '--save-exact', ...rootArgs, ...specs] };
    case 'yarn':
      return { command, args: [...argsPrefix, 'add', '--exact', ...rootArgs, ...specs] };
    case 'npm':
      return {
        command,
        args: [...argsPrefix, 'install', '--legacy-peer-deps', '--save-exact', ...specs],
      };
  }
  throw new Error(`Unsupported package manager: ${String(packageManager)}`);
}

function isYarnClassic(
  invocation: PackageManagerInvocation,
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      invocation.command,
      [...invocation.argsPrefix, '--version'],
      { cwd, env: environment, timeout: 5_000, windowsHide: true },
      (error, stdout) => resolve(!error && stdout.trim().startsWith('1.')),
    );
  });
}

async function checkYarnRegistry(
  invocation: PackageManagerInvocation,
  cwd: string,
  env: NodeJS.ProcessEnv,
  scopes: ReadonlySet<string>,
  registry: string,
): Promise<string | undefined> {
  // Modern Yarn accepts a global registry via the environment, while a scope
  // configured in npmScopes takes precedence and cannot be overridden that way.
  for (const scope of scopes) {
    const key = 'npmScopes[' + JSON.stringify(scope.slice(1)) + '].npmRegistryServer';
    const output = await new Promise<string | undefined>((resolve) => {
      execFile(
        invocation.command,
        [...invocation.argsPrefix, 'config', 'get', key, '--json'],
        { cwd, env, timeout: 5_000, windowsHide: true },
        (error, stdout) => resolve(error ? undefined : stdout.trim()),
      );
    });
    if (output === 'undefined' || output === 'null') continue;
    try {
      if (output !== undefined) {
        const scoped: unknown = JSON.parse(output);
        if (
          typeof scoped === 'string' &&
          new URL(scoped).href.replace(/\/+$/, '') === new URL(registry).href.replace(/\/+$/, '')
        )
          continue;
        if (typeof scoped === 'string')
          return (
            'The explicit registry conflicts with Yarn npmScopes for ' +
            scope +
            '. Align npmRegistryServer with the requested registry before installing.'
          );
      }
    } catch {
      // Report the setting by name. Neither command output nor credentials are needed.
    }
    return (
      'Could not verify Yarn npmScopes registry for ' +
      scope +
      '. Check yarn config before installing.'
    );
  }
  return undefined;
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

  const assignments = parseWindowsShimAssignments(shimContents);
  const rule = PACKAGE_MANAGER_ENTRYPOINT_RULES[packageManager];
  const allowedVariables = new Set(rule.cliVariables);

  for (const variable of rule.cliVariables) {
    const values = assignments.get(variable);
    if (!values) {
      continue;
    }

    for (const value of values) {
      const entrypoint = resolveShimTarget(
        value,
        assignments,
        shimPath,
        platform,
        allowedVariables,
      );
      if (entrypoint && isKnownPackageManagerEntrypoint(packageManager, entrypoint)) {
        return entrypoint;
      }
    }
  }

  const directTargetPattern = /"((?:%~dp0|%dp0%)[\\/][^"\r\n]+\.(?:js|cjs|mjs))"/gi;
  for (const match of shimContents.matchAll(directTargetPattern)) {
    const target = match[1];
    if (target) {
      const entrypoint = resolveShimTarget(
        target,
        assignments,
        shimPath,
        platform,
        allowedVariables,
      );
      if (entrypoint && isKnownPackageManagerEntrypoint(packageManager, entrypoint)) {
        return entrypoint;
      }
    }
  }

  const absoluteTargetPattern = /"([A-Za-z]:[\\/][^"\r\n]+\.(?:js|cjs|mjs))"/gi;
  for (const match of shimContents.matchAll(absoluteTargetPattern)) {
    const target = match[1];
    if (target) {
      const entrypoint = resolveShimTarget(
        target,
        assignments,
        shimPath,
        platform,
        allowedVariables,
      );
      if (entrypoint && isKnownPackageManagerEntrypoint(packageManager, entrypoint)) {
        return entrypoint;
      }
    }
  }

  return undefined;
}

function parseWindowsShimAssignments(contents: string): Map<string, string[]> {
  const assignments = new Map<string, string[]>();
  const assignmentPattern =
    /^\s*@?set\s+(?:"([A-Za-z_][A-Za-z0-9_]*)=([^"\r\n]*)"|([A-Za-z_][A-Za-z0-9_]*)=([^\r\n]*))\s*$/gim;

  for (const match of contents.matchAll(assignmentPattern)) {
    const name = (match[1] ?? match[3])?.toUpperCase();
    const value = (match[2] ?? match[4])?.trim();
    if (name && value !== undefined) {
      const values = assignments.get(name) ?? [];
      values.push(value);
      assignments.set(name, values);
    }
  }

  return assignments;
}

function resolveShimTarget(
  rawTarget: string,
  assignments: Map<string, string[]>,
  shimPath: string,
  platform: NodeJS.Platform,
  allowedVariables: ReadonlySet<string>,
  seenVariables: Set<string> = new Set(),
): string | undefined {
  const target = rawTarget.trim().replace(/^"|"$/g, '');
  const markerMatch = target.match(/^%(?:~dp0|dp0%)([\\/].*)$/i);
  if (markerMatch?.[1]) {
    const pathModule = platform === 'win32' ? win32 : posix;
    const relativeTarget = markerMatch[1].replace(/^[\\/]/, '');
    const resolvedTarget = pathModule.resolve(pathModule.dirname(shimPath), relativeTarget);
    return isJavaScriptEntrypoint(resolvedTarget) ? resolvedTarget : undefined;
  }

  const variableMatch = target.match(/^%([A-Za-z_][A-Za-z0-9_]*)%([\\/].*)?$/);
  if (variableMatch?.[1]) {
    const variable = variableMatch[1].toUpperCase();
    if (!allowedVariables.has(variable)) {
      return undefined;
    }

    if (seenVariables.has(variable)) {
      return undefined;
    }

    const assignedValues = assignments.get(variable);
    if (!assignedValues) {
      return undefined;
    }

    const nextSeenVariables = new Set(seenVariables);
    nextSeenVariables.add(variable);
    for (const assignedValue of assignedValues) {
      const resolved = resolveShimTarget(
        `${assignedValue}${variableMatch[2] ?? ''}`,
        assignments,
        shimPath,
        platform,
        allowedVariables,
        nextSeenVariables,
      );
      if (resolved) {
        return resolved;
      }
    }
    return undefined;
  }

  return isJavaScriptEntrypoint(target) ? target : undefined;
}

function isKnownPackageManagerEntrypoint(
  packageManager: PackageManagerType,
  filePath: string,
): boolean {
  const fileName = win32.basename(filePath).toLowerCase();
  return PACKAGE_MANAGER_ENTRYPOINT_RULES[packageManager].cliBasenames.includes(fileName);
}

function matchesPackageManagerPath(
  packageManager: PackageManagerType,
  packageManagerPath: string,
  platform: NodeJS.Platform,
): boolean {
  const pathModule = platform === 'win32' ? win32 : posix;
  const fileName = pathModule.basename(packageManagerPath).toLowerCase();
  return (
    fileName === `${packageManager}.cmd` ||
    fileName === `${packageManager}.exe` ||
    isKnownPackageManagerEntrypoint(packageManager, packageManagerPath)
  );
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
  registry: string | undefined,
  scopes: ReadonlySet<string>,
): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  if (!registry) return environment;
  const overrides = {
    npm_config_registry: registry,
    ...Object.fromEntries(
      [...scopes].map((scope) => ['npm_config_' + scope + ':registry', registry]),
    ),
    // Classic Yarn reads npm's registry setting; modern Yarn uses this key.
    ...(packageManager === 'yarn' ? { YARN_NPM_REGISTRY_SERVER: registry } : {}),
  };
  const overridden = new Set(Object.keys(overrides).map((key) => key.toLowerCase()));
  for (const key of Object.keys(environment)) {
    if (overridden.has(key.toLowerCase())) delete environment[key];
  }
  return Object.assign(environment, overrides);
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
