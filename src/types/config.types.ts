import type { AliasMapping, AnalysisResult } from './alias.types';

/**
 * 依赖解析器的配置选项
 */
export interface DepsConflictResolverOptions {
  /**
   * 需要分析的依赖包名列表
   */
  dependencies: string[];

  /**
   * 项目根目录路径
   */
  projectRoot?: string;

  /**
   * 是否自动安装缺失的别名依赖
   * @default true
   */
  autoInstall?: boolean;

  /**
   * 包管理器类型
   * - 'auto': 自动检测（基于 lock 文件或 package.json 的 packageManager 字段）
   * - 'npm' | 'yarn' | 'pnpm': 指定包管理器
   * @default 'auto'
   */
  packageManager?: 'auto' | 'npm' | 'yarn' | 'pnpm';

  /**
   * NPM 注册表地址
   * - 不指定或 undefined: 自动检测（从 .npmrc 等配置文件读取）
   * - 字符串: 指定 registry 地址
   * @default 自动检测
   */
  registry?: string;

  /**
   * 是否启用调试日志
   * @default false
   */
  debug?: boolean;

  /** Never query a registry or run installation; only verified installed aliases are usable. */
  offline?: boolean;

  /** Fail when required peers, aliases, or resolution contexts remain unresolved. */
  strict?: boolean;

  /**
   * 自定义别名前缀
   * @default 'aliased-'
   */
  aliasPrefix?: string;

  /**
   * 排除特定依赖包对某些模块的解析重定向
   * 键为原始包名，值为需要从 allDependents 中剔除的包名列表
   * @example { vue: ['vue-demi'] } - vue-demi 中的 import vue 不会被重定向
   */
  excludeRedirects?: Record<string, string[]>;

  /**
   * 显式纳入特定依赖包对某些模块的解析重定向
   * 键为原始包名，值为需要强制加入 allDependents 的包名列表
   * 常用于处理 semver 范围写得过宽（如 ">=2.5.0" 同时满足 Vue 2/3），
   * 但运行时仍依赖旧版本实现的包
   * 优先于 excludeRedirects 应用（include 后再 exclude）
   * @example { vue: ['@rili/ui', '@kmt/meeting-setting'] }
   */
  includeRedirects?: Record<string, string[]>;

  /**
   * 覆写指定依赖包声明的 peerDependencies 版本范围
   * 键支持 `<包名>` 或 `<包名>@<semver范围>`（含 scoped 包，如 `'@rili/ui@1.x'`），
   * 值为 `{ peer包名: 版本范围 }` 映射；优先级：纯包名 < 版本范围 < 精确版本（按 peer 粒度合并）
   * 适用于上游包 peerDependencies 过宽（如 ">=2.5.0" 漏写上限）或缺失，
   * 导致无法自动检出冲突并接管其整棵物理依赖子树的场景
   * @example { '@rili/ui@1.x': { vue: '>=2.5.17 <3' } }
   */
  peerOverrides?: Record<string, Record<string, string>>;
}

/**
 * 解析后的配置（带默认值）
 * 注意：packageManager 和 registry 在解析后会是具体的值，不会是 'auto'
 */
export interface ResolvedOptions extends Required<
  Omit<DepsConflictResolverOptions, 'offline' | 'strict' | 'peerOverrides'>
> {
  offline?: boolean;
  strict?: boolean;
  peerOverrides?: Record<string, Record<string, string>>;
  /**
   * 解析后的包管理器类型（已自动检测或用户指定）
   */
  packageManager: 'npm' | 'yarn' | 'pnpm';
}

/**
 * 插件钩子
 */
export interface PluginHooks {
  /**
   * 分析完成后的钩子
   */
  onAnalysisComplete?: (result: AnalysisResult) => void | Promise<void>;

  /**
   * 安装完成后的钩子
   */
  onInstallComplete?: (installed: AliasMapping[]) => void | Promise<void>;

  /**
   * 解析模块前的钩子
   */
  beforeResolve?: (source: string, importer: string | undefined) => string | null | undefined;
}

/**
 * 完整的插件配置
 */
export interface PluginConfig extends DepsConflictResolverOptions {
  /**
   * 钩子函数
   */
  hooks?: PluginHooks;
}
