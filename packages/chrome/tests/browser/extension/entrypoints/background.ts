/// <reference types="chrome" />

import {
  chromeTarget,
  type ChromeAdapterModel,
  usingBackgroundScript,
} from "@nexus-js/chrome";
import type {
  Allified,
  Asyncified,
  ConnectionAuthContext,
  ConnectionWhere,
} from "@nexus-js/core";
import { createNexusStore } from "@nexus-js/core/state";
import {
  relayService,
  type RelayServiceCallContext,
} from "@nexus-js/core/relay";
import { eventKey, type BridgeEvent } from "../../protocol";
import { defineBackground } from "wxt/utils/define-background";
import {
  DocumentToolToken,
  DocumentRelayToken,
  DocumentRouteToken,
  FixtureAdminToken,
  RelayAdminToken,
  TargetedContentAdminToken,
  type DocumentReference,
  type DocumentToolService,
  type FixtureAppMeta,
  type RelayAdminResponse,
  type FixtureError,
  WorkspaceToken,
} from "../shared/contracts";
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
import { workspaceStateDefinition } from "../shared/workspace-state";
import { isPreRouteCommand, type PreRouteCommand } from "../shared/scenario";

const passiveSelectTimeoutMs = 1_000;

type FixtureChromeModel = ChromeAdapterModel<FixtureAppMeta>;
type FixtureChromeTarget = FixtureChromeModel["connectionTarget"];
type FixtureWhere = ConnectionWhere<FixtureChromeModel>;
type FixtureContext = Parameters<FixtureWhere>[0];
type DocumentToolProxy = Asyncified<DocumentToolService>;
type DocumentToolMulticast = Allified<DocumentToolService>;
type ValidatedContentSender = Readonly<{
  tabId: number;
  frameId: number;
  documentId?: string;
  senderUrl: string;
}>;

function createContentRegistry() {
  const facts = new Map<string, ContentFact>();

  const snapshot = (fact: ContentFact): ContentFact => ({ ...fact });
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

    get(label: string): ContentFact | undefined {
      const fact = facts.get(label);
      return fact ? snapshot(fact) : undefined;
    },

    currentMain(runId: string | undefined): ContentFact | undefined {
      const fact = facts.get("main");
      if (
        !fact ||
        fact.runId !== runId ||
        fact.frameId !== 0 ||
        !fact.documentId
      )
        return undefined;
      return snapshot(fact);
    },

    frameTarget(label: string): FixtureChromeTarget | undefined {
      const fact = facts.get(label);
      return fact
        ? chromeTarget.contentFrame({
            tabId: fact.tabId,
            frameId: fact.frameId,
          })
        : undefined;
    },

    exactTarget(label: string): FixtureChromeTarget | undefined {
      const fact = facts.get(label);
      return fact ? target(fact) : undefined;
    },

    targets(labels?: readonly string[]): readonly FixtureChromeTarget[] {
      return [...facts.values()]
        .filter((fact) => !labels || labels.includes(fact.label))
        .map(target);
    },

    evictNavigation(tabId: number, frameId: number): ContentFact[] {
      return evict((fact) => fact.tabId === tabId && fact.frameId === frameId);
    },

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

  function evict(predicate: (fact: ContentFact) => boolean): ContentFact[] {
    const removed: ContentFact[] = [];
    for (const [label, fact] of facts) {
      if (!predicate(fact)) continue;
      facts.delete(label);
      removed.push(snapshot(fact));
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
    retiredBetaSessionId: undefined as string | undefined,
    resolveBetaReplacement: undefined as (() => void) | undefined,
    betaReplacement: undefined as Promise<void> | undefined,
  };
  relayState.betaReplacement = new Promise<void>((resolve) => {
    relayState.resolveBetaReplacement = resolve;
  });
  const retained = {
    tool: undefined as DocumentToolProxy | undefined,
    reference: undefined as DocumentReference | undefined,
    multicast: undefined as DocumentToolMulticast | undefined,
    multicastTargets: undefined as readonly FixtureChromeTarget[] | undefined,
  };
  const contentRegistry = createContentRegistry();

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
    },
  });
  const workspaceState = createNexusStore(workspaceStateDefinition);
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
    multicastBoundInvoke: () => invokeBoundMulticast(),
    multicastFail: () => failBoundMulticast(),
    capabilityInvoke: () => invokeCapability(),
    capabilityProxyInvoke: () => invokeCapabilityProxy(),
    capabilityReferenceInvoke: () => invokeCapabilityReference(),
    capabilityRelease: () => releaseCapabilityReference(),
    identityPinned: () => invokePinnedIdentity(),
    createOffscreen: () => createOffscreen(),
    closeOffscreen: () => closeOffscreen(),
  });
  nexus.provide(RelayAdminToken, {
    registerCurrentDocument: async () => handleRelayControl("register"),
    refreshCurrentDocument: async () => handleRelayControl("refresh"),
    setPolicyMode: async (mode) => handleRelayControl("policy", mode),
  });
  nexus.provide(TargetedContentAdminToken, {
    providerFirstSelect: () => providerFirstSelect(),
    contentHold: (label) => holdContent(label),
    identityConstraint: () => identityConstraint(),
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

  function ensureRun(runId: string): Promise<void> {
    if (runState.activeRunId === runId) return Promise.resolve();
    runState.activation ??= activateRun(runId).finally(() => {
      runState.activation = undefined;
    });
    return runState.activation;
  }

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

  async function runPreRouteCommand(
    command: PreRouteCommand,
    sender: chrome.runtime.MessageSender,
  ): Promise<Record<string, unknown>> {
    await runState.ready;
    try {
      const target = senderContentTarget(sender);
      if (command === "select-start") return selectWithoutRoute();
      if (command === "provider-cardinality")
        return selectProviderCardinality();
      if (command === "create-frame" || command === "create-document")
        return createSenderTarget(command, sender, target);
      if (command === "create-concurrent") return createConcurrent(target);
      if (command === "pre-ready-port-close") return probePreReadyClose(target);
      if (command === "multicast-select") return bindMulticast();
      if (command === "multicast-create") return createMulticast();
      if (command === "multicast-rebind") return createExactMulticast();
      if (command === "multicast-unavailable")
        return createUnavailableMulticast();
      if (command === "identity-select-beta") return selectFreshBeta();
      if (command === "reference-callback") return invokeCallback(target);
      if (command === "capability-retain") return retainCapability(target);
      return { code: "E_FIXTURE_COMMAND_UNSUPPORTED" };
    } catch (error) {
      return errorResult(error);
    }
  }

  async function selectWithoutRoute(): Promise<Record<string, unknown>> {
    await runState.reporter?.barrier("select-started");
    const started = performance.now();
    const selected = await nexus.safeSelect(DocumentToolToken, {
      wait: { timeout: passiveSelectTimeoutMs },
    });
    const settled = performance.now();
    await runState.reporter?.barrier(
      selected.isErr() ? "select-pending-no-route" : "select-resolved",
    );
    return selected.isErr()
      ? {
          ...errorResult(selected.error),
          waitTimeoutMs: passiveSelectTimeoutMs,
          started,
          settled,
        }
      : { identity: await selected.value.identity() };
  }

  async function selectProviderCardinality(): Promise<Record<string, unknown>> {
    const providers = await nexus.safeSelectMulticast(DocumentToolToken, {
      expects: "all",
    });
    if (providers.isErr()) return errorResult(providers.error);
    const identities = await providers.value.identity();
    await runState.reporter?.barrier(
      `selection-${
        identities.length === 0
          ? "zero"
          : identities.length === 1
            ? "one"
            : "two"
      }-ready`,
    );
    if (identities.length === 0) return { code: "E_SERVICE_NO_MATCH" };
    return { count: identities.length, identities };
  }

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
    const created = await nexus.safeCreate(DocumentToolToken, {
      target: exactTarget,
    });
    return created.isErr()
      ? errorResult(created.error)
      : { target: exactTarget, identity: await created.value.identity() };
  }

  async function createConcurrent(
    target: FixtureChromeTarget | undefined,
  ): Promise<Record<string, unknown>> {
    if (!target) return { code: "E_TARGET_UNAVAILABLE" };
    const beforePorts = runState.observedContentPorts;
    const [first, second] = await Promise.all([
      nexus.safeCreate(DocumentToolToken, { target }),
      nexus.safeCreate(DocumentToolToken, { target }),
    ]);
    const route = await nexus.safeCreate(DocumentRouteToken, { target });
    return {
      first: first.isErr()
        ? errorResult(first.error)
        : await first.value.identity(),
      second: second.isErr()
        ? errorResult(second.error)
        : await second.value.identity(),
      acceptedRoute: route.isErr()
        ? errorResult(route.error)
        : { ...(await route.value.facts()) },
      observedPortDelta: runState.observedContentPorts - beforePorts,
    };
  }

  async function probePreReadyClose(
    target: FixtureChromeTarget | undefined,
  ): Promise<Record<string, unknown>> {
    if (!target) return { code: "E_TARGET_UNAVAILABLE" };
    const created = await nexus.safeCreate(DocumentToolToken, { target });
    return created.isErr()
      ? errorResult(created.error)
      : { code: "E_FIXTURE_UNEXPECTED_PROXY" };
  }

  async function createMulticast(): Promise<Record<string, unknown>> {
    const targets = contentRegistry.targets(["alpha", "beta"]);
    if (targets.length < 2) return { code: "E_TARGET_UNAVAILABLE" };
    const routes = await Promise.all(
      targets.map((target) => nexus.safeCreate(DocumentToolToken, { target })),
    );
    const failed = routes.find((route) => route.isErr());
    if (failed?.isErr()) return errorResult(failed.error);
    const multicast = await nexus.safeCreateMulticast(DocumentToolToken, {
      targets,
      expects: "all",
    });
    if (multicast.isErr()) return errorResult(multicast.error);
    retained.multicast = multicast.value;
    await runState.reporter?.barrier("multicast-all-acquired");
    retained.multicastTargets = targets;
    await runState.reporter?.barrier("multicast-targets-retained");
    return { identities: await multicast.value.identity() };
  }

  async function createUnavailableMulticast(): Promise<
    Record<string, unknown>
  > {
    if (!retained.multicastTargets) return { code: "E_TARGET_UNAVAILABLE" };
    const multicast = await nexus.safeCreateMulticast(DocumentToolToken, {
      targets: retained.multicastTargets,
      expects: "all",
      timeout: 1_000,
    });
    await runState.reporter?.barrier("multicast-unavailable-ready");
    return multicast.isErr()
      ? errorResult(multicast.error)
      : { code: "E_FIXTURE_UNEXPECTED_MULTICAST_SUCCESS" };
  }

  async function selectFreshBeta(): Promise<Record<string, unknown>> {
    const beta = contentRegistry.get("beta");
    const target = contentRegistry.exactTarget("beta");
    if (!beta) return { code: "E_SERVICE_NO_MATCH" };
    if (!target) return { code: "E_TARGET_UNAVAILABLE" };
    const selected = await nexus.safeCreate(DocumentToolToken, {
      target,
      where: (context: FixtureContext) =>
        context.app.label === "beta" &&
        context.app.sessionId === beta.sessionId,
    });
    if (selected.isErr()) return errorResult(selected.error);
    await runState.reporter?.barrier("beta-selected-fresh");
    return { identity: await selected.value.identity() };
  }

  async function invokeCallback(
    target: FixtureChromeTarget | undefined,
  ): Promise<Record<string, unknown>> {
    if (!target) return { code: "E_TARGET_UNAVAILABLE" };
    const tool = await nexus.safeCreate(DocumentToolToken, { target });
    if (tool.isErr()) return errorResult(tool.error);
    const callback = await tool.value.acceptCallback(async () => "callback-ok");
    await runState.reporter?.barrier("callback-invoked");
    return { callback };
  }

  async function retainCapability(
    target: FixtureChromeTarget | undefined,
  ): Promise<Record<string, unknown>> {
    if (!target) return { code: "E_TARGET_UNAVAILABLE" };
    const tool = await nexus.safeCreate(DocumentToolToken, { target });
    if (tool.isErr()) return errorResult(tool.error);
    retained.tool = tool.value;
    retained.reference = await retained.tool.createReference();
    await runState.reporter?.barrier("alpha-reference-created");
    return {
      identity: await retained.tool.identity(),
      reference: await retained.reference.label(),
    };
  }

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

  async function providerFirstSelect() {
    const selected = await nexus.safeSelect(DocumentToolToken);
    if (selected.isErr()) return errorResult(selected.error);
    return { identity: await selected.value.identity() };
  }

  async function holdContent(label: string): Promise<FixtureError> {
    const target = contentRegistry.frameTarget(label);
    if (!target) return { code: "E_TARGET_UNAVAILABLE" };
    const tool = await nexus.safeCreate(DocumentToolToken, {
      target,
    });
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

  async function identityConstraint(): Promise<FixtureError> {
    const alpha = contentRegistry.get("alpha");
    const target = contentRegistry.exactTarget("alpha");
    if (!alpha || !target) return { code: "E_TARGET_UNAVAILABLE" };
    const constrained = await nexus.safeCreate(DocumentToolToken, {
      target,
      where: (context: FixtureContext) => context.app.label === "beta",
    });
    if (constrained.isErr()) {
      await runState.reporter?.barrier("alpha-constraint-failed");
      return errorResult(constrained.error);
    }
    return { code: "E_FIXTURE_UNEXPECTED_RETARGET" };
  }

  async function invokeBoundMulticast() {
    if (!retained.multicast) return { code: "E_FIXTURE_MULTICAST_ABSENT" };
    try {
      return { identities: await retained.multicast.identity() };
    } catch (error) {
      return errorResult(error);
    }
  }

  async function failBoundMulticast() {
    if (!retained.multicast) return { code: "E_FIXTURE_MULTICAST_ABSENT" };
    try {
      const results = await retained.multicast.fail();
      await runState.reporter?.barrier("multicast-remote-rejection-ready");
      return { results };
    } catch (error) {
      return errorResult(error);
    }
  }

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

  async function invokeCapabilityProxy() {
    if (!retained.tool) return { code: "E_FIXTURE_CAPABILITY_ABSENT" };
    try {
      return { identity: await retained.tool.identity() };
    } catch (error) {
      return errorResult(error);
    }
  }

  async function invokeCapabilityReference() {
    if (!retained.reference) return { code: "E_FIXTURE_CAPABILITY_ABSENT" };
    try {
      return { reference: await retained.reference.label() };
    } catch (error) {
      return errorResult(error);
    }
  }

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

  async function invokePinnedIdentity() {
    if (!retained.tool) return { code: "E_FIXTURE_CAPABILITY_ABSENT" };
    try {
      return { identity: await retained.tool.identity() };
    } catch (error) {
      return errorResult(error);
    }
  }

  async function createOffscreen() {
    await ensureOffscreen();
    return { requested: true } as const;
  }

  async function closeOffscreen() {
    await chrome.offscreen.closeDocument();
    offscreenState.resolveReady = undefined;
    offscreenState.create = undefined;
    offscreenState.activeSessionId = undefined;
    return { requested: true } as const;
  }

  async function handleRelayControl(
    operation: "register" | "refresh" | "policy",
    mode?: "allow" | "deny",
  ): Promise<RelayAdminResponse> {
    await runState.ready;
    if (operation === "policy") {
      if (!mode)
        return { result: errorResultCode("E_FIXTURE_CONTROL_REJECTED") };
      const policyMode = mode;
      relayState.policyMode = policyMode;
      return {
        result: {
          ok: true,
          type: "relay-policy-mode-result",
          mode: policyMode,
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
    relayState.target = current;
    const target = chromeTarget.contentDocument({
      tabId: current.tabId,
      documentId: current.documentId,
    });
    installRelayProvider(target);
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

  function installRelayProvider(target: FixtureChromeTarget): void {
    nexus.provide(
      relayService(DocumentRelayToken, {
        forwardThrough: nexus,
        forwardTarget: target,
        payload: { mode: "serializable" },
        policy: { canCall: (context) => evaluateRelayCall(context) },
      }),
    );
  }

  async function evaluateRelayCall(
    context: RelayServiceCallContext<FixtureChromeModel>,
  ): Promise<boolean> {
    const originContext = context.origin?.context;
    const originSessionId = context.origin?.app?.sessionId ?? null;
    const allowedOrigin =
      originContext === "popup" ||
      originContext === "workspace" ||
      originContext === "fixture-workspace";
    const decision =
      relayState.policyMode === "allow" && allowedOrigin ? "allow" : "deny";
    const connection = context.connection?.observed ?? context.connection;
    await runState.reporter?.result(
      JSON.stringify({
        type: "relay-policy-observation",
        decision,
        originContext:
          originContext === "fixture-workspace"
            ? "workspace"
            : (originContext ?? null),
        originSessionId,
        relayContext: normalizeString(context.relay?.context),
        relaySessionId: normalizeString(context.relay?.app?.sessionId),
        connectionTabId: normalizeNumber(connection?.tabId),
        connectionFrameId: normalizeNumber(connection?.frameId),
        connectionDocumentId: normalizeString(connection?.documentId),
        tokenId: context.tokenId,
        operation: context.operation,
        path: context.path,
        ...(decision === "deny" ? { code: "E_RELAY_POLICY_DENIED" } : {}),
      }),
    );
    return decision === "allow";
  }

  async function bindMulticast() {
    const selected = await nexus.safeSelectMulticast(DocumentToolToken, {
      expects: "all",
    });
    if (selected.isErr()) return errorResult(selected.error);
    retained.multicast = selected.value;
    await runState.reporter?.barrier("multicast-snapshot-bound");
    return { identities: await retained.multicast.identity() };
  }

  async function createExactMulticast(): Promise<Record<string, unknown>> {
    if (relayState.retiredBetaSessionId) {
      const beta = contentRegistry.get("beta");
      if (!beta || beta.sessionId === relayState.retiredBetaSessionId) {
        await relayState.betaReplacement;
      }
    }
    const targets = contentRegistry.targets(["alpha", "beta"]);
    if (targets.length < 2) return { code: "E_TARGET_UNAVAILABLE" };
    const routes = await Promise.all(
      targets.map((target) => nexus.safeCreate(DocumentToolToken, { target })),
    );
    const failed = routes.find((route) => route.isErr());
    if (failed?.isErr()) return errorResult(failed.error);
    const multicast = await nexus.safeCreateMulticast(DocumentToolToken, {
      targets,
      expects: "all",
    });
    if (multicast.isErr()) return errorResult(multicast.error);
    retained.multicast = multicast.value;
    await runState.reporter?.barrier("multicast-snapshot-bound");
    return { identities: await retained.multicast.identity() };
  }

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
  readonly participant: "popup" | "workspace";
  readonly sessionId: string;
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

function errorResultCode(code: string): RelayAdminResponse["result"] {
  return { ok: false, type: "fixture-error", code, message: null };
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && actual.every((key) => keys.includes(key))
  );
}

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

function isUiIdentity(value: unknown): value is UiIdentity {
  if (!value || typeof value !== "object") return false;
  const ui = value as Record<string, unknown>;
  return (
    hasExactKeys(ui, ["participant", "sessionId"]) &&
    (ui.participant === "popup" || ui.participant === "workspace") &&
    isFixtureSessionId(ui.sessionId)
  );
}

function isBoundedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function senderContentTarget(sender: chrome.runtime.MessageSender) {
  if (sender.tab?.id === undefined || sender.frameId === undefined)
    return undefined;
  return chromeTarget.contentFrame({
    tabId: sender.tab.id,
    frameId: sender.frameId,
  });
}

function senderDocumentTarget(sender: chrome.runtime.MessageSender) {
  if (sender.tab?.id === undefined || sender.documentId === undefined)
    return undefined;
  return chromeTarget.contentDocument({
    tabId: sender.tab.id,
    documentId: sender.documentId,
  });
}

function errorResult(error: unknown): FixtureError {
  return { code: fixtureErrorCode(error) };
}

function senderMatchesRun(
  sender: chrome.runtime.MessageSender,
  runId: string,
): boolean {
  const url = senderUrl(sender);
  return (
    !!url && isFixtureRunId(runId) && url.searchParams.get("runId") === runId
  );
}

function isExtensionSender(sender: chrome.runtime.MessageSender): boolean {
  return typeof sender.id === "string" && sender.id === chrome.runtime.id;
}

function isContentSender(
  sender: chrome.runtime.MessageSender,
  runId: string,
): boolean {
  const url = senderUrl(sender);
  return !!(
    isExtensionSender(sender) &&
    sender.tab?.id !== undefined &&
    sender.frameId !== undefined &&
    url?.protocol === "http:" &&
    url.hostname === "127.0.0.1" &&
    (url.port === "4173" || url.port === "4174") &&
    senderMatchesRun(sender, runId)
  );
}

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

function isUiSenderForParticipant(
  sender: chrome.runtime.MessageSender,
  runId: string,
  participant: UiIdentity["participant"],
): boolean {
  const url = senderUrl(sender);
  return isUiSender(sender, runId) && url?.pathname === `/${participant}.html`;
}

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

function normalizeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

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

function senderUrl(sender: chrome.runtime.MessageSender): URL | undefined {
  if (!sender.url) return undefined;
  try {
    return new URL(sender.url);
  } catch {
    return undefined;
  }
}

function normalizedSenderUrl(
  sender: chrome.runtime.MessageSender,
): string | undefined {
  return senderUrl(sender)?.href;
}

function normalizedContentSender(
  sender: chrome.runtime.MessageSender,
): ValidatedContentSender | undefined {
  if (
    sender.tab?.id === undefined ||
    sender.frameId === undefined ||
    !isContentSender(sender, senderUrl(sender)?.searchParams.get("runId") ?? "")
  )
    return undefined;
  const senderUrlValue = normalizedSenderUrl(sender);
  return senderUrlValue
    ? {
        tabId: sender.tab.id,
        frameId: sender.frameId,
        documentId: sender.documentId,
        senderUrl: senderUrlValue,
      }
    : undefined;
}

function sanitizeBoundaryRunId(value: unknown): string {
  return isFixtureRunId(value) ? sanitizeFixtureText(value) : "unknown";
}
