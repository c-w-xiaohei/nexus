import type { IEndpoint, IPort } from "@nexus-js/core";
import { VirtualPortRouter } from "@nexus-js/core/transport/virtual-port";
import { DEFAULT_CHANNEL, DEFAULT_INSTANCE } from "./constants";
import { createEnvelope, readEnvelope, type MessageEnvelope } from "./envelope";
import { IframeAdapterError } from "./errors";
import { createPlatformMeta } from "./platform-meta";
import { createCapabilities } from "./shared";
import type {
  EndpointCapabilities,
  IframeFrameTarget,
  IframeParentEndpointOptions,
  IframePlatformMeta,
  IframeUserMeta,
} from "./types";
import { originMatches, validateAppId, validateOrigin } from "./validation";
import { getWindow, postMessageFrom } from "./window";

type ParentFrameState = IframeFrameTarget & {
  router?: VirtualPortRouter.Context;
  removeLoad: () => void;
};

/**
 * Parent-side endpoint. Its trust boundary is the iframe contentWindow configured
 * for each frame: matching origin is not enough when same-origin frames coexist.
 */
export class IframeParentEndpoint implements IEndpoint<
  IframeUserMeta,
  IframePlatformMeta
> {
  readonly capabilities: EndpointCapabilities;
  private readonly frames = new Map<string, ParentFrameState>();
  private onConnect:
    | ((port: IPort, platformMetadata?: IframePlatformMeta) => void)
    | undefined;
  private closed = false;

  constructor(private readonly options: IframeParentEndpointOptions) {
    validateAppId(options.appId);
    this.capabilities = createCapabilities(options.binaryPackets);
    for (const frame of options.frames)
      this.frames.set(frame.frameId, this.createFrameState(frame));
  }

  listen(
    onConnect: (port: IPort, platformMetadata?: IframePlatformMeta) => void,
  ): void {
    this.closed = false;
    this.onConnect = onConnect;
    for (const state of this.frames.values()) {
      this.ensureRouter(state);
      this.listenFrame(state);
    }
  }

  async connect(
    targetDescriptor: Partial<IframeUserMeta>,
  ): Promise<[IPort, IframePlatformMeta]> {
    const state = this.resolveFrame(targetDescriptor);
    this.ensureRouter(state);
    if (!state.router)
      throw new IframeAdapterError(
        "Iframe router is unavailable",
        "E_IFRAME_CONNECT_FAILED",
      );
    const port = await VirtualPortRouter.safeConnect(state.router).match(
      (value) => value,
      (error) => {
        throw new IframeAdapterError(
          "Could not connect to iframe",
          "E_IFRAME_CONNECT_FAILED",
          error,
        );
      },
    );
    return [port, this.createMeta(state)];
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onConnect = undefined;
    for (const state of this.frames.values()) {
      this.closeFrame(state);
      state.removeLoad();
    }
  }

  private createFrameState(frame: IframeFrameTarget): ParentFrameState {
    validateOrigin(frame.origin, this.options.allowAnyOrigin);
    const onLoad = () => {
      const wasListening = frameState.router?.listening === true;
      // An iframe navigation replaces the child session. Close the old virtual
      // port router, but re-enter listen mode so future child connects still work.
      this.resetFrame(frameState);
      if (wasListening) this.listenFrame(frameState);
    };
    const frameState: ParentFrameState = {
      ...frame,
      router: undefined,
      removeLoad: () => frame.iframe.removeEventListener("load", onLoad),
    };
    frame.iframe.addEventListener("load", onLoad);
    return frameState;
  }

  private ensureRouter(state: ParentFrameState): void {
    if (this.closed) return;
    if (state.router && !state.router.closed) return;
    state.router = VirtualPortRouter.create({
      bus: this.createBus(state),
      localId: `iframe-parent:${this.options.appId}:${state.frameId}`,
    });
  }

  private listenFrame(state: ParentFrameState): void {
    if (!this.onConnect) return;
    this.ensureRouter(state);
    if (!state.router) return;
    VirtualPortRouter.safeListen(state.router, (port) =>
      this.onConnect?.(port, this.createMeta(state)),
    );
  }

  private createBus(state: ParentFrameState): VirtualPortRouter.Bus {
    const localWindow = getWindow(
      this.options.localWindow ?? this.options.window,
    );
    return {
      send: (payload, transfer) => {
        const target = state.iframe.contentWindow;
        if (!target)
          throw new IframeAdapterError(
            "Iframe contentWindow is unavailable",
            "E_IFRAME_CONNECT_FAILED",
          );
        postMessageFrom(
          localWindow,
          target,
          this.wrap(payload, state.nonce),
          state.origin,
          transfer,
        );
      },
      subscribe: (handler) => {
        const listener = (event: MessageEvent) => {
          // Parent inbound traffic must come from the exact child window, match
          // the allowed origin policy, and carry this adapter channel plus nonce.
          if (event.source !== state.iframe.contentWindow) return;
          const envelope = readEnvelope(event.data);
          if (!envelope || !this.matchesEnvelope(envelope, state, event.origin))
            return;
          handler(envelope.payload);
        };
        localWindow.addEventListener("message", listener as EventListener);
        return () =>
          localWindow.removeEventListener("message", listener as EventListener);
      },
    };
  }

  private matchesEnvelope(
    envelope: MessageEnvelope,
    state: ParentFrameState,
    origin: string,
  ): boolean {
    return (
      envelope.appId === this.options.appId &&
      envelope.channel === (this.options.channel ?? DEFAULT_CHANNEL) &&
      originMatches(origin, state.origin, this.options.allowAnyOrigin) &&
      (state.nonce === undefined || envelope.nonce === state.nonce)
    );
  }

  private wrap(payload: unknown, nonce?: string): MessageEnvelope {
    return createEnvelope(
      this.options.appId,
      this.options.channel ?? DEFAULT_CHANNEL,
      payload,
      nonce,
    );
  }

  private resolveFrame(target: Partial<IframeUserMeta>): ParentFrameState {
    if (target.context !== undefined && target.context !== "iframe-child")
      throw new IframeAdapterError(
        "No iframe matched target descriptor",
        "E_IFRAME_TARGET_NOT_FOUND",
      );
    const frameId =
      target.context === "iframe-child" ? target.frameId : undefined;
    const candidates = Array.from(this.frames.values()).filter((state) => {
      if (frameId && state.frameId !== frameId) return false;
      if (target.appId && target.appId !== this.options.appId) return false;
      if (
        target.instance &&
        (state.instance ?? DEFAULT_INSTANCE) !== target.instance
      )
        return false;
      if (target.origin && state.origin !== target.origin) return false;
      return true;
    });
    const match = candidates[0];
    if (!match)
      throw new IframeAdapterError(
        "No iframe matched target descriptor",
        "E_IFRAME_TARGET_NOT_FOUND",
      );
    return match;
  }

  private closeFrame(state: ParentFrameState): void {
    if (state.router) VirtualPortRouter.safeClose(state.router);
    state.router = undefined;
  }

  private resetFrame(state: ParentFrameState): void {
    if (state.router) VirtualPortRouter.safeClose(state.router);
    state.router = undefined;
  }

  private createMeta(state: ParentFrameState): IframePlatformMeta {
    return createPlatformMeta({
      transport: "iframe-postmessage",
      appId: this.options.appId,
      channel: this.options.channel ?? DEFAULT_CHANNEL,
      frameId: state.frameId,
      localRole: "iframe-parent",
      remoteRole: "iframe-child",
      origin: state.origin,
      expectedOrigin: state.origin,
      sourceMatched: true,
      originMatched: true,
      nonceMatched: true,
      trusted: true,
    });
  }
}
