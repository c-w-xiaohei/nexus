import { NexusError } from "./nexus-error.js";
import type { NexusErrorOptions } from "./nexus-error.js";

export type NexusConfigurationErrorCode =
  | "E_CONFIGURATION_INVALID"
  | "E_PROVIDER_DUPLICATE_TOKEN"
  | "E_PROVIDER_BATCH_INVALID"
  | "E_NEXUS_BOOTSTRAPPING_LOCKED"
  | "E_NEXUS_BOOTSTRAP_FAILED"
  | "E_NEXUS_DISPOSED"
  | "E_NEXUS_ALREADY_READY"
  | "E_ENDPOINT_SOURCE_CONFLICT"
  | "E_DUPLICATE_PROVIDER";
export type NexusUsageErrorCode =
  | "E_USAGE_INVALID"
  | "E_PROVIDER_BATCH_INVALID";

/**
 * Represents an error in the configuration of the Nexus instance.
 * This is thrown synchronously when `nexus.configure()` is called with
 * invalid or incomplete options.
 */
export class NexusConfigurationError<
  C extends NexusConfigurationErrorCode = NexusConfigurationErrorCode,
> extends NexusError {
  declare public readonly code: C;
  /** Records configuration failure without losing bootstrap or registration diagnostics. */
  constructor(
    message: string,
    code: C = "E_CONFIGURATION_INVALID" as C,
    optionsOrContext?: NexusErrorOptions | Record<string, unknown>,
  ) {
    super(message, code, normalizeErrorOptions(optionsOrContext));
  }
}

/**
 * Represents an error in how a Nexus API is used.
 * For example, passing a non-positive acquisition timeout.
 */
export class NexusUsageError<
  C extends NexusUsageErrorCode = NexusUsageErrorCode,
> extends NexusError {
  declare public readonly code: C;
  /** Creates a usage failure with a literal code suitable for public error-union narrowing. */
  constructor(
    message: string,
    code: C = "E_USAGE_INVALID" as C,
    optionsOrContext?: NexusErrorOptions | Record<string, unknown>,
  ) {
    super(message, code, normalizeErrorOptions(optionsOrContext));
  }
}

/** Accepts structured error options or the existing shorthand diagnostic context. */
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
