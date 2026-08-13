import type { EndpointCapabilities } from "./types.js";

export function createCapabilities(
  binaryPackets?: boolean,
): EndpointCapabilities {
  return { binaryPackets: binaryPackets !== false, transferables: true };
}
