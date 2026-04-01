/**
 * 依赖信息
 */
export interface DependencyInfo {
  /**
   * 包名
   */
  name: string;

  /**
   * 版本号或版本范围
   */
  version: string;

  /**
   * 依赖路径（从根依赖到当前依赖的路径）
   */
  dependencyPath: string[];

  /**
   * 子依赖
   */
  dependencies: Record<string, string>;

  /**
   * Peer 依赖
   */
  peerDependencies: Record<string, string>;

  /**
   * Peer 依赖元信息
   */
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;

  /**
   * 是否为可选 peer 依赖
   */
  isOptionalPeer?: boolean;
}

/**
 * Peer 依赖冲突信息
 */
export interface PeerConflict {
  /**
   * 包名
   */
  packageName: string;

  /**
   * 主工程中的版本
   */
  mainProjectVersion: string | null;

  /**
   * peer 依赖要求的版本范围
   */
  requiredRange: string;

  /**
   * 请求此 peer 依赖的包路径列表
   */
  requestedBy: DependencyPath[];

  /**
   * 冲突的版本范围（与主工程版本不兼容的）
   */
  conflictingRanges: DependencyPath[];

  /**
   * 是否存在冲突
   */
  hasConflict: boolean;

  /**
   * 是否需要安装别名
   */
  needsAlias: boolean;
}

/**
 * 依赖路径
 */
export interface DependencyPath {
  /**
   * 依赖路径数组
   */
  path: string[];

  /**
   * 要求的版本范围
   */
  requiredRange: string;
}
