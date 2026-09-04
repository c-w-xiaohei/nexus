import { Token } from "../src/api/token";
import type { NexusInstance } from "../src/api/types";
import type { RefWrapper } from "../src/types/ref-wrapper";
import { createStarNetwork } from "../src/utils/test-utils";
import { REF_WRAPPER_SYMBOL } from "../src/types/ref-wrapper";
import { RELEASE_PROXY_SYMBOL } from "../src/types/symbols";
import { LogicalConnection } from "../src/connection/logical-connection";
import type { NexusMessage } from "../src/types/message";
import type { TestAdapterModel } from "../src/utils/test-utils";

export type AppUserMeta =
  | { context: "background"; version: string }
  | {
      context: "content-script";
      url: string;
      issueId: string;
      isActive: boolean;
      groups?: string[];
    }
  | { context: "popup"; activeIssueId?: string };

export type ContentScriptMeta = Extract<
  AppUserMeta,
  { context: "content-script" }
>;

export type AppConnectionMeta = { from: string };
export type AppAdapterModel = TestAdapterModel<AppUserMeta, AppConnectionMeta>;

export interface Settings {
  showAvatars: boolean;
  defaultProject: string;
}

export interface Comment {
  id: string;
  user: string;
  body: string;
}

export type SubscriptionId = string;

export class TimelineProcessor {
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

export interface IBackgroundService {
  getSettings(): Promise<Settings>;
  saveSettings(newSettings: Settings): Promise<void>;
  subscribeToComments(
    issueId: string,
    onNewComment: (comment: Comment) => void,
  ): Promise<SubscriptionId>;
  unsubscribe(subId: SubscriptionId): Promise<void>;
  processTimeline(processor: TimelineProcessor): Promise<unknown>;
  refreshAllTabs(): Promise<void[]>;
  requestHighlight(issueId: string, user: string): Promise<void>;
}

export interface IContentScriptService {
  highlightUser(user: string): Promise<boolean>;
  getTimelineProcessor(): Promise<RefWrapper<TimelineProcessor>>;
  refresh(): Promise<void>;
  getTitle(): Promise<string>;
  bumpSessionCounter(): Promise<number>;
}

export interface ISettingsService {
  getSettings(): Promise<Settings>;
  updateSettings(settings: Partial<Settings>): Promise<Settings>;
}

export interface ICommentService {
  getComments(issueId: string): Promise<Comment[]>;
  addComment(issueId: string, comment: Omit<Comment, "id">): Promise<Comment>;
}

export interface IUserService {
  getUserProfile(): Promise<{ id: string; name: string }>;
}

export const BackgroundServiceToken = new Token<IBackgroundService>(
  "background-service",
);

export const ContentScriptServiceToken = new Token<IContentScriptService>(
  "content-script-service",
);

export class BackgroundServiceImpl implements IBackgroundService {
  private settings: Settings = { showAvatars: true, defaultProject: "Nexus" };
  private commentSubscriptions = new Map<
    SubscriptionId,
    (comment: Comment) => void
  >();

  _simulateNewComment(subId: SubscriptionId, comment: Comment) {
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
    onNewComment: (comment: Comment) => void,
  ) {
    const subId: SubscriptionId = `sub-${issueId}-${Math.random()}`;
    this.commentSubscriptions.set(subId, onNewComment);
    return subId;
  }

  async unsubscribe(subId: SubscriptionId): Promise<void> {
    const callback = this.commentSubscriptions.get(subId) as
      | ({ [RELEASE_PROXY_SYMBOL]?: unknown } & ((comment: Comment) => void))
      | undefined;
    this.commentSubscriptions.delete(subId);
    const release = callback?.[RELEASE_PROXY_SYMBOL];
    if (typeof release === "function") {
      release();
    }
  }

  async processTimeline(processor: TimelineProcessor) {
    processor.addEvent("processed by background");
    return processor.process();
  }

  async refreshAllTabs(): Promise<void[]> {
    return [];
  }

  async requestHighlight(_issueId: string, _user: string): Promise<void> {}
}

export class ContentScriptServiceImpl implements IContentScriptService {
  private sessionCounter = 0;

  constructor(private meta: ContentScriptMeta) {}

  async highlightUser(user: string): Promise<boolean> {
    if (user === "non-existent-user") {
      throw new Error(`User "${user}" not found on page.`);
    }
    return true;
  }

  async getTimelineProcessor(): Promise<RefWrapper<TimelineProcessor>> {
    return {
      [REF_WRAPPER_SYMBOL]: true,
      target: new TimelineProcessor(this.meta.issueId),
    };
  }

  async refresh(): Promise<void> {}

  async getTitle(): Promise<string> {
    return `Issue ${this.meta.issueId} - My Test Project`;
  }

  async bumpSessionCounter(): Promise<number> {
    this.sessionCounter += 1;
    return this.sessionCounter;
  }
}

export type IssueCompanionWorld = {
  background: {
    nexus: NexusInstance<AppAdapterModel>;
    service: BackgroundServiceImpl;
  };
  cs1: {
    nexus: NexusInstance<AppAdapterModel>;
    service: ContentScriptServiceImpl;
  };
  cs2: {
    nexus: NexusInstance<AppAdapterModel>;
    service: ContentScriptServiceImpl;
  };
  popup: {
    nexus: NexusInstance<AppAdapterModel>;
  };
};

export async function createIssueCompanionWorld(): Promise<IssueCompanionWorld> {
  const bgMeta: AppUserMeta = { context: "background", version: "1.0.0" };
  const cs1Meta: ContentScriptMeta = {
    context: "content-script",
    issueId: "CS1",
    url: "github.com/issue/1",
    isActive: true,
    groups: ["issue-pages"],
  };
  const cs2Meta: ContentScriptMeta = {
    context: "content-script",
    issueId: "CS2",
    url: "github.com/issue/2",
    isActive: false,
    groups: ["issue-pages"],
  };
  const popupMeta: AppUserMeta = { context: "popup" };

  const backgroundService = new BackgroundServiceImpl();
  const cs1Service = new ContentScriptServiceImpl(cs1Meta);
  const cs2Service = new ContentScriptServiceImpl(cs2Meta);

  const network = await createStarNetwork<AppUserMeta, AppConnectionMeta>({
    center: {
      meta: bgMeta,
      providers: {
        [BackgroundServiceToken.id]: backgroundService,
      },
    },
    leaves: [
      {
        meta: cs1Meta,
        providers: { [ContentScriptServiceToken.id]: cs1Service },
        cmConfig: { connectTo: [{ context: "background" }] },
      },
      {
        meta: cs2Meta,
        providers: { [ContentScriptServiceToken.id]: cs2Service },
        cmConfig: { connectTo: [{ context: "background" }] },
      },
      {
        meta: popupMeta,
        cmConfig: { connectTo: [{ context: "background" }] },
      },
    ],
  });

  return {
    background: {
      nexus: network.get("background")!.nexus,
      service: backgroundService,
    },
    cs1: {
      nexus: network.get("content-script:CS1")!.nexus,
      service: cs1Service,
    },
    cs2: {
      nexus: network.get("content-script:CS2")!.nexus,
      service: cs2Service,
    },
    popup: {
      nexus: network.get("popup")!.nexus,
    },
  };
}

export function closeAllConnections(
  instances: Array<{ nexus: NexusInstance<AppAdapterModel> } | undefined>,
) {
  for (const instance of instances) {
    if (!instance?.nexus) {
      continue;
    }
    const cm = (instance.nexus as any).connectionManager;
    if (!cm) {
      continue;
    }
    const connections = Array.from((cm as any).connections.values());
    for (const connection of connections) {
      (connection as LogicalConnection<AppAdapterModel>).close();
    }
  }
}

export function listLogicalConnections(instance: {
  nexus: NexusInstance<AppAdapterModel>;
}): Array<LogicalConnection<AppAdapterModel>> {
  const cm = (instance.nexus as any).connectionManager;
  if (!cm) {
    return [];
  }
  return Array.from((cm as any).connections.values()) as Array<
    LogicalConnection<AppAdapterModel>
  >;
}

export function findLogicalConnection(
  instance: { nexus: NexusInstance<AppAdapterModel> },
  predicate: (connection: LogicalConnection<AppAdapterModel>) => boolean,
): LogicalConnection<AppAdapterModel> | undefined {
  return listLogicalConnections(instance).find(predicate);
}

export async function injectIncomingMessage(
  instance: { nexus: NexusInstance<AppAdapterModel> },
  sourceConnectionId: string,
  message: NexusMessage,
): Promise<void> {
  const engine = (instance.nexus as any).engine;
  if (!engine) {
    throw new Error("Engine not initialized for integration fixture.");
  }

  const result = await engine.safeOnMessage(message, sourceConnectionId);
  if (result.isErr()) throw result.error;
}

export function teardownIssueCompanionWorld(world?: IssueCompanionWorld) {
  if (!world) {
    return;
  }
  closeAllConnections([world.background, world.cs1, world.cs2, world.popup]);
}
