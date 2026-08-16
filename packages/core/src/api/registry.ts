import type { IEndpoint } from "@/transport";
import type { AdapterModel } from "@/types/adapter-model";
import type { Token } from "./token";
import type { EndpointOptions } from "./decorators/endpoint";
import type { ExposeOptions } from "./decorators/expose";
import { NexusConfigurationError } from "@/errors";

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
  private readonly servicesMap = new Map<
    Token<object, any>,
    ServiceProviderData
  >();
  private readonly serviceTokenIds = new Set<string>();
  private endpoint: EndpointRegistrationData | null = null;

  public hasRegistrations(): boolean {
    return this.servicesMap.size > 0 || this.endpoint !== null;
  }

  public snapshot(): DecoratorSnapshot {
    return {
      providers: new Map(this.servicesMap),
      endpoint: this.endpoint,
    };
  }

  public registerService(
    token: Token<object, any>,
    data: ServiceProviderData,
  ): void {
    if (this.serviceTokenIds.has(token.id)) {
      throw new NexusConfigurationError(
        `Nexus: Provider for token ID "${token.id}" has already been registered on this Nexus instance.`,
        "E_DUPLICATE_PROVIDER",
        { token: token.id },
      );
    }

    this.serviceTokenIds.add(token.id);
    this.servicesMap.set(token, data);
  }

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
