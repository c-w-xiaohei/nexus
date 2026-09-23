import { describe, it, expect, beforeEach } from "vitest";
import { ResourceManager } from "./resource-manager";
import { ResourceScopeHandle } from "./resource-scope";

describe("ResourceManager", () => {
  let resourceManager: ResourceManager;

  // Mock objects
  const mockService = {
    echo: (msg: string) => msg,
    nested: {
      getValue: () => 123,
    },
  };
  const mockResource = () => {};

  beforeEach(() => {
    // Create a new instance for each test to ensure isolation.
    resourceManager = new ResourceManager();
  });

  describe("Exposed Services", () => {
    it("should register and retrieve an exposed service", () => {
      resourceManager.registerExposedServices([
        { name: "myApi", service: mockService },
      ]);
      const target = resourceManager.getExposedService("myApi");
      expect(target).toBe(mockService);
    });

    it("should return undefined for a non-existent service", () => {
      const target = resourceManager.getExposedService("nonExistentApi");
      expect(target).toBeUndefined();
    });

    it("replaces existing exposed providers", () => {
      const replacement = { echo: () => "replacement" };

      resourceManager.registerExposedServices([
        { name: "myApi", service: mockService },
      ]);
      resourceManager.registerExposedServices([
        { name: "myApi", service: replacement },
      ]);

      expect(resourceManager.getExposedService("myApi")).toBe(replacement);
    });

    it("commits duplicate names in order because declaration validation belongs to Nexus", () => {
      const first = { echo: () => "first" };
      const second = { echo: () => "second" };

      resourceManager.registerExposedServices([
        { name: "duplicate", service: first },
        { name: "duplicate", service: second },
      ]);

      expect(resourceManager.getExposedService("duplicate")).toBe(second);
    });
  });

  describe("Local Resources", () => {
    it("should register a local resource and return a unique ID", () => {
      const id1 = resourceManager.registerLocalResource(mockResource, "conn-1");
      const id2 = resourceManager.registerLocalResource({}, "conn-2");
      expect(id1).toMatch(/^res-\d+$/);
      expect(id2).toMatch(/^res-\d+$/);
      expect(id1).not.toBe(id2);
    });

    it("should retrieve a registered local resource by its ID", () => {
      const resourceId = resourceManager.registerLocalResource(
        mockResource,
        "conn-1",
      );
      const record = resourceManager.getLocalResource(resourceId);
      expect(record).toBeDefined();
      expect(record?.target).toBe(mockResource);
      expect(record?.ownerConnectionId).toBe("conn-1");
    });

    it("should return undefined for a non-existent resource ID", () => {
      const record = resourceManager.getLocalResource("res-nonexistent");
      expect(record).toBeUndefined();
    });

    it("should release a local resource, making it irretrievable", () => {
      const resourceId = resourceManager.registerLocalResource(
        mockResource,
        "conn-1",
      );
      expect(resourceManager.getLocalResource(resourceId)).toBeDefined();

      resourceManager.releaseLocalResource(resourceId);
      expect(resourceManager.getLocalResource(resourceId)).toBeUndefined();
    });
  });

  describe("Connection Cleanup", () => {
    it("keeps source and resource IDs distinct even when they contain separators", () => {
      const count = resourceManager.countRemoteProxies();
      resourceManager.registerRemoteProxy("b\u0000c", "a");
      resourceManager.registerRemoteProxy("b\u0000c", "a");
      resourceManager.registerRemoteProxy("c", "a\u0000b");
      expect(resourceManager.countRemoteProxies()).toBe(count + 2);
      resourceManager.cleanupConnection("a");
      expect(resourceManager.hasRemoteProxy("b\u0000c", "a")).toBe(false);
      expect(resourceManager.hasRemoteProxy("c", "a\u0000b")).toBe(true);
      resourceManager.releaseRemoteProxy("c", "a\u0000b");
      expect(resourceManager.countRemoteProxies()).toBe(count);
    });
    let localResId1: string;
    let localResId2: string;

    beforeEach(() => {
      // Setup: Register resources and proxies for two different connections.
      localResId1 = resourceManager.registerLocalResource({}, "conn-A");
      localResId2 = resourceManager.registerLocalResource({}, "conn-B");
      resourceManager.registerRemoteProxy("remote-res-A", "conn-A");
      resourceManager.registerRemoteProxy("remote-res-B", "conn-B");
    });

    it("should clean up all resources and proxies associated with a specific connection ID", () => {
      // Verify everything exists before cleanup
      expect(resourceManager.getLocalResource(localResId1)).toBeDefined();
      expect(resourceManager.hasRemoteProxy("remote-res-A", "conn-A")).toBe(
        true,
      );

      // Perform cleanup for conn-A
      resourceManager.cleanupConnection("conn-A");

      // Verify conn-A's resources are gone
      expect(resourceManager.getLocalResource(localResId1)).toBeUndefined();
      expect(resourceManager.hasRemoteProxy("remote-res-A", "conn-A")).toBe(
        false,
      );

      // Verify conn-B's resources are NOT affected
      expect(resourceManager.getLocalResource(localResId2)).toBeDefined();
      expect(resourceManager.hasRemoteProxy("remote-res-B", "conn-B")).toBe(
        true,
      );
    });

    it("should not affect any resources if the connection ID has no associated items", () => {
      resourceManager.cleanupConnection("conn-C");

      // Verify nothing was deleted
      expect(resourceManager.getLocalResource(localResId1)).toBeDefined();
      expect(resourceManager.getLocalResource(localResId2)).toBeDefined();
    });

    it("should release a remote proxy explicitly without disconnect cleanup", () => {
      const initialProxyCount = resourceManager.countRemoteProxies();
      resourceManager.registerRemoteProxy("remote-res-X", "conn-X");

      expect(resourceManager.countRemoteProxies()).toBe(initialProxyCount + 1);
      resourceManager.releaseRemoteProxy("remote-res-X", "conn-X");
      expect(resourceManager.countRemoteProxies()).toBe(initialProxyCount);
    });

    it("keeps same resource IDs from separate source connections distinct", () => {
      const initialProxyCount = resourceManager.countRemoteProxies();
      resourceManager.registerRemoteProxy("res-1", "conn-A");
      resourceManager.registerRemoteProxy("res-1", "conn-B");

      resourceManager.releaseRemoteProxy("res-1", "conn-A");

      expect(resourceManager.countRemoteProxies()).toBe(initialProxyCount + 1);
      expect(resourceManager.hasRemoteProxy("res-1", "conn-B")).toBe(true);
    });

    it("keeps matching resource IDs from sibling scopes on one connection distinct", () => {
      const first = new ResourceScopeHandle(
        "scope-first",
        "service",
        "conn-A",
        "requester",
        () => {},
      );
      const sibling = new ResourceScopeHandle(
        "scope-sibling",
        "service",
        "conn-A",
        "requester",
        () => {},
      );

      resourceManager.registerRemoteProxy("res-1", "conn-A", first);
      resourceManager.registerRemoteProxy("res-1", "conn-A", sibling);
      resourceManager.releaseRemoteProxy("res-1", "conn-A", first);

      expect(resourceManager.hasRemoteProxy("res-1", "conn-A", first)).toBe(
        false,
      );
      expect(resourceManager.hasRemoteProxy("res-1", "conn-A", sibling)).toBe(
        true,
      );
    });
  });
});
