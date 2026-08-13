import type { EndpointMeta, PlatformMeta } from "../types/identity.js";
import type { InlineTarget } from "./types/config.js";
import {
  Token,
  type TokenOptions,
  validateDefaultTarget as validateTokenDefaultTarget,
} from "./token.js";
import { NexusUsageError } from "../errors/index.js";
import { fn } from "../utils/fn.js";
import { Result } from "better-result";
const { err, ok } = Result;
import { z } from "zod";

/**
 * Configuration options for TokenSpace.
 * Supports setting namespace name and default target configuration.
 */
export interface TokenSpaceConfig<
  U extends EndpointMeta,
  _P extends PlatformMeta,
  _M extends string = never,
  _D extends string = never,
> {
  /** The name of the namespace, which will be used as a prefix for all child Token IDs */
  name: string;

  defaultTarget?: InlineTarget<U> | null;
}

/**
 * Default target types supported by TokenSpace.
 * Only allows inline-defined descriptors and matchers, not named references.
 * This ensures type safety and avoids runtime errors from referencing unregistered named entities.
 */
export type TokenSpaceDefaultTarget<U extends EndpointMeta> = InlineTarget<U>;

/**
 * Configuration options for child TokenSpace.
 * Allows partial override of parent configuration.
 */
export interface ChildTokenSpaceConfig<
  U extends EndpointMeta,
  _M extends string = never,
  _D extends string = never,
> {
  defaultTarget?: InlineTarget<U> | null;
}

const NonEmptyNameSchema = z
  .string()
  .trim()
  .min(1, "Name cannot be empty")
  .refine((value) => !value.includes(":"), {
    message: "Name cannot contain ':' character",
  });

const validateTokenSpaceName = fn(NonEmptyNameSchema, (name) => name);

const TokenSpaceDefaultTargetSchema = z
  .object({
    descriptor: z
      .custom<Partial<EndpointMeta>>(
        (value) =>
          typeof value === "object" && value !== null && !Array.isArray(value),
      )
      .optional(),
    matcher: z
      .custom<unknown>((value) => typeof value === "function")
      .optional(),
  })
  .refine(
    (input) =>
      typeof input.descriptor !== "undefined" ||
      typeof input.matcher !== "undefined",
    {
      message: "defaultTarget requires at least one of descriptor or matcher",
    },
  )
  .optional();

const validateTokenSpaceDefaultTarget = fn(
  TokenSpaceDefaultTargetSchema,
  (input) => input,
);

/**
 * TokenSpace class: A factory and namespace manager for creating and organizing Tokens.
 *
 * Core features:
 * 1. Context binding: Binds to specific EndpointMeta and PlatformMeta types
 * 2. Default configuration holder: Holds optional defaultTarget configuration
 * 3. Namespace prefix manager: Manages Token ID prefixes
 * 4. Token factory: Provides token() method to create Token instances
 * 5. Nested namespaces: Supports creating child TokenSpaces
 *
 * @template U EndpointMeta type
 * @template P PlatformMeta type
 */
export class TokenSpace<
  U extends EndpointMeta,
  P extends PlatformMeta,
  M extends string = never,
  D extends string = never,
> {
  private readonly _name: string;
  private readonly _defaultTarget?: InlineTarget<U>;
  private readonly _fullPath: string;

  /**
   * Creates a new TokenSpace instance.
   *
   * @param config Configuration object containing name and optional default target
   * @param parentPath Full path of the parent TokenSpace (for nesting)
   */
  constructor(config: TokenSpaceConfig<U, P, M, D>, parentPath?: string) {
    const validatedName = validateTokenSpaceName(config.name);
    if (validatedName.isErr()) {
      throw new NexusUsageError(validatedName.error.message);
    }

    this._name = validatedName.value;
    const defaultTarget = normalizeTokenSpaceDefaultTarget(config);
    if (defaultTarget.isErr()) {
      throw defaultTarget.error;
    }

    this._defaultTarget = defaultTarget.value;

    // Build full path: concatenate with parent path if exists, otherwise use current name
    this._fullPath = parentPath ? `${parentPath}:${this._name}` : this._name;
  }

  /**
   * Gets the name of the current TokenSpace.
   */
  get name(): string {
    return this._name;
  }

  /**
   * Gets the full path of the current TokenSpace.
   */
  get fullPath(): string {
    return this._fullPath;
  }

  /**
   * Gets the default target configuration of the current TokenSpace.
   */
  get defaultTarget(): InlineTarget<U> | undefined {
    return this._defaultTarget;
  }

  /**
   * Creates a new Token instance.
   *
   * @template T Service interface type
   * @param serviceName Local name of the Token within the current namespace
   * @returns Newly created Token instance with ID as full path concatenated with service name
   */
  token<T>(serviceName: string, options?: TokenOptions<U>): Token<T, U> {
    return this.safeToken<T>(serviceName, options).match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });
  }

  safeToken<T>(
    serviceName: string,
    options?: TokenOptions<U>,
  ): Result<Token<T, U>, Error> {
    const validatedServiceName = validateTokenSpaceName(serviceName);
    if (validatedServiceName.isErr()) {
      return err(new NexusUsageError(validatedServiceName.error.message));
    }

    const cleanServiceName = validatedServiceName.value;
    const tokenId = `${this._fullPath}:${cleanServiceName}`;

    try {
      return ok(
        new Token<T, U>(
          tokenId,
          options ?? { defaultTarget: this._defaultTarget },
        ),
      );
    } catch (error) {
      return err(normalizeSafeError(error));
    }
  }

  /**
   * Creates a child TokenSpace instance.
   *
   * @param name Name of the child namespace
   * @param config Optional configuration object to override or inherit parent configuration
   * @returns Newly created child TokenSpace instance
   */
  space(
    name: string,
    config?: ChildTokenSpaceConfig<U, M, D>,
  ): TokenSpace<U, P, M, D> {
    return this.safeSpace(name, config).match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });
  }

  safeSpace(
    name: string,
    config?: ChildTokenSpaceConfig<U, M, D>,
  ): Result<TokenSpace<U, P, M, D>, Error> {
    const validatedName = validateTokenSpaceName(name);
    if (validatedName.isErr()) {
      return err(new NexusUsageError(validatedName.error.message));
    }

    const mergedConfig = {
      name: validatedName.value,
    } as TokenSpaceConfig<U, P, M, D>;

    if (Object.hasOwn(config ?? {}, "defaultTarget")) {
      mergedConfig.defaultTarget = config?.defaultTarget;
    } else {
      mergedConfig.defaultTarget = Object.hasOwn(config ?? {}, "defaultTarget")
        ? config?.defaultTarget
        : this._defaultTarget;
    }

    try {
      return ok(new TokenSpace<U, P, M, D>(mergedConfig, this._fullPath));
    } catch (error) {
      return err(normalizeSafeError(error));
    }
  }
}

function normalizeSafeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new NexusUsageError(
    "Unexpected non-Error thrown by TokenSpace",
    "E_USAGE_INVALID",
    {
      cause: error,
    },
  );
}

function normalizeTokenSpaceDefaultTarget<
  U extends EndpointMeta,
  M extends string,
  D extends string,
>(
  config: TokenSpaceConfig<U, PlatformMeta, M, D>,
): Result<InlineTarget<U> | undefined, NexusUsageError> {
  const hasDefaultTarget = Object.hasOwn(config, "defaultTarget");

  if (!hasDefaultTarget || config.defaultTarget === null) {
    return ok(undefined);
  }

  try {
    validateTokenDefaultTarget(config.defaultTarget);
  } catch (error) {
    return err(error as NexusUsageError);
  }

  const validatedDefaultTarget = validateTokenSpaceDefaultTarget(
    config.defaultTarget as InlineTarget<U> | undefined,
  );
  if (validatedDefaultTarget.isErr()) {
    return err(
      new NexusUsageError(
        "TokenSpace defaultTarget is invalid",
        "E_USAGE_INVALID",
        {
          cause: validatedDefaultTarget.error,
        },
      ),
    );
  }

  return ok(
    validatedDefaultTarget.value
      ? (validatedDefaultTarget.value as InlineTarget<U>)
      : undefined,
  );
}
