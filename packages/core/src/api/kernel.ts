import { ConnectionManager } from "@/connection/connection-manager";
import type { ConnectionManagerHandlers } from "@/connection/types";
import { NexusConfigurationError } from "@/errors";
import { Engine } from "@/service/engine";
import { Transport } from "@/transport";
import type { AdapterModel } from "@/types/adapter-model";
import type { NexusMessage } from "@/types/message";
import { Result } from "better-result";
import { toSerializedError } from "@/utils/error";
const { err, ok } = Result;
import type { EndpointRegistration } from "./decorators/endpoint";
import type { ServiceRegistration } from "./decorators/expose";
import {
  validateProviderBatch,
  validateProviderIds,
  type NexusConfig,
} from "./types/config";
import type { Connection } from "./connection";

/** Assemble first; Nexus installs these instances before starting listener traffic. */
export async function buildKernel<M extends AdapterModel>(
  initialConfig: NexusConfig<M>,
  serviceRegistry: readonly ServiceRegistration[],
  endpointRegistration: EndpointRegistration<M> | null,
  observers:
    | Pick<ConnectionManagerHandlers<M>, "onDisconnect" | "onIdentityUpdated">
    | undefined,
  getConnection: (id: string) => Connection<M>,
): Promise<
  Result<{ engine: Engine<M>; connectionManager: ConnectionManager<M> }, Error>
> {
  const config = initialConfig;
  if (endpointRegistration && config.endpoint) {
    return err(
      new NexusConfigurationError(
        "Nexus: configure({ endpoint }) and @nexus.Endpoint(...) cannot both define the bootstrap endpoint.",
        "E_ENDPOINT_SOURCE_CONFLICT",
      ),
    );
  }
  const valid = validateProviderBatch(
    config.providers === undefined ? [] : config.providers,
  );
  if (valid.isErr()) return valid;
  const identities = validateProviderIds([
    ...(config.providers ?? []).map(({ token }) => token.id),
    ...serviceRegistry.map(({ token }) => token.id),
  ]);
  if (identities.isErr()) return identities;
  const meta = endpointRegistration?.options.meta ?? config.endpoint?.meta;
  if (!meta || (!endpointRegistration && !config.endpoint?.implementation)) {
    return err(
      new NexusConfigurationError(
        "Nexus initialization requires endpoint implementation and meta.",
      ),
    );
  }
  return Result.tryPromise({
    try: async () => {
      const endpoint = endpointRegistration
        ? {
            ...endpointRegistration.options,
            implementation: new endpointRegistration.targetClass(),
          }
        : config.endpoint!;
      const providers = (config.providers ?? []).map(
        ({ token, service, policy }) => ({ name: token.id, service, policy }),
      );
      for (const { token, targetClass, options } of serviceRegistry) {
        const service = options?.factory
          ? await options.factory({ targetClass, token, localMeta: meta })
          : new targetClass();
        const checked = validateProviderBatch([
          { token, service, policy: options?.policy },
        ]);
        if (checked.isErr()) return err(checked.error);
        providers.push({ name: token.id, service, policy: options?.policy });
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
        Transport.create(endpoint.implementation!),
        handlers,
        meta,
      );
      engine = new Engine(manager, {
        getConnection,
        callTimeout: config.callTimeout,
        policy: config.policy,
      });
      engine.provideServices(providers);
      return ok({ engine, connectionManager: manager });
    },
    catch: (error) =>
      new NexusConfigurationError(
        "Nexus bootstrap construction failed.",
        "E_NEXUS_BOOTSTRAP_FAILED",
        { cause: toSerializedError(error) },
      ),
  }).then((result) => result.andThen((built) => built));
}
