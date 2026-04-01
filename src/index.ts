// 对外只保留：核心控制器（编程式调用） + 必要类型
export type {
  DepsConflictResolverOptions,
  ResolvedOptions,
  AnalysisResult,
  AliasMapping,
  AliasPathMapping,
  PeerConflict,
  PluginHooks,
  PluginConfig,
  // Workspace/Monorepo 相关类型
  PnpmWorkspaceConfig,
  WorkspaceDetectionResult,
  CatalogResolution,
  WorkspaceAliasInfo,
} from './types/index';

export { DepsConflictResolver, createResolver } from './core/resolver';

// 导出 WorkspaceDetector 供高级用法
export { WorkspaceDetector, createWorkspaceDetector } from './core/workspace-detector';
