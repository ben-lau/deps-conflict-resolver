import type { AliasMapping, ResolvedOptions } from '../types/index';
import { createLogger } from '../utils/logger';
import { fileExists, readPackageJsonCached } from '../utils/fs';
import { join } from 'path';
import semver from 'semver';
import { createPackageManagerAdapter, type PackageManagerAdapter } from './package-manager-adapter';

const logger = createLogger('package-installer');

/**
 * 安装超时时间（毫秒）
 */
const INSTALL_TIMEOUT = 120000; // 120秒

/**
 * 安装结果
 */
interface InstallResult {
  /**
   * 是否成功
   */
  success: boolean;

  /**
   * 安装的包
   */
  installed: string[];

  /**
   * 失败的包
   */
  failed: string[];

  /**
   * 错误信息
   */
  errors: string[];
}

interface InstalledAliasVerification {
  matches: boolean;
  actualPackageName: string | null;
  actualVersion: string | null;
  reason:
    | 'matched'
    | 'missing-package-json'
    | 'invalid-package-json'
    | 'package-name-mismatch'
    | 'version-mismatch';
}

/**
 * 包安装器
 * 负责安装别名依赖
 *
 * 安装策略：
 * - 只安装 aliasMappings 中有 installSpec 的别名（与主工程版本冲突的）
 * - 复用已存在的别名（installSpec 为空表示复用）
 * - 不自动安装缺失的 peer 依赖，只记录警告
 */
export class PackageInstaller {
  private options: ResolvedOptions;
  private packageManager: PackageManagerAdapter;

  constructor(
    options: ResolvedOptions,
    packageManager: PackageManagerAdapter = createPackageManagerAdapter(options),
  ) {
    this.options = options;
    this.packageManager = packageManager;
  }

  /**
   * 安装别名依赖
   */
  async installAliases(mappings: AliasMapping[]): Promise<InstallResult> {
    const result: InstallResult = {
      success: true,
      installed: [],
      failed: [],
      errors: [],
    };

    if (mappings.length === 0) {
      logger.info('No aliases to install');
      return result;
    }

    // 过滤出需要安装的，同时拒绝覆盖已占用但不匹配的别名
    const toInstall: AliasMapping[] = [];
    const reportCollision = (mapping: AliasMapping, verification: InstalledAliasVerification) => {
      const collision = {
        code: 'ALIAS_NAME_OCCUPIED',
        aliasName: mapping.aliasName,
        expected: {
          packageName: mapping.originalName,
          version: mapping.resolvedVersion,
        },
        actual: {
          packageName: verification.actualPackageName,
          version: verification.actualVersion,
        },
        reason: verification.reason,
      };
      result.success = false;
      result.failed.push(mapping.aliasName);
      result.errors.push(`Alias collision: ${JSON.stringify(collision)}`);
      logger.warn(`Alias collision: ${JSON.stringify(collision)}`);
    };

    for (const m of mappings) {
      const aliasPath = join(this.options.projectRoot, 'node_modules', m.aliasName);

      // 没有 installSpec 表示复用现有别名，不需要安装
      if (!m.installSpec) {
        if (fileExists(aliasPath)) {
          const verification = this.verifyInstalledVersion(
            aliasPath,
            m.originalName,
            m.resolvedVersion,
          );
          if (!verification.matches) {
            reportCollision(m, verification);
            continue;
          }
        }

        logger.debug(`Skipping ${m.aliasName}: reusing existing installation`);
        continue;
      }

      // 检查是否已安装
      if (!fileExists(aliasPath)) {
        toInstall.push(m); // 未安装，需要安装
        continue;
      }

      // 已安装，验证版本是否正确
      const verification = this.verifyInstalledVersion(
        aliasPath,
        m.originalName,
        m.resolvedVersion,
      );
      if (!verification.matches) {
        reportCollision(m, verification);
        continue;
      }

      logger.debug(`${m.aliasName} already installed with correct version`);
    }

    if (toInstall.length === 0) {
      if (result.success) {
        logger.info('All aliases already installed with correct versions');
      }
      return result;
    }

    logger.info(`Installing ${toInstall.length} alias packages...`);

    const installSpecs = toInstall.map((m) => m.installSpec);
    const installResult = await this.runInstall(installSpecs);

    if (installResult.success) {
      result.installed = toInstall.map((m) => m.aliasName);
      logger.info(`Successfully installed: ${result.installed.join(', ')}`);
    } else {
      result.success = false;
      result.failed.push(...toInstall.map((m) => m.aliasName));
      result.errors.push(...installResult.errors);
      logger.error(`Failed to install aliases: ${installResult.errors.join(', ')}`);
    }

    return result;
  }

  /**
   * 验证已安装的别名版本是否正确
   * @returns 验证结果及已安装包信息
   */
  private verifyInstalledVersion(
    aliasPath: string,
    expectedPackageName: string,
    expectedVersion: string,
  ): InstalledAliasVerification {
    try {
      const pkgJsonPath = join(aliasPath, 'package.json');
      if (!fileExists(pkgJsonPath)) {
        return {
          matches: false,
          actualPackageName: null,
          actualVersion: null,
          reason: 'missing-package-json',
        };
      }

      const pkgJson = readPackageJsonCached(aliasPath);
      if (!pkgJson) {
        logger.debug(`Failed to verify version: unable to read/parse ${pkgJsonPath}`);
        return {
          matches: false,
          actualPackageName: null,
          actualVersion: null,
          reason: 'invalid-package-json',
        };
      }

      const actualPackageName = pkgJson.name ?? null;
      const actualVersion = pkgJson.version ?? null;

      // 检查实际包名是否匹配（npm 别名安装后，name 字段是原始包名）
      if (pkgJson.name !== expectedPackageName) {
        logger.debug(
          `Package name mismatch: expected ${expectedPackageName}, got ${pkgJson.name ?? 'unknown'}`,
        );
        return {
          matches: false,
          actualPackageName,
          actualVersion,
          reason: 'package-name-mismatch',
        };
      }

      // 检查版本是否匹配（使用 semver 等价比较，容忍 v1.0.0 vs 1.0.0 等格式差异）
      const installedClean = semver.clean(pkgJson.version ?? '');
      const expectedClean = semver.clean(expectedVersion);
      if (!installedClean || !expectedClean || installedClean !== expectedClean) {
        logger.debug(
          `Version mismatch: expected ${expectedVersion}, got ${pkgJson.version ?? 'unknown'}`,
        );
        return {
          matches: false,
          actualPackageName,
          actualVersion,
          reason: 'version-mismatch',
        };
      }

      return {
        matches: true,
        actualPackageName,
        actualVersion,
        reason: 'matched',
      };
    } catch (error) {
      logger.debug(`Failed to verify version: ${String(error)}`);
      return {
        matches: false,
        actualPackageName: null,
        actualVersion: null,
        reason: 'invalid-package-json',
      };
    }
  }

  /**
   * 执行安装命令
   */
  private async runInstall(packages: string[]): Promise<{ success: boolean; errors: string[] }> {
    if (packages.length === 0) {
      return { success: true, errors: [] };
    }

    const runResult = await this.packageManager.install(packages);

    if (runResult.stdout) {
      logger.debug(`stdout: ${runResult.stdout}`);
    }
    if (runResult.stderr) {
      logger.debug(`stderr: ${runResult.stderr}`);
    }

    if (runResult.success) {
      logger.info('Install completed');
      return { success: true, errors: [] };
    }

    const errorMessage = runResult.timedOut
      ? `Install timeout after ${INSTALL_TIMEOUT / 1000}s`
      : runResult.stderr || `Process exited with code ${runResult.exitCode}`;
    logger.error(`Install failed: ${errorMessage}`);
    return { success: false, errors: [errorMessage] };
  }
}

/**
 * 创建包安装器实例
 */
export function createPackageInstaller(options: ResolvedOptions): PackageInstaller {
  return new PackageInstaller(options);
}
