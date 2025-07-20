import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { Nexus } from "./nexus";
import type { NexusInstance } from "./types";
import { Token } from "./token";
import { Expose } from "./decorators/expose";
import { createStarNetwork, createMockPortPair } from "@/utils/test-utils";
import type { IEndpoint } from "@/transport";
import { REF_WRAPPER_SYMBOL } from "@/types/ref-wrapper";
import {
  NexusRemoteError,
  NexusTargetingError,
  NexusDisconnectedError,
} from "@/errors";
import { DecoratorRegistry } from "./registry";

import { LogicalConnection } from "@/connection/logical-connection";

// ===========================================================================
// 1. Test Scenario: Types, Interfaces, and Tokens
// ===========================================================================

// --- Metadata ---
type AppUserMeta =
  | { context: "background"; version: string }
  | {
      context: "content-script";
      url: string;
      issueId: string;
      isActive: boolean;
      groups?: string[];
    }
  | { context: "popup"; activeIssueId?: string };

type ContentScriptMeta = Extract<AppUserMeta, { context: "content-script" }>;

type AppPlatformMeta = { from: string };

// --- Data Models ---
interface Settings {
  showAvatars: boolean;
  defaultProject: string;
}
interface Comment {
  id: string;
  user: string;
  body: string;
}
type SubscriptionId = string;

// --- Stateful Object for `ref()` testing ---
class TimelineProcessor {
  private events: string[] = [];
  constructor(public issueId: string) {}
  addEvent(event: string) {
    this.events.push(event);
  }
  process() {
    return {
      issueId: this.issueId,
      eventCount: this.events.length,
      firstEvent: this.events[0],
    };
  }
}

// --- Service Contracts (Interfaces & Tokens) ---

// Background Service
interface IBackgroundService {
  getSettings(): Promise<Settings>;
  saveSettings(newSettings: Settings): Promise<void>;
  subscribeToComments(
    issueId: string,
    onNewComment: (comment: Comment) => void
  ): Promise<SubscriptionId>;
  unsubscribe(subId: SubscriptionId): Promise<void>;
  processTimeline(processor: TimelineProcessor): Promise<any>;
  refreshAllTabs(): Promise<void[]>; // For broadcast
  requestHighlight(issueId: string, user: string): Promise<void>;
}
const BackgroundServiceToken = new Token<IBackgroundService>(
  "background-service"
);

// Content Script Service
interface IContentScriptService {
  highlightUser(user: string): Promise<boolean>;
  getTimelineProcessor(): Promise<TimelineProcessor>;
  refresh(): Promise<void>;
  getTitle(): Promise<string>;
}

// Additional service interfaces for TokenSpace tests
interface ISettingsService {
  getSettings(): Promise<Settings>;
  updateSettings(settings: Partial<Settings>): Promise<Settings>;
}

interface ICommentService {
  getComments(issueId: string): Promise<Comment[]>;
  addComment(issueId: string, comment: Omit<Comment, "id">): Promise<Comment>;
}

interface IUserService {
  getUserProfile(): Promise<{ id: string; name: string }>;
}
const ContentScriptServiceToken = new Token<IContentScriptService>(
  "content-script-service"
);

// ===========================================================================
// 2. Mock Service Implementations
// ===========================================================================

class BackgroundServiceImpl implements IBackgroundService {
  private settings: Settings = { showAvatars: true, defaultProject: "Nexus" };
  private commentSubscriptions = new Map<
    SubscriptionId,
    (comment: Comment) => void
  >();

  // Helper to simulate a new comment arriving
  public _simulateNewComment(subId: SubscriptionId, comment: Comment) {
    this.commentSubscriptions.get(subId)?.(comment);
  }

  async getSettings() {
    return this.settings;
  }
  async saveSettings(newSettings: Settings) {
    this.settings = newSettings;
  }
  async subscribeToComments(
    issueId: string,
    onNewComment: (comment: Comment) => void
  ) {
    const subId: SubscriptionId = `sub-${issueId}-${Math.random()}`;
    this.commentSubscriptions.set(subId, onNewComment);
    return subId;
  }
  async unsubscribe(subId: SubscriptionId): Promise<void> {
    this.commentSubscriptions.delete(subId);
  }
  async processTimeline(processor: TimelineProcessor) {
    // Interact with the stateful object passed by reference
    processor.addEvent("processed by background");
    return processor.process();
  }
  // This method will be called via a broadcast proxy, so it's empty.
  async refreshAllTabs(): Promise<void[]> {
    return [];
  }
  // This is a fire-and-forget call to a specific client
  async requestHighlight(_issueId: string, _user: string): Promise<void> {
    // In a real app, we'd use create() here to call the content script.
    // This method is just a placeholder for the interface.
  }
}

class ContentScriptServiceImpl implements IContentScriptService {
  constructor(private meta: ContentScriptMeta) {}

  async highlightUser(user: string): Promise<boolean> {
    if (user === "non-existent-user") {
      throw new Error(`User "${user}" not found on page.`);
    }
    return true; // Simulate success
  }
  async getTimelineProcessor(): Promise<TimelineProcessor> {
    // Create and return a new stateful object
    return {
      [REF_WRAPPER_SYMBOL]: true, // Mark for passing by reference
      target: new TimelineProcessor(this.meta.issueId),
    } as any;
  }
  async refresh(): Promise<void> {
    // Simulate refreshing data, e.g., re-rendering a component
  }
  async getTitle(): Promise<string> {
    return `Issue ${this.meta.issueId} - My Test Project`;
  }
}

// ===========================================================================
// 3. E2E Test Suite
// ===========================================================================

describe("Nexus L4 E2E: GitHub Issue Companion", () => {
  // Store instances for all nodes in our test
  let background: {
    nexus: NexusInstance<AppUserMeta, AppPlatformMeta>;
    service: BackgroundServiceImpl;
  };
  let cs1: {
    nexus: NexusInstance<AppUserMeta, AppPlatformMeta>;
    service: ContentScriptServiceImpl;
  };
  let cs2: {
    nexus: NexusInstance<AppUserMeta, AppPlatformMeta>;
    service: ContentScriptServiceImpl;
  };
  let popup: { nexus: NexusInstance<AppUserMeta, AppPlatformMeta> };

  // This beforeEach hook sets up a complete, interconnected environment
  // before each test, ensuring test isolation.
  beforeEach(async () => {
    // Reset decorator registrations from previous tests
    DecoratorRegistry.clear();

    const bgMeta: AppUserMeta = { context: "background", version: "1.0.0" };
    const cs1Meta: ContentScriptMeta = {
      context: "content-script",
      issueId: "CS1",
      url: "github.com/issue/1",
      isActive: true,
      groups: ["issue-pages"], // Added for group broadcast test
    };
    const cs2Meta: ContentScriptMeta = {
      context: "content-script",
      issueId: "CS2",
      url: "github.com/issue/2",
      isActive: false,
      groups: ["issue-pages"], // Added for group broadcast test
    };
    const popupMeta: AppUserMeta = { context: "popup" };

    const backgroundService = new BackgroundServiceImpl();
    const cs1Service = new ContentScriptServiceImpl(cs1Meta);
    const cs2Service = new ContentScriptServiceImpl(cs2Meta);

    const network = await createStarNetwork<AppUserMeta, AppPlatformMeta>({
      center: {
        meta: bgMeta,
        services: {
          [BackgroundServiceToken.id]: backgroundService,
        },
      },
      leaves: [
        {
          meta: cs1Meta,
          services: { [ContentScriptServiceToken.id]: cs1Service },
          cmConfig: { connectTo: [{ descriptor: { context: "background" } }] },
        },
        {
          meta: cs2Meta,
          services: { [ContentScriptServiceToken.id]: cs2Service },
          cmConfig: { connectTo: [{ descriptor: { context: "background" } }] },
        },
        {
          meta: popupMeta,
          cmConfig: { connectTo: [{ descriptor: { context: "background" } }] },
        },
      ],
    });

    background = {
      nexus: network.get("background")!.nexus,
      service: backgroundService,
    };
    cs1 = {
      nexus: network.get("content-script:CS1")!.nexus,
      service: cs1Service,
    };
    cs2 = {
      nexus: network.get("content-script:CS2")!.nexus,
      service: cs2Service,
    };
    popup = {
      nexus: network.get("popup")!.nexus,
    };
  });

  // +++ 新增的 afterEach 钩子 +++
  afterEach(() => {
    const instances = [background, cs1, cs2, popup];
    for (const instance of instances) {
      if (instance?.nexus) {
        // 通过访问内部的 connectionManager 关闭所有连接
        const cm = (instance.nexus as any).connectionManager;
        if (cm) {
          const connections = Array.from((cm as any).connections.values());
          for (const conn of connections) {
            // 调用底层的 port.close() 来确保双向断开
            (conn as LogicalConnection<any, any>).close();
          }
        }
      }
    }
    // 确保所有实例引用被清除，以便垃圾回收
    background = cs1 = cs2 = popup = undefined as any;
  });

  it("should perform basic RPC from client to host", async () => {
    // Popup wants to get the settings from the background
    const bgApi = await popup.nexus.create(BackgroundServiceToken, {
      target: { descriptor: { context: "background" } },
      // The default 'expects' is 'one', which is what we want for a unique service.
    });
    expect(bgApi).toBeDefined();

    const settings = await bgApi.getSettings();
    expect(settings.showAvatars).toBe(true);
    expect(settings.defaultProject).toBe("Nexus");
  });

  it("should handle host-to-client callbacks", async () => {
    // Content-script 1 subscribes to comments
    const bgApi = await cs1.nexus.create(BackgroundServiceToken, {
      target: { descriptor: { context: "background" } },
    });
    expect(bgApi).toBeDefined();

    const onNewComment = vi.fn();
    const subId = await bgApi.subscribeToComments("CS1", onNewComment);
    expect(subId).toBeDefined();

    // Background service simulates a new comment arriving for this subscription
    const testComment: Comment = {
      id: "c1",
      user: "testuser",
      body: "Hello Nexus!",
    };
    background.service._simulateNewComment(subId, testComment);

    // Assert that the callback was invoked on the client with the correct data
    await vi.waitFor(() => {
      expect(onNewComment).toHaveBeenCalledTimes(1);
    });
    expect(onNewComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: "Hello Nexus!" })
    );
  });

  describe("Connection Lifecycle and Error Handling", () => {
    it("should reject with a connection error if the host is unreachable", async () => {
      // This test requires a custom setup where the host endpoint fails.
      DecoratorRegistry.clear();

      const clientMeta: AppUserMeta = { context: "popup" };
      const hostDescriptor = { context: "background" } as const;
      const UnreachableToken = new Token<IBackgroundService>("unreachable");

      // The mock endpoint's connect will simulate a failure.
      const failingEndpoint: IEndpoint<any, any> = {
        connect: vi.fn(async () => {
          throw new Error("Simulated connection failure: Host not found");
        }),
        listen: vi.fn(), // IMPORTANT: Mock all methods of the interface
      };

      const client = new Nexus<AppUserMeta, AppPlatformMeta>().configure({
        endpoint: {
          meta: clientMeta,
          implementation: failingEndpoint,
        },
      });

      // The create call itself should now reject because it fails fast.
      await expect(
        client.create(UnreachableToken, {
          target: { descriptor: hostDescriptor },
        })
      ).rejects.toThrow("Simulated connection failure");
    });

    it("should reject subsequent calls on a proxy after connection is closed", async () => {
      const bgApi = await popup.nexus.create(BackgroundServiceToken, {
        target: { descriptor: { context: "background" } },
      });
      expect(bgApi).toBeDefined();

      // Perform one successful call
      const settings = await bgApi.getSettings();
      expect(settings.showAvatars).toBe(true);

      // Now, manually find and close the connection from the popup's side.
      const popupCm = (popup.nexus as any).connectionManager;
      const connection = Array.from(
        (popupCm as any).connections.values()
      )[0] as LogicalConnection<any, any>;
      // connection.handleDisconnect(); // INCORRECT: This only disconnects one side.
      // We must close the underlying port to simulate a real-world disconnect.
      (connection as any).close();

      // Wait for the disconnect to be processed
      await vi.waitFor(() => {
        expect((popupCm as any).connections.size).toBe(0);
      });

      // Any new call on the same proxy should fail.
      // Because the test harness doesn't support reconnection, this will fail
      // during the connection attempt.
      await expect(bgApi.getSettings()).rejects.toBeInstanceOf(
        NexusDisconnectedError
      );
    });

    it("should auto-cleanup resources on the host when a client disconnects", async () => {
      const bgApi = await cs1.nexus.create(BackgroundServiceToken, {
        target: { descriptor: { context: "background" } },
      });
      const bgResourceManager = (background.nexus as any).engine
        .resourceManager;

      const initialProxyCount = (bgResourceManager as any).remoteProxyRegistry
        .size;

      const onNewComment = vi.fn();
      await bgApi.subscribeToComments("CS1-cleanup", onNewComment);

      // A remote proxy for the callback should now exist on the background
      expect(
        (bgResourceManager as any).remoteProxyRegistry.size
      ).toBeGreaterThan(initialProxyCount);

      // Now, disconnect CS1 completely by closing the underlying port
      const cs1Cm = (cs1.nexus as any).connectionManager;
      const connection = Array.from(
        (cs1Cm as any).connections.values()
      )[0] as LogicalConnection<any, any>;
      // connection.handleDisconnect(); // INCORRECT
      (connection as any).close(); // CORRECT: Simulates full duplex disconnect

      // Wait for the background to process the disconnect and clean up
      await vi.waitFor(() => {
        expect((bgResourceManager as any).remoteProxyRegistry.size).toBe(
          initialProxyCount
        );
      });
    });
  });

  describe("`create` Target Resolution Priority", () => {
    it("should use the target from Token.defaultTarget if available", async () => {
      // We can reuse the main setup.
      // Let's create a new token with a default target.
      const Cs1TokenWithDefault = new Token<IContentScriptService>(
        ContentScriptServiceToken.id, // Use the CORRECT service ID
        {
          descriptor: { context: "content-script", issueId: "CS1" },
        }
      );

      // Request the service from the background using the new token WITHOUT specifying a target
      // Note: The second argument is now required. The default target is handled inside `create`.
      const cs1Api = await background.nexus.create(Cs1TokenWithDefault, {
        target: {},
      });
      const title = await cs1Api.getTitle();
      expect(title).toContain("CS1");
    });

    it("should use the target from endpoint.connectTo as a fallback", async () => {
      // This is already implicitly tested, but this makes it explicit.
      // cs1 is configured with `connectTo: [{ descriptor: { context: "background" } }]`
      const bgApi = await cs1.nexus.create(BackgroundServiceToken, {
        target: {},
      }); // No target in options
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

      // Calling create without a specific target should fail
      await expect(
        ambiguousNexus.create(BackgroundServiceToken, { target: {} })
      ).rejects.toThrow(/ambiguous/);
    });
  });

  describe("when a matcher-only call finds no connections", () => {
    const noMatchTarget = {
      matcher: (id: AppUserMeta) =>
        id.context === "content-script" && id.issueId === "NON_EXISTENT_ID",
    };

    it("should reject with NexusTargetingError for 'create' (fail-fast)", async () => {
      // The `create` call now rejects immediately if no connection is found.
      const promise = background.nexus.create(ContentScriptServiceToken, {
        target: noMatchTarget,
        expects: "first",
      });
      await expect(promise).rejects.toBeInstanceOf(NexusTargetingError);
    });

    it("should resolve with an empty array for 'all' strategy (multicast)", async () => {
      const api = await background.nexus.createMulticast(
        ContentScriptServiceToken,
        {
          target: noMatchTarget,
          expects: "all",
        }
      );
      // For 'all' strategy, the proxy method returns a promise that resolves
      // to an array of results. When no connections match, it resolves to an empty array.
      const results = await api.refresh();
      expect(results).toEqual([]);
    });

    it("should return an empty async iterator for 'stream' strategy (multicast)", async () => {
      const streamProxy = await background.nexus.createMulticast(
        ContentScriptServiceToken,
        { target: noMatchTarget, expects: "stream" }
      );
      // Calling a method on a stream proxy returns a promise that resolves to the async iterator.
      const iterator = await streamProxy.refresh();
      const results = [];
      // When no connections match, the returned iterator should be empty.
      for await (const result of iterator) {
        results.push(result);
      }
      expect(results).toEqual([]);
    });
  });

  it("should pass stateful objects by reference using nexus.ref()", async () => {
    // This test simulates the BACKGROUND context performing all actions to verify
    // that it can remotely control a stateful object living on a content script.

    // --- Action performed by: BACKGROUND ---
    // 1. Get a proxy to the Content Script 1 (CS1) service.
    const csApi = await background.nexus.create(ContentScriptServiceToken, {
      target: {
        matcher: (id: AppUserMeta) =>
          id.context === "content-script" && id.issueId === "CS1",
      },
      expects: "one", // We expect exactly one active CS1
    });
    expect(csApi).toBeDefined();

    // --- Action performed by: BACKGROUND ---
    // 2. Ask CS1 for a new stateful object. CS1 creates a TimelineProcessor
    //    instance and returns it by reference.
    //    `processorProxy` is now a proxy on BG, pointing to the real object on CS1.
    const processorProxy = await csApi.getTimelineProcessor();

    // --- Action performed by: BACKGROUND ---
    // 3. Interact with the stateful object *through the proxy*. These calls
    //    are sent to CS1 and modify the state of the original object.
    processorProxy.addEvent("event-1-from-background");
    processorProxy.addEvent("event-2-from-background");

    // --- Action performed by: BACKGROUND ---
    // 4. Get the final processed state from the object, again via the proxy.
    //    The `process()` method will execute on CS1 using the now-modified state.
    const result = await processorProxy.process();

    // --- Asserts performed by: BACKGROUND (via the test runner) ---
    // 5. Verify the result contains the state changes initiated from the background.
    expect(result.issueId).toBe("CS1");
    expect(result.eventCount).toBe(2);
    expect(result.firstEvent).toBe("event-1-from-background");
  });

  it("should correctly release a remote resource proxy", async () => {
    // Spy on the real resource manager of the content script
    const cs1ResourceManager = (cs1.nexus as any).engine.resourceManager;
    const initialResourceCount = (cs1ResourceManager as any)
      .localResourceRegistry.size;

    const csApi = await background.nexus.create(ContentScriptServiceToken, {
      target: {
        matcher: (id) =>
          id.context === "content-script" && id.issueId === "CS1",
      },
      expects: "one",
    });
    expect(csApi).toBeDefined();

    // 1. Get a proxy to a resource living on CS1
    const processorProxy = await csApi.getTimelineProcessor();
    expect(
      (cs1ResourceManager as any).localResourceRegistry.size
    ).toBeGreaterThan(initialResourceCount);

    // 2. Manually release it from the background. This is now fire-and-forget.
    background.nexus.release(processorProxy);

    // 3. The resource should be gone from CS1's resource manager
    await vi.waitFor(() => {
      expect((cs1ResourceManager as any).localResourceRegistry.size).toBe(
        initialResourceCount
      );
    });
  });

  it("should propagate errors from remote back to caller", async () => {
    const csApi = await background.nexus.create(ContentScriptServiceToken, {
      target: {
        matcher: (id) =>
          id.context === "content-script" && id.issueId === "CS1",
      },
      expects: "one",
    });
    expect(csApi).toBeDefined();

    // Attempt to call a method that will throw an error on the remote
    const promise = csApi.highlightUser("non-existent-user");

    // Assert that the promise rejects with a specific Nexus error type
    await expect(promise).rejects.toBeInstanceOf(NexusRemoteError);
    await expect(promise).rejects.toThrow(/User "non-existent-user" not found/);
  });

  it("should discover endpoints using dynamic metadata", async () => {
    // Initially, CS1 is active.
    let activeTabApi = await background.nexus.create(
      ContentScriptServiceToken,
      {
        target: {
          matcher: (id) => id.context === "content-script" && id.isActive,
        },
        expects: "first",
      }
    );
    let title = await activeTabApi.getTitle();
    expect(title).toContain("CS1");

    // Now, simulate the user switching tabs. CS2 becomes active, CS1 becomes inactive.
    cs1.nexus.updateIdentity({ isActive: false });
    cs2.nexus.updateIdentity({ isActive: true });

    // Allow time for identity updates to propagate.
    // In a real system this is near-instant, but in tests we wait.
    await new Promise((r) => setTimeout(r, 50));

    // Re-run discovery. It should now find CS2.
    activeTabApi = await background.nexus.create(ContentScriptServiceToken, {
      target: {
        matcher: (id) => id.context === "content-script" && id.isActive,
      },
      expects: "first",
    });
    title = await activeTabApi.getTitle();
    expect(title).toContain("CS2");
  });

  it("should use named and compound matchers for discovery", async () => {
    // Reconfigure the background nexus on the fly to add named matchers
    background.nexus.configure({
      matchers: {
        "is-active": (id) => id.context === "content-script" && id.isActive,
        "is-github-issue": (id) =>
          id.context === "content-script" &&
          id.url.startsWith("github.com/issue"),
      },
    });

    const activeGitHubTab = await background.nexus.create(
      ContentScriptServiceToken,
      {
        target: {
          // The type augmentation with `configure` works for compile-time safety.
          // This test confirms the runtime logic of named matchers also works
          // when they are added to a live instance.
          matcher: (background.nexus.matchers as any).and(
            "is-active",
            "is-github-issue"
          ),
        },
        expects: "first",
      }
    );

    const title = await activeGitHubTab!.getTitle();
    expect(title).toContain("CS1"); // CS1 is the active one
  });

  it("should broadcast to all matched endpoints with 'all' strategy", async () => {
    // Spy on the refresh method of both content script implementations
    const cs1RefreshSpy = vi.spyOn(cs1.service, "refresh");
    const cs2RefreshSpy = vi.spyOn(cs2.service, "refresh");

    const allTabsProxy = await background.nexus.createMulticast(
      ContentScriptServiceToken,
      {
        target: {
          matcher: (id) => id.context === "content-script",
        },
        expects: "all",
      }
    );

    // For the 'all' strategy, the return value is an array of settled results.
    // We await the method call itself.
    const results = await allTabsProxy.refresh();

    // The results array confirms the call was attempted for both targets.
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);

    // Both spies should have been called
    expect(cs1RefreshSpy).toHaveBeenCalledTimes(1);
    expect(cs2RefreshSpy).toHaveBeenCalledTimes(1);
  });

  it("should broadcast to a service group using groupName", async () => {
    const cs1RefreshSpy = vi.spyOn(cs1.service, "refresh");
    const cs2RefreshSpy = vi.spyOn(cs2.service, "refresh");

    const groupProxy = await background.nexus.createMulticast(
      ContentScriptServiceToken,
      {
        target: { groupName: "issue-pages" },
        expects: "all",
      }
    );

    const results = await groupProxy.refresh();
    expect(results).toHaveLength(2);
    expect(cs1RefreshSpy).toHaveBeenCalledTimes(1);
    expect(cs2RefreshSpy).toHaveBeenCalledTimes(1);
  });

  it("should handle partial failures when broadcasting", async () => {
    // configureNexusLogger({ enabled: true, level: LogLevel.DEBUG });

    // Modify CS2's getTitle implementation to throw an error
    vi.spyOn(cs2.service, "getTitle").mockRejectedValue(
      new Error("Failed to get title from CS2")
    );

    const allTabsProxy = await background.nexus.createMulticast(
      ContentScriptServiceToken,
      {
        target: {
          matcher: (id) => id.context === "content-script",
        },
        expects: "all",
      }
    );

    const results = await allTabsProxy.getTitle();

    expect(results).toHaveLength(2);
    const fulfilledResult = results.find((r) => r.status === "fulfilled");
    const rejectedResult = results.find((r) => r.status === "rejected");

    expect(fulfilledResult).toBeDefined();
    expect(fulfilledResult?.value).toContain("CS1");

    expect(rejectedResult).toBeDefined();
    expect(rejectedResult?.reason.message).toContain(
      "Failed to get title from CS2"
    );
  });

  it("should stream results with 'stream' strategy", async () => {
    const streamProxy = await background.nexus.createMulticast(
      ContentScriptServiceToken,
      {
        target: {
          matcher: (id) => id.context === "content-script",
        },
        expects: "stream",
      }
    );

    const receivedResults: { from: string; title: string }[] = [];
    // Calling a method on a stream proxy returns a promise that resolves to the async iterator.
    const titleIterator = await streamProxy!.getTitle();
    for await (const result of titleIterator) {
      if (result.status === "fulfilled") {
        receivedResults.push({ from: result.from, title: result.value });
      }
    }

    // We should have received results from both content scripts
    expect(receivedResults).toHaveLength(2);
    expect(receivedResults.map((r) => r.title)).toContain(
      "Issue CS1 - My Test Project"
    );
    expect(receivedResults.map((r) => r.title)).toContain(
      "Issue CS2 - My Test Project"
    );
  });

  it("should use a factory for dependency injection", async () => {
    // This test requires a separate, isolated setup
    DecoratorRegistry.clear();

    class Dependency {
      getValue() {
        return "injected-value";
      }
    }
    interface IServiceWithDep {
      getInjectedValue(): string;
    }
    const ServiceWithDepToken = new Token<IServiceWithDep>("service-with-dep");

    // Use the @Expose decorator with a factory
    @Expose(ServiceWithDepToken, {
      factory: () =>
        new (class implements IServiceWithDep {
          private dep = new Dependency();
          getInjectedValue() {
            return this.dep.getValue();
          }
        })(),
    })
    // @ts-ignore - Used by decorator
    class ServiceWithDepImpl implements IServiceWithDep {
      // This implementation is just a placeholder for the decorator
      getInjectedValue() {
        return "";
      }
    }

    const hostNexus = new Nexus<any, any>().configure({
      endpoint: {
        meta: { context: "host" },
        implementation: { listen: vi.fn() },
      },
    });

    // We need to manually initialize the host to process the decorator
    await (hostNexus as any)._initialize();

    // Now, get the service. The factory should have run.
    const service = (hostNexus as any).engine.resourceManager.getExposedService(
      "service-with-dep"
    );
    expect(service).toBeDefined();
    expect((service as IServiceWithDep).getInjectedValue()).toBe(
      "injected-value"
    );
  });

  // ===========================================================================
  // Token and Decorator Integration Tests
  // ===========================================================================

  describe("Token and Decorator Integration", () => {
    it("should create basic tokens and use them with @Expose decorator", async () => {
      // This test focuses on the fundamental Token + @Expose pattern
      // without complex networking to isolate any issues

      // Clear any previous decorator registrations
      DecoratorRegistry.clear();

      // Create simple tokens
      const SettingsToken = new Token<ISettingsService>("settings-service");
      const CommentToken = new Token<ICommentService>("comment-service");

      // Use @Expose decorator to register services
      @Expose(SettingsToken)
      // @ts-ignore - Used by decorator
      class SettingsServiceImpl implements ISettingsService {
        async getSettings() {
          return { showAvatars: true, defaultProject: "test-project" };
        }
        async updateSettings(settings: Partial<Settings>) {
          return {
            showAvatars: settings.showAvatars ?? true,
            defaultProject: settings.defaultProject ?? "test-project",
          };
        }
      }

      @Expose(CommentToken)
      // @ts-ignore - Used by decorator
      class CommentServiceImpl implements ICommentService {
        async getComments(_issueId: string) {
          return [{ id: "1", user: "test-user", body: "Test comment" }];
        }
        async addComment(_issueId: string, comment: Omit<Comment, "id">) {
          return { id: "new-id", ...comment };
        }
      }

      // Create a single Nexus instance to test service registration
      const nexus = new Nexus<AppUserMeta, AppPlatformMeta>().configure({
        endpoint: {
          meta: { context: "background", version: "1.0" },
          implementation: { listen: vi.fn() },
        },
      });

      // Initialize to process decorators
      await (nexus as any)._initialize();

      // Verify services were registered by the decorators
      const settingsService = (
        nexus as any
      ).engine.resourceManager.getExposedService(SettingsToken.id);
      const commentService = (
        nexus as any
      ).engine.resourceManager.getExposedService(CommentToken.id);

      expect(settingsService).toBeDefined();
      expect(commentService).toBeDefined();

      // Test the actual service functionality
      const settings = await (
        settingsService as ISettingsService
      ).getSettings();
      expect(settings).toEqual({
        showAvatars: true,
        defaultProject: "test-project",
      });

      const comments = await (commentService as ICommentService).getComments(
        "test-issue"
      );
      expect(comments).toEqual([
        { id: "1", user: "test-user", body: "Test comment" },
      ]);
    });

    it("should support TokenSpace for structured token namespaces", async () => {
      // Import TokenSpace
      const { TokenSpace } = await import("./token-space");

      // Create a structured token namespace
      const app = new TokenSpace<AppUserMeta, AppPlatformMeta>({ name: "app" });

      const background = app.tokenSpace("background", {
        defaultTarget: {
          descriptor: { context: "background", version: "1.0" },
        },
      });

      const contentScript = app.tokenSpace("content-script", {
        defaultTarget: {
          matcher: (identity: AppUserMeta) =>
            identity.context === "content-script",
        },
      });

      // Create tokens using TokenSpace
      const BackgroundSettingsToken =
        background.token<ISettingsService>("settings");
      const ContentCommentToken =
        contentScript.token<ICommentService>("comments");

      // Verify token IDs are correctly structured
      expect(BackgroundSettingsToken.id).toBe("app:background:settings");
      expect(ContentCommentToken.id).toBe("app:content-script:comments");

      // Verify defaultTarget inheritance
      expect(BackgroundSettingsToken.defaultTarget).toEqual({
        descriptor: { context: "background", version: "1.0" },
      });
      expect(ContentCommentToken.defaultTarget).toEqual({
        matcher: expect.any(Function),
      });

      // Test the matcher function
      const matcher = ContentCommentToken.defaultTarget?.matcher;
      expect(matcher).toBeDefined();
      if (matcher) {
        expect(
          matcher({
            context: "content-script",
            url: "test",
            issueId: "1",
            isActive: true,
          })
        ).toBe(true);
        expect(matcher({ context: "background", version: "1.0" })).toBe(false);
      }
    });

    it("should support nested TokenSpace configuration inheritance", async () => {
      const { TokenSpace } = await import("./token-space");

      // Create deeply nested TokenSpace structure
      const company = new TokenSpace<AppUserMeta, AppPlatformMeta>({
        name: "company",
        defaultTarget: {
          descriptor: { context: "background", version: "1.0" },
        },
      });

      const product = company.tokenSpace("product");
      const backend = product.tokenSpace("backend");

      // Override parent configuration
      const microservices = backend.tokenSpace("microservices", {
        defaultTarget: {
          matcher: (identity: AppUserMeta) =>
            identity.context === "content-script",
        },
      });

      const auth = microservices.tokenSpace("auth");

      // Create a token in the deeply nested namespace
      const UserToken = auth.token<IUserService>("profile");

      // Verify the token ID reflects the full hierarchy
      expect(UserToken.id).toBe(
        "company:product:backend:microservices:auth:profile"
      );

      // Verify configuration inheritance and override
      expect(UserToken.defaultTarget).toEqual({
        matcher: expect.any(Function), // Should inherit from microservices override
      });

      // Verify the matcher function works correctly
      const matcher = UserToken.defaultTarget?.matcher;
      expect(matcher).toBeDefined();
      if (matcher) {
        expect(
          matcher({
            context: "content-script",
            url: "test",
            issueId: "1",
            isActive: true,
          })
        ).toBe(true);
        expect(matcher({ context: "background", version: "1.0" })).toBe(false);
      }
    });
  });
});
