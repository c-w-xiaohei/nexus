import type {
  AdapterModel,
  ConnectionTargetOf,
  ContextMetaOf,
} from "@/types/adapter-model";
import type { IEndpoint } from "@/transport";
import type { EndpointRegistrationData } from "../registry";
import { nexus } from "../nexus";
import { NexusUsageError } from "@/errors";
import { fn } from "@/utils/fn";
import { isPlainTarget } from "../token";
import { z } from "zod";

/**
 * `@Endpoint` 装饰器的配置选项
 */
export interface EndpointOptions<M extends AdapterModel> {
  /**
   * 当前端点的业务身份。
   */
  meta: ContextMetaOf<M>;
  /**
   * (可选) create() 未指定目标时使用的精确默认目标。
   */
  defaultTarget?: ConnectionTargetOf<M>;
}

const EndpointOptionsSchema = z.object({
  meta: z.custom<object>(
    (value) => typeof value === "object" && value !== null,
  ),
  defaultTarget: z.custom<object>(isPlainTarget).optional(),
});

const validateEndpointOptions = fn(EndpointOptionsSchema, (input) => input);

export type NexusEndpointDecorator<M extends AdapterModel = AdapterModel> = (
  targetClass: new (...args: unknown[]) => IEndpoint<M>,
  context: ClassDecoratorContext,
) => void;

/**
 * `@Endpoint` 装饰器，用于将一个类声明为当前上下文的通信端点。
 * 它将端点的身份、默认服务出口和平台实现内聚在一起。
 *
 * @param options 配置选项，包含 `meta` 和可选的 `defaultTarget`。
 */
export function createEndpointDecorator(registry: {
  registerEndpoint(data: EndpointRegistrationData): void;
}): <M extends AdapterModel>(
  options: EndpointOptions<M>,
) => NexusEndpointDecorator<M> {
  return (options) => createEndpointDecoratorForRegistry(registry, options);
}

export function Endpoint<M extends AdapterModel>(
  options: EndpointOptions<M>,
): NexusEndpointDecorator<M> {
  return nexus.Endpoint(options);
}

function createEndpointDecoratorForRegistry<M extends AdapterModel>(
  registry: { registerEndpoint(data: EndpointRegistrationData): void },
  options: EndpointOptions<M>,
) {
  if (
    options.defaultTarget !== undefined &&
    !isPlainTarget(options.defaultTarget)
  ) {
    throw new NexusUsageError(
      "Nexus Error: Invalid options passed to @Endpoint decorator.",
      "E_USAGE_INVALID",
    );
  }
  const validatedOptions = validateEndpointOptions({
    ...options,
    defaultTarget:
      options.defaultTarget === undefined
        ? undefined
        : { ...options.defaultTarget },
  });
  if (validatedOptions.isErr()) {
    throw new NexusUsageError(
      "Nexus Error: Invalid options passed to @Endpoint decorator.",
      "E_USAGE_INVALID",
      { cause: validatedOptions.error },
    );
  }

  return function (
    targetClass: new (...args: unknown[]) => IEndpoint<M>,
    context: ClassDecoratorContext,
  ) {
    if (context.kind !== "class") {
      throw new NexusUsageError(
        "Nexus Error: @Endpoint decorator can only be applied to classes.",
      );
    }

    // 阶段一：仅收集注册意图到新的静态类中。
    registry.registerEndpoint({
      targetClass,
      options: validatedOptions.value as EndpointOptions<M>,
    });
  };
}
