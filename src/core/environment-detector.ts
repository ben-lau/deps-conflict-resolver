import { promises as fs } from 'fs';
import { join } from 'path';
import { createLogger } from '../utils/logger';
import { fileExists, iterateParentDirs, readPackageJsonCached } from '../utils/fs';
import { DEFAULT_NPM_REGISTRY, LOCK_FILE_MAP } from '../constants';
import type { PackageManagerType, PackageManagerDetectionResult } from '../types/index';

const logger = createLogger('environment-detector');

/**
 * 环境检测器
 * 负责检测项目使用的包管理器和 registry
 */
export class EnvironmentDetector {
  private projectRoot: string;
  private detectionResult: PackageManagerDetectionResult | null = null;
  private registryCache: string | null = null;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  /**
   * 获取检测到的包管理器类型
   */
  getPackageManager(): PackageManagerType {
    const result = this.detect();
    return result.packageManager;
  }

  /**
   * 获取检测到的 registry
   */
  async getRegistry(): Promise<string> {
    if (this.registryCache) {
      return this.registryCache;
    }

    const result = this.detect();
    this.registryCache = await this.detectRegistry(result.packageManager);
    return this.registryCache;
  }

  /**
   * 获取指定包管理器的 registry（兼容旧 API）
   */
  async getRegistryForPackageManager(packageManager: PackageManagerType): Promise<string> {
    return this.detectRegistry(packageManager);
  }

  /**
   * 获取完整的检测结果
   */
  getDetectionResult(): PackageManagerDetectionResult {
    return this.detect();
  }

  /**
   * 重置缓存，强制重新检测
   */
  reset(): void {
    this.detectionResult = null;
    this.registryCache = null;
  }

  /**
   * 更新项目根目录
   */
  setProjectRoot(projectRoot: string): void {
    this.projectRoot = projectRoot;
    this.reset();
  }

  /**
   * 检测项目使用的包管理器
   *
   * 检测优先级：
   * 1. package.json 中的 packageManager 字段（如 "pnpm@8.0.0"）- 向上遍历查找
   * 2. lock 文件存在 - 向上遍历查找（支持 monorepo）
   * 3. 默认为 npm
   */
  private detect(): PackageManagerDetectionResult {
    if (this.detectionResult) {
      return this.detectionResult;
    }

    for (const currentDir of iterateParentDirs(this.projectRoot)) {
      const pkgJsonPath = join(currentDir, 'package.json');
      if (fileExists(pkgJsonPath)) {
        const pkgJson = readPackageJsonCached(currentDir);
        // eslint(type): 显式标注避免 no-unsafe 报错
        const pmField: string | undefined = pkgJson?.packageManager;
        if (pmField) {
          const pm = this.parsePackageManagerField(pmField);
          if (pm) {
            logger.debug(`Detected package manager from package.json: ${pm} (at ${currentDir})`);
            this.detectionResult = {
              packageManager: pm,
              detectedFrom: 'packageJson',
              rootDir: currentDir,
            };
            return this.detectionResult;
          }
        }
      }

      for (const [lockFile, pm] of Object.entries(LOCK_FILE_MAP)) {
        if (fileExists(join(currentDir, lockFile))) {
          logger.debug(
            `Detected package manager from lock file: ${pm} (${lockFile} at ${currentDir})`,
          );
          this.detectionResult = {
            packageManager: pm,
            detectedFrom: 'lockfile',
            rootDir: currentDir,
          };
          return this.detectionResult;
        }
      }
    }

    logger.debug('No lock file found, defaulting to npm');
    this.detectionResult = {
      packageManager: 'npm',
      detectedFrom: 'default',
    };
    return this.detectionResult;
  }

  /**
   * 解析 package.json 中的 packageManager 字段
   * 格式如：pnpm@8.0.0, yarn@3.2.0, npm@9.0.0
   */
  private parsePackageManagerField(value: string): PackageManagerType | null {
    const match = value.match(/^(npm|yarn|pnpm)(@|$)/);
    if (match) {
      return match[1] as PackageManagerType;
    }
    return null;
  }

  /**
   * 检测项目使用的 registry
   *
   * 检测优先级：
   * 1. 项目级 .npmrc（向上遍历，覆盖 monorepo 子包场景）
   * 2. 用户级 .npmrc
   * 3. 包管理器特定配置
   * 4. 默认 registry
   */
  private async detectRegistry(packageManager: PackageManagerType): Promise<string> {
    const defaultRegistry = DEFAULT_NPM_REGISTRY;

    // 1. 从 projectRoot 向上遍历查找 .npmrc（覆盖 monorepo 子包场景）
    for (const dir of iterateParentDirs(this.projectRoot)) {
      const npmrcPath = join(dir, '.npmrc');
      if (fileExists(npmrcPath)) {
        const registry = await this.parseRegistryFromNpmrc(npmrcPath);
        if (registry) {
          logger.debug(`Detected registry from .npmrc: ${registry} (at ${dir})`);
          return registry;
        }
      }
    }

    // 2. 检查用户级配置
    const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? '';
    if (homeDir) {
      // 检查 .npmrc
      const userNpmrc = join(homeDir, '.npmrc');
      if (fileExists(userNpmrc)) {
        const registry = await this.parseRegistryFromNpmrc(userNpmrc);
        if (registry) {
          logger.debug(`Detected registry from user .npmrc: ${registry}`);
          return registry;
        }
      }

      // 检查 pnpm 配置（如果是 pnpm）
      if (packageManager === 'pnpm') {
        const pnpmConfig = join(homeDir, '.pnpmrc');
        if (fileExists(pnpmConfig)) {
          const registry = await this.parseRegistryFromNpmrc(pnpmConfig);
          if (registry) {
            logger.debug(`Detected registry from .pnpmrc: ${registry}`);
            return registry;
          }
        }
      }

      // 检查 yarn 配置（如果是 yarn）—— 向上遍历查找 .yarnrc.yml（覆盖 monorepo 子包场景）
      if (packageManager === 'yarn') {
        for (const dir of iterateParentDirs(this.projectRoot)) {
          const yarnrc = join(dir, '.yarnrc.yml');
          if (fileExists(yarnrc)) {
            const registry = await this.parseRegistryFromYarnrc(yarnrc);
            if (registry) {
              logger.debug(`Detected registry from .yarnrc.yml: ${registry} (at ${dir})`);
              return registry;
            }
          }
        }
      }
    }

    logger.debug(`Using default registry: ${defaultRegistry}`);
    return defaultRegistry;
  }

  /**
   * 从 .npmrc 文件解析 registry
   */
  private async parseRegistryFromNpmrc(filePath: string): Promise<string | null> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n');

      for (const line of lines) {
        const trimmed = line.trim();
        // 跳过注释和空行
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) {
          continue;
        }

        // 匹配 registry=xxx 或 registry = xxx
        const match = trimmed.match(/^registry\s*=\s*(.+)$/i);
        if (match?.[1]) {
          return match[1].trim().replace(/["']/g, '');
        }
      }
    } catch {
      // 忽略读取错误
    }

    return null;
  }

  /**
   * 从 .yarnrc.yml 文件解析 registry
   */
  private async parseRegistryFromYarnrc(filePath: string): Promise<string | null> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n');

      for (const line of lines) {
        const trimmed = line.trim();
        // 匹配 npmRegistryServer: xxx
        const match = trimmed.match(/^npmRegistryServer:\s*["']?(.+?)["']?\s*$/);
        if (match?.[1]) {
          return match[1];
        }
      }
    } catch {
      // 忽略读取错误
    }

    return null;
  }
}

/**
 * 创建环境检测器实例
 */
export function createEnvironmentDetector(projectRoot: string): EnvironmentDetector {
  return new EnvironmentDetector(projectRoot);
}
