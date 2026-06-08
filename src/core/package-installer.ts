import { spawn } from 'child_process';
import type { AliasMapping, ResolvedOptions } from '../types/index';
import { createLogger } from '../utils/logger';
import { fileExists, readPackageJsonCached } from '../utils/fs';
import { join } from 'path';
import semver from 'semver';

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

  constructor(options: ResolvedOptions) {
    this.options = options;
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

    // 过滤出需要安装的
    const toInstall = mappings.filter((m) => {
      // 没有 installSpec 表示复用现有别名，不需要安装
      if (!m.installSpec) {
        logger.debug(`Skipping ${m.aliasName}: reusing existing installation`);
        return false;
      }

      const aliasPath = join(this.options.projectRoot, 'node_modules', m.aliasName);

      // 检查是否已安装
      if (!fileExists(aliasPath)) {
        return true; // 未安装，需要安装
      }

      // 已安装，验证版本是否正确
      const versionMatch = this.verifyInstalledVersion(
        aliasPath,
        m.originalName,
        m.resolvedVersion,
      );
      if (!versionMatch) {
        logger.info(`${m.aliasName} exists but version mismatch, will reinstall`);
        return true; // 版本不匹配，需要重新安装
      }

      logger.debug(`${m.aliasName} already installed with correct version`);
      return false;
    });

    if (toInstall.length === 0) {
      logger.info('All aliases already installed with correct versions');
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
      result.failed = toInstall.map((m) => m.aliasName);
      result.errors = installResult.errors;
      logger.error(`Failed to install aliases: ${installResult.errors.join(', ')}`);
    }

    return result;
  }

  /**
   * 验证已安装的别名版本是否正确
   * @returns true 如果版本匹配
   */
  private verifyInstalledVersion(
    aliasPath: string,
    expectedPackageName: string,
    expectedVersion: string,
  ): boolean {
    try {
      const pkgJsonPath = join(aliasPath, 'package.json');
      if (!fileExists(pkgJsonPath)) {
        return false;
      }

      const pkgJson = readPackageJsonCached(aliasPath);
      if (!pkgJson) {
        logger.debug(`Failed to verify version: unable to read/parse ${pkgJsonPath}`);
        return false;
      }

      // 检查实际包名是否匹配（npm 别名安装后，name 字段是原始包名）
      if (pkgJson.name !== expectedPackageName) {
        logger.debug(
          `Package name mismatch: expected ${expectedPackageName}, got ${pkgJson.name ?? 'unknown'}`,
        );
        return false;
      }

      // 检查版本是否匹配（使用 semver 等价比较，容忍 v1.0.0 vs 1.0.0 等格式差异）
      const installedClean = semver.clean(pkgJson.version ?? '');
      const expectedClean = semver.clean(expectedVersion);
      if (!installedClean || !expectedClean || installedClean !== expectedClean) {
        logger.debug(
          `Version mismatch: expected ${expectedVersion}, got ${pkgJson.version ?? 'unknown'}`,
        );
        return false;
      }

      return true;
    } catch (error) {
      logger.debug(`Failed to verify version: ${String(error)}`);
      return false;
    }
  }

  /**
   * 执行安装命令
   */
  private async runInstall(packages: string[]): Promise<{ success: boolean; errors: string[] }> {
    if (packages.length === 0) {
      return { success: true, errors: [] };
    }

    const { packageManager, projectRoot } = this.options;

    let command: string;
    let args: string[];

    switch (packageManager) {
      case 'yarn':
        command = 'yarn';
        args = ['add', ...packages];
        break;
      case 'pnpm':
        command = 'pnpm';
        args = ['add', ...packages];
        break;
      case 'npm':
      default:
        command = 'npm';
        // 使用 --legacy-peer-deps 跳过 peer 依赖检查，避免卡死
        args = ['install', '--legacy-peer-deps', ...packages];
        break;
    }

    const fullCommand = `${command} ${args.join(' ')}`;
    logger.info(`Running: ${fullCommand}`);

    const startTime = Date.now();

    return new Promise((resolve) => {
      let resolved = false;

      const child = spawn(command, args, {
        cwd: projectRoot,
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      // 超时处理
      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          logger.error(`Install timeout after ${INSTALL_TIMEOUT / 1000}s`);
          child.kill('SIGTERM');
          setTimeout(() => {
            if (!child.killed) {
              child.kill('SIGKILL');
            }
          }, 5000);
          resolve({
            success: false,
            errors: [`Install timeout after ${INSTALL_TIMEOUT / 1000}s`],
          });
        }
      }, INSTALL_TIMEOUT);

      child.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      child.on('error', (error) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutId);
          logger.error(`Install error: ${error.message}`);
          resolve({
            success: false,
            errors: [error.message],
          });
        }
      });

      child.on('close', (code) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutId);
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          if (code === 0) {
            if (stdout) {
              logger.debug(`stdout: ${stdout}`);
            }
            logger.info(`Install completed in ${elapsed}s`);
            resolve({ success: true, errors: [] });
          } else {
            logger.error(`Install failed with exit code ${code}`);
            if (stdout) {
              logger.debug(`stdout: ${stdout}`);
            }
            if (stderr) {
              logger.debug(`stderr: ${stderr}`);
            }
            resolve({
              success: false,
              errors: stderr ? [stderr] : [`Process exited with code ${code}`],
            });
          }
        }
      });
    });
  }
}

/**
 * 创建包安装器实例
 */
export function createPackageInstaller(options: ResolvedOptions): PackageInstaller {
  return new PackageInstaller(options);
}
