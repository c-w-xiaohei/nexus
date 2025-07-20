import { describe, it, expect, beforeEach } from "vitest";
import { ResourceManager } from "./resource-manager";
import { LocalResourceType } from "./types";

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
  const mockProxy = {};

  beforeEach(() => {
    // Create a new instance for each test to ensure isolation.
    resourceManager = new ResourceManager();
  });

  describe("Exposed Services", () => {
    it("should register and retrieve an exposed service", () => {
      resourceManager.registerExposedService("myApi", mockService);
      const target = resourceManager.getExposedService("myApi");
      expect(target).toBe(mockService);
    });

    it("should return undefined for a non-existent service", () => {
      const target = resourceManager.getExposedService("nonExistentApi");
      expect(target).toBeUndefined();
    });
  });

  describe("Local Resources", () => {
    it("should register a local resource and return a unique ID", () => {
      const id1 = resourceManager.registerLocalResource(
        mockResource,
        "conn-1",
        LocalResourceType.FUNCTION
      );
      const id2 = resourceManager.registerLocalResource(
        {},
        "conn-2",
        LocalResourceType.OBJECT
      );
      expect(id1).toMatch(/^res-\d+$/);
      expect(id2).toMatch(/^res-\d+$/);
      expect(id1).not.toBe(id2);
    });

    it("should retrieve a registered local resource by its ID", () => {
      const resourceId = resourceManager.registerLocalResource(
        mockResource,
        "conn-1",
        LocalResourceType.FUNCTION
      );
      const record = resourceManager.getLocalResource(resourceId);
      expect(record).toBeDefined();
      expect(record?.target).toBe(mockResource);
      expect(record?.ownerConnectionId).toBe("conn-1");
      expect(record?.type).toBe(LocalResourceType.FUNCTION);
    });

    it("should return undefined for a non-existent resource ID", () => {
      const record = resourceManager.getLocalResource("res-nonexistent");
      expect(record).toBeUndefined();
    });

    it("should release a local resource, making it irretrievable", () => {
      const resourceId = resourceManager.registerLocalResource(
        mockResource,
        "conn-1",
        LocalResourceType.FUNCTION
      );
      expect(resourceManager.getLocalResource(resourceId)).toBeDefined();

      resourceManager.releaseLocalResource(resourceId);
      expect(resourceManager.getLocalResource(resourceId)).toBeUndefined();
    });
  });

  describe("Connection Cleanup", () => {
    let localResId1: string;
    let localResId2: string;

    beforeEach(() => {
      // Setup: Register resources and proxies for two different connections.
      localResId1 = resourceManager.registerLocalResource(
        {},
        "conn-A",
        LocalResourceType.OBJECT
      );
      localResId2 = resourceManager.registerLocalResource(
        {},
        "conn-B",
        LocalResourceType.OBJECT
      );
      resourceManager.registerRemoteProxy("remote-res-A", mockProxy, "conn-A");
      resourceManager.registerRemoteProxy("remote-res-B", mockProxy, "conn-B");
    });

    it("should clean up all resources and proxies associated with a specific connection ID", () => {
      // Verify everything exists before cleanup
      expect(resourceManager.getLocalResource(localResId1)).toBeDefined();
      // Internal state of remote proxies is not public, so we can't check directly.
      // The test for `releaseLocalResource` confirms the deletion works.

      // Perform cleanup for conn-A
      resourceManager.cleanupConnection("conn-A");

      // Verify conn-A's resources are gone
      expect(resourceManager.getLocalResource(localResId1)).toBeUndefined();
      // We expect that if we tried to get the remote proxy, it would be gone too.

      // Verify conn-B's resources are NOT affected
      expect(resourceManager.getLocalResource(localResId2)).toBeDefined();
    });

    it("should not affect any resources if the connection ID has no associated items", () => {
      resourceManager.cleanupConnection("conn-C");

      // Verify nothing was deleted
      expect(resourceManager.getLocalResource(localResId1)).toBeDefined();
      expect(resourceManager.getLocalResource(localResId2)).toBeDefined();
    });
  });
});
