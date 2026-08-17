import type {
  AdapterModel,
  IEndpoint,
  NexusConfig,
  NexusInstance,
} from "@nexus-js/core";
import type { VirtualPortRouter } from "@nexus-js/core/transport/virtual-port";

export type IframeParentMeta = {
  readonly context: "iframe-parent";
  readonly appId: string;
  readonly instance?: string;
  readonly origin: string;
};

export type IframeChildMeta = {
  readonly context: "iframe-child";
  readonly appId: string;
  readonly instance?: string;
  readonly origin: string;
  readonly frameId: string;
};

export type IframeContextMeta = IframeParentMeta | IframeChildMeta;

/** Exact target for connecting an iframe child to its parent. */
export type IframeParentConnectionTarget = {
  readonly context: "iframe-parent";
  readonly appId: string;
  readonly instance?: string;
  readonly origin: string;
};

/** Target for a configured parent frame. `frameId` identifies one frame. */
export type IframeChildConnectionTarget = {
  readonly context: "iframe-child";
  readonly frameId: string;
  readonly appId?: string;
  readonly instance?: string;
  readonly origin?: string;
};

export type IframeConnectionTarget =
  | IframeParentConnectionTarget
  | IframeChildConnectionTarget;

export type IframeConnectionFacts = {
  readonly sourceMatched: boolean;
  readonly originMatched: boolean;
  readonly nonceMatched: boolean;
  readonly trusted: boolean;
};

export type IframeConnectionMeta = {
  readonly transport: "iframe-postmessage";
  readonly appId: string;
  readonly channel: string;
  readonly frameId?: string;
  readonly localRole: "iframe-parent" | "iframe-child";
  readonly remoteRole: "iframe-parent" | "iframe-child";
  readonly origin: string;
  readonly expectedOrigin: string;
  /** Own, immutable validation facts for this connection session. */
  readonly facts: IframeConnectionFacts;
};

export interface IframeAdapterModel extends AdapterModel {
  contextMeta: IframeContextMeta;
  connectionMeta: IframeConnectionMeta;
  connectionTarget: IframeConnectionTarget;
}

export type EndpointCapabilities = NonNullable<
  IEndpoint<IframeAdapterModel>["capabilities"]
>;

export type WindowLike = Window & {
  parent?: Window | null;
  location?: Location;
};

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
  /**
   * Overrides the core virtual-port heartbeat used to detect unresponsive
   * iframe links. Defaults to the core heartbeat interval and miss count
   * (5000ms / 3 misses unless core changes them); mostly useful for tests or
   * environments that need faster or slower disconnect detection.
   */
  heartbeat?: VirtualPortRouter.HeartbeatOptions;
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
  /**
   * Overrides the core virtual-port heartbeat used to detect unresponsive
   * iframe links. Defaults to the core heartbeat interval and miss count
   * (5000ms / 3 misses unless core changes them); mostly useful for tests or
   * environments that need faster or slower disconnect detection.
   */
  heartbeat?: VirtualPortRouter.HeartbeatOptions;
};

export type IframeParentOptions = IframeParentEndpointOptions &
  Omit<NexusConfig<IframeAdapterModel>, "endpoint"> & { configure?: true };

export type IframeParentConfigOptions = Omit<
  IframeParentOptions,
  "configure"
> & { configure: false };

export type IframeChildOptions = IframeChildEndpointOptions &
  Omit<NexusConfig<IframeAdapterModel>, "endpoint"> & {
    configure?: true;
    defaultTarget?: IframeParentConnectionTarget;
  };

export type IframeChildConfigOptions = Omit<IframeChildOptions, "configure"> & {
  configure: false;
};

export type IframeParentResult = NexusConfig<IframeAdapterModel>;
export type IframeParentConfigured = NexusInstance<IframeAdapterModel>;
