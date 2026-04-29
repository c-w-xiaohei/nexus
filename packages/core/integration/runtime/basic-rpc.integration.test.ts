/**
 * Simulates the day-to-day extension runtime path where popup and content-script
 * clients call a background service and receive host-driven callback events.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import {
  type Comment,
  BackgroundServiceToken,
  createIssueCompanionWorld,
  type IssueCompanionWorld,
  teardownIssueCompanionWorld,
} from "../fixtures";

describe("Nexus L4 Integration: Basic RPC", () => {
  let world: IssueCompanionWorld;

  beforeEach(async () => {
    world = await createIssueCompanionWorld();
  });

  afterEach(() => {
    teardownIssueCompanionWorld(world);
    world = undefined as never;
  });

  it("should perform basic RPC from client to host", async () => {
    const bgApi = await world.popup.nexus.create(BackgroundServiceToken, {
      target: { descriptor: { context: "background" } },
    });
    expect(bgApi).toBeDefined();

    const settings = await bgApi.getSettings();
    expect(settings.showAvatars).toBe(true);
    expect(settings.defaultProject).toBe("Nexus");
  });

  it("should handle host-to-client callbacks", async () => {
    const bgApi = await world.cs1.nexus.create(BackgroundServiceToken, {
      target: { descriptor: { context: "background" } },
    });
    expect(bgApi).toBeDefined();

    const onNewComment = vi.fn();
    const subId = await bgApi.subscribeToComments("CS1", onNewComment);
    expect(subId).toBeDefined();

    const testComment: Comment = {
      id: "c1",
      user: "testuser",
      body: "Hello Nexus!",
    };
    world.background.service._simulateNewComment(subId, testComment);

    await vi.waitFor(() => {
      expect(onNewComment).toHaveBeenCalledTimes(1);
    });
    expect(onNewComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: "Hello Nexus!" }),
    );
  });
});
