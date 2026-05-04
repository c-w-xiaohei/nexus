import { NexusUsageError } from "@/errors";
import type { TargetCriteria, TokenCreateDefaults } from "./types/config";
import type { UserMetadata } from "@/types/identity";

export interface TokenOptions<
  U extends UserMetadata = UserMetadata,
  M extends string = never,
  D extends string = never,
> {
  defaultCreate?: TokenCreateDefaults<U, M, D> | null;
}

/**
 * 一个类型安全的、用于在运行时识别服务的标识符。
 * 它的设计核心是分离“编译时形状”与“运行时身份”。
 *
 * @template T 服务的接口（形状）类型。
 */
export class Token<
  T,
  U extends UserMetadata = UserMetadata,
  M extends string = never,
  D extends string = never,
> {
  declare readonly __shape?: T;
  declare readonly __metadata?: U;

  public readonly id: string;
  public readonly defaultCreate?: TokenCreateDefaults<U, M, D>;

  /**
   * @deprecated Use defaultCreate.target.
   */
  public readonly defaultTarget?: TargetCriteria<U, M, D>;

  /**
   * @param id 一个在整个应用中用于标识此服务的唯一字符串 ID。
   * @param defaultTarget (可选) 为此令牌预设一个默认的寻址目标。
   *                      这能极大地简化 `nexus.create` 的调用。
   */
  constructor(
    id: string,
    optionsOrLegacyTarget?: TokenOptions<U, M, D> | TargetCriteria<U, M, D>,
  ) {
    this.id = id;
    const defaultCreate = normalizeTokenDefaults(optionsOrLegacyTarget);
    this.defaultCreate = defaultCreate ?? undefined;
    this.defaultTarget = defaultCreate?.target;
  }
}

function normalizeTokenDefaults<
  U extends UserMetadata,
  M extends string,
  D extends string,
>(
  optionsOrLegacyTarget?: TokenOptions<U, M, D> | TargetCriteria<U, M, D>,
): TokenCreateDefaults<U, M, D> | undefined {
  if (!optionsOrLegacyTarget) {
    return undefined;
  }

  const input = optionsOrLegacyTarget as Record<string, unknown>;
  const hasDefaultCreate = Object.hasOwn(input, "defaultCreate");
  const hasLegacyTarget =
    Object.hasOwn(input, "descriptor") || Object.hasOwn(input, "matcher");

  if (hasDefaultCreate) {
    const defaultCreate = (optionsOrLegacyTarget as TokenOptions<U, M, D>)
      .defaultCreate;
    validateDefaultCreateTarget(defaultCreate?.target);

    if (hasLegacyTarget) {
      throw new NexusUsageError(
        "Token options cannot mix legacy target shape with defaultCreate.",
        "E_USAGE_DEFAULT_CREATE_CONFLICT",
      );
    }

    return defaultCreate ?? undefined;
  }

  if (Object.hasOwn(input, "expects")) {
    throw new NexusUsageError(
      "Token default target cannot include expects; pass expects at the create() call-site.",
      "E_USAGE_DEFAULT_CREATE_CONFLICT",
    );
  }

  const invalidKeys = Object.keys(input).filter(
    (key) => key !== "descriptor" && key !== "matcher",
  );
  if (invalidKeys.length > 0) {
    throw new NexusUsageError(
      `Token legacy default target only supports descriptor and matcher; invalid key(s): ${invalidKeys.join(", ")}.`,
      "E_USAGE_DEFAULT_CREATE_CONFLICT",
    );
  }

  return { target: optionsOrLegacyTarget as TargetCriteria<U, M, D> };
}

export function validateDefaultCreateTarget(target: unknown): void {
  if (target === null || typeof target === "undefined") {
    return;
  }

  if (typeof target !== "object" || Array.isArray(target)) {
    throw new NexusUsageError(
      "defaultCreate.target must be a plain object when provided.",
      "E_USAGE_DEFAULT_CREATE_CONFLICT",
    );
  }

  const invalidKeys = Object.keys(target).filter(
    (key) => key !== "descriptor" && key !== "matcher",
  );
  if (invalidKeys.length > 0) {
    throw new NexusUsageError(
      `defaultCreate.target only supports descriptor and matcher; invalid key(s): ${invalidKeys.join(", ")}. Pass expects and timeout at the create() call-site.`,
      "E_USAGE_DEFAULT_CREATE_CONFLICT",
    );
  }
}
