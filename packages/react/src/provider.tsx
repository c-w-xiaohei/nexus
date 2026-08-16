import type { AdapterModel } from "@nexus-js/core";
import { createNexusScope } from "./create-nexus-scope.js";
import type { NexusProviderProps as ScopeNexusProviderProps } from "./create-nexus-scope.js";

const defaultNexusScope = createNexusScope<AdapterModel>();

export type NexusProviderProps = ScopeNexusProviderProps<AdapterModel>;

export const NexusProvider = defaultNexusScope.NexusProvider;
export const useDefaultNexus = defaultNexusScope.useNexus;
