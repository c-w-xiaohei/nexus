import { Token } from "../token";
import type { AuthorizationPolicy } from "../types/config";
import { nexus } from "../nexus";
import { NexusUsageError } from "@/errors";
import { args, fn } from "@/utils/fn";
import { z } from "zod";
import type { DefaultAdapterModel } from "@/types/adapter-model";

/**
 * @Expose 装饰器的高级选项。
 */
export type ExposeFactoryContext = {
  targetClass: new (...args: unknown[]) => object;
  token: Token<object, any>;
  localMeta?: object;
};

export interface ExposeOptions {
  /**
   * （可选）为此服务定义一个独立的授权策略。
   * 这会覆盖任何全局定义的策略。
   */
  policy?: AuthorizationPolicy<DefaultAdapterModel>;
  /**
   * （可选）提供一个工厂函数来创建服务实例。
   * 这对于需要依赖注入的场景至关重要。
   * 工厂函数会接收收窄后的 bootstrap context。
   * @returns 服务的实例或一个解析为实例的 Promise
   */
  factory?: (context: ExposeFactoryContext) => object | Promise<object>;
}

/** A deferred class declaration owned by its Nexus instance until bootstrap. */
export type ServiceRegistration = {
  token: Token<object, any>;
  targetClass: new (...args: unknown[]) => object;
  options?: ExposeOptions;
};

export type NexusClassDecorator<T extends object = object> = (
  targetClass: new (...args: unknown[]) => T,
  context: ClassDecoratorContext,
) => void;

const ExposeOptionsSchema = z
  .object({
    policy: z
      .custom<AuthorizationPolicy<DefaultAdapterModel>>(
        (value) => typeof value === "object" && value !== null,
      )
      .optional(),
    factory: z
      .custom<ExposeOptions["factory"]>((value) => typeof value === "function")
      .optional(),
  })
  .optional();

/** Validate decorator arguments before recording a deferred class registration. */
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
export function createExposeDecorator(
  register: (registration: ServiceRegistration) => void,
): <T extends object>(
  token: Token<T, any>,
  options?: ExposeOptions,
) => NexusClassDecorator<T> {
  return (token, options) => {
    const validatedInput = validateExposeInput(token, options);
    if (validatedInput.isErr()) {
      throw new NexusUsageError(
        "Nexus Error: Invalid inputs passed to @Expose decorator.",
        "E_USAGE_INVALID",
        { cause: validatedInput.error },
      );
    }

    const validatedOptions = validatedInput.value.options;

    return function (
      targetClass: new (...args: unknown[]) => object,
      context: ClassDecoratorContext,
    ) {
      if (context.kind !== "class") {
        throw new NexusUsageError(
          "Nexus Error: @Expose decorator can only be applied to classes.",
        );
      }

      // Record the class now; instantiate it when this Nexus instance bootstraps.
      register({
        token,
        targetClass,
        options: validatedOptions,
      });
    };
  };
}

/** Delegate the default Nexus instance's decorator registration to its registry. */
export function Expose<T extends object>(
  token: Token<T, any>,
  options?: ExposeOptions,
): NexusClassDecorator<T> {
  return nexus.Expose(token, options);
}
