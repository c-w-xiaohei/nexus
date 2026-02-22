/**
 * Nexus Internal Logger
 *
 * A lightweight, configurable logging system designed for internal framework
 * debugging. It is not intended for general application-level logging.
 *
 * Features:
 * - Scoped loggers for clear context (e.g., [Nexus-CallProcessor]).
 * - Log levels to control verbosity.
 * - Zero-cost in production: when a log level is disabled, the entire
 *   log statement, including argument evaluation, is skipped.
 * - Simple configuration API (`configureNexusLogger`) for easy use in tests.
 */

export enum LogLevel {
  DEBUG = 10,
  INFO = 20,
  WARN = 30,
  ERROR = 40,
  SILENT = 100,
}

type LogHandler = (
  level: LogLevel,
  scope: string,
  message: string,
  ...args: unknown[]
) => void;

type LogLevels = Partial<Record<"L1" | "L2" | "L3" | "L4" | "*", LogLevel>>;

interface NexusLoggerConfig {
  enabled: boolean;
  levels: LogLevels;
  handler: LogHandler;
}

namespace LoggerConfigStore {
  const defaultHandler: LogHandler = (level, scope, message, ...args) => {
    const formattedMessage = `[${scope}] ${message}`;
    switch (level) {
      case LogLevel.DEBUG:
        console.debug(formattedMessage, ...args);
        break;
      case LogLevel.INFO:
        console.info(formattedMessage, ...args);
        break;
      case LogLevel.WARN:
        console.warn(formattedMessage, ...args);
        break;
      case LogLevel.ERROR:
        console.error(formattedMessage, ...args);
        break;
    }
  };

  export const defaults: NexusLoggerConfig = {
    enabled: false,
    levels: {
      "*": LogLevel.WARN,
    },
    handler: defaultHandler,
  };

  export const config: NexusLoggerConfig = {
    enabled: defaults.enabled,
    levels: { ...defaults.levels },
    handler: defaults.handler,
  };

  export const reset = (): void => {
    config.enabled = defaults.enabled;
    config.handler = defaults.handler;
    config.levels = { ...defaults.levels };
  };
}

/**
 * Configures the Nexus internal logger. This is the primary way to enable
 * detailed logging for debugging, especially within tests.
 *
 * @example
 * import { configureNexusLogger, LogLevel } from 'nexus';
 *
 * describe('My Failing Test', () => {
 *   beforeAll(() => {
 *     configureNexusLogger({ level: LogLevel.DEBUG });
 *   });
 *
 *   afterAll(() => {
 *     configureNexusLogger({ level: LogLevel.WARN }); // Reset after test
 *   });
 *
 *   it('should work', () => {
 *     // ...
 *   });
 * });
 *
 * // Example of layer-specific configuration:
 * configureNexusLogger({
 *   levels: {
 *     'L2': LogLevel.DEBUG, // Show all logs for Layer 2
 *     'L3': LogLevel.INFO,  // Only show info and above for Layer 3
 *     '*': LogLevel.WARN    // All other layers default to warnings
 *   }
 * });
 */
export function configureNexusLogger(
  options: Partial<{
    enabled: boolean;
    level: LogLevel;
    levels: LogLevels;
    handler: LogHandler;
  }>,
): void {
  const config = LoggerConfigStore.config;
  if (options.enabled !== undefined) {
    config.enabled = options.enabled;
  }
  if (options.handler) {
    config.handler = options.handler;
  }

  // Granular `levels` object takes precedence
  if (options.levels) {
    // Merge provided levels into the current config
    Object.assign(config.levels, options.levels);
  }
  // Simple `level` acts as a global override for convenience
  else if (options.level) {
    // If only `level` is provided, it becomes the new default for all layers.
    // We can reset specific layers if needed, but for now, '*' is sufficient.
    config.levels["*"] = options.level;
    // For convenience, let's ensure all layers adopt this level unless overridden.
    config.levels.L1 = options.level;
    config.levels.L2 = options.level;
    config.levels.L3 = options.level;
    config.levels.L4 = options.level;
  }
}

export function resetNexusLoggerForTest(): void {
  LoggerConfigStore.reset();
}

/**
 * A lightweight, scoped logger that only outputs when its level is enabled
 * in the global configuration.
 */
export class Logger {
  private readonly scope: string;
  private readonly layer: string | null = null;

  constructor(scope: string) {
    this.scope = `Nexus-${scope}`;
    // Extract layer like "L1", "L2", "L3" from the scope
    const match = scope.match(/^L\d/);
    if (match) {
      this.layer = match[0];
    }
  }

  private getEffectiveLevel(): LogLevel {
    const config = LoggerConfigStore.config;
    if (this.layer && this.layer in config.levels) {
      // A specific level is set for this logger's layer
      return config.levels[this.layer as keyof LogLevels]!;
    }
    // Fallback to the wildcard level
    return config.levels["*"] ?? LogLevel.WARN;
  }

  /**
   * Logs a high-volume, detailed message for deep debugging.
   */
  public debug(message: string, ...args: unknown[]): void {
    const config = LoggerConfigStore.config;
    if (!config.enabled) return;
    if (this.getEffectiveLevel() <= LogLevel.DEBUG) {
      config.handler(LogLevel.DEBUG, this.scope, message, ...args);
    }
  }

  /**
   * Logs a message for major lifecycle events or important information.
   */
  public info(message: string, ...args: unknown[]): void {
    const config = LoggerConfigStore.config;
    if (!config.enabled) return;
    if (this.getEffectiveLevel() <= LogLevel.INFO) {
      config.handler(LogLevel.INFO, this.scope, message, ...args);
    }
  }

  /**
   * Logs a warning for potential issues that don't break execution.
   */
  public warn(message: string, ...args: unknown[]): void {
    const config = LoggerConfigStore.config;
    if (!config.enabled) return;
    if (this.getEffectiveLevel() <= LogLevel.WARN) {
      config.handler(LogLevel.WARN, this.scope, message, ...args);
    }
  }

  /**
   * Logs an error that has occurred.
   */
  public error(message: string, ...args: unknown[]): void {
    const config = LoggerConfigStore.config;
    if (!config.enabled) return;
    if (this.getEffectiveLevel() <= LogLevel.ERROR) {
      config.handler(LogLevel.ERROR, this.scope, message, ...args);
    }
  }
}
