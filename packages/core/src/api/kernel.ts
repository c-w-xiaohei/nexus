import type { UserMetadata, PlatformMetadata } from "@/types/identity";
import { ConnectionManager } from "@/connection/connection-manager";
import type {
  ConnectionManagerConfig,
  ConnectionManagerHandlers,
} from "@/connection/types";
import { Engine } from "@/service/engine";
import type { NexusConfig, ServiceRegistration } from "./types/config";
import { merge } from "es-toolkit";
import type { Token } from "./token";
import { Transport } from "@/transport";
import type { NexusInstance } from "./types";
import type { NexusMessage } from "@/types/message";
import type {
  EndpointRegistrationData,
  ServiceRegistrationData,
} from "./registry";

/**
 * A type that represents the assembled L1-L3 kernel components.
 */
export interface NexusKernel<
  U extends UserMetadata,
  P extends PlatformMetadata,
> {
  engine: Engine<U, P>;
  connectionManager: ConnectionManager<U, P>;
}

/**
 * Nexus kernel builder.
 * This is a highly cohesive class that encapsulates the complex logic of
 * building and connecting all core components of L1-L3 from configuration and decorator registration information.
 */
export class NexusKernelBuilder<
  U extends UserMetadata,
  P extends PlatformMetadata,
> {
  constructor(
    private readonly initialConfig: NexusConfig<U, P, any, any>,
    private readonly serviceRegistry: Map<Token<any>, ServiceRegistrationData>,
    private readonly endpointRegistration: EndpointRegistrationData | null,
    private readonly nexusInstance: NexusInstance<U, P, any, any>,
    private readonly namedMatchers: Map<string, (identity: U) => boolean>,
    private readonly namedDescriptors: Map<string, Partial<U>>
  ) {}

  /**
   * Execute the complete kernel build process.
   * @returns A Promise containing engine and connectionManager.
   */
  public async build(): Promise<{
    engine: Engine<U, P>;
    connectionManager: ConnectionManager<U, P>;
  }> {
    // 1. Bootstrap final configuration from decorators
    const finalConfig = await this._bootstrapConfig();

    // 2. Validate final configuration
    if (!finalConfig.endpoint?.implementation || !finalConfig.endpoint?.meta) {
      throw new Error(
        "Nexus initialization failed: Endpoint 'implementation' and 'meta' must be provided in the configuration, either via nexus.configure() or the @Endpoint decorator."
      );
    }

    // 3. Instantiate all L1-L3 components (restore correct instantiation logic)
    let engine: Engine<U, P>;

    const handlers: ConnectionManagerHandlers<U, P> = {
      onMessage: (message: NexusMessage, sourceConnectionId: string) => {
        engine.onMessage(message, sourceConnectionId);
      },
      onDisconnect: (connectionId: string) => {
        engine.onDisconnect(connectionId);
      },
    };

    // --- Added: resolve connectTo ---
    const resolvedConnectTo = finalConfig.endpoint.connectTo?.map((target) => {
      const { descriptor: descriptorOrName, matcher: matcherOrName } = target;

      const descriptor =
        typeof descriptorOrName === "string"
          ? this.namedDescriptors.get(descriptorOrName)
          : descriptorOrName;

      const matcher =
        typeof matcherOrName === "string"
          ? this.namedMatchers.get(matcherOrName)
          : matcherOrName;

      if (
        descriptorOrName &&
        typeof descriptorOrName === "string" &&
        !descriptor
      ) {
        throw new Error(
          `Nexus: Descriptor with name "${descriptorOrName}" not found in connectTo.`
        );
      }
      if (matcherOrName && typeof matcherOrName === "string" && !matcher) {
        throw new Error(
          `Nexus: Matcher with name "${matcherOrName}" not found in connectTo.`
        );
      }

      return { descriptor, matcher };
    });
    // --- Resolution complete ---

    const cmConfig: ConnectionManagerConfig<U, P> = {
      connectTo: resolvedConnectTo,
    };

    const transport = new Transport(finalConfig.endpoint.implementation);

    const connectionManager = new ConnectionManager(
      cmConfig,
      transport,
      handlers,
      finalConfig.endpoint.meta
    );

    const servicesForEngine: { services?: Record<string, object> } = {};
    if (finalConfig.services) {
      servicesForEngine.services = finalConfig.services.reduce(
        (acc: Record<string, object>, reg: ServiceRegistration<any>) => {
          acc[reg.token.id] = reg.implementation;
          return acc;
        },
        {}
      );
    }

    engine = new Engine(connectionManager, servicesForEngine);

    return { engine, connectionManager };
  }

  /**
   * (New) Handle all registration information from decorators and merge with initial configuration.
   * This is logic moved from the Nexus class.
   * @returns Final, complete configuration object.
   */
  private async _bootstrapConfig(): Promise<NexusConfig<U, P, any, any>> {
    let finalConfig = this.initialConfig;

    // Bootstrap @Endpoint decorator
    if (this.endpointRegistration) {
      const { targetClass, options } = this.endpointRegistration;
      const implementation = new targetClass();
      const endpointConfig = {
        endpoint: {
          implementation,
          meta: options.meta,
          connectTo: options.connectTo,
        },
      };
      finalConfig = merge(finalConfig, endpointConfig);
    }

    // Bootstrap @Expose decorator
    const decoratedServices: ServiceRegistration<any>[] = [];
    const factoryPromises: Promise<void>[] = [];

    for (const [
      token,
      { targetClass, options },
    ] of this.serviceRegistry.entries()) {
      const createInstance = async () => {
        let implementation: object;
        if (options?.factory) {
          implementation = await Promise.resolve(
            options.factory(this.nexusInstance)
          );
        } else {
          implementation = new targetClass();
        }
        decoratedServices.push({
          token,
          implementation,
          policy: options?.policy,
        });
      };
      factoryPromises.push(createInstance());
    }

    await Promise.all(factoryPromises);

    if (decoratedServices.length > 0) {
      const serviceConfig = { services: decoratedServices };
      finalConfig = merge(finalConfig, serviceConfig);
    }

    return finalConfig;
  }
}
