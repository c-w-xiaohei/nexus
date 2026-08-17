import type { AdapterModel, ConnectionTargetOf } from "@/types/adapter-model";
import { NexusUsageError } from "@/errors";
import { isPlainTarget, Token, type TokenOptions } from "./token";
import { Result } from "better-result";
const { err, ok } = Result;

export interface TokenSpaceConfig<M extends AdapterModel> {
  name: string;
  defaultTarget?: ConnectionTargetOf<M>;
}

export type TokenSpaceDefaultTarget<M extends AdapterModel> =
  ConnectionTargetOf<M>;

export interface ChildTokenSpaceConfig<M extends AdapterModel> {
  defaultTarget?: ConnectionTargetOf<M>;
}

export class TokenSpace<M extends AdapterModel> {
  private readonly fullPathValue: string;
  private readonly defaultTargetValue?: ConnectionTargetOf<M>;

  constructor(config: TokenSpaceConfig<M>, parentPath?: string) {
    if (!config.name.trim() || config.name.includes(":")) {
      throw new NexusUsageError(
        "TokenSpace name must be non-empty and cannot contain ':'.",
      );
    }
    if (
      config.defaultTarget !== undefined &&
      !isPlainTarget(config.defaultTarget)
    ) {
      throw new NexusUsageError(
        "TokenSpace defaultTarget must be a plain object.",
        "E_USAGE_INVALID",
      );
    }
    this.fullPathValue = parentPath
      ? `${parentPath}:${config.name}`
      : config.name;
    this.defaultTargetValue = config.defaultTarget ?? undefined;
  }

  public get name(): string {
    return this.fullPathValue.split(":").at(-1)!;
  }

  public get fullPath(): string {
    return this.fullPathValue;
  }

  public get defaultTarget(): ConnectionTargetOf<M> | undefined {
    return this.defaultTargetValue;
  }

  public token<T>(serviceName: string, options?: TokenOptions<M>): Token<T, M> {
    return this.safeToken(serviceName, options).match({
      ok: (token) => token as Token<T, M>,
      err: (error) => {
        throw error;
      },
    });
  }

  public safeToken<T>(
    serviceName: string,
    options?: TokenOptions<M>,
  ): Result<Token<T, M>, Error> {
    if (!serviceName.trim() || serviceName.includes(":")) {
      return err(
        new NexusUsageError(
          "Token name must be non-empty and cannot contain ':'.",
        ),
      );
    }
    try {
      return ok(
        new Token<T, M>(`${this.fullPathValue}:${serviceName}`, {
          defaultTarget: options?.defaultTarget ?? this.defaultTargetValue,
        } as M extends AdapterModel ? TokenOptions<M> : never),
      );
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  public space(name: string, config?: ChildTokenSpaceConfig<M>): TokenSpace<M> {
    return this.safeSpace(name, config).match({
      ok: (space) => space,
      err: (error) => {
        throw error;
      },
    });
  }

  public safeSpace(
    name: string,
    config?: ChildTokenSpaceConfig<M>,
  ): Result<TokenSpace<M>, Error> {
    try {
      return ok(
        new TokenSpace<M>(
          {
            name,
            defaultTarget: Object.hasOwn(config ?? {}, "defaultTarget")
              ? config?.defaultTarget
              : this.defaultTargetValue,
          },
          this.fullPathValue,
        ),
      );
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
