import type { EndpointMeta, PlatformMeta } from "../types/identity.js";
import { ConnectionManager } from "../connection/connection-manager.js";
import type {
  ConnectionManagerConfig,
  ConnectionManagerHandlers,
} from "../connection/types.js";
import { Engine } from "../service/engine.js";
import type { NexusConfig, ServiceProvider } from "./types/config.js";
import type { Token } from "./token.js";
import { Transport } from "../transport/index.js";
import type { NexusMessage } from "../types/message.js";
import type {
  EndpointRegistrationData,
  ServiceProviderData,
} from "./registry.js";
import { NexusConfigurationError } from "../errors/index.js";
import { TargetResolver } from "./target-resolver.js";
import { Result } from "better-result";
const { err, ok } = Result;

/**
 * A type that represents the assembled L1-L3 kernel components.
 */
export interface NexusKernel<U extends EndpointMeta, P extends PlatformMeta> {
  engine: Engine<U, P>;
  connectionManager: ConnectionManager<U, P>;
}

export namespace NexusKernelBuilder {
  export interface Runtime<U extends EndpointMeta, P extends PlatformMeta> {
    build(): Promise<
      Result<
        {
          engine: Engine<U, P>;
          connectionManager: ConnectionManager<U, P>;
        },
        Error
      >
    >;
  }

  export const create = <U extends EndpointMeta, P extends PlatformMeta>(
    initialConfig: NexusConfig<U, P, string, string>,
    serviceRegistry: ReadonlyMap<Token<object, any>, ServiceProviderData>,
    endpointRegistration: EndpointRegistrationData | null,
    _nexusInstance: unknown,
    namedMatchers: ReadonlyMap<string, (identity: U) => boolean>,
    namedDescriptors: ReadonlyMap<string, Partial<U>>,
  ): Runtime<U, P> => {
    const bootstrapConfig = async (): Promise<
      NexusConfig<U, P, string, string>
    > => {
      let finalConfig = initialConfig;

      const hasExplicitEndpoint = finalConfig.endpoint !== undefined;
      if (endpointRegistration && hasExplicitEndpoint) {
        throw new NexusConfigurationError(
          "Nexus: configure({ endpoint }) and @nexus.Endpoint(...) cannot both define the bootstrap endpoint.",
          "E_ENDPOINT_SOURCE_CONFLICT",
        );
      }

      if (endpointRegistration) {
        const { targetClass, options } = endpointRegistration;
        const implementation = new targetClass();
        const endpointConfig = {
          endpoint: {
            implementation,
            meta: options.meta,
            connectTo: options.connectTo,
          },
        } as NexusConfig<U, P, string, string>;
        finalConfig = {
          ...finalConfig,
          endpoint: {
            ...(finalConfig.endpoint ?? {}),
            ...endpointConfig.endpoint,
          },
        };
      }

      const decoratedServices: ServiceProvider<object, U, P>[] = [];
      const factoryPromises: Promise<void>[] = [];

      for (const [
        token,
        { targetClass, options },
      ] of serviceRegistry.entries()) {
        const createInstance = async () => {
          let service: object;
          if (options?.factory) {
            service = await Promise.resolve(
              options.factory({
                targetClass,
                token,
                localMeta: finalConfig.endpoint?.meta,
              }),
            );
          } else {
            service = new targetClass();
          }
          decoratedServices.push({
            token,
            service,
            policy: options?.policy,
          } as ServiceProvider<object, U, P>);
        };
        factoryPromises.push(createInstance());
      }

      await Promise.all(factoryPromises);

      if (decoratedServices.length > 0) {
        finalConfig = {
          ...finalConfig,
          providers: [...(finalConfig.providers ?? []), ...decoratedServices],
        };
      }

      return finalConfig;
    };

    const build = (): Promise<
      Result<
        {
          engine: Engine<U, P>;
          connectionManager: ConnectionManager<U, P>;
        },
        Error
      >
    > =>
      Result.tryPromise({
        try: bootstrapConfig,
        catch: (error) =>
          error instanceof Error ? error : new Error(String(error)),
      }).then((bootstrapResult) =>
        bootstrapResult.andThenAsync(async (finalConfig) => {
          if (
            !finalConfig.endpoint?.implementation ||
            !finalConfig.endpoint?.meta
          ) {
            return err(
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

              void engineRef.current
                .safeOnMessage(message, sourceConnectionId)
                .then((result) =>
                  result.match({ ok: () => undefined, err: () => undefined }),
                );
            },
            onDisconnect: (connectionId: string) => {
              engineRef.current?.onDisconnect(connectionId);
            },
            onIdentityUpdated: (connectionId, newIdentity, oldIdentity) => {
              if (JSON.stringify(newIdentity) === JSON.stringify(oldIdentity)) {
                return;
              }

              engineRef.current?.onConnectionTargetStale(
                connectionId,
                newIdentity,
                oldIdentity,
              );
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
              return err(resolved.error);
            }

            if (!resolved.value.descriptor) {
              return err(
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
            policy: finalConfig.policy,
          };

          const transport = Transport.create(
            finalConfig.endpoint.implementation,
          );

          const connectionManager = new ConnectionManager<U, P>(
            cmConfig,
            transport,
            handlers,
            finalConfig.endpoint.meta,
          );

          const servicesForEngine: {
            providers?: Record<
              string,
              {
                service: object;
                policy?: ServiceProvider<object, U, P>["policy"];
              }
            >;
          } = {};
          if (finalConfig.providers) {
            servicesForEngine.providers = finalConfig.providers.reduce<
              NonNullable<typeof servicesForEngine.providers>
            >((acc, reg) => {
              acc[reg.token.id] = {
                service: reg.service,
                policy: reg.policy,
              };
              return acc;
            }, {});
          }

          const engine = new Engine<U, P>(connectionManager, {
            ...servicesForEngine,
            policy: finalConfig.policy,
          });
          engineRef.current = engine;

          return ok({ engine, connectionManager });
        }),
      );

    return { build };
  };
}
