import React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createNexusScope, useStoreStatus } from "../src";
import { useStore } from "zustand";
import { connectNexusStore } from "@nexus-js/core/state";
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
  it("selects a real remote handle with Zustand's useStore", async () => {
    const harness = await createReactNexusHarness({
      hosts: [{ id: "host-a", initialCount: 0 }],
    });
    try {
      const remote = await connectNexusStore(
        harness.client.nexus,
        createCounterDefinition(),
        {
          target: { context: "host", hostId: "host-a" },
        },
      );
      const { result, unmount } = renderHook(() =>
        useStore(remote, (state) => state.count),
      );
      expect(result.current).toBe(0);
      await act(async () => {
        await remote.actions.increment(2);
      });
      expect(result.current).toBe(2);
      unmount();
      remote.destroy();
    } finally {
      harness.teardown();
    }
  });

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
        expect(result.current.store).not.toBeNull();
        expect(result.current.store?.getState().count).toBe(0);
      });
    } finally {
      harness.teardown();
    }
  });

  it("scope selection observes remote action updates", async () => {
    const harness = await createReactNexusHarness({
      hosts: [{ id: "host-a", initialCount: 0 }],
    });

    try {
      const definition = createCounterDefinition();
      const CounterScope = ReactNexusScope.createRemoteStoreScope(definition);
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <ReactNexusScope.NexusProvider nexus={harness.client.nexus}>
          <CounterScope.Provider
            options={{
              target: { context: "host", hostId: "host-a" },
            }}
          >
            {children}
          </CounterScope.Provider>
        </ReactNexusScope.NexusProvider>
      );
      const { result } = renderHook(
        () => {
          const remote = CounterScope.useRemoteStore();
          const selected = CounterScope.useSelector((state) => state.count, {
            fallback: -1,
          });
          return { remote, selected };
        },
        { wrapper },
      );

      await waitFor(() => {
        expect(result.current.remote.store).not.toBeNull();
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
        () => {
          const remote = ReactNexusScope.useRemoteStore(definition, {
            target: { context: "host", hostId: "host-a" },
          });
          const phase = useStoreStatus(remote.store, (status) => status.type);
          return { remote, phase };
        },
        { wrapper },
      );

      await waitFor(() => {
        expect(result.current.remote.store).not.toBeNull();
      });

      harness.disconnectHost("host-a");

      await waitFor(() => {
        expect(result.current.phase).toBe("disconnected");
        expect(result.current.remote.error).toBeNull();
      });
    } finally {
      harness.teardown();
    }
  });

  it("target change clears acquisition and selector fallback before replacement", async () => {
    const harness = await createReactNexusHarness({
      hosts: [
        { id: "host-a", initialCount: 7 },
        { id: "host-b", initialCount: 100, connectDelayMs: 60 },
      ],
    });

    try {
      const definition = createCounterDefinition();
      const CounterScope = ReactNexusScope.createRemoteStoreScope(definition);
      let hostId = "host-a";
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <ReactNexusScope.NexusProvider nexus={harness.client.nexus}>
          <CounterScope.Provider
            options={{
              target: { context: "host", hostId },
            }}
          >
            {children}
          </CounterScope.Provider>
        </ReactNexusScope.NexusProvider>
      );
      const { result, rerender } = renderHook(
        () => {
          const remote = CounterScope.useRemoteStore();
          const selected = CounterScope.useSelector((state) => state.count, {
            fallback: -1,
          });
          return { remote, selected };
        },
        { wrapper },
      );

      await waitFor(() => {
        expect(result.current.remote.store).not.toBeNull();
        expect(result.current.selected).toBe(7);
      });

      hostId = "host-b";
      rerender();

      await waitFor(() => {
        expect(result.current.remote.pending).toBe(true);
        expect(result.current.selected).toBe(-1);
      });

      await waitFor(() => {
        expect(harness.getHostSubscriptions("host-a")).toBe(0);
        expect(result.current.remote.store).not.toBeNull();
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
        expect(result.current.store).not.toBeNull();
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
