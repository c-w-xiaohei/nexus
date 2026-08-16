import type { IEndpoint, IPort } from "@nexus-js/core";
import { VirtualPortRouter } from "@nexus-js/core/transport/virtual-port";
import { DEFAULT_CHANNEL, DEFAULT_INSTANCE } from "./constants.js";
import {
  createEnvelope,
  readEnvelope,
  type MessageEnvelope,
} from "./envelope.js";
import { IframeAdapterError } from "./errors.js";
import {
  createConnectionMeta,
  isTrustedConnectionMeta,
} from "./connection-meta.js";
import { createCapabilities } from "./shared.js";
import type {
  EndpointCapabilities,
  IframeChildEndpointOptions,
  IframeAdapterModel,
  IframeConnectionMeta,
  IframeContextMeta,
  WindowLike,
} from "./types.js";
import {
  originMatches,
  targetOriginMatches,
  validateAppId,
  validateOrigin,
} from "./validation.js";
import { getWindow, postMessageFrom } from "./window.js";

/**
 * Child-side endpoint. Its only trusted peer is `window.parent`, further scoped
 * by the configured parent origin, adapter channel, app id, and optional nonce.
 */
export class IframeChildEndpoint implements IEndpoint<IframeAdapterModel> {
  readonly capabilities: EndpointCapabilities;
  private router: VirtualPortRouter.Context | undefined;
  private cleanupLifecycle: (() => void) | undefined;
  private observedOrigin: string | undefined;

  constructor(private readonly options: IframeChildEndpointOptions) {
    validateAppId(options.appId);
    validateOrigin(options.parentOrigin, options.allowAnyOrigin);
    this.capabilities = createCapabilities(options.binaryPackets);
    this.installLifecycleClose();
  }

  listen(
    onConnect: (port: IPort, connectionMeta: IframeConnectionMeta) => void,
  ): void {
    this.ensureRouter();
    if (!this.router) return;
    VirtualPortRouter.safeListen(this.router, (port) =>
      onConnect(port, this.createMeta()),
    );
  }

  async connect(
    target: IframeAdapterModel["connectionTarget"],
  ): Promise<{ port: IPort; connectionMeta: IframeConnectionMeta }> {
    this.validateParentTarget(target);
    this.ensureRouter();
    if (!this.router)
      throw new IframeAdapterError(
        "Iframe router is unavailable",
        "E_IFRAME_CONNECT_FAILED",
      );
    const result = await VirtualPortRouter.safeConnect(this.router);
    if (result.isErr()) {
      throw new IframeAdapterError(
        "Could not connect to iframe parent",
        "E_IFRAME_CONNECT_FAILED",
        result.error,
      );
    }
    const port = result.value;
    return { port, connectionMeta: this.createMeta() };
  }

  matchesTarget(
    target: IframeAdapterModel["connectionTarget"],
    contextMeta: IframeContextMeta,
    connectionMeta: IframeConnectionMeta,
  ): boolean {
    return matchesTarget(target, contextMeta, connectionMeta);
  }

  close(): void {
    this.cleanupLifecycle?.();
    this.cleanupLifecycle = undefined;
    if (this.router) VirtualPortRouter.safeClose(this.router);
    this.router = undefined;
  }

  private ensureRouter(): void {
    if (this.router && !this.router.closed) return;
    this.router = VirtualPortRouter.create({
      bus: this.createBus(),
      localId: `iframe-child:${this.options.appId}:${this.options.frameId ?? "default"}`,
      heartbeat: this.options.heartbeat,
    });
  }

  private createBus(): VirtualPortRouter.Bus {
    const localWindow = getWindow(
      this.options.localWindow ?? this.options.window,
    );
    const parentWindow = (localWindow as WindowLike).parent;
    return {
      send: (payload, transfer) => {
        if (!parentWindow)
          throw new IframeAdapterError(
            "Parent window is unavailable",
            "E_IFRAME_CONNECT_FAILED",
          );
        postMessageFrom(
          localWindow,
          parentWindow,
          this.wrap(payload),
          this.options.parentOrigin,
          transfer,
        );
      },
      subscribe: (handler) => {
        const listener = (event: MessageEvent) => {
          // Child inbound traffic must come from the captured parent window,
          // match the parent origin policy, and carry this channel plus nonce.
          const envelope = readEnvelope(event.data);
          if (
            !envelope ||
            event.source !== parentWindow ||
            !this.matchesEnvelope(envelope, event.origin)
          )
            return;
          this.observedOrigin = event.origin;
          handler(envelope.payload);
        };
        localWindow.addEventListener("message", listener as EventListener);
        return () =>
          localWindow.removeEventListener("message", listener as EventListener);
      },
    };
  }

  private matchesEnvelope(envelope: MessageEnvelope, origin: string): boolean {
    return (
      envelope.appId === this.options.appId &&
      envelope.channel === (this.options.channel ?? DEFAULT_CHANNEL) &&
      originMatches(
        origin,
        this.options.parentOrigin,
        this.options.allowAnyOrigin,
      ) &&
      (this.options.nonce === undefined ||
        envelope.nonce === this.options.nonce)
    );
  }

  private wrap(payload: unknown): MessageEnvelope {
    return createEnvelope(
      this.options.appId,
      this.options.channel ?? DEFAULT_CHANNEL,
      payload,
      this.options.nonce,
    );
  }

  private installLifecycleClose(): void {
    const localWindow = getWindow(
      this.options.localWindow ?? this.options.window,
    );
    const close = () => {
      if (this.router) VirtualPortRouter.safeClose(this.router);
    };
    localWindow.addEventListener("pagehide", close as EventListener);
    localWindow.addEventListener("beforeunload", close as EventListener);
    this.cleanupLifecycle = () => {
      localWindow.removeEventListener("pagehide", close as EventListener);
      localWindow.removeEventListener("beforeunload", close as EventListener);
    };
  }

  private validateParentTarget(
    target: IframeAdapterModel["connectionTarget"],
  ): asserts target is Extract<
    IframeAdapterModel["connectionTarget"],
    { context: "iframe-parent" }
  > {
    if (target.context !== "iframe-parent")
      throw new IframeAdapterError(
        "No iframe parent matched target",
        "E_IFRAME_TARGET_NOT_FOUND",
      );
    if (target.appId !== this.options.appId)
      throw new IframeAdapterError(
        "No iframe parent matched target",
        "E_IFRAME_TARGET_NOT_FOUND",
      );
    if (
      (target.instance ?? DEFAULT_INSTANCE) !==
      (this.options.instance ?? DEFAULT_INSTANCE)
    )
      throw new IframeAdapterError(
        "No iframe parent matched target",
        "E_IFRAME_TARGET_NOT_FOUND",
      );
    if (
      !targetOriginMatches(
        target.origin,
        this.options.parentOrigin,
        this.options.allowAnyOrigin,
      )
    )
      throw new IframeAdapterError(
        "No iframe parent matched target",
        "E_IFRAME_TARGET_NOT_FOUND",
      );
  }

  private createMeta(): IframeConnectionMeta {
    return createConnectionMeta({
      transport: "iframe-postmessage",
      appId: this.options.appId,
      channel: this.options.channel ?? DEFAULT_CHANNEL,
      frameId: this.options.frameId,
      localRole: "iframe-child",
      remoteRole: "iframe-parent",
      origin: this.observedOrigin ?? this.options.parentOrigin,
      expectedOrigin: this.options.parentOrigin,
      facts: {
        sourceMatched: true,
        originMatched: true,
        nonceMatched: true,
        trusted: true,
      },
    });
  }
}

const matchesTarget = (
  target: IframeAdapterModel["connectionTarget"],
  contextMeta: IframeContextMeta,
  connectionMeta: IframeConnectionMeta,
): boolean => {
  if (target.context !== "iframe-parent") return false;
  return (
    contextMeta.context === "iframe-parent" &&
    ("origin" in target
      ? matchesOriginTarget(target.origin, contextMeta.origin, connectionMeta)
      : true) &&
    (target.appId === undefined || contextMeta.appId === target.appId) &&
    (target.instance === undefined ||
      (contextMeta.instance ?? DEFAULT_INSTANCE) === target.instance) &&
    connectionMeta.appId === contextMeta.appId &&
    connectionMeta.origin === contextMeta.origin &&
    (connectionMeta.expectedOrigin === "*" ||
      connectionMeta.expectedOrigin === contextMeta.origin) &&
    connectionMeta.remoteRole === "iframe-parent" &&
    isTrustedConnectionMeta(connectionMeta)
  );
};

function matchesOriginTarget(
  targetOrigin: string | undefined,
  peerOrigin: string,
  connectionMeta: IframeConnectionMeta,
): boolean {
  if (targetOrigin === undefined) return true;
  if (targetOrigin === "*") {
    return connectionMeta.expectedOrigin === "*" && peerOrigin !== "*";
  }
  return targetOrigin === peerOrigin && connectionMeta.origin === peerOrigin;
}
