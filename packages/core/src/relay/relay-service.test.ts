import { describe, expect, it, vi } from "vitest";
import { Token } from "@/api/token";
import {
  SERVICE_INVOKE_END,
  SERVICE_INVOKE_START,
  type ServiceInvocationContext,
} from "@/service/service-invocation-hooks";
import { RELEASE_PROXY_SYMBOL } from "@/types/symbols";
import { NexusServiceError } from "@/errors/service-errors";
import { RelayError, relayService } from "./index";

interface TestMeta {
  context: string;
}

interface TestPlatform {
  from: string;
}

interface TestService {
  profile: {
    update(input: { name: string }): Promise<{ ok: boolean }>;
  };
}

const createInvocation = (): ServiceInvocationContext => ({
  sourceConnectionId: "conn-leaf",
  sourceIdentity: { context: "iframe-leaf" },
  localIdentity: { context: "content-relay" },
  platform: { from: "iframe" },
});

describe("relayService", () => {
  it("forwards nested APPLY calls through the upstream nexus", async () => {
    const update = vi.fn(async () => ({ ok: true }));
    const connect = vi.fn(async () => ({
      get: () => ({ profile: { update } }),
    }));
    const token = new Token<TestService>("relay:test-service:apply");
    const registration = relayService<
      TestService,
      TestMeta,
      TestPlatform,
      TestMeta,
      TestPlatform
    >(token, {
      forwardThrough: { connect } as any,
      forwardTarget: { context: "background" },
    });

    const service = registration.service as TestService & {
      [SERVICE_INVOKE_START](
        invocation: ServiceInvocationContext,
      ): ServiceInvocationContext;
      [SERVICE_INVOKE_END](invocation?: ServiceInvocationContext): void;
    };

    const invocation = service[SERVICE_INVOKE_START](createInvocation());
    const result = await service.profile.update(
      { name: "Ada" },
      invocation as never,
    );
    service[SERVICE_INVOKE_END](invocation);

    expect(connect).toHaveBeenCalledWith({ target: { context: "background" } });
    expect(update).toHaveBeenCalledWith({ name: "Ada" });
    expect(result).toEqual({ ok: true });
  });

  it("passes trusted invocation context to relay policy", async () => {
    const canCall = vi.fn(async () => true);
    const connect = vi.fn(async () => ({
      get: () => ({ profile: { update: vi.fn(async () => ({ ok: true })) } }),
    }));
    const token = new Token<TestService>("relay:test-service:policy");
    const registration = relayService<
      TestService,
      TestMeta,
      TestPlatform,
      TestMeta,
      TestPlatform
    >(token, {
      forwardThrough: { connect } as any,
      forwardTarget: { context: "background" },
      policy: { canCall },
    });

    const service = registration.service as TestService & {
      [SERVICE_INVOKE_START](
        invocation: ServiceInvocationContext,
      ): ServiceInvocationContext;
    };
    const invocation = service[SERVICE_INVOKE_START](createInvocation());

    await service.profile.update({ name: "Lin" }, invocation as never);

    expect(canCall).toHaveBeenCalledWith({
      origin: { context: "iframe-leaf" },
      relay: { context: "content-relay" },
      connection: { from: "iframe" },
      tokenId: token.id,
      path: ["profile", "update"],
      operation: "APPLY",
    });
  });

  it("rejects unsupported capability-bearing args before forwarding upstream", async () => {
    const connect = vi.fn(async () => ({
      get: () => ({ profile: { update: vi.fn() } }),
    }));
    const token = new Token<TestService>("relay:test-service:arg-reject");
    const registration = relayService<
      TestService,
      TestMeta,
      TestPlatform,
      TestMeta,
      TestPlatform
    >(token, {
      forwardThrough: { connect } as any,
      forwardTarget: { context: "background" },
    });
    const service = registration.service as TestService & {
      [SERVICE_INVOKE_START](
        invocation: ServiceInvocationContext,
      ): ServiceInvocationContext;
    };
    const invocation = service[SERVICE_INVOKE_START](createInvocation());

    await expect(
      service.profile.update(
        { name: "Ada", cb: () => undefined } as never,
        invocation as never,
      ),
    ).rejects.toMatchObject({ code: "E_RELAY_PAYLOAD_UNSUPPORTED" });
    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects unsupported capability-bearing upstream results", async () => {
    const released = { [RELEASE_PROXY_SYMBOL]: () => undefined };
    const connect = vi.fn(async () => ({
      get: () => ({ profile: { update: vi.fn(async () => released) } }),
    }));
    const token = new Token<TestService>("relay:test-service:result-reject");
    const registration = relayService<
      TestService,
      TestMeta,
      TestPlatform,
      TestMeta,
      TestPlatform
    >(token, {
      forwardThrough: { connect } as any,
      forwardTarget: { context: "background" },
    });
    const service = registration.service as TestService & {
      [SERVICE_INVOKE_START](
        invocation: ServiceInvocationContext,
      ): ServiceInvocationContext;
    };
    const invocation = service[SERVICE_INVOKE_START](createInvocation());

    await expect(
      service.profile.update({ name: "Ada" }, invocation as never),
    ).rejects.toMatchObject({ code: "E_RELAY_PAYLOAD_UNSUPPORTED" });
  });

  it("maps upstream acquisition failures to relay errors", async () => {
    const connect = vi.fn(async () => {
      throw new NexusServiceError(
        "No upstream service connection matched.",
        "E_SERVICE_NO_MATCH",
      );
    });
    const token = new Token<TestService>("relay:test-service:targeting");
    const registration = relayService<
      TestService,
      TestMeta,
      TestPlatform,
      TestMeta,
      TestPlatform
    >(token, {
      forwardThrough: { connect } as any,
      forwardTarget: { context: "background" },
    });
    const service = registration.service as TestService & {
      [SERVICE_INVOKE_START](
        invocation: ServiceInvocationContext,
      ): ServiceInvocationContext;
    };
    const invocation = service[SERVICE_INVOKE_START](createInvocation());

    await expect(
      service.profile.update({ name: "Ada" }, invocation as never),
    ).rejects.toMatchObject({ code: "E_RELAY_UPSTREAM_FAILURE" });
  });

  it("rejects SET with a structured relay error", async () => {
    const token = new Token<TestService>("relay:test-service:set");
    const registration = relayService<
      TestService,
      TestMeta,
      TestPlatform,
      TestMeta,
      TestPlatform
    >(token, {
      forwardThrough: { connect: vi.fn() } as any,
      forwardTarget: { context: "background" },
    });

    expect(() => {
      (registration.service as any).profile = {};
    }).toThrow(RelayError);
    expect(() => {
      (registration.service as any).profile = {};
    }).toThrow(/not supported/i);
  });
});
