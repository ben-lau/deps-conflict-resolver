/**
 * 日志级别
 */
export enum LogLevel {
  SILENT = 0,
  DEBUG = 1 << 0, // 0001
  INFO = 1 << 1, // 0010
  WARN = 1 << 2, // 0100
  ERROR = 1 << 3, // 1000
  ALL = DEBUG | INFO | WARN | ERROR, // 1111
}

/**
 * 日志配置
 */
interface LoggerConfig {
  /**
   * 日志级别（可选：不传则使用全局默认级别）
   */
  level?: LogLevel;
  prefix: string;
}

/**
 * 全局日志级别（默认显示 INFO、WARN、ERROR）
 * - 用于让不同子模块创建出来的 logger 能共享同一套 level 配置
 * - 避免 "入口开启 debug，但子模块 logger 仍然是 INFO" 的问题
 * - 使用位运算组合，例如：LogLevel.DEBUG | LogLevel.ERROR 只显示调试和错误
 */
const DEFAULT_GLOBAL_LEVEL: LogLevel = LogLevel.INFO | LogLevel.WARN | LogLevel.ERROR;
let __GLOBAL_LEVEL__: LogLevel = DEFAULT_GLOBAL_LEVEL;

/**
 * 重置全局日志级别（主要用于测试隔离）
 */
export function resetGlobalLogLevel(): void {
  __GLOBAL_LEVEL__ = DEFAULT_GLOBAL_LEVEL;
}

/**
 * 日志工具类
 */
export class Logger {
  private prefix: string;
  private levelOverride?: LogLevel;

  constructor(config: Partial<LoggerConfig> = {}) {
    this.prefix = config.prefix ?? '[deps-conflict-resolver]';
    this.levelOverride = config.level;
  }

  /**
   * 设置日志级别
   */
  setLevel(level: LogLevel): void {
    // 约定：库内的日志级别是“全局开关”
    // 这样只需要在入口（resolver/vite/webpack）设置一次，就能影响所有子模块 logger。
    __GLOBAL_LEVEL__ = level;
    // 当前 logger 也应该跟随全局配置，而不是固定为局部 override
    this.levelOverride = undefined;
  }

  private getEffectiveLevel(): LogLevel {
    return this.levelOverride ?? __GLOBAL_LEVEL__;
  }

  /**
   * 调试日志
   */
  debug(...args: unknown[]): void {
    if (this.getEffectiveLevel() & LogLevel.DEBUG) {
      console.debug(this.formatPrefix('DEBUG'), ...args);
    }
  }

  /**
   * 信息日志
   */
  info(...args: unknown[]): void {
    if (this.getEffectiveLevel() & LogLevel.INFO) {
      console.info(this.formatPrefix('INFO'), ...args);
    }
  }

  /**
   * 警告日志
   */
  warn(...args: unknown[]): void {
    if (this.getEffectiveLevel() & LogLevel.WARN) {
      console.warn(this.formatPrefix('WARN'), ...args);
    }
  }

  /**
   * 错误日志
   */
  error(...args: unknown[]): void {
    if (this.getEffectiveLevel() & LogLevel.ERROR) {
      console.error(this.formatPrefix('ERROR'), ...args);
    }
  }

  /**
   * 格式化前缀
   */
  private formatPrefix(level: string): string {
    return `${this.prefix} [${level}]`;
  }
}

/**
 * 创建带有子前缀的日志实例
 */
export function createLogger(subPrefix: string, debug = false): Logger {
  return new Logger({
    prefix: `[deps-conflict-resolver:${subPrefix}]`,
    // debug=true 时强制当前 logger 输出所有日志；否则使用全局级别（默认 INFO/WARN/ERROR）
    level: debug ? LogLevel.ALL : undefined,
  });
}
