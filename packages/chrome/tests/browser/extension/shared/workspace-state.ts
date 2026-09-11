import { createStoreToken } from "@nexus-js/core/state";

export interface WorkspaceState {
  readonly count: number;
}

export type WorkspaceStateActions = {
  increment(): Promise<number>;
};

export const WorkspaceStateToken = createStoreToken<
  WorkspaceState & WorkspaceStateActions
>("nexus-e2e:workspace-state");

export const workspaceStateDefinition = WorkspaceStateToken;

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
