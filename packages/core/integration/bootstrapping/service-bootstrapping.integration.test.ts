/**
 * Simulates service bootstrapping at startup where decorators register providers,
 * factories provide dependency wiring and Tokens define service identity before
 * RPC traffic starts.
 */
import { describe, expect, it, vi } from "vitest";

import { Nexus } from "../../src/api/nexus";
import { Token } from "../../src/api/token";
import type {
  AppAdapterModel,
  Comment,
  ICommentService,
  ISettingsService,
} from "../fixtures";

describe("Nexus L4 Integration: Service Bootstrapping", () => {
  it("should use a factory for dependency injection", async () => {
    const hostNexus = new Nexus<AppAdapterModel>();

    class Dependency {
      getValue() {
        return "injected-value";
      }
    }

    interface IServiceWithDep {
      getInjectedValue(): string;
    }

    const ServiceWithDepToken = new Token<IServiceWithDep>("service-with-dep");

    @hostNexus.Expose(ServiceWithDepToken, {
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

    hostNexus.configure({
      endpoint: {
        meta: { context: "background", version: "1.0" },
        implementation: { listen: vi.fn() },
      },
    });

    await hostNexus.ready();

    const service = (
      hostNexus as any
    ).lifecycle.engine.resourceManager.getExposedService("service-with-dep");
    expect(service).toBeDefined();
    expect((service as IServiceWithDep).getInjectedValue()).toBe(
      "injected-value",
    );
  });

  it("should create basic tokens and use them with @Expose decorator", async () => {
    const nexus = new Nexus<AppAdapterModel>();

    const SettingsToken = new Token<ISettingsService>("settings-service");
    const CommentToken = new Token<ICommentService>("comment-service");

    @nexus.Expose(SettingsToken)
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

    @nexus.Expose(CommentToken)
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

    nexus.configure({
      endpoint: {
        meta: { context: "background", version: "1.0" },
        implementation: { listen: vi.fn() },
      },
    });

    await nexus.ready();

    const settingsService = (
      nexus as any
    ).lifecycle.engine.resourceManager.getExposedService(SettingsToken.id);
    const commentService = (
      nexus as any
    ).lifecycle.engine.resourceManager.getExposedService(CommentToken.id);

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
});
