import { ConnectionManager } from "@/connection/connection-manager";
import type { LogicalConnection } from "@/connection/logical-connection";
import type { ConnectionManagerHandlers } from "@/connection/types";
import { NexusConfigurationError } from "@/errors";
import { Engine } from "@/service/engine";
import { Transport } from "@/transport";
import type { AdapterModel } from "@/types/adapter-model";
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
  getConnection: (session: LogicalConnection<M>) => Connection<M>,
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
      const providers = [...(config.providers ?? [])];
      for (const { token, targetClass, options } of serviceRegistry) {
        const service = options?.factory
          ? await options.factory({ targetClass, token, localMeta: meta })
          : new targetClass();
        const checked = validateProviderBatch([
          { token, service, policy: options?.policy },
        ]);
        if (checked.isErr()) return err(checked.error);
        providers.push({ token, service, policy: options?.policy });
      }
      // Constructors do not start transport traffic; Nexus starts listening only
      // after both sides of this dependency are installed.
      const handlers: ConnectionManagerHandlers = {
        onMessage: (message, connectionId) => {
          void engine.onMessage(message, connectionId);
        },
        // Settle calls/resources before public Connection observers see termination.
        onDisconnect: (connectionId) => engine.onDisconnect(connectionId),
      };
      const manager = new ConnectionManager(
        { policy: config.policy, connectTo: endpoint.connectTo },
        Transport.create(endpoint.implementation!),
        handlers,
        meta,
      );
      const engine = new Engine(manager, {
        getConnection: (id) => {
          const session = manager.getConnection(id);
          if (!session) throw new Error(`Unknown source connection: ${id}`);
          return getConnection(session);
        },
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
