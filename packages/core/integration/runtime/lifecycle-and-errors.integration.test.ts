/**
 * Simulates unstable network/runtime conditions where clients lose transport
 * connectivity, hosts disappear, or remote methods fail, validating integration
 * lifecycle guarantees and error translation at the Nexus API boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Nexus } from "../../src/api/nexus";
import { Token } from "../../src/api/token";
import type { IEndpoint, IPort } from "../../src/transport";
import { LogicalConnection } from "../../src/connection/logical-connection";
import { NexusRemoteError } from "../../src/errors/call-errors";
import { NexusDisconnectedError } from "../../src/index";
import { NexusMessageType } from "../../src/types/message";

import {
  type AppAdapterModel,
  type AppConnectionMeta,
  type AppUserMeta,
  BackgroundServiceImpl,
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
    const clientMeta: AppUserMeta = { context: "popup" };
    const hostTarget = { context: "background" } as const;
    const failingEndpoint: IEndpoint<AppAdapterModel> = {
      connect: vi.fn(async () => {
        throw new Error("Simulated connection failure: Host not found");
      }),
      listen: vi.fn(),
    };

    const client = new Nexus<AppAdapterModel>().configure({
      endpoint: {
        meta: clientMeta,
        implementation: failingEndpoint,
      },
    });

    await expect(
      client.connect({
        target: hostTarget,
      }),
    ).rejects.toMatchObject({
      code: "E_ENDPOINT_CONNECT_FAILED",
      cause: { message: "Simulated connection failure: Host not found" },
    });
  });

  it("should reject subsequent calls on a proxy after connection is closed", async () => {
    const bgApi = (
      await world.popup.nexus.connect({ target: { context: "background" } })
    ).get(BackgroundServiceToken);
    expect(bgApi).toBeDefined();

    const settings = await bgApi.getSettings();
    expect(settings.showAvatars).toBe(true);

    const popupCm = (world.popup.nexus as any).lifecycle.manager;
    const connection = Array.from(
      (popupCm as any).connections.values(),
    )[0] as LogicalConnection<AppAdapterModel>;
    (connection as any).close();

    await vi.waitFor(() => {
      expect((popupCm as any).connections.size).toBe(0);
    });

    await expect(bgApi.getSettings()).rejects.toBeInstanceOf(
      NexusDisconnectedError,
    );
  });

  it("rejects a synchronous send failure that closes its connection as disconnected", async () => {
    const token = new Token<IBackgroundService>(
      "synchronous-send-failure-background-service",
    );
    let failPopupSends = false;
    let popupMessageHandler: ((message: unknown) => void) | undefined;
    let backgroundMessageHandler: ((message: unknown) => void) | undefined;
    let popupDisconnectHandler: (() => void) | undefined;
    let backgroundDisconnectHandler: (() => void) | undefined;

    const popupPort: IPort = {
      postMessage: vi.fn((message: unknown) => {
        if (failPopupSends) {
          throw new Error("native port is disconnected");
        }
        setTimeout(() => backgroundMessageHandler?.(message), 0);
      }),
      onMessage: vi.fn((handler: (message: unknown) => void) => {
        popupMessageHandler = handler;
      }),
      onDisconnect: vi.fn((handler: () => void) => {
        popupDisconnectHandler = handler;
      }),
      close: vi.fn(() => {
        popupDisconnectHandler?.();
        backgroundDisconnectHandler?.();
      }),
    };
    const backgroundPort: IPort = {
      postMessage: vi.fn((message: unknown) => {
        setTimeout(() => popupMessageHandler?.(message), 0);
      }),
      onMessage: vi.fn((handler: (message: unknown) => void) => {
        backgroundMessageHandler = handler;
      }),
      onDisconnect: vi.fn((handler: () => void) => {
        backgroundDisconnectHandler = handler;
      }),
      close: vi.fn(() => {
        popupDisconnectHandler?.();
        backgroundDisconnectHandler?.();
      }),
    };

    let acceptConnection:
      | ((port: IPort, connectionMeta: AppConnectionMeta) => void)
      | undefined;
    const background = new Nexus<AppAdapterModel>().configure({
      endpoint: {
        meta: { context: "background", version: "1.0" },
        implementation: {
          listen: (accept) => {
            acceptConnection = accept;
          },
        },
      },
      providers: [{ token, service: new BackgroundServiceImpl() }],
    });
    const popup = new Nexus<AppAdapterModel>().configure({
      endpoint: {
        meta: { context: "popup" },
        implementation: {
          connect: async () => {
            if (!acceptConnection) {
              throw new Error("background listener is not ready");
            }
            acceptConnection(backgroundPort, { from: "popup" });
            return { port: popupPort, connectionMeta: { from: "background" } };
          },
          listen: () => undefined,
          matchesTarget: (target, contextMeta) =>
            target.context === contextMeta.context,
        },
      },
      connectTo: [{ context: "background" }],
    });

    const api = (
      await popup.connect({ target: { context: "background" } })
    ).get(token);
    expect((background as any).lifecycle.manager.connections.size).toBe(1);
    expect((popup as any).lifecycle.manager.connections.size).toBe(1);
    const popupEngine = (popup as any).lifecycle.engine;
    const pendingCallManager = popupEngine.pendingCallManager;
    const handleResponse = vi.spyOn(pendingCallManager, "handleResponse");
    let messageId: number | string | undefined;
    const register = pendingCallManager.register.bind(pendingCallManager);
    vi.spyOn(pendingCallManager, "register").mockImplementation(
      (...args: unknown[]) => {
        messageId = args[0] as number | string;
        return register(...(args as Parameters<typeof register>));
      },
    );

    vi.useFakeTimers();
    try {
      failPopupSends = true;

      const call = api.getSettings();
      await expect(call).rejects.toMatchObject({ code: "E_CONN_CLOSED" });
      await expect(call).rejects.toBeInstanceOf(NexusDisconnectedError);
      expect((popup as any).lifecycle.manager.connections.size).toBe(0);
      expect(messageId).toBeDefined();
      expect(pendingCallManager.canHandleResponse(messageId!, "conn-1")).toBe(
        false,
      );
      expect(vi.getTimerCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(handleResponse).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps old unicast create() proxy session-bound after replacement connection appears", async () => {
    const oldApi = (
      await world.background.nexus.connect({
        target: { context: "content-script", issueId: "CS1" },
      })
    ).get(ContentScriptServiceToken);
    await expect(oldApi.getTitle()).resolves.toContain("CS1");

    const oldConnection = findLogicalConnection(
      world.background,
      (connection) =>
        connection.remoteIdentity?.context === "content-script" &&
        connection.remoteIdentity?.issueId === "CS1",
    );
    expect(oldConnection).toBeDefined();
    oldConnection!.close();

    await expect(oldApi.getTitle()).rejects.toBeInstanceOf(
      NexusDisconnectedError,
    );

    const freshApi = (
      await world.background.nexus.connect({
        target: { context: "content-script", issueId: "CS1" },
      })
    ).get(ContentScriptServiceToken);

    await expect(freshApi.getTitle()).resolves.toContain("CS1");
    await expect(oldApi.getTitle()).rejects.toBeInstanceOf(
      NexusDisconnectedError,
    );
  });

  it("should auto-cleanup resources on the host when a client disconnects", async () => {
    const bgApi = (
      await world.cs1.nexus.connect({ target: { context: "background" } })
    ).get(BackgroundServiceToken);
    const bgResourceManager = (world.background.nexus as any).lifecycle.engine
      .resourceManager;
    const initialProxyCount = bgResourceManager.countRemoteProxies();

    const onNewComment = vi.fn();
    await bgApi.subscribeToComments("CS1-cleanup", onNewComment);

    expect(bgResourceManager.countRemoteProxies()).toBeGreaterThan(
      initialProxyCount,
    );

    const cs1Cm = (world.cs1.nexus as any).lifecycle.manager;
    const connection = Array.from(
      (cs1Cm as any).connections.values(),
    )[0] as LogicalConnection<AppAdapterModel>;
    (connection as any).close();

    await vi.waitFor(() => {
      expect(bgResourceManager.countRemoteProxies()).toBe(initialProxyCount);
    });
  });

  it("should release callback proxy resources on unsubscribe while connection remains alive", async () => {
    const bgApi = (
      await world.cs1.nexus.connect({ target: { context: "background" } })
    ).get(BackgroundServiceToken);
    const bgResourceManager = (world.background.nexus as any).lifecycle.engine
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

    const cs1Cm = (world.cs1.nexus as any).lifecycle.manager;
    expect((cs1Cm as any).connections.size).toBeGreaterThan(0);
  });

  it("should propagate errors from remote back to caller", async () => {
    const contentApi = (
      await world.background.nexus.connect({
        target: { context: "content-script", issueId: "CS1" },
        where: (id: AppUserMeta, _connectionMeta) =>
          id.context === "content-script" && id.issueId === "CS1",
      })
    ).get(ContentScriptServiceToken);

    const promise = contentApi.highlightUser("non-existent-user");

    await expect(promise).rejects.toBeInstanceOf(NexusRemoteError);
    await expect(promise).rejects.toThrow(/User "non-existent-user" not found/);
  });

  it("safeUpdateIdentity should wait for initialization and succeed", async () => {
    const isolated = new Nexus<AppAdapterModel>().configure({
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
    const cs1Api = (
      await world.background.nexus.connect({
        target: { context: "content-script", issueId: "CS1" },
      })
    ).get(ContentScriptServiceToken);

    const bgCm = (world.background.nexus as any).lifecycle.manager;
    const connections = Array.from((bgCm as any).connections.values()) as Array<
      LogicalConnection<AppAdapterModel>
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
    const bgEngine = (world.background.nexus as any).lifecycle.engine;
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
      expect(world.cs1.service.getTitle).toHaveBeenCalled();
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
    const initiallyActiveApi = (
      await world.background.nexus.connect({
        target: { context: "content-script", issueId: "CS1" },
        where: (id: AppUserMeta, _connectionMeta) =>
          id.context === "content-script" && id.isActive,
      })
    ).get(ContentScriptServiceToken);
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
      const probeApi = (
        await world.background.nexus.connect({
          target: { context: "content-script", issueId: "CS2" },
          where: (id: AppUserMeta, _connectionMeta) =>
            id.context === "content-script" && id.isActive,
        })
      ).get(ContentScriptServiceToken);
      await expect(probeApi.getTitle()).resolves.toContain("CS2");
    });

    let capturedMessageId: number | string | null = null;
    const bgEngine = (world.background.nexus as any).lifecycle.engine;
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
      throw new Error("CS2 response release was not initialized");
    };
    vi.spyOn(world.cs2.service, "getTitle").mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseCs2Response = () => resolve("Issue CS2 - My Test Project");
        }),
    );

    const postHandoffApi = (
      await world.background.nexus.connect({
        target: { context: "content-script", issueId: "CS2" },
        where: (id: AppUserMeta, _connectionMeta) =>
          id.context === "content-script" && id.isActive,
      })
    ).get(ContentScriptServiceToken);

    let settled = false;
    const callPromise = postHandoffApi.getTitle().then((result) => {
      settled = true;
      return result;
    });

    await vi.waitFor(() => {
      expect(capturedMessageId).not.toBeNull();
      expect(world.cs2.service.getTitle).toHaveBeenCalled();
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

    const oldApi = (
      await world.background.nexus.connect({
        target: { context: "content-script", issueId: "CS1" },
        where: logicalTarget,
      })
    ).get(ContentScriptServiceToken);

    await expect(oldApi.bumpSessionCounter()).resolves.toBe(1);

    await world.cs1.nexus.updateIdentity({ isActive: false });
    await world.cs2.nexus.updateIdentity({ isActive: true });

    await vi.waitFor(async () => {
      const candidate = (
        await world.background.nexus.connect({
          target: { context: "content-script", issueId: "CS2" },
          where: logicalTarget,
        })
      ).get(ContentScriptServiceToken);
      await expect(candidate.getTitle()).resolves.toContain("CS2");
    });

    const freshApi = (
      await world.background.nexus.connect({
        target: { context: "content-script", issueId: "CS2" },
        where: logicalTarget,
      })
    ).get(ContentScriptServiceToken);

    await expect(freshApi.bumpSessionCounter()).resolves.toBe(1);

    await expect(oldApi.bumpSessionCounter()).resolves.toBe(2);
    await expect(freshApi.bumpSessionCounter()).resolves.toBe(2);
  });
});
