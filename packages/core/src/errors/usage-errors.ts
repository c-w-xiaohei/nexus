import { NexusError } from "./nexus-error";
import type { NexusErrorOptions } from "./nexus-error";

export type NexusConfigurationErrorCode = "E_CONFIGURATION_INVALID";
export type NexusUsageErrorCode = "E_USAGE_INVALID";

/**
 * Represents an error in the configuration of the Nexus instance.
 * This is thrown synchronously when `nexus.configure()` is called with
 * invalid or incomplete options.
 */
export class NexusConfigurationError extends NexusError {
  constructor(
    message: string,
    code: NexusConfigurationErrorCode = "E_CONFIGURATION_INVALID",
    optionsOrContext?: NexusErrorOptions | Record<string, unknown>,
  ) {
    super(message, code, normalizeErrorOptions(optionsOrContext));
  }
}

/**
 * Represents an error in how a Nexus API is used.
 * For example, calling `nexus.create()` without a clear target.
 */
export class NexusUsageError extends NexusError {
  constructor(
    message: string,
    code: NexusUsageErrorCode = "E_USAGE_INVALID",
    optionsOrContext?: NexusErrorOptions | Record<string, unknown>,
  ) {
    super(message, code, normalizeErrorOptions(optionsOrContext));
  }
}

const normalizeErrorOptions = (
  optionsOrContext?: NexusErrorOptions | Record<string, unknown>,
): NexusErrorOptions => {
  if (!optionsOrContext) {
    return {};
  }

  const optionKeys = new Set(["context", "cause", "stack"]);
  const keys = Object.keys(optionsOrContext);
  const hasOptionKey =
    "context" in optionsOrContext ||
    "cause" in optionsOrContext ||
    "stack" in optionsOrContext;
  if (hasOptionKey) {
    const candidate = optionsOrContext as Record<string, unknown>;
    const { context: rawContext, cause, stack, ...extraContext } = candidate;

    const contextFromOptions: Record<string, unknown> = {
      ...extraContext,
    };
    if (
      typeof cause !== "undefined" &&
      (typeof cause !== "object" || cause === null)
    ) {
      contextFromOptions.cause = cause;
    }
    if (typeof stack !== "undefined" && typeof stack !== "string") {
      contextFromOptions.stack = stack;
    }

    const normalizedContext: Record<string, unknown> | undefined =
      typeof rawContext === "object" && rawContext !== null
        ? {
            ...(rawContext as Record<string, unknown>),
            ...contextFromOptions,
          }
        : keys.some((key) => !optionKeys.has(key))
          ? contextFromOptions
          : undefined;

    const normalizedOptions: NexusErrorOptions = {
      context: normalizedContext,
    };

    if (typeof stack === "string") {
      normalizedOptions.stack = stack;
    }
    if (typeof cause === "object" && cause !== null) {
      normalizedOptions.cause = cause as NexusErrorOptions["cause"];
    }

    return normalizedOptions;
  }

  return { context: optionsOrContext as Record<string, unknown> };
};
