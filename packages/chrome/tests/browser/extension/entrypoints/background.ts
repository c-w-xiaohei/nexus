/// <reference types="chrome" />

import {
  chromeTarget,
  type ChromeAdapterModel,
  usingBackgroundScript,
} from "@nexus-js/chrome";
import { createNexusStore } from "@nexus-js/core/state";
import {
  relayService,
  type RelayServiceCallContext,
} from "@nexus-js/core/relay";
import { eventKey } from "../../protocol";
import { defineBackground } from "wxt/utils/define-background";
import {
  DocumentToolToken,
  DocumentRelayToken,
  DocumentRouteToken,
  FixtureAdminToken,
  RelayAdminToken,
  TargetedContentAdminToken,
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

export default defineBackground(() => {
  const identity = backgroundIdentity();
  let activeRunId: string | undefined;
  configureFixtureLogger(identity, () => activeRunId);
  let counter = 0;
  let workspaceInvocationCount = 0;
  let setting = "compact";
  let generation = 1;
  let nonce = crypto.randomUUID();
  let denyCalls = false;
  let relayPolicyMode: "allow" | "deny" = "allow";
  let reporter: ReturnType<typeof createReporter> | undefined;
  let activation: Promise<void> | undefined;
  let resolveOffscreenReady: ((sessionId: string) => void) | undefined;
  let offscreenReady = new Promise<string>((resolve) => {
    resolveOffscreenReady = resolve;
  });
  let offscreenCreate: Promise<string> | undefined;
  let activeOffscreenSessionId: string | undefined;
  let observedContentPorts = 0;
  let relayTarget: ContentFact | undefined;
  let retainedTool: any;
  let retainedReference: any;
  let retainedMulticast: any;
  let retainedMulticastTargets:
    | ReturnType<typeof registeredTargets>
    | undefined;
  const contentRegistry = new Map<string, ContentFact>();
  const isRegisteredContentSender = (
    sender: chrome.runtime.MessageSender,
    runId: string,
    senderSessionId: string,
  ): boolean => {
    if (!isContentSender(sender, runId)) return false;
    const senderUrl = normalizedSenderUrl(sender);
    if (!senderUrl) return false;
    return [...contentRegistry.values()].some(
      (fact) =>
        fact.runId === runId &&
        fact.tabId === sender.tab?.id &&
        fact.frameId === sender.frameId &&
        fact.documentId !== undefined &&
        sender.documentId !== undefined &&
        fact.documentId === sender.documentId &&
        fact.sessionId === senderSessionId &&
        fact.senderUrl === senderUrl,
    );
  };
  let retiredBetaSessionId: string | undefined;
  let resolveBetaReplacement: (() => void) | undefined;
  let betaReplacement = new Promise<void>((resolve) => {
    resolveBetaReplacement = resolve;
  });
  let resolveRunReady: (() => void) | undefined;
  const runReady = new Promise<void>((resolve) => {
    resolveRunReady = resolve;
  });

  const nexus = usingBackgroundScript<{
    fixture: boolean;
    sessionId: string;
    runId?: string;
  }>({
    app: {
      fixture: true,
      sessionId: identity.sessionId,
    },
  });
  nexus.configure({
    policy: {
      canConnect: ({ remoteIdentity, connection }: any) => {
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
        await runReady;
        const invocationCount = ++workspaceInvocationCount;
        await reporter?.result(
          JSON.stringify({
            type: "workspace-invocation",
            operation: "summary",
            invocationCount,
          }),
        );
        return {
          counter,
          setting,
          generation,
          nonce,
          sessionId: identity.sessionId,
        };
      },
      increment: async () => {
        await runReady;
        return ++counter;
      },
      setting: async () => {
        await runReady;
        return setting;
      },
      setSetting: async (value) => {
        await runReady;
        setting = value;
        await chrome.storage.local.set({ [`${fixturePrefix}setting`]: value });
        return setting;
      },
      pending: async () => {
        await runReady;
        await reporter?.barrier("pending-started");
        return new Promise<string>(() => {});
      },
      worker: async () => {
        await runReady;
        return { generation, nonce, sessionId: identity.sessionId };
      },
      createCapability: async () =>
        nexus.ref({
          ping: async () => `capability:${identity.sessionId}:${nonce}`,
        }),
      acceptCallback: async (callback) => callback(),
    },
    {
      policy: {
        canCall: async () => {
          if (!denyCalls) return true;
          await reporter?.result(
            JSON.stringify({
              type: "policy-denied",
              code: "E_AUTH_CALL_DENIED",
              counter,
            }),
          );
          return false;
        },
      },
    },
  );
  nexus.provide(FixtureAdminToken, {
    setCallPolicy: async (nextDenyCalls) => {
      await runReady;
      denyCalls = nextDenyCalls;
      return { denyCalls, counter };
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
      setting = stored[`${fixturePrefix}setting`] as string;
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
            registerContent(message.runId, message.content, _sender);
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
        registerContent(message.runId, message, _sender);
        sendResponse({ ok: true });
        return;
      }
      // Target-routing scenarios must begin before a Nexus route exists, so a
      // public admin proxy would change the behavior they are measuring.
      if (message.kind === "fixture-command") {
        if (
          !isRegisteredContentSender(
            _sender,
            message.runId,
            message.senderSessionId,
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
          message.runId !== activeRunId ||
          !isOffscreenSender(_sender, message.runId)
        ) {
          void recordOffscreenBoundary(message, _sender, "rejected-run");
          sendResponse({ ok: false });
          return;
        }
        void recordOffscreenBoundary(message, _sender, "accepted");
        activeOffscreenSessionId = message.sessionId;
        resolveOffscreenReady?.(message.sessionId);
        sendResponse({ ok: true });
        return;
      }
      if (message.kind === "offscreen-init") {
        if (
          !isOffscreenSender(_sender, message.runId) ||
          message.runId !== activeRunId
        ) {
          void recordOffscreenBoundary(message, _sender, "rejected-sender");
          sendResponse({ ok: false });
          return;
        }
        void chrome.storage.session
          .setAccessLevel({
            accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS",
          })
          .then(() => {
            void recordOffscreenBoundary(message, _sender, "accepted");
            sendResponse({ ok: true });
          })
          .catch((error) => {
            void recordOffscreenBoundary(
              message,
              _sender,
              "response-error",
              error,
            );
            sendResponse({ ok: false });
          });
        return true;
      }
      if (message.kind === "offscreen-diagnostic") {
        if (
          !isOffscreenSender(_sender, activeRunId) ||
          !validateOffscreenEvent(message.event) ||
          message.event.runId !== activeRunId
        ) {
          void recordOffscreenBoundary(message, _sender, "rejected-diagnostic");
          sendResponse({ ok: false });
          return;
        }
        void chrome.storage.session
          .set({ [eventKey(message.event)]: message.event })
          .then(() => {
            void recordOffscreenBoundary(message, _sender, "persisted");
            sendResponse({ ok: true });
          })
          .catch((error) => {
            void recordOffscreenBoundary(
              message,
              _sender,
              "persist-error",
              error,
            );
            sendResponse({ ok: false });
          });
        return true;
      }
    },
  );

  chrome.webNavigation.onCommitted.addListener((details) => {
    const runId = new URL(details.url).searchParams.get("runId");
    if (!runId || runId !== activeRunId) return;
    void reporter?.barrier("navigation-committed");
    for (const [label, fact] of contentRegistry) {
      if (fact.tabId === details.tabId && fact.frameId === details.frameId) {
        contentRegistry.delete(label);
        if (label === "beta") {
          retiredBetaSessionId = fact.sessionId;
          betaReplacement = new Promise<void>((resolve) => {
            resolveBetaReplacement = resolve;
          });
        }
        void reporter?.barrier(`${label}-left-snapshot`);
      }
    }
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (!port.sender?.url?.includes("runId=")) return;
    observedContentPorts += 1;
    const { tab, frameId, documentId } = port.sender;
    port.onDisconnect.addListener(() => {
      for (const [label, fact] of contentRegistry) {
        if (
          fact.tabId === tab?.id &&
          fact.frameId === frameId &&
          fact.documentId === documentId
        ) {
          contentRegistry.delete(label);
          void reporter?.barrier(`${label}-left-snapshot`);
        }
      }
    });
  });

  async function activateRun(runId: string): Promise<void> {
    if (activeRunId === runId) return;
    if (!(await initializeBackgroundRun(runId))) return;
    await chrome.storage.session.setAccessLevel({
      accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS",
    });
    activeRunId = runId;
    workspaceInvocationCount = 0;
    relayPolicyMode = "allow";
    reporter = createReporter({ ...identity, runId });
    await nexus.updateIdentity({
      app: { fixture: true, sessionId: identity.sessionId, runId },
    });
    resolveRunReady?.();
    resolveRunReady = undefined;
    await reporter.barrier("background-ready");
    await reporter.barrier("worker generation/wake");
  }

  function ensureRun(runId: string): Promise<void> {
    if (activeRunId === runId) return Promise.resolve();
    activation ??= activateRun(runId).finally(() => {
      activation = undefined;
    });
    return activation;
  }

  async function ensureOffscreen(): Promise<string> {
    if (offscreenCreate) {
      return await offscreenCreate;
    }
    if (await chrome.offscreen.hasDocument()) {
      if (activeOffscreenSessionId) {
        return activeOffscreenSessionId;
      }
      await chrome.offscreen.closeDocument();
    }
    offscreenCreate = (async () => {
      await runReady;
      await reporter?.barrier("offscreen-create-started");
      activeOffscreenSessionId = undefined;
      offscreenReady = new Promise<string>((resolve) => {
        resolveOffscreenReady = resolve;
      });
      await chrome.offscreen.createDocument({
        url: `offscreen.html?runId=${activeRunId}`,
        reasons: [chrome.offscreen.Reason.DOM_SCRAPING],
        justification: "Fixture export provider lifecycle",
      });
      const sessionId = await offscreenReady;
      await reporter?.barrier("offscreen-ready");
      return sessionId;
    })().catch((error) => {
      offscreenCreate = undefined;
      throw error;
    });
    return await offscreenCreate;
  }

  async function runPreRouteCommand(
    command: PreRouteCommand,
    sender: chrome.runtime.MessageSender,
  ): Promise<Record<string, unknown>> {
    await runReady;
    try {
      if (command === "select-start") {
        await reporter?.barrier("select-started");
        const started = performance.now();
        const selected = await nexus.safeSelect(DocumentToolToken, {
          wait: { timeout: passiveSelectTimeoutMs },
        });
        const settled = performance.now();
        await reporter?.barrier(
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
      if (command === "provider-cardinality") {
        const providers = await nexus.safeSelectMulticast(DocumentToolToken, {
          expects: "all",
        });
        if (providers.isErr()) return errorResult(providers.error);
        const identities = await providers.value.identity();
        if (identities.length === 0) return { code: "E_SERVICE_NO_MATCH" };
        await reporter?.barrier(
          `selection-${identities.length === 0 ? "zero" : identities.length === 1 ? "one" : "two"}-ready`,
        );
        return { count: identities.length, identities };
      }
      const target = senderContentTarget(sender);
      if (command === "create-frame" || command === "create-document") {
        if (!target) return { code: "E_TARGET_UNAVAILABLE" };
        const exactTarget =
          command === "create-document" ? senderDocumentTarget(sender) : target;
        if (!exactTarget) return { code: "E_DOCUMENT_TARGET_UNAVAILABLE" };
        await reporter?.barrier("route-absent");
        const created = await nexus.safeCreate(DocumentToolToken, {
          target: exactTarget,
        });
        return created.isErr()
          ? errorResult(created.error)
          : { target: exactTarget, identity: await created.value.identity() };
      }
      if (command === "create-concurrent") {
        if (!target) return { code: "E_TARGET_UNAVAILABLE" };
        const beforePorts = observedContentPorts;
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
          observedPortDelta: observedContentPorts - beforePorts,
        };
      }
      if (command === "pre-ready-port-close") {
        if (!target) return { code: "E_TARGET_UNAVAILABLE" };
        const created = await nexus.safeCreate(DocumentToolToken, { target });
        return created.isErr()
          ? errorResult(created.error)
          : { code: "E_FIXTURE_UNEXPECTED_PROXY" };
      }
      if (command === "multicast-select") return bindMulticast();
      if (command === "multicast-create") {
        const targets = registeredTargets(["alpha", "beta"]);
        if (targets.length < 2) return { code: "E_TARGET_UNAVAILABLE" };
        const routes = await Promise.all(
          targets.map((target) =>
            nexus.safeCreate(DocumentToolToken, { target }),
          ),
        );
        const failed = routes.find((route) => route.isErr());
        if (failed?.isErr()) return errorResult(failed.error);
        const multicast = await nexus.safeCreateMulticast(DocumentToolToken, {
          targets,
          expects: "all",
        });
        if (multicast.isErr()) return errorResult(multicast.error);
        retainedMulticast = multicast.value;
        await reporter?.barrier("multicast-all-acquired");
        retainedMulticastTargets = targets;
        await reporter?.barrier("multicast-targets-retained");
        return { identities: await multicast.value.identity() };
      }
      if (command === "multicast-rebind") return createExactMulticast();
      if (command === "multicast-unavailable") {
        if (!retainedMulticastTargets) return { code: "E_TARGET_UNAVAILABLE" };
        const multicast = await nexus.safeCreateMulticast(DocumentToolToken, {
          targets: retainedMulticastTargets,
          expects: "all",
          timeout: 1_000,
        });
        await reporter?.barrier("multicast-unavailable-ready");
        return multicast.isErr()
          ? errorResult(multicast.error)
          : { code: "E_FIXTURE_UNEXPECTED_MULTICAST_SUCCESS" };
      }
      if (command === "identity-select-beta") {
        const beta = contentRegistry.get("beta");
        if (!beta) return { code: "E_SERVICE_NO_MATCH" };
        const target = beta.documentId
          ? chromeTarget.contentDocument({
              tabId: beta.tabId,
              documentId: beta.documentId,
            })
          : chromeTarget.contentFrame({
              tabId: beta.tabId,
              frameId: beta.frameId,
            });
        const selected = await nexus.safeCreate(DocumentToolToken, {
          target,
          where: (context: any) =>
            context.app.label === "beta" &&
            context.app.sessionId === beta.sessionId,
        });
        if (selected.isErr()) return errorResult(selected.error);
        await reporter?.barrier("beta-selected-fresh");
        return { identity: await selected.value.identity() };
      }
      if (command === "reference-callback") {
        if (!target) return { code: "E_TARGET_UNAVAILABLE" };
        const tool = await nexus.safeCreate(DocumentToolToken, { target });
        if (tool.isErr()) return errorResult(tool.error);
        const callback = await tool.value.acceptCallback(
          async () => "callback-ok",
        );
        await reporter?.barrier("callback-invoked");
        return { callback };
      }
      if (command === "capability-retain") {
        if (!target) return { code: "E_TARGET_UNAVAILABLE" };
        const tool = await nexus.safeCreate(DocumentToolToken, { target });
        if (tool.isErr()) return errorResult(tool.error);
        retainedTool = tool.value;
        retainedReference = await retainedTool.createReference();
        await reporter?.barrier("alpha-reference-created");
        return {
          identity: await retainedTool.identity(),
          reference: await retainedReference.label(),
        };
      }
      return { code: "E_FIXTURE_COMMAND_UNSUPPORTED" };
    } catch (error) {
      return errorResult(error);
    }
  }

  async function providerFirstSelect() {
    const selected = await nexus.safeSelect(DocumentToolToken);
    if (selected.isErr()) return errorResult(selected.error);
    return { identity: await selected.value.identity() };
  }

  async function holdContent(label: string): Promise<FixtureError> {
    const fact = contentRegistry.get(label);
    if (!fact) return { code: "E_TARGET_UNAVAILABLE" };
    const tool = await nexus.safeCreate(DocumentToolToken, {
      target: chromeTarget.contentFrame({
        tabId: fact.tabId,
        frameId: fact.frameId,
      }),
    });
    if (tool.isErr()) return errorResult(tool.error);
    await reporter?.barrier("hold-call-started");
    try {
      await tool.value.hold();
      return { code: "E_FIXTURE_UNEXPECTED_HOLD_SUCCESS" };
    } catch (error) {
      await reporter?.barrier("hold-terminal-error");
      return errorResult(error);
    }
  }

  async function identityConstraint(): Promise<FixtureError> {
    const alpha = contentRegistry.get("alpha");
    if (!alpha) return { code: "E_TARGET_UNAVAILABLE" };
    const constrained = await nexus.safeCreate(DocumentToolToken, {
      target: alpha.documentId
        ? chromeTarget.contentDocument({
            tabId: alpha.tabId,
            documentId: alpha.documentId,
          })
        : chromeTarget.contentFrame({
            tabId: alpha.tabId,
            frameId: alpha.frameId,
          }),
      where: (context: any) => context.app.label === "beta",
    });
    if (constrained.isErr()) {
      await reporter?.barrier("alpha-constraint-failed");
      return errorResult(constrained.error);
    }
    return { code: "E_FIXTURE_UNEXPECTED_RETARGET" };
  }

  async function invokeBoundMulticast() {
    if (!retainedMulticast) return { code: "E_FIXTURE_MULTICAST_ABSENT" };
    try {
      return { identities: await retainedMulticast.identity() };
    } catch (error) {
      return errorResult(error);
    }
  }

  async function failBoundMulticast() {
    if (!retainedMulticast) return { code: "E_FIXTURE_MULTICAST_ABSENT" };
    try {
      const results = await retainedMulticast.fail();
      await reporter?.barrier("multicast-remote-rejection-ready");
      return { results };
    } catch (error) {
      return errorResult(error);
    }
  }

  async function invokeCapability() {
    if (!retainedTool || !retainedReference)
      return { code: "E_FIXTURE_CAPABILITY_ABSENT" };
    try {
      return {
        identity: await retainedTool.identity(),
        reference: await retainedReference.label(),
      };
    } catch (error) {
      return errorResult(error);
    }
  }

  async function invokeCapabilityProxy() {
    if (!retainedTool) return { code: "E_FIXTURE_CAPABILITY_ABSENT" };
    try {
      return { identity: await retainedTool.identity() };
    } catch (error) {
      return errorResult(error);
    }
  }

  async function invokeCapabilityReference() {
    if (!retainedReference) return { code: "E_FIXTURE_CAPABILITY_ABSENT" };
    try {
      return { reference: await retainedReference.label() };
    } catch (error) {
      return errorResult(error);
    }
  }

  async function releaseCapabilityReference(): Promise<FixtureError> {
    if (!retainedReference) return { code: "E_FIXTURE_CAPABILITY_ABSENT" };
    const released = nexus.safeRelease(retainedReference);
    if (released.isErr()) return errorResult(released.error);
    await reporter?.barrier("reference-released");
    try {
      await retainedReference.label();
      return { code: "E_FIXTURE_UNEXPECTED_RESOURCE_SUCCESS" };
    } catch (error) {
      await reporter?.barrier("reference-terminal-error");
      return errorResult(error);
    }
  }

  async function invokePinnedIdentity() {
    if (!retainedTool) return { code: "E_FIXTURE_CAPABILITY_ABSENT" };
    try {
      return { identity: await retainedTool.identity() };
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
    resolveOffscreenReady = undefined;
    offscreenCreate = undefined;
    activeOffscreenSessionId = undefined;
    return { requested: true } as const;
  }

  async function handleRelayControl(
    operation: "register" | "refresh" | "policy",
    mode?: "allow" | "deny",
  ): Promise<RelayAdminResponse> {
    await runReady;
    if (operation === "policy") {
      if (!mode)
        return { result: errorResultCode("E_FIXTURE_CONTROL_REJECTED") };
      const policyMode = mode;
      relayPolicyMode = policyMode;
      return {
        result: {
          ok: true,
          type: "relay-policy-mode-result",
          mode: policyMode,
          backgroundSessionId: identity.sessionId,
        },
      };
    }
    const current = currentMainFact();
    if (!current) return { result: errorResultCode("E_TARGET_UNAVAILABLE") };
    if (
      operation === "refresh" &&
      relayTarget &&
      relayTarget.documentId === current.documentId
    ) {
      return { result: errorResultCode("E_TARGET_UNCHANGED") };
    }
    relayTarget = current;
    const target = chromeTarget.contentDocument({
      tabId: current.tabId,
      documentId: current.documentId!,
    });
    nexus.provide(
      relayService(DocumentRelayToken, {
        forwardThrough: nexus,
        forwardTarget: target,
        payload: { mode: "serializable" },
        policy: {
          canCall: async (
            context: RelayServiceCallContext<ChromeAdapterModel>,
          ) => {
            const originContext = context.origin?.context;
            const originSessionId = context.origin?.app?.sessionId ?? null;
            const allowedOrigin =
              originContext === "popup" ||
              originContext === "workspace" ||
              originContext === "fixture-workspace";
            const decision =
              relayPolicyMode === "allow" && allowedOrigin ? "allow" : "deny";
            const connection =
              context.connection?.observed ?? context.connection;
            await reporter?.result(
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
                ...(decision === "deny"
                  ? { code: "E_RELAY_POLICY_DENIED" }
                  : {}),
              }),
            );
            return decision === "allow";
          },
        },
      }),
    );
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

  function currentMainFact(): ContentFact | undefined {
    const fact = contentRegistry.get("main");
    if (
      !fact ||
      fact.runId !== activeRunId ||
      fact.frameId !== 0 ||
      !fact.documentId
    )
      return undefined;
    return fact;
  }

  async function bindMulticast() {
    const selected = await nexus.safeSelectMulticast(DocumentToolToken, {
      expects: "all",
    });
    if (selected.isErr()) return errorResult(selected.error);
    retainedMulticast = selected.value;
    await reporter?.barrier("multicast-snapshot-bound");
    return { identities: await retainedMulticast.identity() };
  }

  async function createExactMulticast(): Promise<Record<string, unknown>> {
    if (retiredBetaSessionId) {
      const beta = contentRegistry.get("beta");
      if (!beta || beta.sessionId === retiredBetaSessionId) {
        await betaReplacement;
      }
    }
    const targets = registeredTargets(["alpha", "beta"]);
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
    retainedMulticast = multicast.value;
    await reporter?.barrier("multicast-snapshot-bound");
    return { identities: await retainedMulticast.identity() };
  }

  function registerContent(
    runId: string,
    content: ContentIdentity | undefined,
    sender: chrome.runtime.MessageSender,
  ): void {
    if (
      !content ||
      sender.tab?.id === undefined ||
      sender.frameId === undefined
    )
      return;
    contentRegistry.set(content.label, {
      ...content,
      runId,
      tabId: sender.tab.id,
      frameId: sender.frameId,
      documentId: sender.documentId,
      senderUrl: normalizedSenderUrl(sender)!,
    });
    if (
      content.label === "beta" &&
      content.sessionId !== retiredBetaSessionId
    ) {
      resolveBetaReplacement?.();
      resolveBetaReplacement = undefined;
      void reporter?.barrier("beta-replacement-registered");
    }
  }

  function registeredTargets(labels?: readonly string[]) {
    return [...contentRegistry.values()]
      .filter((fact) => !labels || labels.includes(fact.label))
      .map((fact) =>
        fact.documentId
          ? chromeTarget.contentDocument({
              tabId: fact.tabId,
              documentId: fact.documentId,
            })
          : chromeTarget.contentFrame({
              tabId: fact.tabId,
              frameId: fact.frameId,
            }),
      );
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
  | { readonly kind: "offscreen-diagnostic"; readonly event: unknown };

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

function sanitizeBoundaryRunId(value: unknown): string {
  return isFixtureRunId(value) ? sanitizeFixtureText(value) : "unknown";
}
