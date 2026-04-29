/**
 * Simulates cross-context object sharing where a caller obtains remote stateful
 * objects by reference, mutates them over RPC, and explicitly releases resources
 * to verify lifecycle cleanup semantics on the hosting endpoint.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CallProcessor } from "../../src/service/call-processor";
import { NexusResourceError } from "../../src/errors/resource-errors";
import {
  type AppUserMeta,
  ContentScriptServiceToken,
  createIssueCompanionWorld,
  findLogicalConnection,
  type IssueCompanionWorld,
  teardownIssueCompanionWorld,
} from "../fixtures";

describe("Nexus L4 Integration: Resource and Callback Lifecycles", () => {
  let world: IssueCompanionWorld;

  beforeEach(async () => {
    world = await createIssueCompanionWorld();
  });

  afterEach(() => {
    teardownIssueCompanionWorld(world);
    world = undefined as never;
  });

  it("should pass stateful objects by reference using nexus.ref()", async () => {
    const csApi = await world.background.nexus.create(
      ContentScriptServiceToken,
      {
        target: {
          matcher: (id: AppUserMeta) =>
            id.context === "content-script" && id.issueId === "CS1",
        },
        expects: "one",
      },
    );
    expect(csApi).toBeDefined();

    const processorProxy = await csApi.getTimelineProcessor();
    processorProxy.addEvent("event-1-from-background");
    processorProxy.addEvent("event-2-from-background");

    const result = await processorProxy.process();

    expect(result.issueId).toBe("CS1");
    expect(result.eventCount).toBe(2);
    expect(result.firstEvent).toBe("event-1-from-background");
  });

  it("should correctly release a remote resource proxy", async () => {
    const cs1ResourceManager = (world.cs1.nexus as any).engine.resourceManager;
    const initialResourceCount = cs1ResourceManager.countLocalResources();

    const csApi = await world.background.nexus.create(
      ContentScriptServiceToken,
      {
        target: {
          matcher: (id: AppUserMeta) =>
            id.context === "content-script" && id.issueId === "CS1",
        },
        expects: "one",
      },
    );
    expect(csApi).toBeDefined();

    const processorProxy = await csApi.getTimelineProcessor();
    expect(cs1ResourceManager.countLocalResources()).toBeGreaterThan(
      initialResourceCount,
    );

    world.background.nexus.release(processorProxy);

    await vi.waitFor(() => {
      expect(cs1ResourceManager.countLocalResources()).toBe(
        initialResourceCount,
      );
    });
  });

  it("should treat released remote resource proxies as terminal capabilities", async () => {
    const csApi = await world.background.nexus.create(
      ContentScriptServiceToken,
      {
        target: {
          matcher: (id: AppUserMeta) =>
            id.context === "content-script" && id.issueId === "CS1",
        },
        expects: "one",
      },
    );

    const processorProxy = await csApi.getTimelineProcessor();
    world.background.nexus.release(processorProxy);

    await expect(processorProxy.process()).rejects.toThrow(/released/i);
  });

  it("should throw on SET after a remote resource proxy is released", async () => {
    const csApi = await world.background.nexus.create(
      ContentScriptServiceToken,
      {
        target: {
          matcher: (id: AppUserMeta) =>
            id.context === "content-script" && id.issueId === "CS1",
        },
        expects: "one",
      },
    );

    const processorProxy: any = await csApi.getTimelineProcessor();
    world.background.nexus.release(processorProxy);

    expect(() => {
      processorProxy.someProp = "blocked-after-release";
    }).toThrow(NexusResourceError);
    expect(() => {
      processorProxy.someProp = "blocked-after-release";
    }).toThrow(/released/i);
  });

  it("keeps old remote resource proxies disconnected after replacement connection appears", async () => {
    const csApi = await world.background.nexus.create(
      ContentScriptServiceToken,
      {
        target: {
          descriptor: { context: "content-script", issueId: "CS1" },
        },
        expects: "one",
      },
    );

    const oldProcessorProxy = await csApi.getTimelineProcessor();

    const cs1Connection = findLogicalConnection(
      world.background,
      (connection) =>
        connection.remoteIdentity?.context === "content-script" &&
        connection.remoteIdentity?.issueId === "CS1",
    );
    expect(cs1Connection).toBeDefined();
    cs1Connection!.close();

    const freshApi = await world.background.nexus.create(
      ContentScriptServiceToken,
      {
        target: {
          descriptor: { context: "content-script", issueId: "CS1" },
        },
        expects: "one",
      },
    );
    const freshProcessorProxy = await freshApi.getTimelineProcessor();

    await expect(oldProcessorProxy.process()).rejects.toBeInstanceOf(
      CallProcessor.Error.Disconnected,
    );
    await expect(freshProcessorProxy.process()).resolves.toMatchObject({
      issueId: "CS1",
    });
  });

  it("keeps an old remote resource capability pinned during replacement overlap", async () => {
    const logicalTarget = (id: AppUserMeta) =>
      id.context === "content-script" && id.isActive;

    const oldApi = await world.background.nexus.create(
      ContentScriptServiceToken,
      {
        target: { matcher: logicalTarget },
        expects: "first",
      },
    );
    const oldProcessorProxy = await oldApi.getTimelineProcessor();

    await world.cs1.nexus.updateIdentity({ isActive: false });
    await world.cs2.nexus.updateIdentity({ isActive: true });

    const freshApi = await vi.waitFor(async () => {
      const candidate = await world.background.nexus.create(
        ContentScriptServiceToken,
        {
          target: { matcher: logicalTarget },
          expects: "first",
        },
      );
      await expect(candidate.getTitle()).resolves.toContain("CS2");
      return candidate;
    });
    const freshProcessorProxy = await freshApi.getTimelineProcessor();

    await expect(oldProcessorProxy.process()).resolves.toMatchObject({
      issueId: "CS1",
    });
    await expect(freshProcessorProxy.process()).resolves.toMatchObject({
      issueId: "CS2",
    });
  });
});
