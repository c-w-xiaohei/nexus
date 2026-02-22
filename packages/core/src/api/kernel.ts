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
import { NexusConfigurationError } from "@/errors";
import { TargetResolver } from "./target-resolver";
import { ResultAsync, errAsync, okAsync } from "neverthrow";

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

export namespace NexusKernelBuilder {
  export interface Runtime<U extends UserMetadata, P extends PlatformMetadata> {
    build(): ResultAsync<
      {
        engine: Engine<U, P>;
        connectionManager: ConnectionManager<U, P>;
      },
      Error
    >;
  }

  export const create = <U extends UserMetadata, P extends PlatformMetadata>(
    initialConfig: NexusConfig<U, P, string, string>,
    serviceRegistry: ReadonlyMap<Token<object>, ServiceRegistrationData>,
    endpointRegistration: EndpointRegistrationData | null,
    nexusInstance: NexusInstance<U, P, string, string>,
    namedMatchers: ReadonlyMap<string, (identity: U) => boolean>,
    namedDescriptors: ReadonlyMap<string, Partial<U>>,
  ): Runtime<U, P> => {
    const bootstrapConfig = async (): Promise<
      NexusConfig<U, P, string, string>
    > => {
      let finalConfig = initialConfig;

      if (endpointRegistration) {
        const { targetClass, options } = endpointRegistration;
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

      const decoratedServices: ServiceRegistration<object>[] = [];
      const factoryPromises: Promise<void>[] = [];

      for (const [
        token,
        { targetClass, options },
      ] of serviceRegistry.entries()) {
        const createInstance = async () => {
          let implementation: object;
          if (options?.factory) {
            implementation = await Promise.resolve(
              options.factory(nexusInstance as NexusInstance),
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
    };

    const build = (): ResultAsync<
      {
        engine: Engine<U, P>;
        connectionManager: ConnectionManager<U, P>;
      },
      Error
    > =>
      ResultAsync.fromPromise(bootstrapConfig(), (error) =>
        error instanceof Error ? error : new Error(String(error)),
      ).andThen((finalConfig) => {
        if (
          !finalConfig.endpoint?.implementation ||
          !finalConfig.endpoint?.meta
        ) {
          return errAsync(
            new NexusConfigurationError(
              "Nexus initialization failed: Endpoint 'implementation' and 'meta' must be provided in the configuration, either via nexus.configure() or the @Endpoint decorator.",
            ),
          );
        }

        const engineRef: { current: Engine<U, P> | null } = {
          current: null,
        };

        const handlers: ConnectionManagerHandlers<U, P> = {
          onMessage: (message: NexusMessage, sourceConnectionId: string) => {
            if (!engineRef.current) {
              return;
            }

            return engineRef.current
              .safeOnMessage(message, sourceConnectionId)
              .match(
                () => undefined,
                () => undefined,
              );
          },
          onDisconnect: (connectionId: string) => {
            engineRef.current?.onDisconnect(connectionId);
          },
        };

        const resolvedConnectTo: NonNullable<
          ConnectionManagerConfig<U, P>["connectTo"]
        > = [];

        for (const target of finalConfig.endpoint.connectTo ?? []) {
          const resolved = TargetResolver.resolveNamedTarget(
            target,
            namedDescriptors,
            namedMatchers,
            "in connectTo",
          );
          if (resolved.isErr()) {
            return errAsync(resolved.error);
          }

          if (!resolved.value.descriptor) {
            return errAsync(
              new NexusConfigurationError(
                "Nexus: connectTo targets must include a descriptor.",
              ),
            );
          }

          resolvedConnectTo.push(
            resolved.value.matcher
              ? {
                  descriptor: resolved.value.descriptor,
                  matcher: resolved.value.matcher,
                }
              : {
                  descriptor: resolved.value.descriptor,
                },
          );
        }

        const cmConfig: ConnectionManagerConfig<U, P> = {
          connectTo:
            resolvedConnectTo.length > 0 ? resolvedConnectTo : undefined,
        };

        const transport = Transport.create(finalConfig.endpoint.implementation);

        const connectionManager = new ConnectionManager<U, P>(
          cmConfig,
          transport,
          handlers,
          finalConfig.endpoint.meta,
        );

        const servicesForEngine: { services?: Record<string, object> } = {};
        if (finalConfig.services) {
          servicesForEngine.services = finalConfig.services.reduce(
            (acc: Record<string, object>, reg: ServiceRegistration<object>) => {
              acc[reg.token.id] = reg.implementation;
              return acc;
            },
            {},
          );
        }

        const engine = new Engine(connectionManager, servicesForEngine);
        engineRef.current = engine;

        return okAsync({ engine, connectionManager });
      });

    return { build };
  };
}
