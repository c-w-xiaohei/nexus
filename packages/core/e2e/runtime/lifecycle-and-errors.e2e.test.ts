/**
 * Simulates unstable network/runtime conditions where clients lose transport
 * connectivity, hosts disappear, or remote methods fail, validating end-to-end
 * lifecycle guarantees and error translation at the Nexus API boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Nexus } from "../../src/api/nexus";
import { Token } from "../../src/api/token";
import type { IEndpoint } from "../../src/transport";
import { DecoratorRegistry } from "../../src/api/registry";
import { LogicalConnection } from "../../src/connection/logical-connection";
import { CallProcessor } from "../../src/service/call-processor";

import {
  type AppPlatformMeta,
  type AppUserMeta,
  type IBackgroundService,
  BackgroundServiceToken,
  ContentScriptServiceToken,
  createIssueCompanionWorld,
  type IssueCompanionWorld,
  teardownIssueCompanionWorld,
} from "../fixtures";

describe("Nexus L4 E2E: Connection Lifecycle and Error Handling", () => {
  let world: IssueCompanionWorld;

  beforeEach(async () => {
    world = await createIssueCompanionWorld();
  });

  afterEach(() => {
    teardownIssueCompanionWorld(world);
    world = undefined as never;
  });

  it("should reject with a connection error if the host is unreachable", async () => {
    DecoratorRegistry.clear();

    const clientMeta: AppUserMeta = { context: "popup" };
    const hostDescriptor = { context: "background" } as const;
    const UnreachableToken = new Token<IBackgroundService>("unreachable");

    const failingEndpoint: IEndpoint<any, any> = {
      connect: vi.fn(async () => {
        throw new Error("Simulated connection failure: Host not found");
      }),
      listen: vi.fn(),
    };

    const client = new Nexus<AppUserMeta, AppPlatformMeta>().configure({
      endpoint: {
        meta: clientMeta,
        implementation: failingEndpoint,
      },
    });

    await expect(
      client.create(UnreachableToken, {
        target: { descriptor: hostDescriptor },
      }),
    ).rejects.toThrow("Failed to resolve connection");
  });

  it("should reject subsequent calls on a proxy after connection is closed", async () => {
    const bgApi = await world.popup.nexus.create(BackgroundServiceToken, {
      target: { descriptor: { context: "background" } },
    });
    expect(bgApi).toBeDefined();

    const settings = await bgApi.getSettings();
    expect(settings.showAvatars).toBe(true);

    const popupCm = (world.popup.nexus as any).connectionManager;
    const connection = Array.from(
      (popupCm as any).connections.values(),
    )[0] as LogicalConnection<any, any>;
    (connection as any).close();

    await vi.waitFor(() => {
      expect((popupCm as any).connections.size).toBe(0);
    });

    await expect(bgApi.getSettings()).rejects.toBeInstanceOf(
      CallProcessor.Error.Disconnected,
    );
  });

  it("should auto-cleanup resources on the host when a client disconnects", async () => {
    const bgApi = await world.cs1.nexus.create(BackgroundServiceToken, {
      target: { descriptor: { context: "background" } },
    });
    const bgResourceManager = (world.background.nexus as any).engine
      .resourceManager;
    const initialProxyCount = bgResourceManager.countRemoteProxies();

    const onNewComment = vi.fn();
    await bgApi.subscribeToComments("CS1-cleanup", onNewComment);

    expect(bgResourceManager.countRemoteProxies()).toBeGreaterThan(
      initialProxyCount,
    );

    const cs1Cm = (world.cs1.nexus as any).connectionManager;
    const connection = Array.from(
      (cs1Cm as any).connections.values(),
    )[0] as LogicalConnection<any, any>;
    (connection as any).close();

    await vi.waitFor(() => {
      expect(bgResourceManager.countRemoteProxies()).toBe(initialProxyCount);
    });
  });

  it("should release callback proxy resources on unsubscribe while connection remains alive", async () => {
    const bgApi = await world.cs1.nexus.create(BackgroundServiceToken, {
      target: { descriptor: { context: "background" } },
    });
    const bgResourceManager = (world.background.nexus as any).engine
      .resourceManager;
    const initialProxyCount = bgResourceManager.countRemoteProxies();

    const callback = vi.fn();
    const subId = await bgApi.subscribeToComments(
      "CS1-live-unsubscribe",
      callback,
    );

    await vi.waitFor(() => {
      expect(bgResourceManager.countRemoteProxies()).toBeGreaterThan(
        initialProxyCount,
      );
    });

    await bgApi.unsubscribe(subId);

    await vi.waitFor(() => {
      expect(bgResourceManager.countRemoteProxies()).toBe(initialProxyCount);
    });

    const cs1Cm = (world.cs1.nexus as any).connectionManager;
    expect((cs1Cm as any).connections.size).toBeGreaterThan(0);
  });

  it("should propagate errors from remote back to caller", async () => {
    const contentApi = await world.background.nexus.create(
      ContentScriptServiceToken,
      {
        target: {
          matcher: (id: AppUserMeta) =>
            id.context === "content-script" && id.issueId === "CS1",
        },
        expects: "one",
      },
    );

    const promise = contentApi.highlightUser("non-existent-user");

    await expect(promise).rejects.toBeInstanceOf(CallProcessor.Error.Remote);
    await expect(promise).rejects.toThrow(/User "non-existent-user" not found/);
  });

  it("safeUpdateIdentity should wait for initialization and succeed", async () => {
    const isolated = new Nexus<AppUserMeta, AppPlatformMeta>().configure({
      endpoint: {
        meta: { context: "background", version: "1.0" },
        implementation: {},
      },
    });

    const result = await isolated.safeUpdateIdentity({ version: "2.0" });
    expect(result.isOk()).toBe(true);
  });

  it("safeUpdateIdentity should return usage error for invalid payload", async () => {
    const result = await world.background.nexus.safeUpdateIdentity(
      null as unknown as Partial<AppUserMeta>,
    );
    expect(result.isErr()).toBe(true);
  });
});
