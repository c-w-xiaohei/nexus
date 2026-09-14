import type { AdapterModel } from "@/types/adapter-model";
import { NexusUsageError } from "@/errors";
import { Token } from "./token";
import { StoreToken, type StoreValidationSchemas } from "../state/contract";
import { Result } from "better-result";

export interface TokenSpaceConfig {
  name: string;
}

/** Namespaces service contracts; connection addresses belong to acquisition calls. */
export class TokenSpace<M extends AdapterModel> {
  private readonly fullPathValue: string;

  /** Creates one namespace segment, optionally beneath an existing namespace. */
  constructor(config: TokenSpaceConfig, parentPath?: string) {
    const valid = validateName(config.name);
    if (valid.isErr()) throw valid.error;
    this.fullPathValue = parentPath
      ? `${parentPath}:${config.name}`
      : config.name;
  }

  /** Returns the local namespace segment. */
  public get name(): string {
    return this.fullPathValue.split(":").at(-1)!;
  }

  /** Returns the stable, fully qualified namespace. */
  public get fullPath(): string {
    return this.fullPathValue;
  }

  /** Creates a model-bound service token without selecting a peer. */
  public token<T>(serviceName: string): Token<T, M> {
    const result = this.safeToken<T>(serviceName);
    if (result.isErr()) throw result.error;
    return result.value;
  }

  /** Validates a service name and returns its namespaced token. */
  public safeToken<T>(serviceName: string): Result<Token<T, M>, Error> {
    return validateName(serviceName).map(
      () => new Token<T, M>(`${this.fullPathValue}:${serviceName}`),
    );
  }

  /** Creates a State contract with optional wire validation. */
  public storeToken<Store extends object>(
    serviceName: string,
    options?: { validation?: StoreValidationSchemas<Store> },
  ): StoreToken<Store, M> {
    const result = this.safeStoreToken<Store>(serviceName, options);
    if (result.isErr()) throw result.error;
    return result.value;
  }

  /** Validates a State contract name without throwing expected name errors. */
  public safeStoreToken<Store extends object>(
    serviceName: string,
    options?: { validation?: StoreValidationSchemas<Store> },
  ): Result<StoreToken<Store, M>, Error> {
    return validateName(serviceName).map(
      () =>
        new StoreToken<Store, M>(
          `${this.fullPathValue}:${serviceName}`,
          options,
        ),
    );
  }

  /** Creates a child namespace inheriting only the qualified name and model. */
  public space(name: string): TokenSpace<M> {
    const result = this.safeSpace(name);
    if (result.isErr()) throw result.error;
    return result.value;
  }

  /** Returns a child namespace or a name-validation failure. */
  public safeSpace(name: string): Result<TokenSpace<M>, Error> {
    return validateName(name).map(
      () => new TokenSpace<M>({ name }, this.fullPathValue),
    );
  }
}

/** Rejects ambiguous or empty namespace segments at the construction boundary. */
function validateName(name: string): Result<void, NexusUsageError> {
  if (typeof name !== "string" || !name.trim() || name.includes(":"))
    return Result.err(
      new NexusUsageError(
        "Token name must be non-empty and cannot contain ':'.",
      ),
    );
  return Result.ok(undefined);
}
