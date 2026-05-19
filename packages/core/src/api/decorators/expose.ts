import { Token } from "../token";
import type { AuthorizationPolicy } from "../types/config";
import type { ServiceRegistrationData } from "../registry";
import { nexus } from "../nexus";
import { NexusUsageError } from "@/errors";
import { args, fn } from "@/utils/fn";
import { z } from "zod";
import type { UserMetadata, PlatformMetadata } from "@/types/identity";

/**
 * @Expose 装饰器的高级选项。
 */
export type ExposeFactoryContext = {
  targetClass: new (...args: unknown[]) => object;
  token: Token<object>;
  localMeta?: UserMetadata;
};

export interface ExposeOptions {
  /**
   * （可选）为此服务定义一个独立的授权策略。
   * 这会覆盖任何全局定义的策略。
   */
  policy?: AuthorizationPolicy<UserMetadata, PlatformMetadata>;
  /**
   * （可选）提供一个工厂函数来创建服务实例。
   * 这对于需要依赖注入的场景至关重要。
   * 工厂函数会接收收窄后的 bootstrap context。
   * @returns 服务的实例或一个解析为实例的 Promise
   */
  factory?: (context: ExposeFactoryContext) => object | Promise<object>;
}

export type NexusClassDecorator<T extends object = object> = (
  targetClass: new (...args: unknown[]) => T,
  context: ClassDecoratorContext,
) => void;

const ExposeOptionsSchema = z
  .object({
    policy: z
      .custom<
        AuthorizationPolicy<UserMetadata, PlatformMetadata>
      >((value) => typeof value === "object" && value !== null && ((value as AuthorizationPolicy<UserMetadata, PlatformMetadata>).canConnect === undefined || typeof (value as AuthorizationPolicy<UserMetadata, PlatformMetadata>).canConnect === "function") && ((value as AuthorizationPolicy<UserMetadata, PlatformMetadata>).canCall === undefined || typeof (value as AuthorizationPolicy<UserMetadata, PlatformMetadata>).canCall === "function"))
      .optional(),
    factory: z
      .custom<ExposeOptions["factory"]>((value) => typeof value === "function")
      .optional(),
  })
  .optional();

const validateExposeInput = fn(
  args([
    ["token", z.instanceof(Token)],
    ["options", ExposeOptionsSchema],
  ] as const),
  (token, options) => ({ token, options }),
);

/**
 * `@Expose` 装饰器，用于将一个类声明为可被远程调用的服务。
 *
 * @param token 标识此服务的 `Token` 对象。
 * @param options （可选）高级配置选项，如 `factory` 用于依赖注入。
 */
export function createExposeDecorator(registry: {
  registerService(token: Token<object>, data: ServiceRegistrationData): void;
}): <T extends object>(
  token: Token<T>,
  options?: ExposeOptions,
) => NexusClassDecorator<T> {
  return (token, options) =>
    createExposeDecoratorForRegistry(registry, token as Token<object>, options);
}

export function Expose<T extends object>(
  token: Token<T>,
  options?: ExposeOptions,
): NexusClassDecorator<T> {
  return nexus.Expose(token, options);
}

function createExposeDecoratorForRegistry(
  registry: {
    registerService(token: Token<object>, data: ServiceRegistrationData): void;
  },
  token: Token<object>,
  options?: ExposeOptions,
) {
  const validatedInput = validateExposeInput(token, options);
  if (validatedInput.isErr()) {
    throw new NexusUsageError(
      "Nexus Error: Invalid inputs passed to @Expose decorator.",
      "E_USAGE_INVALID",
      { cause: validatedInput.error },
    );
  }

  const validatedToken = token;
  const validatedOptions = validatedInput.value.options;

  return function (
    targetClass: new (...args: unknown[]) => object,
    context: ClassDecoratorContext,
  ) {
    // 标准装饰器的 context 对象提供了元信息，如 'kind'。
    // 我们可以用它来验证装饰器是否被正确地用在了类上。
    if (context.kind !== "class") {
      throw new NexusUsageError(
        "Nexus Error: @Expose decorator can only be applied to classes.",
      );
    }

    // 阶段一：仅收集注册信息到新的静态类中。
    registry.registerService(validatedToken, {
      targetClass,
      options: validatedOptions,
    });
  };
}
