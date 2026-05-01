import type { EndpointCapabilities } from "./types";

export function createCapabilities(
  binaryPackets?: boolean,
): EndpointCapabilities {
  return { binaryPackets: binaryPackets !== false, transferables: true };
}
