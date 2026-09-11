import { memo } from "react";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createNexusScope } from "../src";
import {
  createCounterDefinition,
  createReactNexusHarness,
  type ReactAdapterModel,
} from "./fixtures";

describe("remote store render isolation", () => {
  it("does not render the owner for snapshots or a disconnected handle", async () => {
    const harness = await createReactNexusHarness({ hosts: [{ id: "host" }] });
    const scope = createNexusScope<ReactAdapterModel>();
    const definition = createCounterDefinition();
    let renders = 0;
    const { result, unmount } = renderHook(
      () => {
        renders++;
        return scope.useRemoteStore(definition, {
          target: { context: "host", hostId: "host" },
        });
      },
      {
        wrapper: ({ children }) => (
          <scope.NexusProvider nexus={harness.client.nexus}>
            {children}
          </scope.NexusProvider>
        ),
      },
    );
    try {
      await waitFor(() => expect(result.current.store).not.toBeNull());
      const acquired = result.current;
      const before = renders;
      await act(async () => {
        await acquired.store!.actions.increment(1);
      });
      expect(acquired.store!.getState().count).toBe(1);
      act(() => harness.disconnectHost("host"));
      await waitFor(() =>
        expect(acquired.store!.getStatus().type).toBe("disconnected"),
      );
      expect(result.current).toBe(acquired);
      expect(result.current.pending).toBe(false);
      expect(result.current.error).toBeNull();
      expect(renders).toBe(before);
    } finally {
      unmount();
      harness.teardown();
    }
  });

  it("only renders consumers whose selected values change", async () => {
    const harness = await createReactNexusHarness({ hosts: [{ id: "host" }] });
    const nexusScope = createNexusScope<ReactAdapterModel>();
    const scope = nexusScope.createRemoteStoreScope(createCounterDefinition());
    const renders = {
      owner: 0,
      actions: 0,
      error: 0,
      parity: 0,
      count: 0,
      phase: 0,
      version: 0,
    };
    let remote: ReturnType<typeof scope.useRemoteStore> | undefined;
    let phase: string | null = null;
    const Owner = memo(() => {
      remote = scope.useRemoteStore();
      renders.owner++;
      return null;
    });
    const Actions = memo(() => {
      scope.useActions();
      renders.actions++;
      return null;
    });
    const ErrorOnly = memo(() => {
      scope.useError();
      renders.error++;
      return null;
    });
    const Parity = memo(() => {
      const parity = scope.useSelector((state) => state.count % 2, {
        fallback: 0,
      });
      renders.parity++;
      return <output data-testid="parity">{parity}</output>;
    });
    const Count = memo(() => {
      const count = scope.useSelector((state) => state.count, { fallback: 0 });
      renders.count++;
      return <output data-testid="count">{count}</output>;
    });
    const Phase = memo(() => {
      phase = scope.useStatus((status) => status.type);
      renders.phase++;
      return null;
    });
    const Version = memo(() => {
      scope.useStatus((status) =>
        status.type === "ready" ? status.version : null,
      );
      renders.version++;
      return null;
    });
    const tree = () => (
      <nexusScope.NexusProvider nexus={harness.client.nexus}>
        <scope.Provider
          options={{ target: { context: "host", hostId: "host" } }}
        >
          <Owner />
          <Actions />
          <ErrorOnly />
          <Parity />
          <Count />
          <Phase />
          <Version />
        </scope.Provider>
      </nexusScope.NexusProvider>
    );
    const view = render(tree());
    try {
      await waitFor(() => expect(phase).toBe("ready"));
      const acquired = remote!;
      const before = { ...renders };
      view.rerender(tree());
      expect(renders).toEqual(before);

      // Await each caller ACK separately so batching cannot hide context fan-out.
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          await acquired.store!.actions.increment(2);
        });
      }
      expect(remote).toBe(acquired);
      expect(view.getByTestId("parity").textContent).toBe("0");
      expect(view.getByTestId("count").textContent).toBe("6");
      expect(renders).toEqual({
        ...before,
        count: before.count + 3,
        version: before.version + 3,
      });

      const after = { ...renders };
      act(() => harness.disconnectHost("host"));
      await waitFor(() => expect(phase).toBe("disconnected"));
      expect(remote).toBe(acquired);
      expect(renders).toEqual({
        ...after,
        phase: after.phase + 1,
        version: after.version + 1,
      });
    } finally {
      view.unmount();
      harness.teardown();
    }
  });
});
