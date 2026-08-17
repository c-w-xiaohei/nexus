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
  IframeAdapterModel,
  IframeConnectionMeta,
  IframeContextMeta,
  IframeFrameTarget,
  IframeParentEndpointOptions,
} from "./types.js";
import { originMatches, validateAppId, validateOrigin } from "./validation.js";
import { getWindow, postMessageFrom } from "./window.js";

type ParentFrameState = IframeFrameTarget & {
  router?: VirtualPortRouter.Context;
  observedOrigin?: string;
  removeLoad: () => void;
};

/**
 * Parent-side endpoint. Its trust boundary is the iframe contentWindow configured
 * for each frame: matching origin is not enough when same-origin frames coexist.
 */
export class IframeParentEndpoint implements IEndpoint<IframeAdapterModel> {
  readonly capabilities: EndpointCapabilities;
  private readonly frames: ParentFrameState[] = [];
  private onConnect:
    | ((port: IPort, connectionMeta: IframeConnectionMeta) => void)
    | undefined;
  private closed = false;

  constructor(private readonly options: IframeParentEndpointOptions) {
    validateAppId(options.appId);
    this.capabilities = createCapabilities(options.binaryPackets);
    for (const frame of options.frames)
      this.frames.push(this.createFrameState(frame));
  }

  listen(
    onConnect: (port: IPort, connectionMeta: IframeConnectionMeta) => void,
  ): void {
    this.closed = false;
    this.onConnect = onConnect;
    for (const state of this.frames) {
      this.ensureRouter(state);
      this.listenFrame(state);
    }
  }

  async connect(
    target: IframeAdapterModel["connectionTarget"],
  ): Promise<{ port: IPort; connectionMeta: IframeConnectionMeta }> {
    const state = this.resolveFrame(target);
    this.ensureRouter(state);
    if (!state.router)
      throw new IframeAdapterError(
        "Iframe router is unavailable",
        "E_IFRAME_CONNECT_FAILED",
      );
    const result = await VirtualPortRouter.safeConnect(state.router);
    if (result.isErr()) {
      throw new IframeAdapterError(
        "Could not connect to iframe",
        "E_IFRAME_CONNECT_FAILED",
        result.error,
      );
    }
    const port = result.value;
    return { port, connectionMeta: this.createMeta(state) };
  }

  matchesTarget(
    target: IframeAdapterModel["connectionTarget"],
    contextMeta: IframeContextMeta,
    connectionMeta: IframeConnectionMeta,
  ): boolean {
    return matchesTarget(target, contextMeta, connectionMeta);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onConnect = undefined;
    for (const state of this.frames) {
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
      heartbeat: this.options.heartbeat,
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
          state.observedOrigin = event.origin;
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

  private resolveFrame(
    target: IframeAdapterModel["connectionTarget"],
  ): ParentFrameState {
    if (target.context !== "iframe-child" || !target.frameId)
      throw new IframeAdapterError(
        "No iframe matched target",
        "E_IFRAME_TARGET_NOT_FOUND",
      );
    const candidates = this.frames.filter((state) => {
      if (state.frameId !== target.frameId) return false;
      if (target.appId !== undefined && target.appId !== this.options.appId)
        return false;
      if (
        target.instance !== undefined &&
        (state.instance ?? DEFAULT_INSTANCE) !== target.instance
      )
        return false;
      if (
        target.origin !== undefined &&
        !(
          (target.origin === "*" && state.origin === "*") ||
          originMatches(
            target.origin,
            state.origin,
            this.options.allowAnyOrigin,
          )
        )
      )
        return false;
      return true;
    });
    if (candidates.length === 0)
      throw new IframeAdapterError(
        "No iframe matched target",
        "E_IFRAME_TARGET_NOT_FOUND",
      );
    if (candidates.length > 1)
      throw new IframeAdapterError(
        "Multiple iframes matched target",
        "E_IFRAME_TARGET_AMBIGUOUS",
      );
    const [match] = candidates;
    return match!;
  }

  private closeFrame(state: ParentFrameState): void {
    if (state.router) VirtualPortRouter.safeClose(state.router);
    state.router = undefined;
  }

  private resetFrame(state: ParentFrameState): void {
    if (state.router) VirtualPortRouter.safeClose(state.router);
    state.router = undefined;
    state.observedOrigin = undefined;
  }

  private createMeta(state: ParentFrameState): IframeConnectionMeta {
    return createConnectionMeta({
      transport: "iframe-postmessage",
      appId: this.options.appId,
      channel: this.options.channel ?? DEFAULT_CHANNEL,
      frameId: state.frameId,
      localRole: "iframe-parent",
      remoteRole: "iframe-child",
      origin: state.observedOrigin ?? state.origin,
      expectedOrigin: state.origin,
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
  if (target.context === "iframe-parent") {
    return false;
  }

  return (
    contextMeta.context === "iframe-child" &&
    (target.appId === undefined || contextMeta.appId === target.appId) &&
    (target.instance === undefined ||
      (contextMeta.instance ?? DEFAULT_INSTANCE) === target.instance) &&
    (target.origin === undefined ||
      matchesOriginTarget(target.origin, contextMeta.origin, connectionMeta)) &&
    (target.frameId === undefined ||
      connectionMeta.frameId === target.frameId) &&
    connectionMeta.appId === contextMeta.appId &&
    connectionMeta.origin === contextMeta.origin &&
    (connectionMeta.expectedOrigin === "*" ||
      connectionMeta.expectedOrigin === contextMeta.origin) &&
    connectionMeta.remoteRole === "iframe-child" &&
    isTrustedConnectionMeta(connectionMeta)
  );
};

function matchesOriginTarget(
  targetOrigin: string,
  peerOrigin: string,
  connectionMeta: IframeConnectionMeta,
): boolean {
  if (targetOrigin === "*") {
    return connectionMeta.expectedOrigin === "*" && peerOrigin !== "*";
  }
  return targetOrigin === peerOrigin && connectionMeta.origin === peerOrigin;
}
