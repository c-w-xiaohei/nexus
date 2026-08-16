import type { AdapterModel, NexusInstance } from "@nexus-js/core";
import { useDefaultNexus } from "./provider.js";

export const useNexus = (): NexusInstance<AdapterModel> => {
  return useDefaultNexus();
};
