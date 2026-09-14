import type { IEndpoint } from "@/transport";
import type { AdapterModel } from "@/types/adapter-model";
import type { Token } from "./token";
import type { EndpointOptions } from "./decorators/endpoint";
import type { ExposeOptions } from "./decorators/expose";
import { NexusConfigurationError } from "@/errors";
import { snapshotEndpoint } from "./types/config";

/**
 * A type-safe representation of the service registration data.
 * @internal
 */
export type ServiceProviderData = {
  targetClass: new (...args: unknown[]) => object;
  options?: ExposeOptions;
};

/**
 * A type-safe representation of the endpoint registration data.
 * @internal
 */
export type EndpointRegistrationData<M extends AdapterModel = AdapterModel> = {
  targetClass: new (...args: unknown[]) => IEndpoint<M>;
  options: EndpointOptions<M>;
};

export type DecoratorSnapshot<M extends AdapterModel = AdapterModel> = {
  providers: ReadonlyMap<Token<object, any>, ServiceProviderData>;
  endpoint: EndpointRegistrationData<M> | null;
};

export class InstanceDecoratorRegistry {
  // Token IDs define provider identity; retain the Token for factory injection.
  private readonly services = new Map<
    string,
    {
      token: Token<object, any>;
      data: ServiceProviderData;
    }
  >();
  private endpoint: EndpointRegistrationData | null = null;

  /** Return a detached bootstrap snapshot so later registrations cannot mutate it. */
  public snapshot(): DecoratorSnapshot {
    return {
      providers: new Map(
        [...this.services.values()].map(({ token, data }) => [token, data]),
      ),
      endpoint: this.endpoint
        ? {
            targetClass: this.endpoint.targetClass,
            options: snapshotEndpoint(this.endpoint.options),
          }
        : null,
    };
  }

  /** Register one token's class and reject duplicate IDs before bootstrap. */
  public registerService(
    token: Token<object, any>,
    data: ServiceProviderData,
  ): void {
    if (this.services.has(token.id)) {
      throw new NexusConfigurationError(
        `Nexus: Provider for token ID "${token.id}" has already been registered on this Nexus instance.`,
        "E_DUPLICATE_PROVIDER",
        { token: token.id },
      );
    }

    this.services.set(token.id, { token, data });
  }

  /** Register the sole decorator-provided endpoint, rejecting competing sources. */
  public registerEndpoint(data: EndpointRegistrationData): void {
    if (this.endpoint) {
      throw new NexusConfigurationError(
        "Nexus: @Endpoint decorator has already been registered on this Nexus instance.",
        "E_ENDPOINT_SOURCE_CONFLICT",
      );
    }
    this.endpoint = data;
  }
}
