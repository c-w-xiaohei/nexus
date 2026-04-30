import {
  nexus,
  type IEndpoint,
  type IPort,
  type NexusConfig,
  type NexusInstance,
  type TargetCriteria,
} from "@nexus-js/core";
import { VirtualPortRouter } from "@nexus-js/core/transport/virtual-port";

export type IframeParentMeta = {
  context: "iframe-parent";
  appId: string;
  instance?: string;
  origin: string;
};
export type IframeChildMeta = {
  context: "iframe-child";
  appId: string;
  instance?: string;
  origin: string;
  frameId: string;
};
export type IframeUserMeta = IframeParentMeta | IframeChildMeta;

export type IframePlatformMeta = {
  transport: "iframe-postmessage";
  appId: string;
  channel: string;
  frameId?: string;
  localRole: "iframe-parent" | "iframe-child";
  remoteRole: "iframe-parent" | "iframe-child";
  origin: string;
  expectedOrigin: string;
  sourceMatched: boolean;
  originMatched: boolean;
  nonceMatched: boolean;
  trusted: boolean;
};

export type IframeAdapterErrorCode =
  | "E_IFRAME_CONFIG_INVALID"
  | "E_IFRAME_TARGET_NOT_FOUND"
  | "E_IFRAME_CONNECT_FAILED";

export class IframeAdapterError extends Error {
  constructor(
    message: string,
    readonly code: IframeAdapterErrorCode,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "IframeAdapterError";
  }
}

export type IframeFrameTarget = {
  frameId: string;
  iframe: HTMLIFrameElement;
  origin: string;
  nonce?: string;
  instance?: string;
};

export type IframeParentEndpointOptions = {
  appId: string;
  instance?: string;
  window?: Window;
  localWindow?: Window;
  frames: readonly IframeFrameTarget[];
  channel?: string;
  allowAnyOrigin?: boolean;
  binaryPackets?: boolean;
};

export type IframeChildEndpointOptions = {
  appId: string;
  instance?: string;
  frameId?: string;
  window?: Window;
  localWindow?: Window;
  parentOrigin: string;
  channel?: string;
  nonce?: string;
  allowAnyOrigin?: boolean;
  binaryPackets?: boolean;
};

export type IframeParentOptions = IframeParentEndpointOptions &
  Omit<
    NexusConfig<IframeUserMeta, IframePlatformMeta>,
    "endpoint" | "matchers" | "descriptors"
  > & { configure?: true };
export type IframeParentConfigOptions = Omit<
  IframeParentOptions,
  "configure"
> & { configure: false };
export type IframeChildOptions = IframeChildEndpointOptions &
  Omit<
    NexusConfig<IframeUserMeta, IframePlatformMeta>,
    "endpoint" | "matchers" | "descriptors"
  > & {
    configure?: true;
    connectTo?: readonly TargetCriteria<IframeUserMeta, string, string>[];
  };
export type IframeChildConfigOptions = Omit<IframeChildOptions, "configure"> & {
  configure: false;
};

type EndpointCapabilities = NonNullable<
  IEndpoint<IframeUserMeta, IframePlatformMeta>["capabilities"]
>;
type WindowLike = Window & { parent?: Window | null; location?: Location };
type MessageEnvelope = {
  __nexusIframe: true;
  appId: string;
  channel: string;
  nonce?: string;
  payload: unknown;
};

const DEFAULT_CHANNEL = "nexus:iframe";
const DEFAULT_INSTANCE = "default";

export const IframeMatchers = {
  parent: (appId: string) => (identity: IframeUserMeta) =>
    identity.context === "iframe-parent" && identity.appId === appId,
  child: (appId: string) => (identity: IframeUserMeta) =>
    identity.context === "iframe-child" && identity.appId === appId,
  instance: (name: string) => (identity: IframeUserMeta) =>
    (identity.instance ?? DEFAULT_INSTANCE) === name,
  origin: (origin: string) => (identity: IframeUserMeta) =>
    identity.origin === origin,
  frame: (frameId: string) => (identity: IframeUserMeta) =>
    identity.context === "iframe-child" && identity.frameId === frameId,
};

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
    return [port, this.createMeta(state, "outgoing")];
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
      this.onConnect?.(port, this.createMeta(state, "incoming")),
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
    return {
      __nexusIframe: true,
      appId: this.options.appId,
      channel: this.options.channel ?? DEFAULT_CHANNEL,
      nonce,
      payload,
    };
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

  private createMeta(
    state: ParentFrameState,
    direction: "incoming" | "outgoing",
  ): IframePlatformMeta {
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
      trusted: direction === "incoming" || direction === "outgoing",
    });
  }
}

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
    return {
      __nexusIframe: true,
      appId: this.options.appId,
      channel: this.options.channel ?? DEFAULT_CHANNEL,
      nonce: this.options.nonce,
      payload,
    };
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

type ParentFrameState = IframeFrameTarget & {
  router?: VirtualPortRouter.Context;
  removeLoad: () => void;
};

export function usingIframeParent(
  options: IframeParentConfigOptions,
): NexusConfig<IframeUserMeta, IframePlatformMeta>;
export function usingIframeParent(
  options: IframeParentOptions,
): NexusInstance<IframeUserMeta, IframePlatformMeta>;
export function usingIframeParent(
  options: IframeParentOptions | IframeParentConfigOptions,
) {
  const instance = options.instance ?? DEFAULT_INSTANCE;
  const origin = getOrigin(options.localWindow ?? options.window);
  const config: NexusConfig<IframeUserMeta, IframePlatformMeta> = {
    ...options,
    endpoint: {
      meta: {
        context: "iframe-parent",
        appId: options.appId,
        instance,
        origin,
      },
      implementation: new IframeParentEndpoint(options),
    },
    matchers: baseMatchers(options.appId, instance),
    descriptors: Object.fromEntries(
      options.frames.map((frame, index) => [
        index === 0 ? "child" : `child:${frame.frameId}`,
        {
          context: "iframe-child",
          appId: options.appId,
          instance: frame.instance ?? instance,
          frameId: frame.frameId,
          origin: frame.origin,
        },
      ]),
    ) as Record<string, Partial<IframeUserMeta>>,
  };
  return options.configure === false ? config : nexus.configure(config);
}

export function usingIframeChild(
  options: IframeChildConfigOptions,
): NexusConfig<IframeUserMeta, IframePlatformMeta>;
export function usingIframeChild(
  options: IframeChildOptions,
): NexusInstance<IframeUserMeta, IframePlatformMeta>;
export function usingIframeChild(
  options: IframeChildOptions | IframeChildConfigOptions,
) {
  const instance = options.instance ?? DEFAULT_INSTANCE;
  const frameId = options.frameId ?? "default";
  const config: NexusConfig<IframeUserMeta, IframePlatformMeta> = {
    ...options,
    endpoint: {
      meta: {
        context: "iframe-child",
        appId: options.appId,
        instance,
        origin: getOrigin(options.localWindow ?? options.window),
        frameId,
      },
      implementation: new IframeChildEndpoint({ ...options, frameId }),
      connectTo: options.connectTo,
    },
    matchers: baseMatchers(options.appId, instance),
    descriptors: {
      parent: {
        context: "iframe-parent",
        appId: options.appId,
        instance,
        origin: options.parentOrigin,
      },
    },
  };
  return options.configure === false ? config : nexus.configure(config);
}

function baseMatchers(appId: string, instance: string) {
  return {
    parent: IframeMatchers.parent(appId),
    child: IframeMatchers.child(appId),
    instance: IframeMatchers.instance(instance),
  };
}

function createCapabilities(binaryPackets?: boolean): EndpointCapabilities {
  return { binaryPackets: binaryPackets === true, transferables: true };
}

function validateAppId(appId: string): void {
  if (!appId)
    throw new IframeAdapterError(
      "Iframe appId must not be empty",
      "E_IFRAME_CONFIG_INVALID",
    );
}

function validateOrigin(origin: string, allowAnyOrigin?: boolean): void {
  if (!origin)
    throw new IframeAdapterError(
      "Iframe target origin is required",
      "E_IFRAME_CONFIG_INVALID",
    );
  if (origin === "*" && allowAnyOrigin !== true)
    throw new IframeAdapterError(
      "Iframe '*' origin requires allowAnyOrigin:true",
      "E_IFRAME_CONFIG_INVALID",
    );
}

function originMatches(
  actual: string,
  expected: string,
  allowAnyOrigin?: boolean,
): boolean {
  return expected === "*" && allowAnyOrigin === true
    ? true
    : actual === expected;
}

function readEnvelope(value: unknown): MessageEnvelope | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Partial<MessageEnvelope>;
  if (
    record.__nexusIframe !== true ||
    typeof record.appId !== "string" ||
    typeof record.channel !== "string"
  )
    return undefined;
  return record as MessageEnvelope;
}

function getWindow(localWindow?: Window): Window {
  if (localWindow) return localWindow;
  if (typeof window !== "undefined") return window;
  throw new IframeAdapterError(
    "Iframe window is required outside browser globals",
    "E_IFRAME_CONFIG_INVALID",
  );
}

function getOrigin(localWindow?: Window): string {
  const value =
    (getWindow(localWindow) as WindowLike).origin ??
    (getWindow(localWindow) as WindowLike).location?.origin;
  if (!value)
    throw new IframeAdapterError(
      "Iframe window origin is unavailable",
      "E_IFRAME_CONFIG_INVALID",
    );
  return value;
}

function createPlatformMeta(meta: IframePlatformMeta): IframePlatformMeta {
  return meta;
}

function postMessageFrom(
  source: Window,
  target: Window,
  message: unknown,
  targetOrigin: string,
  transfer?: Transferable[],
): void {
  const fakeDeliver = (
    source as unknown as {
      deliver?: (
        target: Window,
        data: unknown,
        targetOrigin?: string,
        transfer?: Transferable[],
      ) => void;
    }
  ).deliver;
  if (typeof fakeDeliver === "function") {
    fakeDeliver.call(source, target, message, targetOrigin, transfer);
    return;
  }
  target.postMessage(message, targetOrigin, transfer);
}
