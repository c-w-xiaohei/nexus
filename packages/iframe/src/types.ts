import type {
  IEndpoint,
  NexusConfig,
  NexusInstance,
  TargetCriteria,
} from "@nexus-js/core";
import type { VirtualPortRouter } from "@nexus-js/core/transport/virtual-port";

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
  /** True only when the MessageEvent source is the exact expected Window. */
  sourceMatched: boolean;
  /** True only when the MessageEvent origin satisfies the configured origin policy. */
  originMatched: boolean;
  /** True only when the optional channel nonce matches the configured peer nonce. */
  nonceMatched: boolean;
  /** Trusted is true only after source, origin, app id, channel, and nonce checks pass. */
  trusted: boolean;
};

export type EndpointCapabilities = NonNullable<
  IEndpoint<IframeUserMeta, IframePlatformMeta>["capabilities"]
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

export type IframeParentResult = NexusConfig<
  IframeUserMeta,
  IframePlatformMeta
>;
export type IframeParentConfigured = NexusInstance<
  IframeUserMeta,
  IframePlatformMeta
>;
