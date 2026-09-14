import { ConnectionManager } from "@/connection/connection-manager";
import type { ConnectionManagerHandlers } from "@/connection/types";
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
import type { Connection } from "./connection";

/** Assemble first; Nexus installs these instances before starting listener traffic. */
export async function buildKernel<M extends AdapterModel>(
  initialConfig: NexusConfig<M>,
  serviceRegistry: ReadonlyMap<Token<object, any>, ServiceProviderData>,
  endpointRegistration: EndpointRegistrationData<M> | null,
  observers:
    | Pick<ConnectionManagerHandlers<M>, "onDisconnect" | "onIdentityUpdated">
    | undefined,
  getConnection: (id: string) => Connection<M>,
): Promise<
  Result<{ engine: Engine<M>; connectionManager: ConnectionManager<M> }, Error>
> {
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
    let engine: Engine<M> | undefined;
    const handlers: ConnectionManagerHandlers<M> = {
      onMessage: (message: NexusMessage, connectionId: string) => {
        void engine?.safeOnMessage(message, connectionId);
      },
      onDisconnect: (connectionId) => {
        // Settle calls/resources before public Connection observers see termination.
        engine?.onDisconnect(connectionId);
        observers?.onDisconnect(connectionId);
      },
      onIdentityUpdated: (connectionId, next, previous, connectionMeta) => {
        engine?.onConnectionIdentityUpdated(connectionId);
        observers?.onIdentityUpdated?.(
          connectionId,
          next,
          previous,
          connectionMeta,
        );
      },
    };
    const manager = new ConnectionManager(
      { policy: config.policy, connectTo: endpoint.connectTo },
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
    engine = new Engine(manager, {
      getConnection,
      callTimeout: config.callTimeout,
      providers,
      policy: config.policy,
    });
    return ok({ engine, connectionManager: manager });
  });
}

/** Merge decorator registrations into configuration before runtime construction. */
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
        connectTo: registration.options.connectTo,
      }
    : config.endpoint;
  return {
    ...config,
    endpoint,
    providers: [...(config.providers ?? []), ...decorated],
  };
}
