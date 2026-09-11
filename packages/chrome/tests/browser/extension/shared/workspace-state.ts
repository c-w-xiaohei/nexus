import { Token } from "@nexus-js/core";
import type { NexusStoreServiceContract } from "@nexus-js/core/state";

export interface WorkspaceState {
  readonly count: number;
}

export type WorkspaceStateActions = {
  increment(): Promise<number>;
};

export const WorkspaceStateToken = new Token<
  NexusStoreServiceContract<WorkspaceState, WorkspaceStateActions>
>("nexus-e2e:workspace-state");

export const workspaceStateDefinition = {
  token: WorkspaceStateToken,
};

export const workspaceStateCreator = (
  set: (state: Partial<WorkspaceState>) => void,
  get: () => WorkspaceState,
) => ({
  count: 0,
  async increment() {
    const count = get().count + 1;
    set({ count });
    return count;
  },
});
