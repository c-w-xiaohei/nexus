/**
 * Simulates cross-context object sharing where a caller obtains remote stateful
 * objects by reference, mutates them over RPC, and explicitly releases resources
 * to verify lifecycle cleanup semantics on the hosting endpoint.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type AppUserMeta,
  ContentScriptServiceToken,
  createIssueCompanionWorld,
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
});
