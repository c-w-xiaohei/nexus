/// <reference types="chrome" />

import {
  chromeTarget,
  type ChromeAdapterModel,
  usingBackgroundScript,
} from "@nexus-js/chrome";
import type {
  Asyncified,
  ConnectionResource,
  ConnectionAuthContext,
  ConnectionWhere,
  RelayHandle,
  ServiceCallAuthContext,
} from "@nexus-js/core";
import { Nexus } from "@nexus-js/core";
import { createNexusStore } from "@nexus-js/core/state";
import { eventKey, type BridgeEvent } from "../../protocol";
import { defineBackground } from "wxt/utils/define-background";
import {
  DocumentToolToken,
  DocumentRelayToken,
  DocumentRouteToken,
  FixtureAdminToken,
  RelayAdminToken,
  SidePanelAdminToken,
  SidePanelToken,
  TargetedContentAdminToken,
  type DocumentReference,
  type DocumentToolService,
  type FixtureAppMeta,
  type RelayAdminResponse,
  type FixtureError,
  type IdentityResult,
  type UiTargetResult,
  SessionToken,
  WorkspaceToken,
} from "../shared/contracts";
import {
  AddressedAdminToken,
  AddressedPageToken,
  type AddressedPageService,
} from "../shared/addressed-contracts";
import {
  activeRunKey,
  backgroundIdentity,
  configureFixtureLogger,
  createReporter,
  fixtureErrorCode,
  fixturePrefix,
  initializeBackgroundRun,
  isFixtureRunId,
  isFixtureSessionId,
  sanitizeFixtureError,
  sanitizeFixtureText,
  validateOffscreenEvent,
} from "../shared/runtime";
import {
  workspaceStateCreator,
  workspaceStateDefinition,
} from "../shared/workspace-state";
import { isPreRouteCommand, type PreRouteCommand } from "../shared/scenario";

type FixtureChromeModel = ChromeAdapterModel<FixtureAppMeta>;
type FixtureChromeTarget = FixtureChromeModel["connectionTarget"];
type FixtureWhere = ConnectionWhere<FixtureChromeModel>;
type FixtureContext = Parameters<FixtureWhere>[0];
type ValidatedContentSender = Readonly<{
  tabId: number;
  frameId: number;
  documentId?: string;
  senderUrl: string;
}>;

/** Converts rejected errors to JSON-safe diagnostics before sending browser test reports. */
function serializeOutcome<T>(result: PromiseSettledResult<T>) {
  if (result.status === "fulfilled") return result;
  return {
    status: result.status,
    reason: {
      message: sanitizeFixtureError(result.reason),
      code: fixtureErrorCode(result.reason),
    },
  };
}

/** Track content sessions so fixture commands can build exact adapter targets. */
function createContentRegistry() {
  const facts = new Map<string, ContentFact>();

  /** Convert a content fact into a document-precise or frame-precise target. */
  const target = (fact: ContentFact): FixtureChromeTarget =>
    fact.documentId
      ? chromeTarget.contentDocument({
          tabId: fact.tabId,
          documentId: fact.documentId,
        })
      : chromeTarget.contentFrame({
          tabId: fact.tabId,
          frameId: fact.frameId,
        });

  return {
    /** Register or replace the session facts for one content participant. */
    register(
      runId: string,
      content: ContentIdentity,
      sender: ValidatedContentSender,
    ): void {
      facts.set(content.label, {
        ...content,
        runId,
        tabId: sender.tabId,
        frameId: sender.frameId,
        documentId: sender.documentId,
        senderUrl: sender.senderUrl,
      });
    },

    /** Verify that a sender still owns the recorded content session. */
    isRegisteredSender(
      runId: string,
      senderSessionId: string,
      sender: ValidatedContentSender,
    ): boolean {
      return [...facts.values()].some(
        (fact) =>
          fact.runId === runId &&
          fact.tabId === sender.tabId &&
          fact.frameId === sender.frameId &&
          fact.documentId !== undefined &&
          sender.documentId !== undefined &&
          fact.documentId === sender.documentId &&
          fact.sessionId === senderSessionId &&
          fact.senderUrl === sender.senderUrl,
      );
    },

    /** Return a defensive copy of one participant's recorded facts. */
    get(label: string): ContentFact | undefined {
      const fact = facts.get(label);
      return fact ? { ...fact } : undefined;
    },

    /** Return the current main-frame document only for the active run. */
    currentMain(runId: string | undefined): ContentFact | undefined {
      const fact = facts.get("main");
      if (
        !fact ||
        fact.runId !== runId ||
        fact.frameId !== 0 ||
        !fact.documentId
      )
        return undefined;
      return { ...fact };
    },

    /** Build a frame target from a recorded participant label. */
    frameTarget(label: string): FixtureChromeTarget | undefined {
      const fact = facts.get(label);
      return fact
        ? chromeTarget.contentFrame({
            tabId: fact.tabId,
            frameId: fact.frameId,
          })
        : undefined;
    },

    /** Build the most precise target available for a recorded participant. */
    exactTarget(label: string): FixtureChromeTarget | undefined {
      const fact = facts.get(label);
      return fact ? target(fact) : undefined;
    },

    /** Build targets for all recorded participants or a requested label subset. */
    targets(labels?: readonly string[]): readonly FixtureChromeTarget[] {
      return [...facts.values()]
        .filter((fact) => !labels || labels.includes(fact.label))
        .map(target);
    },

    /** Evict sessions in a frame after navigation commits. */
    evictNavigation(tabId: number, frameId: number): ContentFact[] {
      return evict((fact) => fact.tabId === tabId && fact.frameId === frameId);
    },

    /** Evict the session matching a disconnected port's document identity. */
    evictDisconnect(
      tabId: number | undefined,
      frameId: number | undefined,
      documentId: string | undefined,
    ): ContentFact[] {
      return evict(
        (fact) =>
          fact.tabId === tabId &&
          fact.frameId === frameId &&
          fact.documentId === documentId,
      );
    },
  };

  /** Remove matching sessions and return copies for lifecycle reporting. */
  function evict(predicate: (fact: ContentFact) => boolean): ContentFact[] {
    const removed: ContentFact[] = [];
    for (const [label, fact] of facts) {
      if (!predicate(fact)) continue;
      facts.delete(label);
      removed.push({ ...fact });
    }
    return removed;
  }
}

export default defineBackground(() => {
  const identity = backgroundIdentity();
  const runState = (() => {
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    return {
      activeRunId: undefined as string | undefined,
      counter: 0,
      workspaceInvocationCount: 0,
      setting: "compact",
      generation: 1,
      nonce: crypto.randomUUID(),
      denyCalls: false,
      reporter: undefined as ReturnType<typeof createReporter> | undefined,
      activation: undefined as Promise<void> | undefined,
      observedContentPorts: 0,
      ready,
      resolveReady,
    };
  })();
  configureFixtureLogger(identity, () => runState.activeRunId);
  const offscreenState = {
    resolveReady: undefined as ((sessionId: string) => void) | undefined,
    ready: undefined as Promise<string> | undefined,
    create: undefined as Promise<string> | undefined,
    activeSessionId: undefined as string | undefined,
  };
  offscreenState.ready = new Promise<string>((resolve) => {
    offscreenState.resolveReady = resolve;
  });
  const relayState = {
    policyMode: "allow" as "allow" | "deny",
    target: undefined as ContentFact | undefined,
    registration: undefined as RelayHandle | undefined,
    retiredBetaSessionId: undefined as string | undefined,
    resolveBetaReplacement: undefined as (() => void) | undefined,
    betaReplacement: undefined as Promise<void> | undefined,
  };
  relayState.betaReplacement = new Promise<void>((resolve) => {
    relayState.resolveBetaReplacement = resolve;
  });
  const retained = {
    tool: undefined as Asyncified<DocumentToolService> | undefined,
    reference: undefined as Asyncified<DocumentReference> | undefined,
    multicast: undefined as
      | readonly ConnectionResource<DocumentToolService, FixtureChromeModel>[]
      | undefined,
    multicastTargets: undefined as readonly FixtureChromeTarget[] | undefined,
  };
  const contentRegistry = createContentRegistry();
  let retainedAddressedConnection:
    | Awaited<ReturnType<typeof nexus.connect>>
    | undefined;
  let retainedUiConnection:
    | Awaited<ReturnType<typeof nexus.connect>>
    | undefined;
  let retainedSidePanelConnection:
    | Awaited<ReturnType<typeof nexus.connect>>
    | undefined;
  const uiRegistry = new Map<
    "popup" | "options" | "workspace",
    { readonly sessionId: string; readonly windowId?: number }
  >();

  const nexus = usingBackgroundScript<FixtureAppMeta>({
    app: {
      fixture: true,
      sessionId: identity.sessionId,
    },
  });
  nexus.configure({
    policy: {
      canConnect: ({
        remoteIdentity,
        connection,
      }: ConnectionAuthContext<FixtureChromeModel>) => {
        const declared = remoteIdentity.app.declaredFrameId;
        return (
          declared === undefined || declared === connection.observed.frameId
        );
      },
      canCall: (context) =>
        context.serviceName === DocumentRelayToken.id
          ? evaluateRelayCall(context)
          : true,
    },
  });
  const workspaceState = createNexusStore(
    workspaceStateDefinition,
    workspaceStateCreator,
    {
      snapshot: (state) => ({ count: state.count }),
      expose: ["increment"],
    },
  );
  nexus.provide(workspaceState.provider);
  nexus.provide(
    WorkspaceToken,
    {
      summary: async () => {
        await runState.ready;
        const invocationCount = ++runState.workspaceInvocationCount;
        await runState.reporter?.result(
          JSON.stringify({
            type: "workspace-invocation",
            operation: "summary",
            invocationCount,
          }),
        );
        return {
          counter: runState.counter,
          setting: runState.setting,
          generation: runState.generation,
          nonce: runState.nonce,
          sessionId: identity.sessionId,
        };
      },
      increment: async () => {
        await runState.ready;
        return ++runState.counter;
      },
      setting: async () => {
        await runState.ready;
        return runState.setting;
      },
      setSetting: async (value) => {
        await runState.ready;
        runState.setting = value;
        await chrome.storage.local.set({ [`${fixturePrefix}setting`]: value });
        return runState.setting;
      },
      pending: async () => {
        await runState.ready;
        await runState.reporter?.barrier("pending-started");
        return new Promise<string>(() => {});
      },
      worker: async () => {
        await runState.ready;
        return {
          generation: runState.generation,
          nonce: runState.nonce,
          sessionId: identity.sessionId,
        };
      },
      createCapability: async () =>
        nexus.ref({
          ping: async () =>
            `capability:${identity.sessionId}:${runState.nonce}`,
        }),
      acceptCallback: async (callback) => callback(),
    },
    {
      policy: {
        canCall: async () => {
          if (!runState.denyCalls) return true;
          await runState.reporter?.result(
            JSON.stringify({
              type: "policy-denied",
              code: "E_AUTH_CALL_DENIED",
              counter: runState.counter,
            }),
          );
          return false;
        },
      },
    },
  );
  nexus.provide(FixtureAdminToken, {
    setCallPolicy: async (nextDenyCalls) => {
      await runState.ready;
      runState.denyCalls = nextDenyCalls;
      return { denyCalls: runState.denyCalls, counter: runState.counter };
    },
    multicastBoundInvoke: invokeBoundMulticast,
    multicastFail: failBoundMulticast,
    capabilityInvoke: invokeCapability,
    capabilityProxyInvoke: invokeCapabilityProxy,
    capabilityReferenceInvoke: invokeCapabilityReference,
    capabilityRelease: releaseCapabilityReference,
    identityPinned: invokeCapabilityProxy,
    createOffscreen,
    closeOffscreen,
    popupTargetCall: () => callUiTarget("popup"),
    optionsTargetCall: () => callUiTarget("options"),
    offscreenTargetCall: () => callUiTarget("offscreen"),
    retainedUiCall,
  });
  nexus.provide(SidePanelAdminToken, {
    sidePanelCall,
    sidePanelRetainedCall,
  });
  nexus.provide(RelayAdminToken, {
    registerCurrentDocument: async () => handleRelayControl("register"),
    refreshCurrentDocument: async () => handleRelayControl("refresh"),
    setPolicyMode: async (mode) => handleRelayControl("policy", mode),
  });
  nexus.provide(TargetedContentAdminToken, {
    providerFirstSelect: connectExistingContent,
    contentHold: holdContent,
    identityConstraint,
  });
  nexus.provide(AddressedAdminToken, {
    callPage: async (endpointId) => {
      const connection = await nexus.connect({
        target: chromeTarget.extensionPage({ endpointId }),
      });
      return {
        connectionId: connection.id,
        ...(await connection.get(AddressedPageToken).identity()),
      };
    },
    callPageTwice: async (endpointId) => {
      const target = chromeTarget.extensionPage({ endpointId });
      const [first, second] = await Promise.all([
        nexus.connect({ target }),
        nexus.connect({ target }),
      ]);
      return [
        {
          connectionId: first.id,
          ...(await first.get(AddressedPageToken).identity()),
        },
        {
          connectionId: second.id,
          ...(await second.get(AddressedPageToken).identity()),
        },
      ];
    },
    callAbsentPage: async (endpointId) => {
      const result = await nexus.safeConnect({
        target: chromeTarget.extensionPage({ endpointId }),
        timeout: 500,
      });
      if (result.isOk()) {
        return { code: "E_FIXTURE_UNEXPECTED_CONNECTION" };
      }
      return { code: fixtureErrorCode(result.error) };
    },
    retainPage: async (endpointId) => {
      retainedAddressedConnection = await nexus.connect({
        target: chromeTarget.extensionPage({ endpointId }),
      });
      return await retainedAddressedConnection
        .get(AddressedPageToken)
        .identity();
    },
    invokeRetainedPage: async () => {
      if (!retainedAddressedConnection)
        throw new Error("addressed page connection was not retained");
      return await retainedAddressedConnection
        .get(AddressedPageToken)
        .identity();
    },
  });

  void nexus.ready().then(async () => {
    const stored = await chrome.storage.local.get(`${fixturePrefix}setting`);
    if (typeof stored[`${fixturePrefix}setting`] === "string") {
      runState.setting = stored[`${fixturePrefix}setting`] as string;
    }
    const durableRun = await chrome.storage.local.get(activeRunKey);
    const runId = durableRun[activeRunKey];
    if (isFixtureRunId(runId)) await ensureRun(runId);
  });

  chrome.sidePanel.onOpened.addListener((info) => {
    void runState.reporter?.result(
      JSON.stringify({
        type: "sidepanel-opened",
        path: info.path,
        windowId: info.windowId,
      }),
    );
  });
  chrome.sidePanel.onClosed.addListener((info) => {
    void runState.reporter?.result(
      JSON.stringify({
        type: "sidepanel-closed",
        path: info.path,
        windowId: info.windowId,
      }),
    );
  });

  chrome.runtime.onMessage.addListener(
    (message: unknown, _sender, sendResponse) => {
      if (!isControl(message)) {
        sendResponse({ ok: false, code: "E_FIXTURE_CONTROL_REJECTED" });
        return;
      }
      if (message.kind === "run-init") {
        if (
          !isBootstrapSender(
            _sender,
            message.runId,
            message.content,
            message.ui,
          )
        ) {
          sendResponse({ ok: false, code: "E_FIXTURE_CONTROL_REJECTED" });
          return;
        }
        void ensureRun(message.runId)
          .then(() => {
            const sender = normalizedContentSender(_sender);
            if (message.content && sender) {
              registerContent(message.runId, message.content, sender);
            }
            if (message.ui) {
              uiRegistry.set(message.ui.participant, {
                sessionId: message.ui.sessionId,
                windowId: message.ui.windowId,
              });
            }
          })
          .then(() => sendResponse({ ok: true }))
          .catch((error) => sendResponse(errorResult(error)));
        return true;
      }
      if (message.kind === "content-identity") {
        if (!isContentSender(_sender, message.runId)) {
          sendResponse({ ok: false, code: "E_FIXTURE_CONTROL_REJECTED" });
          return;
        }
        const sender = normalizedContentSender(_sender);
        if (sender) registerContent(message.runId, message, sender);
        sendResponse({ ok: true });
        return;
      }
      // Target-routing scenarios must begin before a Nexus route exists, so a
      // public admin proxy would change the behavior they are measuring.
      if (message.kind === "fixture-command") {
        const sender = normalizedContentSender(_sender);
        if (
          !isContentSender(_sender, message.runId) ||
          !sender ||
          !contentRegistry.isRegisteredSender(
            message.runId,
            message.senderSessionId,
            sender,
          )
        ) {
          sendResponse({ ok: false, code: "E_FIXTURE_CONTROL_REJECTED" });
          return;
        }
        void runPreRouteCommand(message.command, _sender)
          .then(sendResponse)
          .catch((error) => sendResponse(errorResult(error)));
        return true;
      }
      if (message.kind === "ui-ready") {
        if (
          message.participant !== "offscreen" ||
          message.runId !== runState.activeRunId ||
          !isOffscreenSender(_sender, message.runId)
        ) {
          void recordOffscreenBoundary(message, _sender, "rejected-run");
          sendResponse({ ok: false });
          return;
        }
        acceptOffscreenReady(message, _sender, sendResponse);
        return;
      }
      if (message.kind === "offscreen-init") {
        if (
          !isOffscreenSender(_sender, message.runId) ||
          message.runId !== runState.activeRunId
        ) {
          void recordOffscreenBoundary(message, _sender, "rejected-sender");
          sendResponse({ ok: false });
          return;
        }
        void initializeOffscreenMessage(message, _sender, sendResponse);
        return true;
      }
      if (message.kind === "offscreen-diagnostic") {
        if (
          !isOffscreenSender(_sender, runState.activeRunId) ||
          !validateOffscreenEvent(message.event) ||
          message.event.runId !== runState.activeRunId
        ) {
          void recordOffscreenBoundary(message, _sender, "rejected-diagnostic");
          sendResponse({ ok: false });
          return;
        }
        void persistOffscreenDiagnostic(message, _sender, sendResponse);
        return true;
      }
    },
  );

  chrome.webNavigation.onCommitted.addListener((details) => {
    const runId = new URL(details.url).searchParams.get("runId");
    if (!runId || runId !== runState.activeRunId) return;
    void runState.reporter?.barrier("navigation-committed");
    for (const fact of contentRegistry.evictNavigation(
      details.tabId,
      details.frameId,
    )) {
      if (fact.label === "beta") {
        relayState.retiredBetaSessionId = fact.sessionId;
        relayState.betaReplacement = new Promise<void>((resolve) => {
          relayState.resolveBetaReplacement = resolve;
        });
      }
      void runState.reporter?.barrier(`${fact.label}-left-snapshot`);
    }
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (!port.sender?.url?.includes("runId=")) return;
    runState.observedContentPorts += 1;
    const { tab, frameId, documentId } = port.sender;
    port.onDisconnect.addListener(() => {
      for (const fact of contentRegistry.evictDisconnect(
        tab?.id,
        frameId,
        documentId,
      )) {
        void runState.reporter?.barrier(`${fact.label}-left-snapshot`);
      }
    });
  });

  /** Initialize one browser fixture run and publish its ready barrier. */
  async function activateRun(runId: string): Promise<void> {
    if (runState.activeRunId === runId) return;
    if (!(await initializeBackgroundRun(runId))) return;
    await chrome.storage.session.setAccessLevel({
      accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS",
    });
    runState.activeRunId = runId;
    runState.workspaceInvocationCount = 0;
    relayState.policyMode = "allow";
    runState.reporter = createReporter({ ...identity, runId });
    await nexus.updateIdentity({
      app: { fixture: true, sessionId: identity.sessionId, runId },
    });
    runState.resolveReady();
    await runState.reporter.barrier("background-ready");
    await runState.reporter.barrier("worker generation/wake");
  }

  /** Coalesce concurrent run activation requests behind one promise. */
  function ensureRun(runId: string): Promise<void> {
    if (runState.activeRunId === runId) return Promise.resolve();
    runState.activation ??= activateRun(runId).finally(() => {
      runState.activation = undefined;
    });
    return runState.activation;
  }

  /** Create or reuse the offscreen document and await its session handshake. */
  async function ensureOffscreen(): Promise<string> {
    if (offscreenState.create) {
      return await offscreenState.create;
    }
    if (await chrome.offscreen.hasDocument()) {
      if (offscreenState.activeSessionId) {
        return offscreenState.activeSessionId;
      }
      await chrome.offscreen.closeDocument();
    }
    offscreenState.create = (async () => {
      await runState.ready;
      await runState.reporter?.barrier("offscreen-create-started");
      offscreenState.activeSessionId = undefined;
      offscreenState.ready = new Promise<string>((resolve) => {
        offscreenState.resolveReady = resolve;
      });
      await chrome.offscreen.createDocument({
        url: `offscreen.html?runId=${runState.activeRunId}`,
        reasons: [chrome.offscreen.Reason.DOM_SCRAPING],
        justification: "Fixture export provider lifecycle",
      });
      const sessionId = await offscreenState.ready;
      await runState.reporter?.barrier("offscreen-ready");
      return sessionId;
    })().catch((error) => {
      offscreenState.create = undefined;
      throw error;
    });
    return await offscreenState.create;
  }

  /** Execute commands that must observe route creation before normal acquisition. */
  async function runPreRouteCommand(
    command: PreRouteCommand,
    sender: chrome.runtime.MessageSender,
  ): Promise<Record<string, unknown>> {
    await runState.ready;
    try {
      const target = senderContentTarget(sender);
      if (command === "select-start") {
        const started = Date.now();
        await runState.reporter?.barrier("select-started");
        const pending = nexus.safeConnect({ timeout: 1_000 });
        await runState.reporter?.barrier("select-pending-no-route");
        const connected = await pending;
        if (connected.isErr())
          return {
            ...errorResult(connected.error),
            waitTimeoutMs: 1_000,
            started,
            settled: Date.now(),
          };
        return {
          identity: await connected.value.get(DocumentToolToken).identity(),
        };
      }
      if (command === "provider-cardinality") {
        const count = (await nexus.connectMulticast()).connections.length;
        if (count === 0) return { count };
        await runState.reporter?.barrier(
          count === 1 ? "selection-one-ready" : "selection-two-ready",
        );
        return { count };
      }
      if (command === "create-frame" || command === "create-document")
        return await createSenderTarget(command, sender, target);
      if (command === "create-concurrent")
        return await createConcurrent(target);
      if (command === "pre-ready-port-close")
        return await probePreReadyClose(target);
      if (
        command === "multicast-select" ||
        command === "multicast-create" ||
        command === "multicast-rebind"
      )
        return await bindMulticast(command);
      if (command === "multicast-unavailable")
        return await createUnavailableMulticast();
      if (command === "identity-select-beta") return await selectFreshBeta();
      if (command === "reference-callback")
        return await invokeCallback(senderDocumentTarget(sender) ?? target);
      if (command === "capability-retain")
        return await retainCapability(senderDocumentTarget(sender) ?? target);
      return { code: "E_FIXTURE_COMMAND_UNSUPPORTED" };
    } catch (error) {
      return errorResult(error);
    }
  }

  /** Acquire one sender-derived target while the fixture route is still absent. */
  async function createSenderTarget(
    command: "create-frame" | "create-document",
    sender: chrome.runtime.MessageSender,
    target: FixtureChromeTarget | undefined,
  ): Promise<Record<string, unknown>> {
    if (!target) return { code: "E_TARGET_UNAVAILABLE" };
    const exactTarget =
      command === "create-document" ? senderDocumentTarget(sender) : target;
    if (!exactTarget) return { code: "E_DOCUMENT_TARGET_UNAVAILABLE" };
    await runState.reporter?.barrier("route-absent");
    const connection = await nexus.connect({ target: exactTarget });
    return {
      target: exactTarget,
      identity: await connection.get(DocumentToolToken).identity(),
    };
  }

  /** Exercise concurrent target acquisition and report route reuse behavior. */
  async function createConcurrent(
    target: FixtureChromeTarget | undefined,
  ): Promise<Record<string, unknown>> {
    if (!target) return { code: "E_TARGET_UNAVAILABLE" };
    const beforePorts = runState.observedContentPorts;
    const [first, second] = await Promise.all([
      nexus.safeConnect({ target }),
      nexus.safeConnect({ target }),
    ]);
    const route = (await nexus.safeConnect({ target })).andThen((connection) =>
      connection.safeGet(DocumentRouteToken),
    );
    const firstTool = first.andThen((connection) =>
      connection.safeGet(DocumentToolToken),
    );
    const secondTool = second.andThen((connection) =>
      connection.safeGet(DocumentToolToken),
    );
    return {
      first: firstTool.isErr()
        ? errorResult(firstTool.error)
        : await firstTool.value.identity(),
      second: secondTool.isErr()
        ? errorResult(secondTool.error)
        : await secondTool.value.identity(),
      acceptedRoute: route.isErr()
        ? errorResult(route.error)
        : { ...(await route.value.facts()) },
      observedPortDelta: runState.observedContentPorts - beforePorts,
    };
  }

  /** Verify that a pre-ready route closes before exposing a service proxy. */
  async function probePreReadyClose(
    target: FixtureChromeTarget | undefined,
  ): Promise<Record<string, unknown>> {
    if (!target) return { code: "E_TARGET_UNAVAILABLE" };
    const connection = await nexus.connect({ target });
    connection.get(DocumentToolToken);
    return { code: "E_FIXTURE_UNEXPECTED_PROXY" };
  }

  /** Attempt a retained multicast snapshot after its targets become unavailable. */
  async function createUnavailableMulticast(): Promise<
    Record<string, unknown>
  > {
    if (!retained.multicastTargets) return { code: "E_TARGET_UNAVAILABLE" };
    const multicast = await nexus.safeConnectMulticast({
      targets: retained.multicastTargets,
      timeout: 1_000,
    });
    await runState.reporter?.barrier("multicast-unavailable-ready");
    return multicast.isErr()
      ? errorResult(multicast.error)
      : { code: "E_FIXTURE_UNEXPECTED_MULTICAST_SUCCESS" };
  }

  /** Acquire the current beta session while constraining its committed identity. */
  async function selectFreshBeta(): Promise<Record<string, unknown>> {
    const beta = contentRegistry.get("beta");
    const target = contentRegistry.exactTarget("beta");
    if (!beta) return { code: "E_SERVICE_NO_MATCH" };
    if (!target) return { code: "E_TARGET_UNAVAILABLE" };
    const connection = await nexus.connect({
      target,
      where: (context: FixtureContext) =>
        context.app.label === "beta" &&
        context.app.sessionId === beta.sessionId,
    });
    const service = connection.get(DocumentToolToken);
    await runState.reporter?.barrier("beta-selected-fresh");
    return { identity: await service.identity() };
  }

  /** Exercise a remote callback through a target selected from the sender. */
  async function invokeCallback(
    target: FixtureChromeTarget | undefined,
  ): Promise<Record<string, unknown>> {
    if (!target) return { code: "E_TARGET_UNAVAILABLE" };
    const connection = await nexus.connect({ target });
    const callback = await connection
      .get(DocumentToolToken)
      .acceptCallback(async () => "callback-ok");
    await runState.reporter?.barrier("callback-invoked");
    return { callback };
  }

  /** Retain a service and reference capability for later lifecycle commands. */
  async function retainCapability(
    target: FixtureChromeTarget | undefined,
  ): Promise<Record<string, unknown>> {
    if (!target) return { code: "E_TARGET_UNAVAILABLE" };
    const connection = await nexus.connect({ target });
    retained.tool = connection.get(DocumentToolToken);
    retained.reference = await retained.tool.createReference();
    await runState.reporter?.barrier("alpha-reference-created");
    return {
      identity: await retained.tool.identity(),
      reference: await retained.reference.label(),
    };
  }

  /** Complete the offscreen startup handshake and reply to the sender. */
  function acceptOffscreenReady(
    message: Extract<Control, { kind: "ui-ready" }>,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ): void {
    void recordOffscreenBoundary(message, sender, "accepted");
    offscreenState.activeSessionId = message.sessionId;
    offscreenState.resolveReady?.(message.sessionId);
    sendResponse({ ok: true });
  }

  /** Grant the offscreen context storage access before acknowledging startup. */
  async function initializeOffscreenMessage(
    message: Extract<Control, { kind: "offscreen-init" }>,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ): Promise<void> {
    try {
      await chrome.storage.session.setAccessLevel({
        accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS",
      });
      void recordOffscreenBoundary(message, sender, "accepted");
      sendResponse({ ok: true });
    } catch (error) {
      void recordOffscreenBoundary(message, sender, "response-error", error);
      sendResponse({ ok: false });
    }
  }

  /** Persist an accepted offscreen diagnostic without leaking storage failures. */
  async function persistOffscreenDiagnostic(
    message: Extract<Control, { kind: "offscreen-diagnostic" }>,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ): Promise<void> {
    const event = message.event;
    try {
      await chrome.storage.session.set({
        [eventKey(event)]: event,
      });
      void recordOffscreenBoundary(message, sender, "persisted");
      sendResponse({ ok: true });
    } catch (error) {
      void recordOffscreenBoundary(message, sender, "persist-error", error);
      sendResponse({ ok: false });
    }
  }

  /** Uses the already-connected alpha session without dialing or waiting for provider discovery. */
  async function connectExistingContent(): Promise<
    IdentityResult | FixtureError
  > {
    const connected = await nexus.safeConnect({
      where: (context: FixtureContext) => context.app.label === "alpha",
      timeout: 1_000,
    });
    if (connected.isErr()) return errorResult(connected.error);
    const service = connected.value.safeGet(DocumentToolToken);
    if (service.isErr()) return errorResult(service.error);
    return { identity: await service.value.identity() };
  }

  /** Hold a target-bound remote call open until the fixture observes termination. */
  async function holdContent(label: string): Promise<FixtureError> {
    const target = contentRegistry.frameTarget(label);
    if (!target) return { code: "E_TARGET_UNAVAILABLE" };
    const tool = (await nexus.safeConnect({ target })).andThen((connection) =>
      connection.safeGet(DocumentToolToken),
    );
    if (tool.isErr()) return errorResult(tool.error);
    await runState.reporter?.barrier("hold-call-started");
    try {
      await tool.value.hold();
      return { code: "E_FIXTURE_UNEXPECTED_HOLD_SUCCESS" };
    } catch (error) {
      await runState.reporter?.barrier("hold-terminal-error");
      return errorResult(error);
    }
  }

  /** Attempt a deliberately incompatible identity constraint for error reporting. */
  async function identityConstraint(): Promise<FixtureError> {
    const target = contentRegistry.exactTarget("alpha");
    if (!target) return { code: "E_TARGET_UNAVAILABLE" };
    const constrained = (
      await nexus.safeConnect({
        target,
        where: (context: FixtureContext) => context.app.label === "beta",
      })
    ).andThen((connection) => connection.safeGet(DocumentToolToken));
    if (constrained.isErr()) {
      await runState.reporter?.barrier("alpha-constraint-failed");
      return errorResult(constrained.error);
    }
    return { code: "E_FIXTURE_UNEXPECTED_RETARGET" };
  }

  /** Invoke retained multicast resources and preserve per-member outcomes. */
  async function invokeBoundMulticast() {
    if (!retained.multicast) return { code: "E_FIXTURE_MULTICAST_ABSENT" };
    try {
      const identities = await Promise.all(
        retained.multicast.map(async ({ result }) => {
          if (result.isErr()) throw result.error;
          return await result.value.identity();
        }),
      );
      return {
        identities: identities.map((value) => ({
          status: "fulfilled" as const,
          value,
        })),
      };
    } catch (error) {
      return errorResult(error);
    }
  }

  /** Invoke the retained multicast failure operation for rejection coverage. */
  async function failBoundMulticast() {
    if (!retained.multicast) return { code: "E_FIXTURE_MULTICAST_ABSENT" };
    try {
      const results = (
        await Promise.allSettled(
          retained.multicast.map(async ({ result }) => {
            if (result.isErr()) throw result.error;
            return await result.value.fail();
          }),
        )
      ).map(serializeOutcome);
      await runState.reporter?.barrier("multicast-remote-rejection-ready");
      return { results };
    } catch (error) {
      return errorResult(error);
    }
  }

  /** Invoke both retained service and reference capabilities. */
  async function invokeCapability() {
    if (!retained.tool || !retained.reference)
      return { code: "E_FIXTURE_CAPABILITY_ABSENT" };
    try {
      return {
        identity: await retained.tool.identity(),
        reference: await retained.reference.label(),
      };
    } catch (error) {
      return errorResult(error);
    }
  }

  /** Invoke the retained service capability after a separate reference path. */
  async function invokeCapabilityProxy() {
    if (!retained.tool) return { code: "E_FIXTURE_CAPABILITY_ABSENT" };
    try {
      return { identity: await retained.tool.identity() };
    } catch (error) {
      return errorResult(error);
    }
  }

  /** Invoke the retained remote reference independently of its service proxy. */
  async function invokeCapabilityReference() {
    if (!retained.reference) return { code: "E_FIXTURE_CAPABILITY_ABSENT" };
    try {
      return { reference: await retained.reference.label() };
    } catch (error) {
      return errorResult(error);
    }
  }

  /** Release the retained reference and verify subsequent use is terminal. */
  async function releaseCapabilityReference(): Promise<FixtureError> {
    if (!retained.reference) return { code: "E_FIXTURE_CAPABILITY_ABSENT" };
    const released = nexus.safeRelease(retained.reference);
    if (released.isErr()) return errorResult(released.error);
    await runState.reporter?.barrier("reference-released");
    try {
      await retained.reference.label();
      return { code: "E_FIXTURE_UNEXPECTED_RESOURCE_SUCCESS" };
    } catch (error) {
      await runState.reporter?.barrier("reference-terminal-error");
      return errorResult(error);
    }
  }

  /** Request offscreen creation through the fixture's lifecycle coordinator. */
  async function createOffscreen() {
    await ensureOffscreen();
    return { requested: true } as const;
  }

  /** Close the offscreen document and clear its startup state. */
  async function closeOffscreen() {
    await chrome.offscreen.closeDocument();
    offscreenState.resolveReady = undefined;
    offscreenState.create = undefined;
    offscreenState.activeSessionId = undefined;
    return { requested: true } as const;
  }

  /** Dial a built-in UI receiver from Background with an exact adapter target. */
  async function callUiTarget(
    context: "popup" | "options" | "offscreen",
  ): Promise<UiTargetResult | FixtureError> {
    const target =
      context === "popup"
        ? popupTarget()
        : context === "options"
          ? chromeTarget.optionsPage()
          : chromeTarget.offscreenDocument();
    if (!target) return { code: "E_TARGET_UNAVAILABLE" };
    const connected = await nexus.safeConnect({ target, timeout: 1_000 });
    if (connected.isErr()) return errorResult(connected.error);
    retainedUiConnection = connected.value;
    try {
      const sessionId = await connected.value.get(SessionToken).session();
      return {
        connectionId: connected.value.id,
        receiver: { participant: context, sessionId },
      };
    } catch (error) {
      return errorResult(error);
    }
  }

  /** Call the previously selected UI connection to prove terminal retention. */
  async function retainedUiCall(): Promise<UiTargetResult | FixtureError> {
    if (!retainedUiConnection) return { code: "E_FIXTURE_CONNECTION_ABSENT" };
    try {
      const sessionId = await retainedUiConnection.get(SessionToken).session();
      return {
        connectionId: retainedUiConnection.id,
        receiver: { participant: "retained", sessionId },
      };
    } catch (error) {
      return errorResult(error);
    }
  }

  /** Acquire the real Chrome side panel by its owning browser window. */
  async function sidePanelCall(): Promise<UiTargetResult | FixtureError> {
    const popup = uiRegistry.get("popup");
    if (popup?.windowId === undefined) return { code: "E_TARGET_UNAVAILABLE" };
    const connected = await nexus.safeConnect({
      target: chromeTarget.sidePanel({ windowId: popup.windowId }),
      timeout: 1_000,
    });
    if (connected.isErr()) return errorResult(connected.error);
    retainedSidePanelConnection = connected.value;
    try {
      return {
        connectionId: connected.value.id,
        receiver: await connected.value.get(SidePanelToken).identity(),
      };
    } catch (error) {
      return errorResult(error);
    }
  }

  /** Invoke the retained side-panel connection after Chrome closes its page. */
  async function sidePanelRetainedCall(): Promise<
    UiTargetResult | FixtureError
  > {
    if (!retainedSidePanelConnection)
      return { code: "E_FIXTURE_CONNECTION_ABSENT" };
    try {
      return {
        connectionId: retainedSidePanelConnection.id,
        receiver: await retainedSidePanelConnection
          .get(SidePanelToken)
          .identity(),
      };
    } catch (error) {
      return errorResult(error);
    }
  }

  function popupTarget(): FixtureChromeTarget | undefined {
    const popup = uiRegistry.get("popup");
    return popup?.windowId === undefined
      ? undefined
      : chromeTarget.popup({ windowId: popup.windowId });
  }

  /** Register, refresh, or reconfigure the document relay provider. */
  async function handleRelayControl(
    operation: "register" | "refresh" | "policy",
    mode?: "allow" | "deny",
  ): Promise<RelayAdminResponse> {
    await runState.ready;
    if (operation === "policy") {
      if (!mode)
        return { result: errorResultCode("E_FIXTURE_CONTROL_REJECTED") };
      relayState.policyMode = mode;
      return {
        result: {
          ok: true,
          type: "relay-policy-mode-result",
          mode,
          backgroundSessionId: identity.sessionId,
        },
      };
    }
    const current = contentRegistry.currentMain(runState.activeRunId);
    if (!current || !current.documentId)
      return { result: errorResultCode("E_TARGET_UNAVAILABLE") };
    if (
      operation === "refresh" &&
      relayState.target &&
      relayState.target.documentId === current.documentId
    ) {
      return { result: errorResultCode("E_TARGET_UNCHANGED") };
    }
    relayState.registration?.dispose();
    relayState.target = current;
    relayState.registration = Nexus.relay({
      from: nexus,
      to: {
        nexus,
        target: chromeTarget.contentDocument({
          tabId: current.tabId,
          documentId: current.documentId,
        }),
      },
      services: [DocumentRelayToken],
    });
    return {
      result: {
        ok: true,
        type:
          operation === "refresh"
            ? "relay-refresh-result"
            : "relay-register-result",
        relayTokenId: "nexus-e2e:document-relay",
        backgroundSessionId: identity.sessionId,
      },
    };
  }

  /** Apply the entry-instance policy to the direct downstream peer. */
  async function evaluateRelayCall(
    context: ServiceCallAuthContext<FixtureChromeModel>,
  ): Promise<boolean> {
    const peerContext = context.remoteIdentity.context;
    const peerSessionId = context.remoteIdentity.app.sessionId;
    const allowedPeer =
      peerContext === "popup" ||
      peerContext === "workspace" ||
      peerContext === "fixture-workspace";
    const decision =
      relayState.policyMode === "allow" && allowedPeer ? "allow" : "deny";
    await runState.reporter?.result(
      JSON.stringify({
        type: "relay-policy-observation",
        decision,
        peerContext:
          peerContext === "fixture-workspace" ? "workspace" : peerContext,
        peerSessionId,
        connectionTabId: normalizeNumber(context.connection.tabId),
        connectionFrameId: normalizeNumber(context.connection.frameId),
        connectionDocumentId: normalizeString(context.connection.documentId),
        serviceName: context.serviceName,
        operation: context.operation,
        path: context.path,
        ...(decision === "deny" ? { code: "E_AUTH_CALL_DENIED" } : {}),
      }),
    );
    return decision === "allow";
  }

  /** Captures one multicast snapshot, waiting for replacement only in the rebind scenario. */
  async function bindMulticast(
    command: "multicast-select" | "multicast-create" | "multicast-rebind",
  ) {
    if (command === "multicast-rebind" && relayState.retiredBetaSessionId) {
      const beta = contentRegistry.get("beta");
      if (!beta || beta.sessionId === relayState.retiredBetaSessionId) {
        await relayState.betaReplacement;
      }
    }
    const targets =
      command === "multicast-select"
        ? undefined
        : contentRegistry.targets(["alpha", "beta"]);
    if (targets && targets.length < 2) return { code: "E_TARGET_UNAVAILABLE" };
    const multicast = await nexus.connectMulticast({ targets });
    const resources = multicast.get(DocumentToolToken);
    if (targets) {
      // Exact-target scenarios require every service; passive snapshots retain per-member errors.
      for (const { result } of resources) {
        if (result.isErr()) throw result.error;
      }
    }
    retained.multicast = resources;
    if (command === "multicast-create") {
      await runState.reporter?.barrier("multicast-all-acquired");
      retained.multicastTargets = targets;
      await runState.reporter?.barrier("multicast-targets-retained");
    } else {
      await runState.reporter?.barrier("multicast-snapshot-bound");
    }
    return {
      identities: (
        await Promise.allSettled(
          resources.map(async ({ result }) => {
            if (result.isErr()) throw result.error;
            return await result.value.identity();
          }),
        )
      ).map(serializeOutcome),
    };
  }

  /** Record a content session and resolve any pending beta replacement barrier. */
  function registerContent(
    runId: string,
    content: ContentIdentity,
    sender: ValidatedContentSender,
  ): void {
    contentRegistry.register(runId, content, sender);
    if (
      content.label === "beta" &&
      content.sessionId !== relayState.retiredBetaSessionId
    ) {
      relayState.resolveBetaReplacement?.();
      relayState.resolveBetaReplacement = undefined;
      void runState.reporter?.barrier("beta-replacement-registered");
    }
  }

  /** Store sanitized offscreen boundary diagnostics for fixture assertions. */
  async function recordOffscreenBoundary(
    message: {
      readonly kind: string;
      readonly runId?: unknown;
      readonly sessionId?: unknown;
      readonly event?: unknown;
    },
    sender: chrome.runtime.MessageSender,
    status: string,
    error?: unknown,
  ): Promise<void> {
    const diagnosticEvent =
      message.kind === "offscreen-diagnostic" &&
      message.event &&
      typeof message.event === "object"
        ? (message.event as Record<string, unknown>)
        : undefined;
    const runId = sanitizeBoundaryRunId(
      isFixtureRunId(message.runId) ? message.runId : diagnosticEvent?.runId,
    );
    const event = {
      kind: "offscreen-boundary",
      runId,
      status: sanitizeFixtureText(status),
      messageKind: sanitizeFixtureText(message.kind),
      sessionId:
        typeof message.sessionId === "string"
          ? sanitizeFixtureText(message.sessionId)
          : undefined,
      senderUrl: sender.url ? sanitizeFixtureText(sender.url) : undefined,
      senderId: sender.id ? sanitizeFixtureText(sender.id) : undefined,
      error: error === undefined ? undefined : sanitizeFixtureError(error),
      timestamp: Date.now(),
    };
    try {
      await chrome.storage.session.set({
        [`${fixturePrefix}offscreen-boundary:${crypto.randomUUID()}`]: event,
      });
    } catch {
      // Diagnostics are best effort and must not expose storage errors.
    }
  }
});

type ContentIdentity = {
  readonly label: string;
  readonly sessionId: string;
  readonly nonce: string;
};

type ContentFact = ContentIdentity & {
  readonly runId: string;
  readonly tabId: number;
  readonly frameId: number;
  readonly documentId?: string;
  readonly senderUrl: string;
};

type UiIdentity = {
  readonly participant: "popup" | "options" | "workspace";
  readonly sessionId: string;
  readonly windowId?: number;
};

type Control =
  | {
      readonly kind: "run-init";
      readonly runId: string;
      readonly content?: ContentIdentity;
      readonly ui?: UiIdentity;
    }
  | ({
      readonly kind: "content-identity";
      readonly runId: string;
    } & ContentIdentity)
  | {
      readonly kind: "fixture-command";
      readonly runId: string;
      readonly senderSessionId: string;
      readonly command: PreRouteCommand;
    }
  | {
      readonly kind: "ui-ready";
      readonly runId: string;
      readonly sessionId: string;
      readonly participant: string;
    }
  | {
      readonly kind: "offscreen-init";
      readonly runId: string;
      readonly sessionId: string;
    }
  | { readonly kind: "offscreen-diagnostic"; readonly event: BridgeEvent };

/** Validate an extension control message before dispatching fixture work. */
function isControl(value: unknown): value is Control {
  if (!value || typeof value !== "object") return false;
  const control = value as Record<string, unknown>;
  switch (control.kind) {
    case "run-init":
      return (
        (hasExactKeys(control, ["kind", "runId"]) ||
          hasExactKeys(control, ["kind", "runId", "content"]) ||
          hasExactKeys(control, ["kind", "runId", "ui"])) &&
        isFixtureRunId(control.runId) &&
        (control.content === undefined || isContentIdentity(control.content)) &&
        (control.ui === undefined || isUiIdentity(control.ui))
      );
    case "content-identity":
      return (
        hasExactKeys(control, [
          "kind",
          "runId",
          "label",
          "sessionId",
          "nonce",
        ]) &&
        isFixtureRunId(control.runId) &&
        isContentIdentity(control)
      );
    case "fixture-command":
      return (
        hasExactKeys(control, [
          "kind",
          "runId",
          "senderSessionId",
          "command",
        ]) &&
        isFixtureRunId(control.runId) &&
        isFixtureSessionId(control.senderSessionId) &&
        isBoundedString(control.command) &&
        isPreRouteCommand(control.command)
      );
    case "ui-ready":
      return (
        hasExactKeys(control, ["kind", "runId", "sessionId", "participant"]) &&
        isFixtureRunId(control.runId) &&
        isFixtureSessionId(control.sessionId) &&
        control.participant === "offscreen"
      );
    case "offscreen-init":
      return (
        hasExactKeys(control, ["kind", "runId", "sessionId"]) &&
        isFixtureRunId(control.runId) &&
        isFixtureSessionId(control.sessionId)
      );
    case "offscreen-diagnostic":
      return (
        hasExactKeys(control, ["kind", "event"]) &&
        validateOffscreenEvent(control.event)
      );
    default:
      return false;
  }
}

/** Convert a fixture error code into the relay admin response shape. */
function errorResultCode(code: string): RelayAdminResponse["result"] {
  return { ok: false, type: "fixture-error", code, message: null };
}

/** Require an untrusted object to contain exactly the expected message keys. */
function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && actual.every((key) => keys.includes(key))
  );
}

/** Validate the minimal identity payload sent by a content script. */
function isContentIdentity(value: unknown): value is ContentIdentity {
  if (!value || typeof value !== "object") return false;
  const content = value as Record<string, unknown>;
  return (
    hasExactKeys(content, ["label", "sessionId", "nonce"]) &&
    isBoundedString(content.label) &&
    isFixtureSessionId(content.sessionId) &&
    isFixtureSessionId(content.nonce)
  );
}

/** Validate the participant identity supplied by an extension UI page. */
function isUiIdentity(value: unknown): value is UiIdentity {
  if (!value || typeof value !== "object") return false;
  const ui = value as Record<string, unknown>;
  return (
    (hasExactKeys(ui, ["participant", "sessionId"]) ||
      hasExactKeys(ui, ["participant", "sessionId", "windowId"])) &&
    (ui.participant === "popup" ||
      ui.participant === "options" ||
      ui.participant === "workspace") &&
    isFixtureSessionId(ui.sessionId) &&
    (ui.windowId === undefined ||
      (typeof ui.windowId === "number" &&
        Number.isSafeInteger(ui.windowId) &&
        ui.windowId >= 0))
  );
}

/** Restrict fixture-controlled strings before using them in routing state. */
function isBoundedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

/** Build a frame target from a sender when tab and frame identity are present. */
function senderContentTarget(sender: chrome.runtime.MessageSender) {
  if (sender.tab?.id === undefined || sender.frameId === undefined)
    return undefined;
  return chromeTarget.contentFrame({
    tabId: sender.tab.id,
    frameId: sender.frameId,
  });
}

/** Build a document target from a sender with a committed document identity. */
function senderDocumentTarget(sender: chrome.runtime.MessageSender) {
  if (sender.tab?.id === undefined || sender.documentId === undefined)
    return undefined;
  return chromeTarget.contentDocument({
    tabId: sender.tab.id,
    documentId: sender.documentId,
  });
}

/** Normalize an arbitrary fixture failure to its stable error code. */
function errorResult(error: unknown): FixtureError {
  return { code: fixtureErrorCode(error) };
}

/** Check the sender extension identity before trusting its metadata. */
function isExtensionSender(sender: chrome.runtime.MessageSender): boolean {
  return typeof sender.id === "string" && sender.id === chrome.runtime.id;
}

/** Validate an HTTP content-script sender for a specific fixture run. */
function isContentSender(
  sender: chrome.runtime.MessageSender,
  runId: string,
  url = senderUrl(sender),
): boolean {
  return !!(
    isExtensionSender(sender) &&
    sender.tab?.id !== undefined &&
    sender.frameId !== undefined &&
    url?.protocol === "http:" &&
    url.hostname === "127.0.0.1" &&
    (url.port === "4173" || url.port === "4174") &&
    isFixtureRunId(runId) &&
    url.searchParams.get("runId") === runId
  );
}

/** Validate the sender allowed to bootstrap content or UI identity. */
function isBootstrapSender(
  sender: chrome.runtime.MessageSender,
  runId: string,
  content: ContentIdentity | undefined,
  ui: UiIdentity | undefined,
): boolean {
  if (content) return ui === undefined && isContentSender(sender, runId);
  if (ui) return isUiSenderForParticipant(sender, runId, ui.participant);
  return isContentSender(sender, runId) || isUiSender(sender, runId);
}

/** Restrict a validated UI sender to its declared participant page. */
function isUiSenderForParticipant(
  sender: chrome.runtime.MessageSender,
  runId: string,
  participant: UiIdentity["participant"],
): boolean {
  const url = senderUrl(sender);
  return isUiSender(sender, runId) && url?.pathname === `/${participant}.html`;
}

/** Validate an extension UI sender and its run query parameter. */
function isUiSender(
  sender: chrome.runtime.MessageSender,
  runId: string,
): boolean {
  const url = senderUrl(sender);
  if (!isExtensionSender(sender) || !url || !isFixtureRunId(runId))
    return false;
  return (
    url.protocol === "chrome-extension:" &&
    url.host === chrome.runtime.id &&
    ["/popup.html", "/options.html", "/workspace.html"].includes(
      url.pathname,
    ) &&
    url.searchParams.get("runId") === runId
  );
}

/** Convert finite diagnostic numbers to nullable fixture output. */
function normalizeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Convert diagnostic strings to nullable fixture output. */
function normalizeString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Validate an offscreen document sender for the active or requested run. */
function isOffscreenSender(
  sender: chrome.runtime.MessageSender,
  runId: string | undefined,
): boolean {
  const url = senderUrl(sender);
  if (!url) return false;
  return (
    isExtensionSender(sender) &&
    url.protocol === "chrome-extension:" &&
    url.host === chrome.runtime.id &&
    url.pathname === "/offscreen.html" &&
    (runId === undefined || url.searchParams.get("runId") === runId)
  );
}

/** Parse sender URLs at the trust boundary without propagating malformed input. */
function senderUrl(sender: chrome.runtime.MessageSender): URL | undefined {
  if (!sender.url) return undefined;
  try {
    return new URL(sender.url);
  } catch {
    return undefined;
  }
}

/** Extract validated content sender facts for registry authorization checks. */
function normalizedContentSender(
  sender: chrome.runtime.MessageSender,
): ValidatedContentSender | undefined {
  const url = senderUrl(sender);
  if (
    !url ||
    sender.tab?.id === undefined ||
    sender.frameId === undefined ||
    !isContentSender(sender, url.searchParams.get("runId") ?? "", url)
  )
    return undefined;
  return {
    tabId: sender.tab.id,
    frameId: sender.frameId,
    documentId: sender.documentId,
    senderUrl: url.href,
  };
}

/** Sanitize a boundary run ID while preserving an explicit unknown marker. */
function sanitizeBoundaryRunId(value: unknown): string {
  return isFixtureRunId(value) ? sanitizeFixtureText(value) : "unknown";
}
