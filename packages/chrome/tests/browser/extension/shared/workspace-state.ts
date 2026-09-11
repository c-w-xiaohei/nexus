import type { ChromeAdapterModel } from "@nexus-js/chrome";
import { createStoreToken } from "@nexus-js/core/state";
import type { FixtureAppMeta } from "./contracts";

export interface WorkspaceStore {
  readonly count: number;
  increment(): Promise<number>;
}

export const WorkspaceStateToken = createStoreToken<
  WorkspaceStore,
  ChromeAdapterModel<FixtureAppMeta>
>("nexus-e2e:workspace-state");

export const workspaceStateDefinition = WorkspaceStateToken;

export const workspaceStateCreator = (
  set: (state: Partial<WorkspaceStore>) => void,
  get: () => WorkspaceStore,
) => ({
  count: 0,
  async increment() {
    const count = get().count + 1;
    set({ count });
    return count;
  },
});
