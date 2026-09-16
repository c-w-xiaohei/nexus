import type { ConnectionManager } from "@/connection/connection-manager";
import type { NexusMessage } from "@/types/message";
import { NexusMessageType } from "@/types/message";
import type { AdapterModel } from "@/types/adapter-model";
import { NexusDisconnectedError } from "@/errors/call-errors";
import { Logger } from "@/logger";
import { CallProcessor } from "./call-processor";
import { MessageHandler } from "./message/message-handler";
import { PayloadProcessor } from "./payload/payload-processor";
import { PendingCallManager } from "./pending-call-manager";
import { ProxyFactory } from "./proxy-factory";
import { ResourceManager } from "./resource-manager";
import {
  getServiceInvocationHook,
  SERVICE_ON_DISCONNECT,
} from "./service-invocation-hooks";
import type { Result } from "better-result";
import type {
  NexusAuthorizationPolicy,
  ServiceProvider,
} from "@/api/types/config";
import type { Connection } from "@/api/connection";

export class Engine<M extends AdapterModel> {
  private readonly logger = new Logger("L3 --- Engine");

  // Session-owned resources and outbound call lifecycle.
  private readonly resourceManager = new ResourceManager();
  private readonly pendingCallManager = new PendingCallManager();

  // Expose only the factory's creation capability, not the factory itself.
  public readonly createServiceProxy: ProxyFactory["createServiceProxy"];
  private readonly messageHandler: MessageHandler<M>;

  /** One L2-to-call error boundary shared by calls, replies and releases. */
  private readonly safeSendMessage = (
    message: NexusMessage,
    connectionId: string,
  ): Result<void, Error> =>
    this.connectionManagerState
      .safeSendMessage(message, connectionId)
      .mapError((error) =>
        error.code === "E_CONN_CLOSED" &&
        !(error instanceof NexusDisconnectedError)
          ? new NexusDisconnectedError(
              error.message,
              "E_CONN_CLOSED",
              error.context,
              error.cause,
            )
          : error,
      );

  /** Local release is final; remote notification is best effort, without an ACK. */
  private readonly dispatchRelease = (
    resourceId: string,
    connectionId: string,
  ): void => {
    this.safeSendMessage(
      { type: NexusMessageType.RELEASE, id: null, resourceId },
      connectionId,
    ).tapError((error) =>
      this.logger.warn(
        `Failed to dispatch release for resource #${resourceId} to ${connectionId}.`,
        error,
      ),
    );
  };

  /** Compose service, payload, call, and message processing around one manager. */
  constructor(
    private readonly connectionManagerState: Pick<
      ConnectionManager<M>,
      | "safeSendMessage"
      | "isConnectionReady"
      | "getConnectionAuthSnapshot"
      | "publishProviders"
    >,
    config: {
      policy?: NexusAuthorizationPolicy<M>;
      getConnection: (id: string) => Connection<M>;
      callTimeout?: number;
    },
  ) {
    const proxyFactory = new ProxyFactory(
      {
        // Construction never dispatches: this closes the proxy/payload/call cycle
        // without making Engine a second call-processing entry point.
        safeDispatchCall: (options) => callProcessor.safeProcess(options),
        dispatchRelease: this.dispatchRelease,
      },
      this.resourceManager,
      config.getConnection,
      config.callTimeout,
    );
    this.createServiceProxy =
      proxyFactory.createServiceProxy.bind(proxyFactory);
    const payloadProcessor = new PayloadProcessor(
      this.resourceManager,
      proxyFactory,
    );
    this.messageHandler = new MessageHandler({
      safeSendMessage: this.safeSendMessage,
      dispatchRelease: this.dispatchRelease,
      pendingCalls: this.pendingCallManager,
      resourceManager: this.resourceManager,
      payloadProcessor,
      policy: config.policy,
      getConnectionAuthContext: (connectionId) =>
        this.connectionManagerState.getConnectionAuthSnapshot(connectionId),
    });
    const callProcessor = new CallProcessor({
      isConnectionReady: (id) =>
        this.connectionManagerState.isConnectionReady(id),
      safeSendMessage: this.safeSendMessage,
      payloadProcessor,
      pendingCallManager: this.pendingCallManager,
    });
  }

  /** Atomically register providers locally, then announce their availability. */
  public provideServices(
    providers: readonly ServiceProvider<object, M>[],
  ): void {
    const registrations = providers.map(({ token, service, policy }) => ({
      name: token.id,
      service,
      policy,
    }));
    this.resourceManager.registerExposedServices(registrations);
    this.connectionManagerState.publishProviders(
      registrations.map(({ name }) => name),
    );
  }

  /** Consumes inbound processing failures locally; completion never promotes an RPC error to session failure. */
  public async onMessage(
    message: NexusMessage,
    sourceConnectionId: string,
  ): Promise<void> {
    const result = await this.messageHandler.safeHandleMessage(
      message,
      sourceConnectionId,
    );
    if (result.isErr()) {
      try {
        this.logger.error("Incoming message handling failed", result.error);
      } catch {
        // The original failure is already consumed; do not replace it with a log failure.
      }
    }
  }

  /** Release session-owned state before notifying service and proxy observers. */
  public onDisconnect(connectionId: string): void {
    this.resourceManager.cleanupConnection(connectionId);
    this.pendingCallManager.onDisconnect(connectionId);
    for (const service of this.resourceManager.listExposedServices()) {
      try {
        getServiceInvocationHook(
          service,
          SERVICE_ON_DISCONNECT,
        )?.(connectionId);
      } catch (error) {
        this.logger.error("Exposed service disconnect hook failed.", error);
      }
    }
  }
}
