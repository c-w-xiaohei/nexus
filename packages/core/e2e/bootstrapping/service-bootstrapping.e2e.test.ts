/**
 * Simulates service bootstrapping at startup where decorators register services,
 * factories provide dependency wiring, and TokenSpace namespaces define runtime
 * service identity and targeting defaults before RPC traffic starts.
 */
import { describe, expect, it, vi } from "vitest";

import { Nexus } from "../../src/api/nexus";
import { Token } from "../../src/api/token";
import { Expose } from "../../src/api/decorators/expose";
import { DecoratorRegistry } from "../../src/api/registry";

import type {
  AppPlatformMeta,
  AppUserMeta,
  Comment,
  ICommentService,
  ISettingsService,
  IUserService,
} from "../fixtures";

describe("Nexus L4 E2E: Service Bootstrapping", () => {
  it("should use a factory for dependency injection", async () => {
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

    @Expose(ServiceWithDepToken, {
      factory: () =>
        new (class implements IServiceWithDep {
          private dep = new Dependency();

          getInjectedValue() {
            return this.dep.getValue();
          }
        })(),
    })
    class ServiceWithDepImpl implements IServiceWithDep {
      getInjectedValue() {
        return "";
      }
    }

    void ServiceWithDepImpl;

    const hostNexus = new Nexus<any, any>().configure({
      endpoint: {
        meta: { context: "host" },
        implementation: { listen: vi.fn() },
      },
    });

    await (hostNexus as any)._initialize();

    const service = (hostNexus as any).engine.resourceManager.getExposedService(
      "service-with-dep",
    );
    expect(service).toBeDefined();
    expect((service as IServiceWithDep).getInjectedValue()).toBe(
      "injected-value",
    );
  });

  it("should create basic tokens and use them with @Expose decorator", async () => {
    DecoratorRegistry.clear();

    const SettingsToken = new Token<ISettingsService>("settings-service");
    const CommentToken = new Token<ICommentService>("comment-service");

    @Expose(SettingsToken)
    class SettingsServiceImpl implements ISettingsService {
      async getSettings() {
        return { showAvatars: true, defaultProject: "test-project" };
      }

      async updateSettings(
        settings: Partial<{ showAvatars: boolean; defaultProject: string }>,
      ) {
        return {
          showAvatars: settings.showAvatars ?? true,
          defaultProject: settings.defaultProject ?? "test-project",
        };
      }
    }

    @Expose(CommentToken)
    class CommentServiceImpl implements ICommentService {
      async getComments(_issueId: string) {
        return [{ id: "1", user: "test-user", body: "Test comment" }];
      }

      async addComment(_issueId: string, comment: Omit<Comment, "id">) {
        return { id: "new-id", ...comment };
      }
    }

    void SettingsServiceImpl;
    void CommentServiceImpl;

    const nexus = new Nexus<AppUserMeta, AppPlatformMeta>().configure({
      endpoint: {
        meta: { context: "background", version: "1.0" },
        implementation: { listen: vi.fn() },
      },
    });

    await (nexus as any)._initialize();

    const settingsService = (
      nexus as any
    ).engine.resourceManager.getExposedService(SettingsToken.id);
    const commentService = (
      nexus as any
    ).engine.resourceManager.getExposedService(CommentToken.id);

    expect(settingsService).toBeDefined();
    expect(commentService).toBeDefined();

    const settings = await (settingsService as ISettingsService).getSettings();
    expect(settings).toEqual({
      showAvatars: true,
      defaultProject: "test-project",
    });

    const comments = await (commentService as ICommentService).getComments(
      "test-issue",
    );
    expect(comments).toEqual([
      { id: "1", user: "test-user", body: "Test comment" },
    ]);
  });

  it("should support TokenSpace for structured token namespaces", async () => {
    const { TokenSpace } = await import("../../src/api/token-space");

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

    const BackgroundSettingsToken =
      background.token<ISettingsService>("settings");
    const ContentCommentToken =
      contentScript.token<ICommentService>("comments");

    expect(BackgroundSettingsToken.id).toBe("app:background:settings");
    expect(ContentCommentToken.id).toBe("app:content-script:comments");

    expect(BackgroundSettingsToken.defaultTarget).toEqual({
      descriptor: { context: "background", version: "1.0" },
    });
    expect(ContentCommentToken.defaultTarget).toEqual({
      matcher: expect.any(Function),
    });

    const matcher = ContentCommentToken.defaultTarget?.matcher;
    expect(matcher).toBeDefined();
    if (matcher) {
      expect(
        matcher({
          context: "content-script",
          url: "test",
          issueId: "1",
          isActive: true,
        }),
      ).toBe(true);
      expect(matcher({ context: "background", version: "1.0" })).toBe(false);
    }
  });

  it("should support nested TokenSpace configuration inheritance", async () => {
    const { TokenSpace } = await import("../../src/api/token-space");

    const company = new TokenSpace<AppUserMeta, AppPlatformMeta>({
      name: "company",
      defaultTarget: {
        descriptor: { context: "background", version: "1.0" },
      },
    });

    const product = company.tokenSpace("product");
    const backend = product.tokenSpace("backend");
    const microservices = backend.tokenSpace("microservices", {
      defaultTarget: {
        matcher: (identity: AppUserMeta) =>
          identity.context === "content-script",
      },
    });
    const auth = microservices.tokenSpace("auth");

    const UserToken = auth.token<IUserService>("profile");

    expect(UserToken.id).toBe(
      "company:product:backend:microservices:auth:profile",
    );
    expect(UserToken.defaultTarget).toEqual({
      matcher: expect.any(Function),
    });

    const matcher = UserToken.defaultTarget?.matcher;
    expect(matcher).toBeDefined();
    if (matcher) {
      expect(
        matcher({
          context: "content-script",
          url: "test",
          issueId: "1",
          isActive: true,
        }),
      ).toBe(true);
      expect(matcher({ context: "background", version: "1.0" })).toBe(false);
    }
  });
});
