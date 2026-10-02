import { resolveTransportConfig } from "@nexus-js/core/transport/config";
import { IframeAdapterError } from "./errors.js";
import type {
  EndpointCapabilities,
  IframeChildEndpointOptions,
  IframeParentEndpointOptions,
} from "./types.js";

export function resolveIframeTransport(
  options: IframeParentEndpointOptions | IframeChildEndpointOptions,
) {
  if ("binaryPackets" in options)
    throw new IframeAdapterError(
      "Use transport.binaryPackets to select iframe packet mode",
      "E_IFRAME_CONFIG_INVALID",
    );
  const { binaryPackets = true, ...limits } = options.transport ?? {};
  try {
    return resolveTransportConfig(limits, binaryPackets);
  } catch (error) {
    throw new IframeAdapterError(
      error instanceof Error
        ? error.message
        : "Invalid iframe transport config",
      "E_IFRAME_CONFIG_INVALID",
    );
  }
}

export const endpointCapabilities: EndpointCapabilities = Object.freeze({
  binaryPackets: true,
  transferables: true,
});
