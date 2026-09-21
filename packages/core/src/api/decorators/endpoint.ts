import type {
  AdapterModel,
  ConnectionTargetOf,
  ContextMetaOf,
} from "@/types/adapter-model";
import type { IEndpoint } from "@/transport";
import { nexus } from "../nexus";
import { NexusUsageError } from "@/errors";
import { fn } from "@/utils/fn";
import { isPlainTarget } from "../token";
import { custom, optional, strictObject } from "valibot";

/**
 * `@Endpoint` 装饰器的配置选项
 */
export interface EndpointOptions<M extends AdapterModel> {
  /**
   * 当前端点的业务身份。
   */
  meta: ContextMetaOf<M>;
  /** One-shot startup connections, independent of service acquisition and ready(). */
  connectTo?: readonly ConnectionTargetOf<M>[];
}

const EndpointOptionsSchema = strictObject({
  meta: custom<object>((value) => typeof value === "object" && value !== null),
  connectTo: optional(
    custom<readonly object[]>(
      (value) => Array.isArray(value) && value.every(isPlainTarget),
    ),
  ),
});

/** Validates endpoint registration before its metadata snapshot is captured. */
const validateEndpointOptions = fn(EndpointOptionsSchema, (input) => input);

export type NexusEndpointDecorator<M extends AdapterModel = AdapterModel> = (
  targetClass: new (...args: unknown[]) => IEndpoint<M>,
  context: ClassDecoratorContext,
) => void;

/** A deferred endpoint declaration; Nexus owns its registration window. */
export type EndpointRegistration<M extends AdapterModel = AdapterModel> = {
  targetClass: new (...args: unknown[]) => IEndpoint<M>;
  options: EndpointOptions<M>;
};

/**
 * `@Endpoint` 装饰器，用于将一个类声明为当前上下文的通信端点。
 * 它将端点的身份、启动连接和平台实现内聚在一起。
 *
 * @param register 当前 Nexus 实例的声明写入入口。
 */
export function createEndpointDecorator(
  register: (registration: EndpointRegistration) => void,
): <M extends AdapterModel>(
  options: EndpointOptions<M>,
) => NexusEndpointDecorator<M> {
  /** Captures validated endpoint configuration for the next class registration. */
  return <M extends AdapterModel>(options: EndpointOptions<M>) => {
    // Validate the original target before copying it: cloning a class instance
    // would hide an invalid target's prototype from the schema.
    const validatedOptions = validateEndpointOptions(options);
    if (validatedOptions.isErr()) {
      throw new NexusUsageError(
        "Nexus Error: Invalid options passed to @Endpoint decorator.",
        "E_USAGE_INVALID",
        { cause: validatedOptions.error },
      );
    }

    const registrationOptions = {
      ...validatedOptions.value,
    } as EndpointOptions<M>;
    if (registrationOptions.connectTo !== undefined) {
      registrationOptions.connectTo = Object.freeze([
        ...registrationOptions.connectTo,
      ]);
    }

    /** Records the class; construction remains owned by the bootstrap snapshot. */
    return function (
      targetClass: new (...args: unknown[]) => IEndpoint<M>,
      context: ClassDecoratorContext,
    ) {
      if (context.kind !== "class") {
        throw new NexusUsageError(
          "Nexus Error: @Endpoint decorator can only be applied to classes.",
        );
      }

      // Collect registration only; instantiate the endpoint at bootstrap.
      register({
        targetClass,
        options: registrationOptions,
      });
    };
  };
}

/** Registers an endpoint on the default Nexus singleton. */
export function Endpoint<M extends AdapterModel>(
  options: EndpointOptions<M>,
): NexusEndpointDecorator<M> {
  return nexus.Endpoint(options);
}
