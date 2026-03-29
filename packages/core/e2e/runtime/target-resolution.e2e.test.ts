/**
 * Simulates endpoint discovery and fan-out behavior in a multi-context extension,
 * covering target fallback rules, dynamic identity updates, matcher composition,
 * and multicast strategies under both full-success and partial-failure outcomes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Nexus } from "../../src/api/nexus";
import { createMockPortPair } from "../../src/utils/test-utils";
import { DecoratorRegistry } from "../../src/api/registry";

import {
  type AppPlatformMeta,
  type AppUserMeta,
  type IContentScriptService,
  BackgroundServiceToken,
  ContentScriptServiceToken,
  createIssueCompanionWorld,
  type IssueCompanionWorld,
  teardownIssueCompanionWorld,
} from "../fixtures";
import { Token } from "../../src/api/token";

describe("Nexus L4 E2E: Target Resolution and Discovery", () => {
  let world: IssueCompanionWorld;

  beforeEach(async () => {
    world = await createIssueCompanionWorld();
  });

  afterEach(() => {
    teardownIssueCompanionWorld(world);
    world = undefined as never;
  });

  describe("`create` Target Resolution Priority", () => {
    it("should use the target from Token.defaultTarget if available", async () => {
      const Cs1TokenWithDefault = new Token<IContentScriptService>(
        ContentScriptServiceToken.id,
        {
          descriptor: { context: "content-script", issueId: "CS1" },
        },
      );

      const cs1Api = await world.background.nexus.create(Cs1TokenWithDefault, {
        target: {},
      });
      const title = await cs1Api.getTitle();
      expect(title).toContain("CS1");
    });

    it("should use the target from endpoint.connectTo as a fallback", async () => {
      const bgApi = await world.cs1.nexus.create(BackgroundServiceToken, {
        target: {},
      });
      expect(bgApi).toBeDefined();
      const settings = await bgApi.getSettings();
      expect(settings.showAvatars).toBe(true);
    });

    it("should throw an error if endpoint.connectTo is ambiguous", async () => {
      DecoratorRegistry.clear();
      const connectToTargets = [
        { descriptor: { context: "background" } },
        { descriptor: { context: "content-script", issueId: "CS1" } },
      ] as const;

      const ambiguousNexus = new Nexus<
        AppUserMeta,
        AppPlatformMeta
      >().configure({
        endpoint: {
          meta: { context: "popup" },
          implementation: {
            connect: vi.fn(async (): Promise<[any, any]> => {
              const [port] = createMockPortPair();
              return [port, { from: "mock" }];
            }),
            listen: vi.fn(),
          },
          connectTo: connectToTargets,
        },
      });

      await expect(
        ambiguousNexus.create(BackgroundServiceToken, { target: {} }),
      ).rejects.toThrow(/ambiguous/);
    });
  });

  describe("when a matcher-only call finds no connections", () => {
    const noMatchTarget = {
      matcher: (id: AppUserMeta) =>
        id.context === "content-script" && id.issueId === "NON_EXISTENT_ID",
    };

    it("should reject with targeting error for 'create' (fail-fast)", async () => {
      const promise = world.background.nexus.create(ContentScriptServiceToken, {
        target: noMatchTarget,
        expects: "first",
      });
      await expect(promise).rejects.toMatchObject({
        code: "E_TARGET_NO_MATCH",
      });
    });

    it("should resolve with an empty array for 'all' strategy (multicast)", async () => {
      const api = await world.background.nexus.createMulticast(
        ContentScriptServiceToken,
        {
          target: noMatchTarget,
          expects: "all",
        },
      );
      const results = await api.refresh();
      expect(results).toEqual([]);
    });

    it("should return an empty async iterator for 'stream' strategy (multicast)", async () => {
      const streamProxy = await world.background.nexus.createMulticast(
        ContentScriptServiceToken,
        { target: noMatchTarget, expects: "stream" },
      );
      const iterator = await streamProxy.refresh();
      const results = [];
      for await (const result of iterator) {
        results.push(result);
      }
      expect(results).toEqual([]);
    });
  });

  it("should discover endpoints using dynamic metadata", async () => {
    let activeTabApi = await world.background.nexus.create(
      ContentScriptServiceToken,
      {
        target: {
          matcher: (id) => id.context === "content-script" && id.isActive,
        },
        expects: "first",
      },
    );
    let title = await activeTabApi.getTitle();
    expect(title).toContain("CS1");

    await world.cs1.nexus.updateIdentity({ isActive: false });
    await world.cs2.nexus.updateIdentity({ isActive: true });
    await new Promise((r) => setTimeout(r, 50));

    activeTabApi = await world.background.nexus.create(
      ContentScriptServiceToken,
      {
        target: {
          matcher: (id) => id.context === "content-script" && id.isActive,
        },
        expects: "first",
      },
    );
    title = await activeTabApi.getTitle();
    expect(title).toContain("CS2");
  });

  it("should use named and compound matchers for discovery", async () => {
    world.background.nexus.configure({
      matchers: {
        "is-active": (id) => id.context === "content-script" && id.isActive,
        "is-github-issue": (id) =>
          id.context === "content-script" &&
          id.url.startsWith("github.com/issue"),
      },
    });

    const activeGitHubTab = await world.background.nexus.create(
      ContentScriptServiceToken,
      {
        target: {
          matcher: (world.background.nexus.matchers as any).and(
            "is-active",
            "is-github-issue",
          ),
        },
        expects: "first",
      },
    );

    const title = await activeGitHubTab.getTitle();
    expect(title).toContain("CS1");
  });

  it("should broadcast to all matched endpoints with 'all' strategy", async () => {
    const cs1RefreshSpy = vi.spyOn(world.cs1.service, "refresh");
    const cs2RefreshSpy = vi.spyOn(world.cs2.service, "refresh");

    const allTabsProxy = await world.background.nexus.createMulticast(
      ContentScriptServiceToken,
      {
        target: {
          matcher: (id) => id.context === "content-script",
        },
        expects: "all",
      },
    );

    const results = await allTabsProxy.refresh();

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(cs1RefreshSpy).toHaveBeenCalledTimes(1);
    expect(cs2RefreshSpy).toHaveBeenCalledTimes(1);
  });

  it("should broadcast to a service group using groupName", async () => {
    const cs1RefreshSpy = vi.spyOn(world.cs1.service, "refresh");
    const cs2RefreshSpy = vi.spyOn(world.cs2.service, "refresh");

    const groupProxy = await world.background.nexus.createMulticast(
      ContentScriptServiceToken,
      {
        target: { groupName: "issue-pages" },
        expects: "all",
      },
    );

    const results = await groupProxy.refresh();
    expect(results).toHaveLength(2);
    expect(cs1RefreshSpy).toHaveBeenCalledTimes(1);
    expect(cs2RefreshSpy).toHaveBeenCalledTimes(1);
  });

  it("should handle partial failures when broadcasting", async () => {
    vi.spyOn(world.cs2.service, "getTitle").mockRejectedValue(
      new Error("Failed to get title from CS2"),
    );

    const allTabsProxy = await world.background.nexus.createMulticast(
      ContentScriptServiceToken,
      {
        target: {
          matcher: (id) => id.context === "content-script",
        },
        expects: "all",
      },
    );

    const results = await allTabsProxy.getTitle();

    expect(results).toHaveLength(2);
    const fulfilledResult = results.find((r) => r.status === "fulfilled");
    const rejectedResult = results.find((r) => r.status === "rejected");

    expect(fulfilledResult).toBeDefined();
    expect(fulfilledResult?.value).toContain("CS1");

    expect(rejectedResult).toBeDefined();
    expect(rejectedResult?.reason.message).toContain(
      "Failed to get title from CS2",
    );
  });

  it("should stream results with 'stream' strategy", async () => {
    const streamProxy = await world.background.nexus.createMulticast(
      ContentScriptServiceToken,
      {
        target: {
          matcher: (id) => id.context === "content-script",
        },
        expects: "stream",
      },
    );

    const receivedResults: { from: string; title: string }[] = [];
    const titleIterator = await streamProxy.getTitle();
    for await (const result of titleIterator) {
      if (result.status === "fulfilled") {
        receivedResults.push({ from: result.from, title: result.value });
      }
    }

    expect(receivedResults).toHaveLength(2);
    expect(receivedResults.map((r) => r.title)).toContain(
      "Issue CS1 - My Test Project",
    );
    expect(receivedResults.map((r) => r.title)).toContain(
      "Issue CS2 - My Test Project",
    );
  });
});
