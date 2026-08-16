import { ConnectionManager } from "@/connection/connection-manager";
import type {
  ConnectionManagerConfig,
  ConnectionManagerHandlers,
} from "@/connection/types";
import { NexusConfigurationError } from "@/errors";
import { Engine } from "@/service/engine";
import { Transport } from "@/transport";
import type { AdapterModel } from "@/types/adapter-model";
import type { NexusMessage } from "@/types/message";
import { Result } from "better-result";
const { err, ok } = Result;
import type { EndpointRegistrationData, ServiceProviderData } from "./registry";
import type { NexusConfig, ServiceProvider } from "./types/config";
import type { Token } from "./token";

export namespace NexusKernelBuilder {
  export interface Runtime<M extends AdapterModel> {
    build(): Promise<
      Result<
        { engine: Engine<M>; connectionManager: ConnectionManager<M> },
        Error
      >
    >;
  }

  export const create = <M extends AdapterModel>(
    initialConfig: NexusConfig<M>,
    serviceRegistry: ReadonlyMap<Token<object, any>, ServiceProviderData>,
    endpointRegistration: EndpointRegistrationData<M> | null,
  ): Runtime<M> => ({
    build: async () => {
      const bootstrap = await Result.tryPromise({
        try: () =>
          bootstrapConfig(initialConfig, serviceRegistry, endpointRegistration),
        catch: (error) =>
          error instanceof Error ? error : new Error(String(error)),
      });
      return bootstrap.andThen((config) => {
        const endpoint = config.endpoint;
        if (!endpoint?.implementation || !endpoint.meta) {
          return err(
            new NexusConfigurationError(
              "Nexus initialization requires endpoint implementation and meta.",
            ),
          );
        }
        const engineRef: { current: Engine<M> | null } = { current: null };
        const handlers: ConnectionManagerHandlers<M> = {
          onMessage: (message: NexusMessage, connectionId: string) => {
            void engineRef.current
              ?.safeOnMessage(message, connectionId)
              .then((result) =>
                result.match({ ok: () => undefined, err: () => undefined }),
              );
          },
          onDisconnect: (connectionId) =>
            engineRef.current?.onDisconnect(connectionId),
          onIdentityUpdated: (connectionId, next, previous, connectionMeta) =>
            engineRef.current?.onConnectionTargetStale(
              connectionId,
              next,
              previous,
              connectionMeta,
            ),
        };
        const managerConfig: ConnectionManagerConfig<M> = {
          policy: config.policy,
        };
        const manager = new ConnectionManager(
          managerConfig,
          Transport.create(endpoint.implementation),
          handlers,
          endpoint.meta,
        );
        const providers = Object.fromEntries(
          (config.providers ?? []).map((provider) => [
            provider.token.id,
            {
              service: provider.service,
              policy: provider.policy,
            },
          ]),
        );
        const engine = new Engine(manager, {
          providers,
          policy: config.policy,
        });
        engineRef.current = engine;
        return ok({ engine, connectionManager: manager });
      });
    },
  });
}

async function bootstrapConfig<M extends AdapterModel>(
  config: NexusConfig<M>,
  serviceRegistry: ReadonlyMap<Token<object, any>, ServiceProviderData>,
  registration: EndpointRegistrationData<M> | null,
): Promise<NexusConfig<M>> {
  if (registration && config.endpoint) {
    throw new NexusConfigurationError(
      "Nexus: configure({ endpoint }) and @nexus.Endpoint(...) cannot both define the bootstrap endpoint.",
      "E_ENDPOINT_SOURCE_CONFLICT",
    );
  }
  const decorated: ServiceProvider<object, M>[] = [];
  for (const [token, data] of serviceRegistry) {
    const service = data.options?.factory
      ? await data.options.factory({
          targetClass: data.targetClass,
          token,
          localMeta: config.endpoint?.meta,
        })
      : new data.targetClass();
    decorated.push({
      token,
      service,
      policy: data.options?.policy as ServiceProvider<object, M>["policy"],
    });
  }
  const endpoint = registration
    ? {
        implementation: new registration.targetClass(),
        meta: registration.options.meta,
        defaultTarget: registration.options.defaultTarget,
      }
    : config.endpoint;
  return {
    ...config,
    endpoint,
    providers: [...(config.providers ?? []), ...decorated],
  };
}
