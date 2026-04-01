/**
 * Monorepo/Workspace 相关类型定义
 */

/**
 * pnpm-workspace.yaml 配置结构
 */
export interface PnpmWorkspaceConfig {
  /**
   * 工作空间包的 glob 模式列表
   */
  packages?: string[];

  /**
   * pnpm catalog 配置（依赖版本共享）
   * @see https://pnpm.io/catalogs
   */
  catalog?: Record<string, string>;

  /**
   * 命名 catalogs
   */
  catalogs?: Record<string, Record<string, string>>;
}

/**
 * Workspace 检测结果
 */
export interface WorkspaceDetectionResult {
  /**
   * 是否在 monorepo 中
   */
  isMonorepo: boolean;

  /**
   * Workspace 根目录（monorepo 根）
   */
  workspaceRoot: string | null;

  /**
   * 当前项目在 workspace 中的相对路径
   */
  currentProjectPath?: string;

  /**
   * Workspace 类型
   */
  workspaceType: 'pnpm' | 'yarn' | 'npm' | 'lerna' | 'none';

  /**
   * pnpm catalog 配置（仅 pnpm workspace）
   */
  catalog?: Record<string, string>;

  /**
   * 命名 catalogs（仅 pnpm workspace）
   */
  catalogs?: Record<string, Record<string, string>>;
}

/**
 * Catalog 协议解析结果
 */
export interface CatalogResolution {
  /**
   * 原始版本规格（如 "catalog:" 或 "catalog:react17"）
   */
  original: string;

  /**
   * 解析后的实际版本范围
   */
  resolved: string | null;

  /**
   * catalog 名称（default 或具体的名称）
   */
  catalogName: string;

  /**
   * 是否解析成功
   */
  success: boolean;
}

/**
 * Workspace 级别的别名信息
 */
export interface WorkspaceAliasInfo {
  /**
   * 别名名称（package.json 中的 key）
   */
  aliasName: string;

  /**
   * 目标包的真实名称
   */
  targetPackage: string;

  /**
   * 版本规格
   */
  versionSpec: string;

  /**
   * 定义此别名的包路径
   */
  definedIn: string;

  /**
   * 是否是 workspace 根目录定义的
   */
  isWorkspaceRoot: boolean;
}

/**
 * 支持的特殊版本协议
 */
export type SpecialVersionProtocol =
  | 'catalog' // catalog: 或 catalog:default
  | 'catalog:*' // catalog:name (命名 catalog)
  | 'workspace' // workspace:* | workspace:^ | workspace:~
  | 'npm' // npm:package@version
  | 'file' // file:./path
  | 'link' // link:./path
  | 'portal' // portal:./path (pnpm)
  | 'normal'; // 普通版本号或范围
