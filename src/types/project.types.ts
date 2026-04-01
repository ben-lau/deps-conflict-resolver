/**
 * NPM 包信息（从注册表获取）
 */
export interface NpmPackageInfo {
  /**
   * 包名
   */
  name: string;

  /**
   * 所有版本列表
   */
  versions: string[];

  /**
   * 版本对应的包信息
   */
  versionDetails: Record<
    string,
    {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    }
  >;

  /**
   * dist-tags（如 latest, next 等）
   */
  distTags: Record<string, string>;
}

/**
 * package.json 结构
 */
export interface PackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  optionalDependencies?: Record<string, string>;
  /**
   * Yarn/NPM workspaces 配置（monorepo）
   */
  workspaces?: string[] | { packages?: string[] };
  /**
   * Node.js packageManager 字段（如 "pnpm@8.0.0"）
   */
  packageManager?: string;
}

/**
 * 已安装依赖的扩展信息
 */
export interface InstalledPackageInfo {
  /** 安装时使用的包名（可能是别名） */
  name: string;
  /** package.json 中的版本号 */
  version: string;
  /** 安装路径 */
  path: string;
  /** 实际的包名（如果是 npm 别名安装，这是原始包名） */
  realName?: string;
  /** 是否为 npm 别名安装 */
  isAlias?: boolean;
}

/**
 * 支持的包管理器类型
 */
export type PackageManagerType = 'npm' | 'yarn' | 'pnpm';

/**
 * 包管理器检测结果
 */
export interface PackageManagerDetectionResult {
  /**
   * 检测到的包管理器
   */
  packageManager: PackageManagerType;

  /**
   * 检测到的 registry（如果有）
   */
  registry?: string;

  /**
   * 检测来源
   */
  detectedFrom: 'lockfile' | 'packageJson' | 'default';

  /**
   * 检测到包管理器配置的目录（monorepo 根目录）
   */
  rootDir?: string;
}
