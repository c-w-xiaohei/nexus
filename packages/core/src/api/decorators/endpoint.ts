import type { UserMetadata } from "@/types/identity";
import type { IEndpoint } from "@/transport";
import type { ConnectToTarget } from "../types/config";
import { DecoratorRegistry } from "../registry";

/**
 * `@Endpoint` 装饰器的配置选项
 */
export interface EndpointOptions<U extends UserMetadata> {
  /**
   * 当前端点的业务身份。
   */
  meta: U;
  /**
   * (可选) 声明此端点在初始化时应主动连接的目标。
   */
  connectTo?: ConnectToTarget<U, string, string>[];
}

/**
 * `@Endpoint` 装饰器，用于将一个类声明为当前上下文的通信端点。
 * 它将端点的身份 (`meta`)、连接行为 (`connectTo`) 和平台实现 (`IEndpoint` 类) 内聚在一起。
 *
 * @param options 配置选项，包含 `meta` 和可选的 `connectTo`。
 */
export function Endpoint<U extends UserMetadata>(options: EndpointOptions<U>) {
  return function (
    targetClass: new (...args: any[]) => IEndpoint<U, any>,
    context: ClassDecoratorContext
  ) {
    if (context.kind !== "class") {
      throw new Error(
        "Nexus Error: @Endpoint decorator can only be applied to classes."
      );
    }

    // 阶段一：仅收集注册意图到新的静态类中。
    DecoratorRegistry.registerEndpoint({ targetClass, options });
  };
}
