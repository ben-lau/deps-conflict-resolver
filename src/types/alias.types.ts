import type { DependencyInfo, PeerConflict } from './dependency.types';

/**
 * 别名映射
 */
export interface AliasMapping {
  /**
   * 原始包名
   */
  originalName: string;

  /**
   * 别名（用于安装）
   */
  aliasName: string;

  /**
   * 实际安装的包名和版本
   */
  installSpec: string;

  /**
   * 解析后的版本
   */
  resolvedVersion: string;

  /**
   * 使用此别名的模块路径（声明 peerDependency 的包）
   */
  usedBy: string[];

  /**
   * 所有需要重定向的依赖包名列表
   * 包含 usedBy 中包的所有运行时子依赖（dependencies + peerDependencies 递归）
   * 用于判断某个 importer 是否需要重定向到别名版本
   * 注意：冲突包自身（如 vue、vue-router）已在收集时被排除，避免主工程引用被误重定向
   */
  allDependents: string[];
}

/**
 * 依赖分析结果
 */
export interface AnalysisResult {
  /**
   * 所有分析过的依赖
   */
  analyzedDependencies: Map<string, DependencyInfo>;

  /**
   * Peer 依赖冲突列表
   */
  peerConflicts: PeerConflict[];

  /**
   * 需要创建的别名映射
   */
  aliasMappings: AliasMapping[];

  /**
   * 第一层依赖中缺失的 peer 依赖（不自动安装，仅警告提示用户）
   */
  missingFirstLevelPeers: Array<{
    packageName: string;
    requiredRange: string;
    requestedBy: string;
  }>;
}

/**
 * 通用的别名路径映射
 * 核心模块提供此格式，由各构建工具插件转换为各自需要的格式
 */
export interface AliasPathMapping {
  /** 别名包名 (如 react-npm-18.2.0) */
  aliasName: string;
  /** 原始包名 (如 react) */
  originalName: string;
  /** 解析后的绝对路径 */
  path: string;
}
