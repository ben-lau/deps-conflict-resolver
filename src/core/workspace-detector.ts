import { readFileSync } from 'fs';
import { join, relative } from 'path';
import { parse as parseYaml } from 'yaml';
import { createLogger } from '../utils/logger';
import { fileExists, iterateParentDirs, readPackageJsonCached } from '../utils/fs';
import { parseNpmAlias } from '../utils/version-spec';
import type {
  PnpmWorkspaceConfig,
  WorkspaceDetectionResult,
  CatalogResolution,
  WorkspaceAliasInfo,
} from '../types/index';

const logger = createLogger('workspace-detector');

/** 版本协议类型 */
type VersionProtocol = 'catalog' | 'workspace' | 'npm' | 'file' | 'link' | 'portal' | 'normal';

/** 协议前缀到类型的映射 */
const PROTOCOL_PREFIXES: Record<string, VersionProtocol> = {
  'catalog:': 'catalog',
  'workspace:': 'workspace',
  'npm:': 'npm',
  'file:': 'file',
  'link:': 'link',
  'portal:': 'portal',
};

/**
 * 从依赖对象中提取指定包的别名
 */
function extractAliasesFromDeps(
  deps: Record<string, string> | undefined,
  targetPackage: string,
  definedIn: string,
  existingAliases: Set<string>,
): WorkspaceAliasInfo[] {
  if (!deps) return [];

  const aliases: WorkspaceAliasInfo[] = [];

  for (const [aliasName, versionSpec] of Object.entries(deps)) {
    if (typeof versionSpec !== 'string') continue;
    if (existingAliases.has(aliasName)) continue;

    const parsed = parseNpmAlias(versionSpec);
    if (parsed && parsed[0] === targetPackage) {
      aliases.push({
        aliasName,
        targetPackage,
        versionSpec: parsed[1],
        definedIn,
        isWorkspaceRoot: true,
      });
      existingAliases.add(aliasName);

      logger.debug(`Found alias: ${aliasName} -> ${targetPackage}@${parsed[1]} (in ${definedIn})`);
    }
  }

  return aliases;
}

/**
 * Workspace 检测器
 * 负责检测 monorepo 结构、解析 catalog 协议、查找 workspace 级别别名
 */
export class WorkspaceDetector {
  private projectRoot: string;
  private detectionResult: WorkspaceDetectionResult | null = null;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  /**
   * 获取 workspace 检测结果
   */
  detect(): WorkspaceDetectionResult {
    if (this.detectionResult) {
      return this.detectionResult;
    }

    this.detectionResult = this.detectWorkspace();
    return this.detectionResult;
  }

  /**
   * 重置缓存
   */
  reset(): void {
    this.detectionResult = null;
  }

  /**
   * 解析 catalog: 协议的版本
   * @param packageName 包名
   * @param versionSpec 版本规格（如 "catalog:" 或 "catalog:react17"）
   */
  resolveCatalogVersion(
    packageName: string,
    versionSpec: string,
  ): CatalogResolution {
    const result: CatalogResolution = {
      original: versionSpec,
      resolved: null,
      catalogName: 'default',
      success: false,
    };

    // 解析 catalog 名称
    if (versionSpec === 'catalog:' || versionSpec === 'catalog:default') {
      result.catalogName = 'default';
    } else if (versionSpec.startsWith('catalog:')) {
      result.catalogName = versionSpec.slice('catalog:'.length);
    } else {
      // 不是 catalog 协议
      return result;
    }

    const workspace = this.detect();
    if (!workspace.isMonorepo || !workspace.workspaceRoot) {
      logger.warn(`Cannot resolve catalog: protocol - not in a monorepo`);
      return result;
    }

    // 从 catalog 中查找版本
    if (result.catalogName === 'default') {
      // 默认 catalog
      const version = workspace.catalog?.[packageName];
      if (version) {
        result.resolved = version;
        result.success = true;
        logger.debug(`Resolved ${packageName} from default catalog: ${version}`);
      }
    } else {
      // 命名 catalog
      const namedCatalog = workspace.catalogs?.[result.catalogName];
      if (namedCatalog) {
        const version = namedCatalog[packageName];
        if (version) {
          result.resolved = version;
          result.success = true;
          logger.debug(`Resolved ${packageName} from catalog:${result.catalogName}: ${version}`);
        }
      }
    }

    if (!result.success) {
      logger.warn(`Package "${packageName}" not found in catalog:${result.catalogName}`);
    }

    return result;
  }

  /**
   * 解析版本规格（支持各种特殊协议）
   * @param packageName 包名
   * @param versionSpec 版本规格
   * @returns 解析后的普通版本范围，或 null（如无法解析）
   */
  resolveVersionSpec(packageName: string, versionSpec: string): string | null {
    const protocol = this.getVersionProtocol(versionSpec);

    switch (protocol) {
      case 'catalog': {
        const resolution = this.resolveCatalogVersion(packageName, versionSpec);
        return resolution.resolved;
      }
      case 'workspace':
      case 'file':
      case 'link':
      case 'portal':
        // 这些协议无法确定具体版本，返回 * 让其匹配任何版本
        return '*';
      case 'npm': {
        const parsed = parseNpmAlias(versionSpec);
        return parsed?.[1] ?? null;
      }
      default:
        // 普通版本号或范围
        return versionSpec;
    }
  }

  /**
   * 判断版本规格的协议类型
   */
  getVersionProtocol(versionSpec: string): VersionProtocol {
    for (const [prefix, protocol] of Object.entries(PROTOCOL_PREFIXES)) {
      if (versionSpec.startsWith(prefix)) {
        return protocol;
      }
    }

    return 'normal';
  }

  /**
   * 从 workspace 根目录和 catalog 中查找已存在的别名
   */
  findWorkspaceAliases(targetPackage: string): WorkspaceAliasInfo[] {
    const workspace = this.detect();

    if (!workspace.isMonorepo || !workspace.workspaceRoot) {
      return [];
    }

    const existingAliases = new Set<string>();
    const aliases: WorkspaceAliasInfo[] = [];
    const catalogPath = join(workspace.workspaceRoot, 'pnpm-workspace.yaml');

    // 1. 从 catalog 中查找别名（pnpm workspace 特有）
    if (workspace.workspaceType === 'pnpm') {
      // 检查默认 catalog
      aliases.push(
        ...extractAliasesFromDeps(workspace.catalog, targetPackage, catalogPath, existingAliases),
      );

      // 检查命名 catalogs
      if (workspace.catalogs) {
        for (const catalog of Object.values(workspace.catalogs)) {
          aliases.push(
            ...extractAliasesFromDeps(catalog, targetPackage, catalogPath, existingAliases),
          );
        }
      }
    }

    // 2. 从 workspace 根目录的 package.json 查找别名
    const rootPkgPath = join(workspace.workspaceRoot, 'package.json');
    const rootPkgJson = readPackageJsonCached(workspace.workspaceRoot);
    if (rootPkgJson) {
      aliases.push(
        ...extractAliasesFromDeps(
          rootPkgJson.dependencies,
          targetPackage,
          rootPkgPath,
          existingAliases,
        ),
        ...extractAliasesFromDeps(
          rootPkgJson.devDependencies,
          targetPackage,
          rootPkgPath,
          existingAliases,
        ),
      );
    }

    return aliases;
  }

  /**
   * 获取 workspace 根目录
   */
  getWorkspaceRoot(): string | null {
    const result = this.detect();
    return result.workspaceRoot;
  }

  /**
   * 检测 workspace
   */
  private detectWorkspace(): WorkspaceDetectionResult {
    for (const dir of iterateParentDirs(this.projectRoot)) {
      // 尝试检测各种 workspace 类型
      const result = this.tryDetectWorkspaceAt(dir);
      if (result) {
        return result;
      }
    }

    // 不在 monorepo 中
    return {
      isMonorepo: false,
      workspaceRoot: null,
      workspaceType: 'none',
    };
  }

  /**
   * 尝试在指定目录检测 workspace
   */
  private tryDetectWorkspaceAt(dir: string): WorkspaceDetectionResult | null {
    // 1. 检查 pnpm-workspace.yaml（pnpm monorepo）
    const pnpmWorkspacePath = join(dir, 'pnpm-workspace.yaml');
    if (fileExists(pnpmWorkspacePath)) {
      const config = this.parsePnpmWorkspaceYaml(pnpmWorkspacePath);
      logger.debug(`Detected pnpm workspace at: ${dir}`);

      return {
        isMonorepo: true,
        workspaceRoot: dir,
        currentProjectPath: relative(dir, this.projectRoot) || '.',
        workspaceType: 'pnpm',
        catalog: config.catalog,
        catalogs: config.catalogs,
      };
    }

    // 2. 检查 package.json 中的 workspaces 字段（yarn/npm workspaces）
    const pkgJson = readPackageJsonCached(dir);
    if (pkgJson?.workspaces) {
      const isYarn = fileExists(join(dir, 'yarn.lock'));
      const workspaceType = isYarn ? 'yarn' : 'npm';
      logger.debug(`Detected ${workspaceType} workspace at: ${dir}`);

      return {
        isMonorepo: true,
        workspaceRoot: dir,
        currentProjectPath: relative(dir, this.projectRoot) || '.',
        workspaceType,
      };
    }

    // 3. 检查 lerna.json
    if (fileExists(join(dir, 'lerna.json'))) {
      logger.debug(`Detected lerna workspace at: ${dir}`);

      return {
        isMonorepo: true,
        workspaceRoot: dir,
        currentProjectPath: relative(dir, this.projectRoot) || '.',
        workspaceType: 'lerna',
      };
    }

    return null;
  }

  /**
   * 解析 pnpm-workspace.yaml
   */
  private parsePnpmWorkspaceYaml(filePath: string): PnpmWorkspaceConfig {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const parsed = parseYaml(content) as PnpmWorkspaceConfig | null;
      return parsed ?? {};
    } catch (error) {
      logger.warn(`Failed to parse pnpm-workspace.yaml: ${String(error)}`);
      return {};
    }
  }
}

/**
 * 创建 Workspace 检测器实例
 */
export function createWorkspaceDetector(projectRoot: string): WorkspaceDetector {
  return new WorkspaceDetector(projectRoot);
}
