import type { IEndpoint } from "@/transport";
import type { UserMetadata, PlatformMetadata } from "@/types/identity";
import type { Token } from "./token";
import type { EndpointOptions } from "./decorators/endpoint";
import type { ExposeOptions } from "./decorators/expose";

/**
 * A type-safe representation of the service registration data.
 * @internal
 */
export type ServiceRegistrationData = {
  targetClass: new (...args: unknown[]) => object;
  options?: ExposeOptions;
};

/**
 * A type-safe representation of the endpoint registration data.
 * @internal
 */
export type EndpointRegistrationData = {
  targetClass: new (
    ...args: unknown[]
  ) => IEndpoint<UserMetadata, PlatformMetadata>;
  options: EndpointOptions<UserMetadata>;
};

export namespace DecoratorRegistry {
  /**
   * Stores all services registered via the @Expose decorator.
   * Key: Service Token
   * Value: Registration data
   */
  const servicesMap = new Map<Token<object>, ServiceRegistrationData>();

  /**
   * Stores the single endpoint registered via the @Endpoint decorator.
   * There can be only one endpoint per JavaScript context.
   */
  let endpoint: EndpointRegistrationData | null = null;
  let owner: symbol | null = null;

  export type Snapshot = {
    services: ReadonlyMap<Token<object>, ServiceRegistrationData>;
    endpoint: EndpointRegistrationData | null;
  };

  export const hasRegistrations = (): boolean =>
    servicesMap.size > 0 || endpoint !== null;

  export const claim = (instanceOwner: symbol): boolean => {
    if (owner && owner !== instanceOwner) {
      return false;
    }
    owner = instanceOwner;
    return true;
  };

  export const snapshot = (): Snapshot => ({
    services: new Map(servicesMap),
    endpoint,
  });

  /**
   * Registers a service. Called by the @Expose decorator.
   * @param token The service's unique Token.
   * @param data The service's registration metadata.
   */
  export const registerService = (
    token: Token<object>,
    data: ServiceRegistrationData,
  ): void => {
    if (servicesMap.has(token)) {
      console.warn(
        `Nexus Warning: Service with token ID "${token.id}" has been registered more than once. The last registration will be used.`,
      );
    }
    servicesMap.set(token, data);
  };

  /**
   * Registers the context's endpoint. Called by the @Endpoint decorator.
   * @param data The endpoint's registration metadata.
   */
  export const registerEndpoint = (data: EndpointRegistrationData): void => {
    if (endpoint) {
      console.warn(
        "Nexus Warning: @Endpoint decorator has been used more than once. Only one Endpoint can be defined per JavaScript context. The last registration will be used.",
      );
    }
    endpoint = data;
  };

  /**
   * Resets the registry to its initial state.
   * This is crucial for ensuring test isolation.
   * @internal
   */
  export const clear = (): void => {
    servicesMap.clear();
    endpoint = null;
    owner = null;
  };
}
