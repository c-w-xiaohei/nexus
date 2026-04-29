/**
 * Simulates unstable network/runtime conditions where clients lose transport
 * connectivity, hosts disappear, or remote methods fail, validating integration
 * lifecycle guarantees and error translation at the Nexus API boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Nexus } from "../../src/api/nexus";
import { Token } from "../../src/api/token";
import type { IEndpoint } from "../../src/transport";
import { DecoratorRegistry } from "../../src/api/registry";
import { LogicalConnection } from "../../src/connection/logical-connection";
import { CallProcessor } from "../../src/service/call-processor";
import { NexusMessageType } from "../../src/types/message";

import {
  type AppPlatformMeta,
  type AppUserMeta,
  type IBackgroundService,
  BackgroundServiceToken,
  ContentScriptServiceToken,
  createIssueCompanionWorld,
  findLogicalConnection,
  injectIncomingMessage,
  type IssueCompanionWorld,
  teardownIssueCompanionWorld,
} from "../fixtures";

describe("Nexus L4 Integration: Connection Lifecycle and Error Handling", () => {
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

  it("keeps old unicast create() proxy session-bound after replacement connection appears", async () => {
    const oldApi = await world.background.nexus.create(
      ContentScriptServiceToken,
      {
        target: { descriptor: { context: "content-script", issueId: "CS1" } },
        expects: "one",
      },
    );
    await expect(oldApi.getTitle()).resolves.toContain("CS1");

    const oldConnection = findLogicalConnection(
      world.background,
      (connection) =>
        connection.remoteIdentity?.context === "content-script" &&
        connection.remoteIdentity?.issueId === "CS1",
    );
    expect(oldConnection).toBeDefined();
    oldConnection!.close();

    const freshApi = await world.background.nexus.create(
      ContentScriptServiceToken,
      {
        target: { descriptor: { context: "content-script", issueId: "CS1" } },
        expects: "one",
      },
    );

    await expect(freshApi.getTitle()).resolves.toContain("CS1");
    await expect(oldApi.getTitle()).rejects.toBeInstanceOf(
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

  it("should ignore forged late responses from non-target connections", async () => {
    const cs1Api = await world.background.nexus.create(
      ContentScriptServiceToken,
      {
        target: { descriptor: { context: "content-script", issueId: "CS1" } },
      },
    );

    const bgCm = (world.background.nexus as any).connectionManager;
    const connections = Array.from((bgCm as any).connections.values()) as Array<
      LogicalConnection<any, any>
    >;

    const cs1Connection = connections.find(
      (connection) =>
        connection.remoteIdentity?.context === "content-script" &&
        connection.remoteIdentity?.issueId === "CS1",
    );
    const cs2Connection = connections.find(
      (connection) =>
        connection.remoteIdentity?.context === "content-script" &&
        connection.remoteIdentity?.issueId === "CS2",
    );

    expect(cs1Connection).toBeDefined();
    expect(cs2Connection).toBeDefined();

    let capturedMessageId: number | string | null = null;
    const bgEngine = (world.background.nexus as any).engine;
    const originalRegister = bgEngine.pendingCallManager.register.bind(
      bgEngine.pendingCallManager,
    );
    vi.spyOn(bgEngine.pendingCallManager, "register").mockImplementation(
      (...args: unknown[]) => {
        const [messageId, options] = args as [number | string, any];
        capturedMessageId = messageId;
        return originalRegister(messageId, options);
      },
    );

    let releaseCs1Response: () => void = () => {
      throw new Error("CS1 response release was not initialized");
    };
    vi.spyOn(world.cs1.service, "getTitle").mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseCs1Response = () => resolve("Issue CS1 - My Test Project");
        }),
    );

    let settled = false;
    const callPromise = cs1Api.getTitle().then((result) => {
      settled = true;
      return result;
    });

    await vi.waitFor(() => {
      expect(capturedMessageId).not.toBeNull();
    });

    await cs2Connection!.safeHandleMessage({
      type: NexusMessageType.RES,
      id: capturedMessageId!,
      result: "Issue CS2 - Stale",
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    releaseCs1Response();
    await expect(callPromise).resolves.toBe("Issue CS1 - My Test Project");
  });

  it("should ignore stale pre-handoff runtime responses after active target replacement", async () => {
    const initiallyActiveApi = await world.background.nexus.create(
      ContentScriptServiceToken,
      {
        target: {
          matcher: (id: AppUserMeta) =>
            id.context === "content-script" && id.isActive,
        },
        expects: "first",
      },
    );
    await expect(initiallyActiveApi.getTitle()).resolves.toContain("CS1");

    const cs1Connection = findLogicalConnection(
      world.background,
      (connection) =>
        connection.remoteIdentity?.context === "content-script" &&
        connection.remoteIdentity?.issueId === "CS1",
    );
    const cs2Connection = findLogicalConnection(
      world.background,
      (connection) =>
        connection.remoteIdentity?.context === "content-script" &&
        connection.remoteIdentity?.issueId === "CS2",
    );
    expect(cs1Connection).toBeDefined();
    expect(cs2Connection).toBeDefined();

    await world.cs1.nexus.updateIdentity({ isActive: false });
    await world.cs2.nexus.updateIdentity({ isActive: true });

    await vi.waitFor(async () => {
      const probeApi = await world.background.nexus.create(
        ContentScriptServiceToken,
        {
          target: {
            matcher: (id: AppUserMeta) =>
              id.context === "content-script" && id.isActive,
          },
          expects: "first",
        },
      );
      await expect(probeApi.getTitle()).resolves.toContain("CS2");
    });

    let capturedMessageId: number | string | null = null;
    let capturedSentConnectionIds: string[] | null = null;
    const bgEngine = (world.background.nexus as any).engine;
    const originalRegister = bgEngine.pendingCallManager.register.bind(
      bgEngine.pendingCallManager,
    );
    vi.spyOn(bgEngine.pendingCallManager, "register").mockImplementation(
      (...args: unknown[]) => {
        const [messageId, options] = args as [number | string, any];
        capturedMessageId = messageId;
        capturedSentConnectionIds = options.sentConnectionIds;
        return originalRegister(messageId, options);
      },
    );

    let releaseCs2Response: () => void = () => {
      throw new Error("CS2 response release was not initialized");
    };
    vi.spyOn(world.cs2.service, "getTitle").mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseCs2Response = () => resolve("Issue CS2 - My Test Project");
        }),
    );

    const postHandoffApi = await world.background.nexus.create(
      ContentScriptServiceToken,
      {
        target: {
          matcher: (id: AppUserMeta) =>
            id.context === "content-script" && id.isActive,
        },
        expects: "first",
      },
    );

    let settled = false;
    const callPromise = postHandoffApi.getTitle().then((result) => {
      settled = true;
      return result;
    });

    await vi.waitFor(() => {
      expect(capturedMessageId).not.toBeNull();
      expect(capturedSentConnectionIds).toEqual([cs2Connection!.connectionId]);
    });

    await injectIncomingMessage(world.background, cs1Connection!.connectionId, {
      type: NexusMessageType.RES,
      id: capturedMessageId!,
      result: "Issue CS1 - Late from stale runtime",
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    releaseCs2Response();
    await expect(callPromise).resolves.toBe("Issue CS2 - My Test Project");
  });

  it("keeps old and fresh unicast proxies session-bound during replacement overlap", async () => {
    const logicalTarget = (id: AppUserMeta) =>
      id.context === "content-script" && id.isActive;

    const oldApi = await world.background.nexus.create(
      ContentScriptServiceToken,
      {
        target: { matcher: logicalTarget },
        expects: "first",
      },
    );

    await expect(oldApi.bumpSessionCounter()).resolves.toBe(1);

    await world.cs1.nexus.updateIdentity({ isActive: false });
    await world.cs2.nexus.updateIdentity({ isActive: true });

    await vi.waitFor(async () => {
      const candidate = await world.background.nexus.create(
        ContentScriptServiceToken,
        {
          target: { matcher: logicalTarget },
          expects: "first",
        },
      );
      await expect(candidate.getTitle()).resolves.toContain("CS2");
    });

    const freshApi = await world.background.nexus.create(
      ContentScriptServiceToken,
      {
        target: { matcher: logicalTarget },
        expects: "first",
      },
    );

    await expect(freshApi.bumpSessionCounter()).resolves.toBe(1);

    await expect(oldApi.bumpSessionCounter()).resolves.toBe(2);
    await expect(freshApi.bumpSessionCounter()).resolves.toBe(2);
  });

  it("should ignore duplicate responses from the same valid target connection", async () => {
    const allTabsProxy = await world.background.nexus.createMulticast(
      ContentScriptServiceToken,
      {
        target: { matcher: (id) => id.context === "content-script" },
        expects: "all",
      },
    );

    const bgCm = (world.background.nexus as any).connectionManager;
    const connections = Array.from((bgCm as any).connections.values()) as Array<
      LogicalConnection<any, any>
    >;
    const cs1Connection = connections.find(
      (connection) =>
        connection.remoteIdentity?.context === "content-script" &&
        connection.remoteIdentity?.issueId === "CS1",
    );
    const cs2Connection = connections.find(
      (connection) =>
        connection.remoteIdentity?.context === "content-script" &&
        connection.remoteIdentity?.issueId === "CS2",
    );

    expect(cs1Connection).toBeDefined();
    expect(cs2Connection).toBeDefined();

    let capturedMessageId: number | string | null = null;
    const bgEngine = (world.background.nexus as any).engine;
    const originalRegister = bgEngine.pendingCallManager.register.bind(
      bgEngine.pendingCallManager,
    );
    vi.spyOn(bgEngine.pendingCallManager, "register").mockImplementation(
      (...args: unknown[]) => {
        const [messageId, options] = args as [number | string, any];
        capturedMessageId = messageId;
        return originalRegister(messageId, options);
      },
    );

    let releaseCs1Response: () => void = () => {
      throw new Error("CS1 replay release was not initialized");
    };
    let releaseCs2Response: () => void = () => {
      throw new Error("CS2 replay release was not initialized");
    };
    vi.spyOn(world.cs1.service, "getTitle").mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseCs1Response = () => resolve("Issue CS1 - My Test Project");
        }),
    );
    vi.spyOn(world.cs2.service, "getTitle").mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseCs2Response = () => resolve("Issue CS2 - My Test Project");
        }),
    );

    let settled = false;
    const callPromise = allTabsProxy.getTitle().then((result) => {
      settled = true;
      return result;
    });

    await vi.waitFor(() => {
      expect(capturedMessageId).not.toBeNull();
    });

    await cs1Connection!.safeHandleMessage({
      type: NexusMessageType.RES,
      id: capturedMessageId!,
      result: "Issue CS1 - Replay 1",
    });
    await cs1Connection!.safeHandleMessage({
      type: NexusMessageType.RES,
      id: capturedMessageId!,
      result: "Issue CS1 - Replay 2",
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    releaseCs1Response();
    releaseCs2Response();
    const settledResults = await callPromise;
    expect(settledResults).toHaveLength(2);
  });

  it("should not shrink pending expectations when an already-responded target disconnects", async () => {
    const allTabsProxy = await world.background.nexus.createMulticast(
      ContentScriptServiceToken,
      {
        target: { matcher: (id) => id.context === "content-script" },
        expects: "all",
      },
    );

    const bgCm = (world.background.nexus as any).connectionManager;
    const connections = Array.from((bgCm as any).connections.values()) as Array<
      LogicalConnection<any, any>
    >;
    const cs1Connection = connections.find(
      (connection) =>
        connection.remoteIdentity?.context === "content-script" &&
        connection.remoteIdentity?.issueId === "CS1",
    );
    const cs2Connection = connections.find(
      (connection) =>
        connection.remoteIdentity?.context === "content-script" &&
        connection.remoteIdentity?.issueId === "CS2",
    );

    expect(cs1Connection).toBeDefined();
    expect(cs2Connection).toBeDefined();

    let capturedMessageId: number | string | null = null;
    const bgEngine = (world.background.nexus as any).engine;
    const originalRegister = bgEngine.pendingCallManager.register.bind(
      bgEngine.pendingCallManager,
    );
    vi.spyOn(bgEngine.pendingCallManager, "register").mockImplementation(
      (...args: unknown[]) => {
        const [messageId, options] = args as [number | string, any];
        capturedMessageId = messageId;
        return originalRegister(messageId, options);
      },
    );

    let releaseCs2Response: () => void = () => {
      throw new Error("CS2 disconnect release was not initialized");
    };
    vi.spyOn(world.cs1.service, "getTitle").mockImplementation(
      () => new Promise(() => undefined),
    );
    vi.spyOn(world.cs2.service, "getTitle").mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseCs2Response = () => resolve("Issue CS2 - My Test Project");
        }),
    );

    let settled = false;
    const callPromise = allTabsProxy.getTitle().then((result) => {
      settled = true;
      return result;
    });

    await vi.waitFor(() => {
      expect(capturedMessageId).not.toBeNull();
    });

    await cs1Connection!.safeHandleMessage({
      type: NexusMessageType.RES,
      id: capturedMessageId!,
      result: "Issue CS1 - Early",
    });

    (cs1Connection as LogicalConnection<any, any>).close();

    await Promise.resolve();
    expect(settled).toBe(false);

    releaseCs2Response();
    const settledResults = await callPromise;
    expect(settledResults).toHaveLength(2);
  });
});
