import type { IEndpoint, IPort } from "@nexus-js/core";
import { VirtualPortRouter } from "@nexus-js/core/transport/virtual-port";
import { DEFAULT_CHANNEL, DEFAULT_INSTANCE } from "./constants";
import { createEnvelope, readEnvelope, type MessageEnvelope } from "./envelope";
import { IframeAdapterError } from "./errors";
import { createPlatformMeta } from "./platform-meta";
import { createCapabilities } from "./shared";
import type {
  EndpointCapabilities,
  IframeChildEndpointOptions,
  IframePlatformMeta,
  IframeUserMeta,
  WindowLike,
} from "./types";
import { originMatches, validateAppId, validateOrigin } from "./validation";
import { getWindow, postMessageFrom } from "./window";

/**
 * Child-side endpoint. Its only trusted peer is `window.parent`, further scoped
 * by the configured parent origin, adapter channel, app id, and optional nonce.
 */
export class IframeChildEndpoint implements IEndpoint<
  IframeUserMeta,
  IframePlatformMeta
> {
  readonly capabilities: EndpointCapabilities;
  private router: VirtualPortRouter.Context | undefined;
  private cleanupLifecycle: (() => void) | undefined;

  constructor(private readonly options: IframeChildEndpointOptions) {
    validateAppId(options.appId);
    validateOrigin(options.parentOrigin, options.allowAnyOrigin);
    this.capabilities = createCapabilities(options.binaryPackets);
    this.installLifecycleClose();
  }

  listen(
    onConnect: (port: IPort, platformMetadata?: IframePlatformMeta) => void,
  ): void {
    this.ensureRouter();
    if (!this.router) return;
    VirtualPortRouter.safeListen(this.router, (port) =>
      onConnect(port, this.createMeta()),
    );
  }

  async connect(
    targetDescriptor: Partial<IframeUserMeta>,
  ): Promise<[IPort, IframePlatformMeta]> {
    this.validateParentTarget(targetDescriptor);
    this.ensureRouter();
    if (!this.router)
      throw new IframeAdapterError(
        "Iframe router is unavailable",
        "E_IFRAME_CONNECT_FAILED",
      );
    const port = await VirtualPortRouter.safeConnect(this.router).match(
      (value) => value,
      (error) => {
        throw new IframeAdapterError(
          "Could not connect to iframe parent",
          "E_IFRAME_CONNECT_FAILED",
          error,
        );
      },
    );
    return [port, this.createMeta()];
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

  private validateParentTarget(target: Partial<IframeUserMeta>): void {
    if (target.context !== undefined && target.context !== "iframe-parent")
      throw new IframeAdapterError(
        "No iframe parent matched target descriptor",
        "E_IFRAME_TARGET_NOT_FOUND",
      );
    if (target.appId !== undefined && target.appId !== this.options.appId)
      throw new IframeAdapterError(
        "No iframe parent matched target descriptor",
        "E_IFRAME_TARGET_NOT_FOUND",
      );
    if (
      target.instance !== undefined &&
      target.instance !== (this.options.instance ?? DEFAULT_INSTANCE)
    )
      throw new IframeAdapterError(
        "No iframe parent matched target descriptor",
        "E_IFRAME_TARGET_NOT_FOUND",
      );
    if (
      target.origin !== undefined &&
      !originMatches(
        target.origin,
        this.options.parentOrigin,
        this.options.allowAnyOrigin,
      )
    )
      throw new IframeAdapterError(
        "No iframe parent matched target descriptor",
        "E_IFRAME_TARGET_NOT_FOUND",
      );
  }

  private createMeta(): IframePlatformMeta {
    return createPlatformMeta({
      transport: "iframe-postmessage",
      appId: this.options.appId,
      channel: this.options.channel ?? DEFAULT_CHANNEL,
      frameId: this.options.frameId,
      localRole: "iframe-child",
      remoteRole: "iframe-parent",
      origin: this.options.parentOrigin,
      expectedOrigin: this.options.parentOrigin,
      sourceMatched: true,
      originMatched: true,
      nonceMatched: true,
      trusted: true,
    });
  }
}
