import type { IEndpoint } from "@/transport";
import type { Token } from "./token";
import type { EndpointOptions } from "./decorators/endpoint";
import type { ExposeOptions } from "./decorators/expose";

/**
 * A type-safe representation of the service registration data.
 * @internal
 */
export type ServiceRegistrationData = {
  targetClass: new (...args: any[]) => any;
  options?: ExposeOptions;
};

/**
 * A type-safe representation of the endpoint registration data.
 * @internal
 */
export type EndpointRegistrationData = {
  targetClass: new (...args: any[]) => IEndpoint<any, any>;
  options: EndpointOptions<any>;
};

/**
 * A centralized, static registry for all decorator-based registrations.
 * This class follows the pattern seen in libraries like TypeDI, where decorators
 * populate a central registry at module load time.
 */
export class DecoratorRegistry {
  /**
   * Stores all services registered via the @Expose decorator.
   * Key: Service Token
   * Value: Registration data
   */
  public static readonly services = new Map<
    Token<any>,
    ServiceRegistrationData
  >();

  /**
   * Stores the single endpoint registered via the @Endpoint decorator.
   * There can be only one endpoint per JavaScript context.
   */
  public static endpoint: EndpointRegistrationData | null = null;

  /**
   * Registers a service. Called by the @Expose decorator.
   * @param token The service's unique Token.
   * @param data The service's registration metadata.
   */
  public static registerService(
    token: Token<any>,
    data: ServiceRegistrationData
  ): void {
    if (this.services.has(token)) {
      console.warn(
        `Nexus Warning: Service with token ID "${token.id}" has been registered more than once. The last registration will be used.`
      );
    }
    this.services.set(token, data);
  }

  /**
   * Registers the context's endpoint. Called by the @Endpoint decorator.
   * @param data The endpoint's registration metadata.
   */
  public static registerEndpoint(data: EndpointRegistrationData): void {
    if (this.endpoint) {
      console.warn(
        `Nexus Warning: @Endpoint decorator has been used more than once. Only one Endpoint can be defined per JavaScript context. The last registration will be used.`
      );
    }
    this.endpoint = data;
  }

  /**
   * Resets the registry to its initial state.
   * This is crucial for ensuring test isolation.
   * @internal
   */
  public static clear(): void {
    this.services.clear();
    this.endpoint = null;
  }
}
