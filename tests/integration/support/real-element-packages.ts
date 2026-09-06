import { cp, mkdir, readFile, symlink } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';

export interface InstalledPackage {
  path: string;
  version: string;
}

interface PackageManifest {
  version?: unknown;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export interface MaterializePackageTreeOptions {
  /**
   * Copy package files without the installation-specific nested node_modules.
   *
   * pnpm may place a peer dependency symlink inside the installed package
   * directory. That symlink reflects the repository's peer resolution, not
   * the temporary scenario's owner scope, so real integration fixtures need
   * to omit it and materialize dependencies explicitly.
   */
  stripNestedNodeModules?: boolean;
}

const SKIPPED_DEPENDENCY = 'vue';

export function resolveInstalledPackage(
  packageName: string,
  fromPackagePath?: string,
): InstalledPackage {
  const packageRequire = fromPackagePath
    ? createRequire(join(fromPackagePath, 'package.json'))
    : createRequire(import.meta.url);

  let packageJsonPath: string;
  try {
    packageJsonPath = packageRequire.resolve(`${packageName}/package.json`);
  } catch (error) {
    try {
      packageJsonPath = findNearestPackageJson(packageRequire.resolve(packageName));
    } catch {
      throw new Error(
        `Real integration dependency "${packageName}" is not installed; run pnpm install`,
        { cause: error },
      );
    }
  }

  const manifest = readManifestSync(packageJsonPath);
  if (typeof manifest.version !== 'string') {
    throw new Error(`Installed package "${packageName}" has no valid version`);
  }

  return {
    path: dirname(packageJsonPath),
    version: manifest.version,
  };
}

export async function materializePackageTree(
  packageName: string,
  installed: InstalledPackage,
  targetNodeModules: string,
  options: MaterializePackageTreeOptions = {},
): Promise<void> {
  const visited = new Set<string>();
  if (packageName !== SKIPPED_DEPENDENCY) {
    await materializePackage(packageName, installed.path, targetNodeModules, visited, options);
  }
}

export async function materializeVue3RuntimeDependencies(
  vue3Path: string,
  targetNodeModules: string,
): Promise<void> {
  const packageNames = ['@vue/runtime-dom', '@vue/runtime-core', '@vue/reactivity', '@vue/shared'];
  const visited = new Set<string>();

  for (const packageName of packageNames) {
    const installed = resolveInstalledPackage(packageName, vue3Path);
    await materializePackage(packageName, installed.path, targetNodeModules, visited);
  }
}

export async function linkDirectory(target: string, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await symlink(target, path, process.platform === 'win32' ? 'junction' : undefined);
}

async function materializePackage(
  packageName: string,
  sourcePath: string,
  targetNodeModules: string,
  visited: Set<string>,
  options: MaterializePackageTreeOptions = {},
): Promise<void> {
  if (packageName === SKIPPED_DEPENDENCY) {
    return;
  }

  const targetPath = packageInstallPath(targetNodeModules, packageName);
  const visitKey = `${targetPath}\0${sourcePath}`;
  if (visited.has(visitKey)) {
    return;
  }
  visited.add(visitKey);

  await mkdir(dirname(targetPath), { recursive: true });
  if (options.stripNestedNodeModules) {
    if (!existsSync(targetPath)) {
      await cp(sourcePath, targetPath, {
        recursive: true,
        filter: (candidatePath) => {
          const relativePath = relative(sourcePath, candidatePath);
          return !relativePath.split(sep).includes('node_modules');
        },
      });
    }
  } else {
    try {
      await symlink(sourcePath, targetPath, process.platform === 'win32' ? 'junction' : undefined);
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
    }
  }

  const manifest = await readManifest(join(sourcePath, 'package.json'));
  const dependencies = Object.keys({
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
  });
  for (const dependencyName of dependencies) {
    if (dependencyName === SKIPPED_DEPENDENCY) {
      continue;
    }

    const isOptional = dependencyName in (manifest.optionalDependencies ?? {});
    let installed: InstalledPackage;
    try {
      installed = resolveInstalledPackage(dependencyName, sourcePath);
    } catch (error) {
      if (isOptional) {
        continue;
      }
      throw error;
    }

    await materializePackage(dependencyName, installed.path, targetNodeModules, visited, options);
  }
}

function packageInstallPath(nodeModulesPath: string, packageName: string): string {
  return join(nodeModulesPath, ...packageName.split('/'));
}

async function readManifest(path: string): Promise<PackageManifest> {
  return JSON.parse(await readFile(path, 'utf8')) as PackageManifest;
}

function readManifestSync(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest;
}

function findNearestPackageJson(entryPath: string): string {
  let directory = dirname(entryPath);
  while (true) {
    const packageJsonPath = join(directory, 'package.json');
    if (existsSync(packageJsonPath)) {
      return packageJsonPath;
    }

    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(`Could not find package.json for ${entryPath}`);
    }
    directory = parent;
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}
