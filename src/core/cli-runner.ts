import { resolve } from 'node:path';
import { DepsConflictResolver } from './resolver';
import { findPackagePath, findProjectRoot, readPackageJsonCached } from '../utils/fs';
import { createLogger, LogLevel } from '../utils/logger';
import { ResolutionError } from './resolution-error';

interface CliOutput {
  stdout(text: string): void;
  stderr(text: string): void;
}

const HELP = [
  'Usage: deps-conflict-resolver <doctor|prepare> [packages...] [options]',
  '',
  'doctor   Analyze without installing; scans runtime dependencies when none are listed.',
  'prepare  Analyze and install verified aliases for the listed packages.',
  '',
  'Options:',
  '  --root <directory>             Project directory (defaults to cwd)',
  '  --package-manager <manager>    auto, npm, pnpm, or yarn',
  '  --registry <url>               Registry used for metadata and installation',
  '  --offline                     Never query a registry or run installation',
  '  --strict                      Return exit code 1 for unresolved conditions',
  '  --json                        Emit a machine-readable report',
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
  try {
    if (argv.length === 0 || argv.includes('--help')) {
      output.stdout(HELP);
      return 0;
    }
    const [command, ...args] = argv;
    if (command !== 'doctor' && command !== 'prepare') {
      throw new Error('Unknown command: ' + command + '\n' + HELP);
    }
    let root = process.cwd();
    let registry: string | undefined;
    let packageManager: 'auto' | 'npm' | 'pnpm' | 'yarn' = 'auto';
    let offline = false;
    let strict = false;
    const packages: string[] = [];
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!;
      if (arg === '--json') continue;
      if (arg === '--offline') {
        offline = true;
        continue;
      }
      if (arg === '--strict') {
        strict = true;
        continue;
      }
      if (arg === '--root' || arg === '--registry' || arg === '--package-manager') {
        const value = args[++index];
        if (!value || value.startsWith('--')) throw new Error('Missing value for ' + arg);
        if (arg === '--root') root = value;
        else if (arg === '--registry') registry = value;
        else {
          if (!['auto', 'npm', 'pnpm', 'yarn'].includes(value))
            throw new Error('Unsupported package manager: ' + value);
          packageManager = value as typeof packageManager;
        }
        continue;
      }
      if (arg.startsWith('-')) throw new Error('Unknown option: ' + arg);
      packages.push(arg);
    }
    if (command === 'prepare' && packages.length === 0) {
      throw new Error('prepare requires at least one dependency name');
    }

    const projectRoot = findProjectRoot(resolve(root));
    if (!projectRoot) throw new Error('Could not find package.json from ' + root);
    const manifest = readPackageJsonCached(projectRoot);
    if (!manifest) throw new Error('Could not read package.json at ' + projectRoot);
    const runtimeDependencies = { ...manifest.dependencies, ...manifest.optionalDependencies };
    const dependencies = [
      ...new Set(
        packages.length > 0
          ? packages
          : Object.keys(runtimeDependencies)
              .filter((name) => !runtimeDependencies[name]?.startsWith('npm:'))
              .filter(
                (name) =>
                  !Object.hasOwn(manifest.optionalDependencies ?? {}, name) ||
                  findPackagePath(name, projectRoot) !== null,
              )
              .sort(),
      ),
    ];

    // CLI reports own their output; library logs must not corrupt JSON.
    createLogger('cli').setLevel(LogLevel.SILENT);
    const resolver = new DepsConflictResolver({
      projectRoot,
      dependencies,
      packageManager,
      registry,
      offline,
      autoInstall: command === 'prepare',
    });
    await resolver.initialize();
    const analysis = resolver.getAnalysisResult()!;
    const diagnostics = resolver.getDiagnostics();
    const report = {
      schemaVersion: 1,
      command,
      projectRoot,
      packageManager: resolver.getOptions().packageManager,
      dependencies,
      aliases: analysis.aliasMappings,
      activeAliases: resolver.getAliasPathMappings(),
      diagnostics,
      installation: resolver.getInstallResult(),
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
      for (const mapping of analysis.aliasMappings) {
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
    }
    return diagnostics.some((diagnostic) => diagnostic.severity === 'error') &&
      (strict || command === 'prepare')
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
