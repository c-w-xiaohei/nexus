import { createContext, type ReactNode } from "react";
import type { NexusInstance } from "@nexus-js/core";

export const NexusContext = createContext<NexusInstance | null>(null);

export interface NexusProviderProps {
  readonly nexus: NexusInstance;
  readonly children: ReactNode;
}

export const NexusProvider = ({ nexus, children }: NexusProviderProps) => {
  return (
    <NexusContext.Provider value={nexus}>{children}</NexusContext.Provider>
  );
};
