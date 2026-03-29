import type { ServiceRegistration } from "@/api/types/config";
import {
  type ServiceInvocationContext,
  SERVICE_INVOKE_END,
  SERVICE_INVOKE_START,
  SERVICE_ON_DISCONNECT,
} from "@/service/service-invocation-hooks";
import { createStoreHost } from "./host/store-host";
import type { NexusStoreDefinition, NexusStoreServiceContract } from "./types";

export const provideNexusStore = <
  TState extends object,
  TActions extends Record<string, (...args: any[]) => any>,
>(
  definition: NexusStoreDefinition<TState, TActions>,
): ServiceRegistration<NexusStoreServiceContract<TState, TActions>> => {
  const host = createStoreHost(definition);

  const implementation: NexusStoreServiceContract<TState, TActions> = {
    subscribe: async (onSync, invocation?: ServiceInvocationContext) => {
      return host.subscribe(onSync, {
        ownerConnectionId: host.resolveSubscriptionOwner(invocation),
      });
    },
    unsubscribe: (subscriptionId) => host.unsubscribe(subscriptionId),
    dispatch: (action, args) => host.dispatch(action, args),
  };

  const implementationWithHooks = implementation as NexusStoreServiceContract<
    TState,
    TActions
  > & {
    [SERVICE_INVOKE_START](
      sourceConnectionId: string,
    ): ServiceInvocationContext;
    [SERVICE_INVOKE_END](invocationContext?: ServiceInvocationContext): void;
    [SERVICE_ON_DISCONNECT](connectionId: string): void;
  };

  implementationWithHooks[SERVICE_INVOKE_START] = (sourceConnectionId) =>
    host.onInvokeStart(sourceConnectionId);
  implementationWithHooks[SERVICE_INVOKE_END] = (invocationContext) => {
    host.onInvokeEnd(invocationContext);
  };
  implementationWithHooks[SERVICE_ON_DISCONNECT] = (connectionId) => {
    host.cleanupConnection(connectionId);
  };

  return {
    token: definition.token,
    implementation: implementationWithHooks,
  };
};
