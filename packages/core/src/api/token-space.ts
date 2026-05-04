import type { UserMetadata, PlatformMetadata } from "@/types/identity";
import type {
  NamedDefaultOptIn,
  TargetCriteria,
  TokenCreateDefaults,
} from "./types/config";
import { Token, type TokenOptions, validateDefaultCreateTarget } from "./token";
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
  M extends string = never,
  D extends string = never,
> {
  /** The name of the namespace, which will be used as a prefix for all child Token IDs */
  name: string;

  defaultCreate?: TokenCreateDefaults<U, M, D> | null;
  namedDefaults?: NamedDefaultOptIn<M, D>["namedDefaults"];

  /**
   * Optional default target configuration.
   * Note: Only accepts inline-defined descriptor objects or matcher functions,
   * not string-form named references, to ensure type safety.
   */
  defaultTarget?: TokenSpaceDefaultTarget<U, M, D>;
}

/**
 * Default target types supported by TokenSpace.
 * Only allows inline-defined descriptors and matchers, not named references.
 * This ensures type safety and avoids runtime errors from referencing unregistered named entities.
 */
export interface TokenSpaceDefaultTarget<
  U extends UserMetadata,
  M extends string = never,
  D extends string = never,
> {
  /**
   * Inline-defined descriptor object.
   * Must be a partial object of UserMetadata, not a string reference.
   */
  descriptor?: TargetCriteria<U, M, D>["descriptor"];

  /**
   * Inline-defined matcher function.
   * Must be an anonymous function, not a string reference.
   */
  matcher?: TargetCriteria<U, M, D>["matcher"];
}

/**
 * Configuration options for child TokenSpace.
 * Allows partial override of parent configuration.
 */
export interface ChildTokenSpaceConfig<
  U extends UserMetadata,
  M extends string = never,
  D extends string = never,
> {
  defaultCreate?: TokenCreateDefaults<U, M, D> | null;
  namedDefaults?: NamedDefaultOptIn<M, D>["namedDefaults"];

  /**
   * Optional default target configuration.
   * If provided, will override the parent's defaultTarget;
   * If not provided, will inherit the parent's defaultTarget.
   */
  defaultTarget?: TokenSpaceDefaultTarget<U, M, D>;
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
export class TokenSpace<
  U extends UserMetadata,
  P extends PlatformMetadata,
  M extends string = never,
  D extends string = never,
> {
  private readonly _name: string;
  private readonly _defaultCreate?: TokenCreateDefaults<U, M, D>;
  private readonly _fullPath: string;
  private readonly _namedDefaults: boolean;

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
    const defaultCreate = normalizeTokenSpaceDefaultCreate(config);
    if (defaultCreate.isErr()) {
      throw defaultCreate.error;
    }

    this._defaultCreate = defaultCreate.value as
      | TokenCreateDefaults<U, M, D>
      | undefined;
    this._namedDefaults = config.namedDefaults === true;

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
  get defaultTarget(): TokenSpaceDefaultTarget<U, M, D> | undefined {
    return this._defaultCreate?.target;
  }

  get defaultCreate(): TokenCreateDefaults<U, M, D> | undefined {
    return this._defaultCreate;
  }

  /**
   * Creates a new Token instance.
   *
   * @template T Service interface type
   * @param serviceName Local name of the Token within the current namespace
   * @returns Newly created Token instance with ID as full path concatenated with service name
   */
  token<T>(
    serviceName: string,
    options?: TokenOptions<U, M, D>,
  ): Token<T, U, M, D> {
    return this.safeToken<T>(serviceName, options).match(
      (value) => value,
      (error) => {
        throw error;
      },
    );
  }

  safeToken<T>(
    serviceName: string,
    options?: TokenOptions<U, M, D>,
  ): Result<Token<T, U, M, D>, Error> {
    const validatedServiceName = validateTokenSpaceName(serviceName);
    if (validatedServiceName.isErr()) {
      return err(new NexusUsageError(validatedServiceName.error.message));
    }

    const cleanServiceName = validatedServiceName.value;
    const tokenId = `${this._fullPath}:${cleanServiceName}`;

    try {
      return ok(
        new Token<T, U, M, D>(
          tokenId,
          options ?? { defaultCreate: this._defaultCreate },
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
  tokenSpace(
    name: string,
    config?: ChildTokenSpaceConfig<U, M, D>,
  ): TokenSpace<U, P, M, D> {
    return this.safeTokenSpace(name, config).match(
      (value) => value,
      (error) => {
        throw error;
      },
    );
  }

  safeTokenSpace(
    name: string,
    config?: ChildTokenSpaceConfig<U, M, D>,
  ): Result<TokenSpace<U, P, M, D>, Error> {
    const validatedName = validateTokenSpaceName(name);
    if (validatedName.isErr()) {
      return err(new NexusUsageError(validatedName.error.message));
    }

    const mergedConfig = {
      name: validatedName.value,
      namedDefaults: config?.namedDefaults ?? this._namedDefaults,
    } as TokenSpaceConfig<U, P, M, D>;

    if (Object.hasOwn(config ?? {}, "defaultTarget")) {
      mergedConfig.defaultTarget = config?.defaultTarget;
    } else {
      mergedConfig.defaultCreate = Object.hasOwn(config ?? {}, "defaultCreate")
        ? config?.defaultCreate
        : this._defaultCreate;
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

function normalizeTokenSpaceDefaultCreate<
  U extends UserMetadata,
  M extends string,
  D extends string,
>(
  config: TokenSpaceConfig<U, PlatformMetadata, M, D>,
): Result<TokenCreateDefaults<U, M, D> | undefined, NexusUsageError> {
  const hasDefaultCreate = Object.hasOwn(config, "defaultCreate");
  const hasDefaultTarget = Object.hasOwn(config, "defaultTarget");

  if (config.defaultTarget && Object.hasOwn(config.defaultTarget, "expects")) {
    return err(
      new NexusUsageError(
        "TokenSpace defaultTarget cannot include expects; pass expects at the create() call-site.",
        "E_USAGE_DEFAULT_CREATE_CONFLICT",
      ),
    );
  }

  if (config.defaultTarget) {
    const invalidKeys = Object.keys(config.defaultTarget).filter(
      (key) => key !== "descriptor" && key !== "matcher",
    );
    if (invalidKeys.length > 0) {
      return err(
        new NexusUsageError(
          `TokenSpace legacy defaultTarget only supports descriptor and matcher; invalid key(s): ${invalidKeys.join(", ")}.`,
          "E_USAGE_DEFAULT_CREATE_CONFLICT",
        ),
      );
    }
  }

  if (hasDefaultCreate && hasDefaultTarget) {
    return err(
      new NexusUsageError(
        "TokenSpace config cannot mix defaultCreate with legacy defaultTarget.",
        "E_USAGE_DEFAULT_CREATE_CONFLICT",
      ),
    );
  }

  if (hasDefaultCreate) {
    try {
      validateDefaultCreateTarget(config.defaultCreate?.target);
    } catch (error) {
      return err(error as NexusUsageError);
    }

    if (
      !config.namedDefaults &&
      hasNamedDefaultTarget(config.defaultCreate?.target)
    ) {
      return err(
        new NexusUsageError(
          "TokenSpace named defaultCreate descriptor or matcher defaults require names to be opted in by the TokenSpace generic types.",
          "E_USAGE_INVALID",
        ),
      );
    }

    return ok(config.defaultCreate ?? undefined);
  }

  const validatedDefaultTarget = validateDefaultTarget(
    config.defaultTarget as TokenSpaceDefaultTarget<U> | undefined,
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
      ? {
          target: validatedDefaultTarget.value as TargetCriteria<U, M, D>,
        }
      : undefined,
  );
}

function hasNamedDefaultTarget<U extends UserMetadata>(
  target: TargetCriteria<U, string, string> | null | undefined,
): boolean {
  return (
    typeof target?.descriptor === "string" ||
    typeof target?.matcher === "string"
  );
}
