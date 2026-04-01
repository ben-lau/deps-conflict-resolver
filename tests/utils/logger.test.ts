import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger, LogLevel, createLogger, resetGlobalLogLevel } from '../../src/utils/logger';

describe('Logger', () => {
  type ConsoleSpy = ReturnType<typeof vi.spyOn>;

  let consoleSpy: {
    debug: ConsoleSpy;
    info: ConsoleSpy;
    warn: ConsoleSpy;
    error: ConsoleSpy;
  };

  beforeEach(() => {
    resetGlobalLogLevel();
    consoleSpy = {
      debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
      info: vi.spyOn(console, 'info').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('log level filtering', () => {
    it.each([
      { level: LogLevel.DEBUG, method: 'debug' as const, shouldLog: true },
      { level: LogLevel.INFO, method: 'debug' as const, shouldLog: false },
      { level: LogLevel.INFO, method: 'info' as const, shouldLog: true },
      { level: LogLevel.WARN, method: 'info' as const, shouldLog: false },
      { level: LogLevel.WARN, method: 'warn' as const, shouldLog: true },
      { level: LogLevel.ERROR, method: 'warn' as const, shouldLog: false },
      { level: LogLevel.ERROR, method: 'error' as const, shouldLog: true },
      { level: LogLevel.SILENT, method: 'error' as const, shouldLog: false },
    ])(
      'should $shouldLog ? "log" : "not log" $method at level $level',
      ({ level, method, shouldLog }) => {
        const log = new Logger({ level });
        log[method]('test message');

        if (shouldLog) {
          expect(consoleSpy[method]).toHaveBeenCalled();
        } else {
          expect(consoleSpy[method]).not.toHaveBeenCalled();
        }
      },
    );
  });

  describe('setLevel', () => {
    it('should dynamically change log level', () => {
      const log = new Logger({ level: LogLevel.INFO });

      log.debug('test');
      expect(consoleSpy.debug).not.toHaveBeenCalled();

      log.setLevel(LogLevel.DEBUG);
      log.debug('test');
      expect(consoleSpy.debug).toHaveBeenCalled();
    });
  });

  describe('log formatting', () => {
    it('should include prefix and level in output', () => {
      const log = new Logger({ level: LogLevel.INFO, prefix: '[test]' });
      log.info('test message');
      expect(consoleSpy.info).toHaveBeenCalledWith(
        expect.stringMatching(/\[test\].*\[INFO\]/),
        'test message',
      );
    });
  });
});

describe('createLogger', () => {
  it('should create logger with correct debug level based on flag', () => {
    resetGlobalLogLevel();
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    // debug=true 时应该输出 debug 日志
    const logWithDebug = createLogger('test-module', true);
    logWithDebug.debug('debug message');
    expect(debugSpy).toHaveBeenCalled();

    debugSpy.mockClear();

    // debug=false 时不应该输出 debug 日志（默认级别不包含 DEBUG）
    const logWithoutDebug = createLogger('test-module', false);
    logWithoutDebug.debug('debug message');
    expect(debugSpy).not.toHaveBeenCalled();

    debugSpy.mockRestore();
  });
});
