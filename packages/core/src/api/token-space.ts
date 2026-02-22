import type { UserMetadata, PlatformMetadata } from "@/types/identity";
import type { TargetCriteria } from "./types/config";
import { Token } from "./token";
import { NexusUsageError } from "@/errors";
import { fn } from "@/utils/fn";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

/**
 * Configuration options for TokenSpace.
 * Supports setting namespace name and default target configuration.
 */
export interface TokenSpaceConfig<
  U extends UserMetadata,
  _P extends PlatformMetadata,
> {
  /** The name of the namespace, which will be used as a prefix for all child Token IDs */
  name: string;

  /**
   * Optional default target configuration.
   * Note: Only accepts inline-defined descriptor objects or matcher functions,
   * not string-form named references, to ensure type safety.
   */
  defaultTarget?: TokenSpaceDefaultTarget<U>;
}

/**
 * Default target types supported by TokenSpace.
 * Only allows inline-defined descriptors and matchers, not named references.
 * This ensures type safety and avoids runtime errors from referencing unregistered named entities.
 */
export interface TokenSpaceDefaultTarget<U extends UserMetadata> {
  /**
   * Inline-defined descriptor object.
   * Must be a partial object of UserMetadata, not a string reference.
   */
  descriptor?: Partial<U>;

  /**
   * Inline-defined matcher function.
   * Must be an anonymous function, not a string reference.
   */
  matcher?: (identity: U) => boolean;

  /**
   * Expected number of connections.
   * @default "one"
   */
  expects?: "one" | "first";
}

/**
 * Configuration options for child TokenSpace.
 * Allows partial override of parent configuration.
 */
export interface ChildTokenSpaceConfig<U extends UserMetadata> {
  /**
   * Optional default target configuration.
   * If provided, will override the parent's defaultTarget;
   * If not provided, will inherit the parent's defaultTarget.
   */
  defaultTarget?: TokenSpaceDefaultTarget<U>;
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
      .custom<
        Partial<UserMetadata>
      >((value) => typeof value === "object" && value !== null && !Array.isArray(value))
      .optional(),
    matcher: z
      .custom<unknown>((value) => typeof value === "function")
      .optional(),
    expects: z.enum(["one", "first"]).optional(),
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

const validateDefaultTarget = fn(
  TokenSpaceDefaultTargetSchema,
  (input) => input,
);

/**
 * TokenSpace class: A factory and namespace manager for creating and organizing Tokens.
 *
 * Core features:
 * 1. Context binding: Binds to specific UserMetadata and PlatformMetadata types
 * 2. Default configuration holder: Holds optional defaultTarget configuration
 * 3. Namespace prefix manager: Manages Token ID prefixes
 * 4. Token factory: Provides token() method to create Token instances
 * 5. Nested namespaces: Supports creating child TokenSpaces
 *
 * @template U UserMetadata type
 * @template P PlatformMetadata type
 */
export class TokenSpace<U extends UserMetadata, P extends PlatformMetadata> {
  private readonly _name: string;
  private readonly _defaultTarget?: TokenSpaceDefaultTarget<U>;
  private readonly _fullPath: string;

  /**
   * Creates a new TokenSpace instance.
   *
   * @param config Configuration object containing name and optional default target
   * @param parentPath Full path of the parent TokenSpace (for nesting)
   */
  constructor(config: TokenSpaceConfig<U, P>, parentPath?: string) {
    const validatedName = validateTokenSpaceName(config.name);
    if (validatedName.isErr()) {
      throw new NexusUsageError(validatedName.error.message);
    }

    this._name = validatedName.value;
    const validatedDefaultTarget = validateDefaultTarget(config.defaultTarget);
    if (validatedDefaultTarget.isErr()) {
      throw new NexusUsageError(
        "TokenSpace defaultTarget is invalid",
        "E_USAGE_INVALID",
        { cause: validatedDefaultTarget.error },
      );
    }

    this._defaultTarget = validatedDefaultTarget.value as
      | TokenSpaceDefaultTarget<U>
      | undefined;

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
  get defaultTarget(): TokenSpaceDefaultTarget<U> | undefined {
    return this._defaultTarget;
  }

  /**
   * Creates a new Token instance.
   *
   * @template T Service interface type
   * @param serviceName Local name of the Token within the current namespace
   * @returns Newly created Token instance with ID as full path concatenated with service name
   */
  token<T>(serviceName: string): Token<T> {
    return this.safeToken<T>(serviceName).match(
      (value) => value,
      (error) => {
        throw error;
      },
    );
  }

  safeToken<T>(serviceName: string): Result<Token<T>, Error> {
    const validatedServiceName = validateTokenSpaceName(serviceName);
    if (validatedServiceName.isErr()) {
      return err(new NexusUsageError(validatedServiceName.error.message));
    }

    const cleanServiceName = validatedServiceName.value;
    const tokenId = `${this._fullPath}:${cleanServiceName}`;

    // Convert TokenSpace's defaultTarget to Token-compatible format
    let tokenDefaultTarget: TargetCriteria<U, never, never> | undefined;

    if (this._defaultTarget) {
      // Only pass descriptor and matcher, expects is not needed at Token level
      tokenDefaultTarget = {};

      if (this._defaultTarget.descriptor) {
        tokenDefaultTarget.descriptor = this._defaultTarget.descriptor;
      }

      if (this._defaultTarget.matcher) {
        tokenDefaultTarget.matcher = this._defaultTarget.matcher;
      }
    }

    return ok(new Token<T>(tokenId, tokenDefaultTarget));
  }

  /**
   * Creates a child TokenSpace instance.
   *
   * @param name Name of the child namespace
   * @param config Optional configuration object to override or inherit parent configuration
   * @returns Newly created child TokenSpace instance
   */
  tokenSpace(
    name: string,
    config?: ChildTokenSpaceConfig<U>,
  ): TokenSpace<U, P> {
    return this.safeTokenSpace(name, config).match(
      (value) => value,
      (error) => {
        throw error;
      },
    );
  }

  safeTokenSpace(
    name: string,
    config?: ChildTokenSpaceConfig<U>,
  ): Result<TokenSpace<U, P>, Error> {
    const validatedName = validateTokenSpaceName(name);
    if (validatedName.isErr()) {
      return err(new NexusUsageError(validatedName.error.message));
    }

    // Merge configuration: child config overrides parent config
    const mergedConfig: TokenSpaceConfig<U, P> = {
      name: validatedName.value,
      defaultTarget: config?.defaultTarget ?? this._defaultTarget,
    };

    return ok(new TokenSpace<U, P>(mergedConfig, this._fullPath));
  }
}
