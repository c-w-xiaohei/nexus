import React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createNexusScope, useStoreSelector } from "../src";
import {
  createCounterDefinition,
  createReactNexusHarness,
  type CounterHarness,
  type ReactAdapterModel,
} from "./fixtures";

const ReactNexusScope = createNexusScope<ReactAdapterModel>();

const createWrapper = (harness: CounterHarness) => {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <ReactNexusScope.NexusProvider nexus={harness.client.nexus}>
        {children}
      </ReactNexusScope.NexusProvider>
    );
  };
};

describe("react integration", () => {
  it("provider + useRemoteStore connects to a real registered store", async () => {
    const harness = await createReactNexusHarness({
      hosts: [{ id: "host-a", initialCount: 0 }],
    });

    try {
      const definition = createCounterDefinition();
      const wrapper = createWrapper(harness);
      const { result } = renderHook(
        () =>
          ReactNexusScope.useRemoteStore(definition, {
            target: { context: "host", hostId: "host-a" },
          }),
        { wrapper },
      );

      await waitFor(() => {
        expect(result.current.status.type).toBe("ready");
        expect(result.current.store).not.toBeNull();
        expect(result.current.store?.getState().count).toBe(0);
      });
    } finally {
      harness.teardown();
    }
  });

  it("action updates become visible through useStoreSelector", async () => {
    const harness = await createReactNexusHarness({
      hosts: [{ id: "host-a", initialCount: 0 }],
    });

    try {
      const definition = createCounterDefinition();
      const wrapper = createWrapper(harness);
      const { result } = renderHook(
        () => {
          const remote = ReactNexusScope.useRemoteStore(definition, {
            target: { context: "host", hostId: "host-a" },
          });
          const selected = useStoreSelector(remote, (state) => state.count, {
            fallback: -1,
          });
          return { remote, selected };
        },
        { wrapper },
      );

      await waitFor(() => {
        expect(result.current.remote.status.type).toBe("ready");
      });

      await act(async () => {
        await result.current.remote.store?.actions.increment(2);
      });

      await waitFor(() => {
        expect(result.current.selected).toBe(2);
      });
    } finally {
      harness.teardown();
    }
  });

  it("transport disconnect becomes hook-visible disconnected", async () => {
    const harness = await createReactNexusHarness({
      hosts: [{ id: "host-a", initialCount: 1 }],
    });

    try {
      const definition = createCounterDefinition();
      const wrapper = createWrapper(harness);
      const { result } = renderHook(
        () =>
          ReactNexusScope.useRemoteStore(definition, {
            target: { context: "host", hostId: "host-a" },
          }),
        { wrapper },
      );

      await waitFor(() => {
        expect(result.current.status.type).toBe("ready");
      });

      harness.disconnectHost("host-a");

      await waitFor(() => {
        expect(result.current.status.type).toBe("disconnected");
        expect(result.current.error).toBeNull();
      });
    } finally {
      harness.teardown();
    }
  });

  it("target change transitions stale/fallback before ready replacement", async () => {
    const harness = await createReactNexusHarness({
      hosts: [
        { id: "host-a", initialCount: 7 },
        { id: "host-b", initialCount: 100, connectDelayMs: 60 },
      ],
    });

    try {
      const definition = createCounterDefinition();
      const wrapper = createWrapper(harness);
      const { result, rerender } = renderHook(
        ({ hostId }) => {
          const remote = ReactNexusScope.useRemoteStore(definition, {
            target: { context: "host", hostId },
          });
          const selected = useStoreSelector(remote, (state) => state.count, {
            fallback: -1,
          });
          return { remote, selected };
        },
        {
          initialProps: { hostId: "host-a" },
          wrapper,
        },
      );

      await waitFor(() => {
        expect(result.current.remote.status.type).toBe("ready");
        expect(result.current.selected).toBe(7);
      });

      rerender({ hostId: "host-b" });

      await act(async () => {
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(result.current.remote.status.type).toBe("ready");
        expect(result.current.selected).toBe(100);
      });
    } finally {
      harness.teardown();
    }
  });

  it("unmount destroys active remote store/subscription path", async () => {
    const harness = await createReactNexusHarness({
      hosts: [{ id: "host-a", initialCount: 0 }],
    });

    try {
      const definition = createCounterDefinition();
      const wrapper = createWrapper(harness);
      const { result, unmount } = renderHook(
        () =>
          ReactNexusScope.useRemoteStore(definition, {
            target: { context: "host", hostId: "host-a" },
          }),
        { wrapper },
      );

      await waitFor(() => {
        expect(result.current.status.type).toBe("ready");
      });

      await waitFor(() => {
        expect(harness.getHostSubscriptions("host-a")).toBe(1);
      });

      unmount();

      await waitFor(() => {
        expect(harness.getHostSubscriptions("host-a")).toBe(0);
      });
    } finally {
      harness.teardown();
    }
  });
});
