import { Token } from "@nexus-js/core";
import {
  defineNexusStore,
  type NexusStoreServiceContract,
} from "@nexus-js/core/state";

export interface WorkspaceState {
  readonly count: number;
}

export interface WorkspaceStateActions extends Record<
  string,
  (...args: any[]) => any
> {
  increment(): Promise<number>;
}

export const WorkspaceStateToken = new Token<
  NexusStoreServiceContract<WorkspaceState, WorkspaceStateActions>
>("nexus-e2e:workspace-state");

export const workspaceStateDefinition = defineNexusStore<
  WorkspaceState,
  WorkspaceStateActions
>({
  token: WorkspaceStateToken,
  state: () => ({ count: 0 }),
  actions: ({ getState, setState }) => ({
    async increment() {
      const count = getState().count + 1;
      setState({ count });
      return count;
    },
  }),
});
