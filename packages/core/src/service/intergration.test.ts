import { vi, describe, it, expect, beforeEach } from "vitest";
import { ConnectionManager } from "@/connection/connection-manager";
import { Engine } from "./engine";
import type { ResourceManager } from "./resource-manager";
import { createL3Endpoints } from "@/utils/test-utils";
import { REF_WRAPPER_SYMBOL } from "@/types/ref-wrapper";
import { RELEASE_PROXY_SYMBOL } from "@/types/symbols";
import { configureNexusLogger, LogLevel } from "@/logger";
import { NexusDisconnectedError, NexusRemoteError } from "@/errors";

// ===========================================================================
// Test-Specific Types (as requested, co-located with the test)
// ===========================================================================

interface Task {
  id: string;
  title: string;
  completed: boolean;
  metadata: object;
}

interface TaskProcessor {
  markComplete(): Promise<boolean>;
  getDetails(): Promise<{ details: string }>;
}

interface TaskService {
  getTasks(): Promise<Task[]>;
  addTask(title: string, metadata: object): Promise<Task>;
  subscribe(onUpdate: (tasks: Task[]) => void): Promise<string>;
  getProcessor(taskId: string): Promise<TaskProcessor | null>;
  throwError(): Promise<void>;
  unsubscribe(subscriptionId: string): Promise<void>;
}

// ===========================================================================
// Mock Implementation of the Service for the "Host" Side
// ===========================================================================

class TaskProcessorImpl implements TaskProcessor {
  constructor(private task: Task) {}

  async markComplete(): Promise<boolean> {
    this.task.completed = true;
    return true;
  }

  async getDetails(): Promise<{ details: string }> {
    return { details: `Details for ${this.task.title}` };
  }
}

class TaskServiceImpl implements TaskService {
  private tasks = new Map<string, Task>();
  private subscribers = new Map<string, (tasks: Task[]) => void>();
  private nextTaskId = 1;
  private nextSubId = 1;

  private notifySubscribers() {
    const taskList = Array.from(this.tasks.values());
    for (const onUpdate of this.subscribers.values()) {
      // It's crucial that the call to the remote callback is not awaited
      // so that one slow client doesn't block notifications for others.
      onUpdate(taskList);
    }
  }

  async getTasks(): Promise<Task[]> {
    return Array.from(this.tasks.values());
  }

  async addTask(title: string, metadata: object): Promise<Task> {
    const id = `task-${this.nextTaskId++}`;
    const newTask: Task = { id, title, completed: false, metadata };
    this.tasks.set(id, newTask);
    this.notifySubscribers();
    return newTask;
  }

  async subscribe(onUpdate: (tasks: Task[]) => void): Promise<string> {
    const id = `sub-${this.nextSubId++}`;
    this.subscribers.set(id, onUpdate);
    // Immediately send the current list to the new subscriber
    onUpdate(Array.from(this.tasks.values()));
    return id;
  }

  async unsubscribe(subscriptionId: string): Promise<void> {
    this.subscribers.delete(subscriptionId);
  }

  async getProcessor(taskId: string): Promise<TaskProcessor | null> {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    // Return a new stateful processor instance for this specific task
    const processor = new TaskProcessorImpl(task);
    // Wrap the stateful object so it's passed by reference, using `as any`
    // to bypass the static type check of the interface. The proxy returned
    // to the client will correctly match the `TaskProcessor` interface.
    return {
      [REF_WRAPPER_SYMBOL]: true,
      target: processor,
    } as any;
  }

  async throwError(): Promise<void> {
    throw new Error("This is an intentional error for testing.");
  }
}

// ===========================================================================
// L3 Integration Test Suite
// ===========================================================================

describe("L3 Engine Integration Test: Task Service", () => {
  let clientEngine: Engine<any, any>;
  let hostEngine: Engine<any, any>;
  let serviceProxy: TaskService;
  let clientCm: ConnectionManager<any, any>;
  let hostCm: ConnectionManager<any, any>;

  // Note: This setup is now async.
  beforeEach(async () => {
    const taskServiceImpl = new TaskServiceImpl();

    const setup = await createL3Endpoints(
      {
        meta: { id: "host" },
        services: { tasks: taskServiceImpl },
      },
      {
        meta: { id: "client" },
      }
    );

    clientEngine = setup.clientEngine;
    hostEngine = setup.hostEngine;
    clientCm = setup.clientCm;
    hostCm = setup.hostCm;

    // --- Create Proxy ---
    // With the redesigned ProxyFactory, we now create a proxy bound directly
    // to the "tasks" service by name.
    serviceProxy = (clientEngine as any).proxyFactory.createServiceProxy(
      "tasks",
      { target: { connectionId: setup.clientConnection.connectionId } }
    );
  });

  it("should perform a basic RPC call and receive a result", async () => {
    const tasks = await serviceProxy.getTasks();
    expect(tasks).toEqual([]);

    const newTask = await serviceProxy.addTask("Test Task", { priority: 1 });
    expect(newTask.title).toBe("Test Task");
    expect(newTask.id).toBe("task-1");

    const updatedTasks = await serviceProxy.getTasks();
    expect(updatedTasks).toHaveLength(1);
    expect(updatedTasks[0].title).toBe("Test Task");
  });

  it("should handle callbacks, enabling host-to-client communication", async () => {
    const onUpdate = vi.fn();

    // Subscribe to updates. The host should immediately send the current list.
    await serviceProxy.subscribe(onUpdate);

    // The host immediately calls back with the initial state (empty array)
    await vi.waitFor(() => {
      expect(onUpdate).toHaveBeenCalledTimes(1);
    });
    expect(onUpdate).toHaveBeenCalledWith([]);

    // Trigger an update on the host
    await serviceProxy.addTask("Second Task", {});

    // The host should call the callback again with the updated list·~
    await vi.waitFor(() => {
      expect(onUpdate).toHaveBeenCalledTimes(2);
    });
    expect(onUpdate).toHaveBeenCalledWith([
      expect.objectContaining({ title: "Second Task" }),
    ]);
  });

  it("should stop notifications after unsubscribing", async () => {
    const onUpdate = vi.fn();
    const subscriptionId = await serviceProxy.subscribe(onUpdate);

    // Initial call
    await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(onUpdate).toHaveBeenCalledWith([]);

    // Unsubscribe
    await serviceProxy.unsubscribe(subscriptionId);

    // Trigger another update
    await serviceProxy.addTask("A task after unsubscribing", {});

    // To be sure no more calls are coming, we can wait a bit
    await new Promise((r) => setTimeout(r, 50));

    // The handler should NOT have been called again
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("should correctly proxy a returned stateful object", async () => {
    const task = await serviceProxy.addTask("Process Me", {});
    expect(task.completed).toBe(false);

    // Get the dedicated processor for this task
    const processor = await serviceProxy.getProcessor(task.id);
    expect(processor).toBeDefined();

    // Interact with the processor proxy
    const result = await processor!.markComplete();
    expect(result).toBe(true);

    // Verify the state was changed on the host. The result of a single-target
    // call is the raw value, not an array.
    const updatedTasks = await serviceProxy.getTasks();
    expect(updatedTasks[0].completed).toBe(true);
  });

  it("should manually release a resource proxy from the client", async () => {
    const task = await serviceProxy.addTask("Task to be processed", {});
    const processor = await serviceProxy.getProcessor(task.id);
    expect(processor).toBeDefined();

    // Find the resourceId of the processor proxy on the client
    const clientResourceManager = (clientEngine as any)
      .resourceManager as ResourceManager;
    // Explicitly type the array to guide the linter
    const remoteProxies: [
      string,
      { proxy: object; sourceConnectionId: string },
    ][] = Array.from(
      (clientResourceManager as any).remoteProxyRegistry.entries()
    );
    const processorEntry = remoteProxies.find(
      ([_id, entry]) => entry.proxy === processor
    );
    expect(processorEntry).toBeDefined();
    const resourceId = processorEntry![0];

    // Verify the original resource exists on the host
    const hostResourceManager = (hostEngine as any)
      .resourceManager as ResourceManager;
    expect(
      (hostResourceManager as any).localResourceRegistry.has(resourceId)
    ).toBe(true);

    // Manually release the proxy on the client using the correct symbol.
    await (processor as any)[RELEASE_PROXY_SYMBOL]();

    // The release message is fire-and-forget, but we can wait for the host
    // to process it by checking the resource registry.
    await vi.waitFor(() => {
      expect(
        (hostResourceManager as any).localResourceRegistry.has(resourceId)
      ).toBe(false);
    });
  });

  it("should propagate errors from the host back to the client", async () => {
    // Using `expect.rejects` to assert that the promise fails
    await expect(serviceProxy.throwError()).rejects.toBeInstanceOf(
      NexusRemoteError
    );
  });

  it("should reject pending calls when a connection is terminated", async () => {
    // This call will be pending when we close the connection.
    const pendingPromise = serviceProxy.getTasks();

    // Find the dynamic connection ID from the established connection.
    const connection = Array.from(
      (clientCm as any).connections.values()
    )[0] as any;

    // Manually call close on the connection, which will trigger disconnect logic
    connection.close();

    // Assert that the pending promise is rejected with a specific message.
    await expect(pendingPromise).rejects.toBeInstanceOf(NexusDisconnectedError);
  });

  it("should reject when calling a proxy bound to a closed connection", async () => {
    // Ensure connection is up
    expect(await serviceProxy.getTasks()).toBeDefined();

    // Find the connection and close it
    const connection = Array.from(
      (clientCm as any).connections.values()
    )[0] as any;
    connection.close();

    // Wait for the client to process the disconnect
    await vi.waitFor(() => {
      expect(Array.from((clientCm as any).connections.values()).length).toBe(0);
    });

    // Now, make a new call on the proxy. The target connection is gone.
    const resultPromise = serviceProxy.getTasks();

    // The call should fail because the target connection is no longer valid.
    await expect(resultPromise).rejects.toBeInstanceOf(NexusDisconnectedError);
  });

  it("should clean up resources when a connection is terminated", async () => {
    const onUpdate = vi.fn();
    await serviceProxy.subscribe(onUpdate);

    // Spy on the internal resource managers
    const clientResourceManager = (clientEngine as any)
      .resourceManager as ResourceManager;
    const hostResourceManager = (hostEngine as any)
      .resourceManager as ResourceManager;

    // A local resource (the onUpdate callback) should exist on the client
    const clientResources = Array.from(
      (clientResourceManager as any).localResourceRegistry.values()
    );
    expect(clientResources.length).toBeGreaterThan(0);

    // A remote proxy for that callback should exist on the host
    const hostProxies = Array.from(
      (hostResourceManager as any).remoteProxyRegistry.values()
    );
    expect(hostProxies.length).toBeGreaterThan(0);

    // --- Simulate connection cleanup ---
    // Find the dynamic connection ID from the established connection.
    const connection = Array.from(
      (clientCm as any).connections.values()
    )[0] as any;

    // Manually call close on the connection, which will trigger disconnect logic
    connection.close();

    await vi.waitFor(() => {
      // Verify that the resources have been purged
      const clientResourcesAfter = Array.from(
        (clientResourceManager as any).localResourceRegistry.values()
      );
      expect(clientResourcesAfter).toHaveLength(0);

      const hostProxiesAfter = Array.from(
        (hostResourceManager as any).remoteProxyRegistry.values()
      );
      expect(hostProxiesAfter).toHaveLength(0);
    });
  });

  describe("Broadcast and Streaming Strategies", () => {
    let broadcastProxy: TaskService;

    beforeEach(() => {
      // Create a proxy that targets the client via a matcher.
      // Even with one client, this tests the broadcast/multi-response logic.
      broadcastProxy = (clientEngine as any).proxyFactory.createServiceProxy(
        "tasks",
        {
          target: { matcher: (meta: any) => meta.id === "host" },
          broadcastOptions: { strategy: "all" },
        }
      );
    });

    it("should return an aggregated array for 'all' strategy", async () => {
      await broadcastProxy.addTask("Task for broadcast", {});
      const tasksResult = await (broadcastProxy as any).getTasks();

      // The result should be an array of results from all matched targets.
      // In this case, one target, so an array with one element.
      expect(tasksResult).toBeInstanceOf(Array);
      expect(tasksResult).toHaveLength(1);
      expect(tasksResult[0].status).toBe("fulfilled");
      // Assert that the 'from' field contains the connection ID as seen by the client
      const hostConnectionId = (clientCm as any).connections
        .keys()
        .next().value;
      expect(tasksResult[0].from).toBe(hostConnectionId);

      const tasks = tasksResult[0].value;
      expect(tasks).toHaveLength(1);
      expect(tasks[0].title).toBe("Task for broadcast");
    });

    it("should stream results for 'stream' strategy", async () => {
      const streamProxy = (clientEngine as any).proxyFactory.createServiceProxy(
        "tasks",
        {
          target: { matcher: (meta: any) => meta.id === "host" },
          strategy: "stream",
        }
      );

      await (streamProxy as any).addTask("Task for stream", {});
      const tasksStream = await (streamProxy as any).getTasks();

      const receivedResults = [];
      for await (const result of tasksStream) {
        receivedResults.push(result);
      }

      expect(receivedResults).toHaveLength(1);
      // For broadcast/stream, the result is an object containing the value.
      const firstResult = receivedResults[0];
      expect(firstResult.status).toBe("fulfilled");
      const tasks = firstResult.value;
      expect(tasks).toHaveLength(1);
      expect(tasks[0].title).toBe("Task for stream");
    });
  });
});
