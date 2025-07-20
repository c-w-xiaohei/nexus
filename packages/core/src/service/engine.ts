import type { ConnectionManager } from "@/connection/connection-manager";
import type {
  NexusMessage,
  MessageId,
  SerializedError,
  ReleaseMessage,
} from "@/types/message";
import { NexusMessageType } from "@/types/message";
import type { PlatformMetadata, UserMetadata } from "@/types/identity";
import { MessageHandler } from "./message/message-handler";
import { PayloadProcessor } from "./payload/payload-processor";
import { ProxyFactory } from "./proxy-factory";
import { ResourceManager } from "./resource-manager";
import type { CallTarget, MessageTarget } from "@/connection/types";
import { createSerializedError } from "@/utils/error";
import { PendingCallManager } from "./pending-call-manager";
import type { CreateProxyOptions } from "./proxy-factory";
import { CallProcessor } from "./call-processor";
import { Logger } from "@/logger";

/** Arguments for dispatching a call from a proxy. */
export type DispatchCallOptions = {
  type: "GET" | "SET" | "APPLY";
  target: CallTarget<any, any>;
  resourceId: string | null;
  path: (string | number)[];
  args?: any[]; // Only for APPLY
  value?: any; // Only for SET
  strategy?: "one" | "first" | "all" | "stream";
  timeout?: number;
  // Options inherited from the proxy's creation
  proxyOptions?: CreateProxyOptions<any>;
};

/**
 * The central orchestrator for Layer 3 (Service & Proxy).
 * It instantiates and wires together all the L3 managers. Its primary role
 * is to receive messages from Layer 2 and delegate them to the MessageHandler.
 */
export class Engine<U extends UserMetadata, P extends PlatformMetadata> {
  private readonly logger = new Logger("L3 --- Engine");
  private readonly resourceManager: ResourceManager;
  private readonly payloadProcessor: PayloadProcessor<U, P>;
  private readonly proxyFactory: ProxyFactory<U, P>;
  private readonly messageHandler: MessageHandler<U, P>;
  private readonly pendingCallManager: PendingCallManager;
  private readonly callProcessor: CallProcessor<U, P>;

  constructor(
    private readonly connectionManager: ConnectionManager<U, P>,
    config: { services?: Record<string, object> } = {}
  ) {
    // Note: The order of instantiation is important due to dependencies.
    this.resourceManager = new ResourceManager();
    if (config.services) {
      for (const [name, service] of Object.entries(config.services)) {
        this.resourceManager.registerExposedService(name, service);
      }
    }
    this.proxyFactory = new ProxyFactory(this, this.resourceManager);
    this.payloadProcessor = new PayloadProcessor(
      this.resourceManager,
      this.proxyFactory
    );
    this.pendingCallManager = new PendingCallManager();
    this.messageHandler = new MessageHandler({
      engine: this,
      resourceManager: this.resourceManager,
      payloadProcessor: this.payloadProcessor,
    });
    this.callProcessor = new CallProcessor({
      connectionManager: this.connectionManager,
      payloadProcessor: this.payloadProcessor,
      pendingCallManager: this.pendingCallManager,
      resourceManager: this.resourceManager,
    });

    // In a complete implementation, this is where the engine would register
    // its `onMessage` handler with the connection manager.
  }

  /**
   * Creates a service proxy. This is the entry point for L4.
   * @internal
   */
  public createServiceProxy<T extends object>(
    serviceName: string,
    options: CreateProxyOptions<U>
  ): T {
    // Directly delegate to the internal proxyFactory
    return this.proxyFactory.createServiceProxy(serviceName, options);
  }

  /**
   * Dynamically registers new services with the resource manager.
   * @param services A map of service names to service implementations.
   */
  public registerServices(services: Record<string, object>): void {
    if (!services) return;
    for (const [name, service] of Object.entries(services)) {
      this.resourceManager.registerExposedService(name, service);
    }
  }

  /**
   * Dispatches a call originating from a proxy.
   * This determines the message type, sanitizes the payload,
   * sends the message, and returns a promise for the response.
   * @internal
   */
  public dispatchCall(
    options: DispatchCallOptions & { broadcastOptions?: { strategy: "stream" } }
  ): AsyncIterable<any>;
  public dispatchCall(options: DispatchCallOptions): Promise<any>;
  public dispatchCall(
    options: DispatchCallOptions
  ): Promise<any> | AsyncIterable<any> {
    return this.callProcessor.process(options);
  }

  /**
   * Dispatches a fire-and-forget notification to release a remote resource.
   * @internal
   */
  public dispatchRelease(resourceId: string, connectionId: string): void {
    const message: ReleaseMessage = {
      type: NexusMessageType.RELEASE,
      id: null,
      resourceId,
    };
    // This is a targeted message, so we create a specific target.
    this.sendMessage(message, { connectionId });
  }

  /**
   * The single entry point for messages incoming from Layer 2.
   * This method would be registered as a handler with the ConnectionManager.
   * @param message The message from a remote endpoint.
   * @param sourceConnectionId The ID of the connection it came from.
   */
  public async onMessage(
    message: NexusMessage,
    sourceConnectionId: string
  ): Promise<void> {
    this.logger.debug(
      `<- Received message #${
        message.id ?? "N/A"
      } from connection ${sourceConnectionId}`,
      message
    );
    try {
      await this.messageHandler.handleMessage(message, sourceConnectionId);
    } catch (err: unknown) {
      this.logger.error(
        `CRITICAL - Unhandled error in message handler for type ${message.type}.`,
        err
      );
      if (message.id) {
        this.sendMessage(
          {
            type: NexusMessageType.ERR,
            id: message.id,
            error: createSerializedError(err),
          },
          sourceConnectionId
        );
      }
    }
  }

  /**
   * Handles a response (success or error) for a pending call.
   * This is the unified replacement for resolve/rejectPendingCall.
   * @internal
   */
  public handleResponse(
    id: MessageId,
    result: any,
    error: SerializedError | null,
    sourceConnectionId?: string,
    isTimeout = false
  ): void {
    this.pendingCallManager.handleResponse(
      id,
      result,
      error,
      sourceConnectionId,
      isTimeout
    );
  }

  /**
   * Sends a message through Layer 2. This is an internal API for handlers.
   * @internal
   */
  public sendMessage(
    message: NexusMessage,
    target: CallTarget<U, any> | string
  ): string[] {
    const messageTarget =
      typeof target === "string" ? { connectionId: target } : target;
    return this.connectionManager.sendMessage(
      messageTarget as MessageTarget<U>,
      message
    );
  }

  /**
   * Disconnected endpoint.
   * @internal
   * @param connectionId The ID of the connection that was closed.
   */
  public onDisconnect(connectionId: string): void {
    this.resourceManager.cleanupConnection(connectionId);
    this.pendingCallManager.onDisconnect(connectionId);
  }
}
