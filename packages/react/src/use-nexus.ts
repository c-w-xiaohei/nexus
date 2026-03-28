import { useContext } from "react";
import type { NexusInstance } from "@nexus-js/core";
import { NexusContext } from "./provider";

export const useNexus = (): NexusInstance => {
  const nexus = useContext(NexusContext);
  if (!nexus) {
    throw new Error("useNexus must be used inside NexusProvider.");
  }

  return nexus;
};
