import { extname, resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { DepsConflictResolver, getResolverBuild } from './resolver';
import { findPackagePath, findProjectRoot, readPackageJsonCached } from '../utils/fs';
import { LogLevel, withLogLevel } from '../utils/logger';
import { ResolutionError } from './resolution-error';
import { loadCliConfig } from './cli-config';
import { diagnoseNextSteps, findSourceHints, suggestEntryPackages } from './cli-advice';
import type { DepsConflictResolverOptions } from '../types';

interface CliOutput {
  stdout(text: string): void;
  stderr(text: string): void;
}

const HELP = [
  'Usage: deps-conflict-resolver <doctor|init|prepare> [packages...] [options]',
  '',
  'doctor   Analyze without installing; scans runtime dependencies when none are selected.',
  'init     Preview a minimal resolver config from installed packages, offline.',
  'prepare  Analyze and install verified aliases for the listed packages.',
  '',
  'Options:',
  '  --config <file>                Import resolver options from JSON or a Node module',
  '  --root <directory>             Project directory (defaults to cwd)',
  '  --package-manager <manager>    auto, npm, pnpm, or yarn',
  '  --registry <url>               Registry used for metadata and installation',
  '  --offline                     Never query a registry or run installation',
  '  --strict                      Return exit code 1 for unresolved conditions',
  '  --json                        Emit a machine-readable report',
  '  --timings                     Include preparation durations and filesystem counts',
  '  --write-plan                  Save a verified offline plan (prepare only)',
  '  --source-hints                Check for Vue 2 patterns in installed entries (doctor)',
  '  --write-config <file.json>    Write the proposed JSON configuration (init only)',
  '  --help                        Show this help',
  '',
].join('\n');

export async function runCli(
  argv: string[],
  output: CliOutput = {
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
  },
): Promise<number> {
  const json = argv.includes('--json');
  const timings = argv.includes('--timings');
  const writePlan = argv.includes('--write-plan');
  try {
    if (argv.length === 0 || argv.includes('--help')) {
      output.stdout(HELP);
      return 0;
    }
    const [command, ...args] = argv;
    if (command !== 'doctor' && command !== 'init' && command !== 'prepare') {
      throw new Error('Unknown command: ' + command + '\n' + HELP);
    }
    if (writePlan && command !== 'prepare') throw new Error('--write-plan requires prepare');
    const overrides: Partial<DepsConflictResolverOptions> = {};
    let configFile: string | undefined;
    let outputConfig: string | undefined;
    let sourceHints = command === 'init';
    const packages: string[] = [];
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!;
      if (arg === '--json' || arg === '--timings' || arg === '--write-plan') continue;
      if (arg === '--source-hints') {
        if (command === 'prepare') throw new Error('--source-hints requires doctor or init');
        sourceHints = true;
        continue;
      }
      if (arg === '--offline') {
        overrides.offline = true;
        continue;
      }
      if (arg === '--strict') {
        overrides.strict = true;
        continue;
      }
      if (
        arg === '--config' ||
        arg === '--root' ||
        arg === '--registry' ||
        arg === '--package-manager' ||
        arg === '--write-config'
      ) {
        const value = args[++index];
        if (!value || value.startsWith('--')) throw new Error('Missing value for ' + arg);
        if (arg === '--config') configFile = value;
        else if (arg === '--root') overrides.projectRoot = value;
        else if (arg === '--registry') overrides.registry = value;
        else if (arg === '--write-config') {
          if (command !== 'init' || extname(value) !== '.json')
            throw new Error('--write-config requires init and a .json output path');
          outputConfig = resolve(value);
        } else {
          if (!['auto', 'npm', 'pnpm', 'yarn'].includes(value))
            throw new Error('Unsupported package manager: ' + value);
          overrides.packageManager = value as DepsConflictResolverOptions['packageManager'];
        }
        continue;
      }
      if (arg.startsWith('-')) throw new Error('Unknown option: ' + arg);
      packages.push(arg);
    }
    const options = { ...(configFile ? await loadCliConfig(configFile) : {}), ...overrides };
    const root = options.projectRoot ?? process.cwd();
    const projectRoot = findProjectRoot(resolve(root));
    if (!projectRoot) throw new Error('Could not find package.json from ' + root);
    const manifest = readPackageJsonCached(projectRoot);
    if (!manifest) throw new Error('Could not read package.json at ' + projectRoot);
    const selectedPackages = packages.length > 0 ? packages : options.dependencies;
    if (command === 'prepare' && !selectedPackages?.length) {
      throw new Error(
        'prepare requires at least one dependency name or a dependencies list from --config',
      );
    }
    const strictMode = options.strict ?? false;
    const runtimeDependencies = { ...manifest.dependencies, ...manifest.optionalDependencies };
    const dependencies = [
      ...new Set(
        selectedPackages ??
          Object.keys(runtimeDependencies)
            .filter((name) => !runtimeDependencies[name]?.startsWith('npm:'))
            .filter(
              (name) =>
                !Object.hasOwn(manifest.optionalDependencies ?? {}, name) ||
                findPackagePath(name, projectRoot) !== null,
            )
            .sort(),
      ),
    ];

    const resolver = new DepsConflictResolver({
      ...options,
      projectRoot,
      dependencies,
      debug: false,
      offline: command === 'init' || options.offline === true || options.preparedPlan === true,
      strict: command === 'prepare' && strictMode,
      autoInstall: command === 'prepare',
      preparedPlan: false,
    });
    let failure: ResolutionError['preparation'];
    try {
      // Keep CLI output machine-readable without silencing other resolvers.
      await withLogLevel(LogLevel.SILENT, () => resolver.initialize());
    } catch (error) {
      if (!(error instanceof ResolutionError) || !error.preparation) throw error;
      failure = error.preparation;
    }
    const diagnostics = failure?.diagnostics ?? resolver.getDiagnostics();
    const analysis = getResolverBuild(resolver).snapshot().analysis;
    const suggestedConfig =
      command === 'init'
        ? {
            dependencies: selectedPackages
              ? dependencies
              : suggestEntryPackages(analysis!, dependencies),
            ...(options.aliasPrefix !== undefined && { aliasPrefix: options.aliasPrefix }),
            ...(options.peerOverrides && { peerOverrides: options.peerOverrides }),
            ...(options.includeRedirects && { includeRedirects: options.includeRedirects }),
            ...(options.excludeRedirects && { excludeRedirects: options.excludeRedirects }),
          }
        : undefined;
    if (outputConfig && suggestedConfig) {
      await writeFile(outputConfig, JSON.stringify(suggestedConfig, null, 2) + '\n', {
        flag: 'wx',
      });
    }
    const hints = sourceHints ? await findSourceHints(projectRoot, dependencies) : [];
    let preparedPlan: string | undefined;
    if (writePlan && !diagnostics.some(({ severity }) => severity === 'error')) {
      try {
        preparedPlan = await withLogLevel(LogLevel.SILENT, () =>
          getResolverBuild(resolver).savePreparedPlan(),
        );
      } catch (error) {
        throw new Error('Cannot save an offline dependency plan: ' + String(error), {
          cause: error,
        });
      }
    }
    const report = {
      schemaVersion: 1,
      command,
      projectRoot,
      packageManager: resolver.getOptions().packageManager,
      dependencies,
      aliases: failure?.aliases ?? analysis!.aliasMappings,
      activeAliases: failure ? [] : resolver.getAliasPathMappings(),
      diagnostics,
      actions: diagnoseNextSteps(diagnostics),
      installation: failure ? failure.installation : resolver.getInstallResult(),
      ...(timings && { timings: resolver.getTimings() }),
      ...(preparedPlan && { preparedPlan }),
      ...(sourceHints && { sourceHints: hints }),
      ...(suggestedConfig && { suggestedConfig }),
      ...(outputConfig && { configFile: outputConfig }),
    };
    if (json) {
      output.stdout(JSON.stringify(report, null, 2) + '\n');
    } else {
      output.stdout(
        'Analyzed ' +
          dependencies.length +
          ' dependencies; ' +
          report.activeAliases.length +
          ' active aliases; ' +
          diagnostics.length +
          ' diagnostics.\n',
      );
      for (const mapping of report.aliases) {
        const active = report.activeAliases.some((entry) => entry.aliasName === mapping.aliasName);
        output.stdout(
          '  ' +
            mapping.originalName +
            '@' +
            mapping.resolvedVersion +
            ' -> ' +
            mapping.aliasName +
            (active ? ' (active)' : ' (requires prepare)') +
            '\n',
        );
      }
      for (const diagnostic of diagnostics) {
        output.stdout('  [' + diagnostic.code + '] ' + diagnostic.message + '\n');
      }
      for (const action of report.actions) {
        output.stdout(
          '  ' + action.packageName + ' [' + action.code + '] ' + action.message + '\n',
        );
      }
      for (const hint of hints) {
        output.stdout('  ' + hint.packageName + ' ' + hint.message + '\n');
        output.stdout(JSON.stringify(hint.config, null, 2) + '\n');
      }
      if (suggestedConfig) {
        if (outputConfig) output.stdout('Wrote resolver options to ' + outputConfig + '\n');
        else
          output.stdout(
            'Suggested resolver options\n' + JSON.stringify(suggestedConfig, null, 2) + '\n',
          );
        if (suggestedConfig.dependencies.length > 0)
          output.stdout(
            'Run deps-conflict-resolver prepare --config <options.json> --strict --write-plan, then import the same options in the bundler with preparedPlan: true and strict: true.\n',
          );
      }
      if (report.timings) output.stdout(JSON.stringify(report.timings, null, 2) + '\n');
      if (preparedPlan) output.stdout('Saved dependency plan to ' + preparedPlan + '\n');
    }
    return diagnostics.some((diagnostic) => diagnostic.severity === 'error') &&
      (strictMode || command === 'prepare')
      ? 1
      : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      output.stdout(
        JSON.stringify(
          {
            error: message,
            diagnostics: error instanceof ResolutionError ? error.diagnostics : [],
          },
          null,
          2,
        ) + '\n',
      );
    } else {
      output.stderr(message + '\n');
    }
    return 1;
  }
}
