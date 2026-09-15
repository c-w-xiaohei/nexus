import type { ConnectionManager } from "@/connection/connection-manager";
import type { NexusMessage, ReleaseMessage } from "@/types/message";
import { NexusMessageType } from "@/types/message";
import type { AdapterModel } from "@/types/adapter-model";
import { NexusDisconnectedError } from "@/errors/call-errors";
import { Logger } from "@/logger";
import { CallProcessor, type CallBinding } from "./call-processor";
import { MessageHandler } from "./message/message-handler";
import { PayloadProcessor } from "./payload/payload-processor";
import { PendingCallManager } from "./pending-call-manager";
import { ProxyFactory } from "./proxy-factory";
import { ResourceManager } from "./resource-manager";
import {
  getServiceInvocationHook,
  SERVICE_ON_DISCONNECT,
} from "./service-invocation-hooks";
import { Result } from "better-result";
import type { NexusAuthorizationPolicy } from "@/api/types/config";
import type { Connection } from "@/api/connection";

export class Engine<M extends AdapterModel> {
  private readonly logger = new Logger("L3 --- Engine");
  private readonly resourceManager: ResourceManager;
  private readonly payloadProcessor: PayloadProcessor;
  private readonly proxyFactory: ProxyFactory;
  private readonly messageHandler: MessageHandler<M>;
  private readonly pendingCallManager: PendingCallManager;
  private readonly callProcessor: CallProcessor;

  /** Compose service, payload, call, and message processing around one manager. */
  constructor(
    private readonly connectionManagerState: ConnectionManager<M>,
    config: {
      policy?: NexusAuthorizationPolicy<M>;
      getConnection: (id: string) => Connection<M>;
      callTimeout?: number;
    },
  ) {
    this.resourceManager = new ResourceManager();

    this.proxyFactory = new ProxyFactory(
      {
        // Construction never dispatches: this closes the proxy/payload/call cycle
        // without making Engine a second call-processing entry point.
        safeDispatchCall: (options) => this.callProcessor.safeProcess(options),
        dispatchRelease: (resourceId, connectionId) =>
          this.dispatchRelease(resourceId, connectionId),
      },
      this.resourceManager,
      config.getConnection,
      config.callTimeout,
    );
    this.payloadProcessor = new PayloadProcessor(
      this.resourceManager,
      this.proxyFactory,
    );
    this.pendingCallManager = new PendingCallManager();
    this.messageHandler = new MessageHandler({
      safeSendMessage: (message, connectionId) =>
        this.safeSendMessage(message, connectionId),
      dispatchRelease: (resourceId, connectionId) =>
        this.dispatchRelease(resourceId, connectionId),
      pendingCalls: this.pendingCallManager,
      resourceManager: this.resourceManager,
      payloadProcessor: this.payloadProcessor,
      policy: config.policy,
      getConnectionAuthContext: (connectionId) =>
        this.connectionManagerState.getConnectionAuthSnapshot(connectionId),
    });
    this.callProcessor = new CallProcessor({
      isConnectionReady: (id) =>
        this.connectionManagerState.isConnectionReady(id),
      sendMessage: (message, connectionId) =>
        this.safeSendMessage(message, connectionId),
      payloadProcessor: this.payloadProcessor,
      pendingCallManager: this.pendingCallManager,
    });
  }

  /** Creates a lightweight service facade; its session lifecycle belongs to Connection. */
  public createServiceProxy<T extends object>(
    serviceName: string,
    options: CallBinding,
  ): T {
    return this.proxyFactory.createServiceProxy<T>(serviceName, options);
  }

  /** Atomically register providers locally, then announce their availability. */
  public provideServices(
    providers: readonly {
      name: string;
      service: object;
      policy?: NexusAuthorizationPolicy<M>;
    }[],
  ): void {
    this.resourceManager.registerExposedServices(providers);
    this.connectionManagerState.publishProviders(
      providers.map(({ name }) => name),
    );
  }

  /** Best-effort notification after local release; logs send failure without waiting for a remote ACK. */
  public dispatchRelease(resourceId: string, connectionId: string): void {
    const message: ReleaseMessage = {
      type: NexusMessageType.RELEASE,
      id: null,
      resourceId,
    };
    const result = this.safeSendMessage(message, connectionId);
    if (result.isErr())
      this.logger.warn(
        `Failed to dispatch release for resource #${resourceId} to ${connectionId}.`,
        result.error,
      );
  }

  /** Handles an incoming message and reports local failures without manufacturing a second reply. */
  public safeOnMessage(
    message: NexusMessage,
    sourceConnectionId: string,
  ): Promise<Result<void, globalThis.Error>> {
    this.logger.debug(
      `<- Received message #${message.id ?? "N/A"} from connection ${sourceConnectionId}`,
      message,
    );

    return this.messageHandler
      .safeHandleMessage(message, sourceConnectionId)
      .then((result) => {
        if (result.isErr())
          this.logger.error("Incoming message handling failed", result.error);
        return result;
      });
  }

  /**
   * Hands a message to exactly one live session.
   * Success means local acceptance, not remote execution.
   */
  public safeSendMessage(
    message: NexusMessage,
    connectionId: string,
  ): Result<void, Error> {
    const result = this.connectionManagerState.safeSendMessage(
      connectionId,
      message,
    );
    if (result.isErr()) {
      const error = result.error;
      if (
        error.code === "E_CONN_CLOSED" &&
        !(error instanceof NexusDisconnectedError)
      ) {
        return Result.err(
          new NexusDisconnectedError(
            error.message,
            "E_CONN_CLOSED",
            error.context,
            error.cause,
          ),
        );
      }
    }
    return result;
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
