import { chromeTarget, usingContentScript } from "@nexus-js/chrome";
import { connectNexusStore, type RemoteStore } from "@nexus-js/core/state";
import { defineContentScript } from "wxt/utils/define-content-script";
import {
  DocumentToolToken,
  DocumentRelayToken,
  DocumentRouteToken,
  WorkspaceToken,
  type WorkspaceService,
} from "../shared/contracts";
import { isScenarioCommand, scenarioCommands } from "../shared/scenario";
import {
  configureFixtureLogger,
  createReporter,
  fixtureErrorCode,
  fixtureIdentity,
  hasStateClientFlag,
  sendRunInit,
} from "../shared/runtime";
import { parseBridgeCommand } from "../../protocol";
import {
  workspaceStateDefinition,
  type WorkspaceState,
  type WorkspaceStateActions,
} from "../shared/workspace-state";

export default defineContentScript({
  matches: ["http://127.0.0.1:4173/*", "http://127.0.0.1:4174/*"],
  allFrames: true,
  world: "ISOLATED",
  runAt: "document_start",
  main() {
    const searchParams = new URLSearchParams(location.search);
    const label = searchParams.get("frame") ?? "main";
    const maybeIdentity = fixtureIdentity(`content:${label}`);
    if (!maybeIdentity) return;
    const identity = maybeIdentity;
    configureFixtureLogger(identity, identity.runId);
    let activeCommand:
      | { readonly command: string; readonly sequence: number }
      | undefined;
    const reporter = createReporter(identity, (event) => {
      if (!activeCommand || (event.kind !== "result" && event.kind !== "error"))
        return;
      window.dispatchEvent(
        new CustomEvent("nexus-e2e-result", {
          detail: {
            kind: event.kind,
            runId: identity.runId,
            command: activeCommand.command,
            sequence: activeCommand.sequence,
            participant: identity.participant,
            sessionId: identity.sessionId,
            value: event.value,
          },
        }),
      );
    });
    const autoInitiate = searchParams.get("auto-initiate") === "true";
    const nonce = crypto.randomUUID();
    const declaredFrameId = searchParams.get("declared-frame");
    const nexus = usingContentScript({
      app: {
        fixture: true,
        sessionId: identity.sessionId,
        runId: identity.runId,
        label,
        ...(declaredFrameId === null
          ? {}
          : { declaredFrameId: Number(declaredFrameId) }),
      },
    });
    let retainedWorkspace:
      | Awaited<ReturnType<typeof nexus.create<WorkspaceService>>>
      | undefined;
    let retainedState:
      | RemoteStore<WorkspaceState, WorkspaceStateActions>
      | undefined;
    let unsubscribeState: (() => void) | undefined;
    let retainedStateUnsubscribe: (() => void) | undefined;
    let freshState:
      | RemoteStore<WorkspaceState, WorkspaceStateActions>
      | undefined;
    let retainedCapability: any;
    let acceptedRoutes = 0;
    let invocationCount = 0;
    let preReadyArmed = false;
    chrome.runtime.onConnect.addListener((port) => {
      if (port.sender?.tab?.id !== undefined) return;
      acceptedRoutes += 1;
      void reporter.barrier("content-route-accepted");
      if (!preReadyArmed) return;
      preReadyArmed = false;
      void reporter.barrier("pre-ready-port-open");
      port.disconnect();
    });
    let freshCapability: any;
    if (label === "main") {
      nexus.provide(DocumentRelayToken, {
        identity: async () => {
          invocationCount += 1;
          return { label, nonce, sessionId: identity.sessionId };
        },
        echo: async (value) => {
          invocationCount += 1;
          return `${label}:${value}`;
        },
      });
    }
    nexus.provide(
      DocumentToolToken,
      {
        identity: async () => {
          invocationCount += 1;
          return { label, nonce, sessionId: identity.sessionId };
        },
        echo: async (value) => {
          invocationCount += 1;
          return `${label}:${value}`;
        },
        fail: async () => Promise.reject(new Error("fixture remote failure")),
        hold: async () => {
          await reporter.barrier("pending-started");
          return new Promise<string>(() => {});
        },
        acceptCallback: async (callback) => callback(),
        createReference: async () =>
          nexus.ref({ label: async () => `${label}:${nonce}` }),
        useReference: async (reference) => reference.label(),
      },
      {
        policy: {
          canConnect: () => true,
        },
      },
    );
    nexus.provide(DocumentRouteToken, {
      facts: async () => ({
        accepted: acceptedRoutes,
        invocationCount,
        sessionId: identity.sessionId,
        nonce,
      }),
    });
    void nexus.ready().then(async () => {
      await sendRunInit(identity.runId, {
        label,
        sessionId: identity.sessionId,
        nonce,
      });
      await reporter.barrier("content-listener-ready without route");
      await reporter.barrier("provider-live");
      document.documentElement.dataset.nexusE2eReady = `${label}:${nonce}`;
      if (autoInitiate) await connectBackground();
      if (
        label === "main" &&
        hasStateClientFlag(window.location, identity.runId) &&
        window.top === window
      ) {
        retainedState = await connectNexusStore(
          nexus,
          workspaceStateDefinition,
        );
        let subscriptionSequence = 0;
        unsubscribeState = retainedState.subscribe(() => {
          const state = retainedState!;
          const status = state.getStatus();
          void reporter.result(
            JSON.stringify({
              type: "state-subscription",
              count: state.getState().count,
            }),
          );
          void reporter.result(
            JSON.stringify({
              result: `state-observed-v${status.type === "ready" ? status.version : "unknown"}`,
              participant: "main",
              sessionId: identity.sessionId,
              status,
              storeInstanceId:
                status.type === "ready" ? status.storeInstanceId : null,
              version: status.type === "ready" ? status.version : null,
              state: state.getState(),
              subscriptionSequence: ++subscriptionSequence,
              error: null,
            }),
          );
        });
        const status = retainedState.getStatus();
        await reporter.result(
          JSON.stringify({
            result: "state-client-ready",
            participant: "main",
            clientSessionId: identity.sessionId,
            sessionId: identity.sessionId,
            status,
            storeInstanceId:
              status.type === "ready" ? status.storeInstanceId : null,
            version: status.type === "ready" ? status.version : null,
            state: retainedState.getState(),
            subscriptionSequence: 0,
            error: null,
          }),
        );
      }
    });

    let lastSequence = 0;
    let commandQueue = Promise.resolve();
    window.addEventListener("nexus-e2e-command", (event) => {
      if (!(event instanceof CustomEvent) || event.target !== window) return;
      const command = parseBridgeCommand(
        event.detail,
        identity.runId,
        scenarioCommands,
      );
      if (
        !command ||
        command.sequence <= lastSequence ||
        !isScenarioCommand(command.command)
      )
        return;
      lastSequence = command.sequence;
      const scenarioCommand =
        command.command as (typeof scenarioCommands)[number];
      const sessionId = bridgeSessionId(event.detail);
      if (event.detail && "sessionId" in event.detail && !sessionId) return;
      commandQueue = commandQueue.then(async () => {
        activeCommand = {
          command: scenarioCommand,
          sequence: command.sequence,
        };
        try {
          await runCommand(scenarioCommand, sessionId);
        } finally {
          activeCommand = undefined;
        }
      });
    });

    async function connectBackground(): Promise<void> {
      await reporter.barrier("content-connect");
      const workspace = await nexus.create(WorkspaceToken);
      const summary = await workspace.summary();
      await reporter.result(
        `background:${summary.generation}:${summary.nonce}`,
      );
    }

    async function runCommand(
      command: (typeof scenarioCommands)[number],
      selectedSessionId?: string,
    ): Promise<void> {
      try {
        if (command === "state-content-action") {
          if (!retainedState) {
            await reporter.result(
              JSON.stringify({
                result: "state-action-result",
                participant: "main",
                sessionId: identity.sessionId,
                status: null,
                state: null,
                error: "E_STATE_CLIENT_ABSENT",
              }),
            );
            return;
          }
          const value = await retainedState.actions.increment();
          await reporter.result(
            JSON.stringify({
              result: "state-action-result",
              participant: "main",
              sessionId: identity.sessionId,
              status: retainedState.getStatus(),
              state: retainedState.getState(),
              value,
              error: null,
            }),
          );
          return;
        }
        if (command === "state-client-cleanup") {
          const state = retainedState;
          if (state) {
            unsubscribeState?.();
            state.destroy();
          }
          await reporter.result(
            JSON.stringify({
              result: "state-client-cleanup-result",
              participant: "main",
              sessionId: identity.sessionId,
              status: state ? state.getStatus() : null,
              state: null,
              error: state ? null : "E_STATE_CLIENT_ABSENT",
            }),
          );
          return;
        }
        if (command === "content-connect") return await connectBackground();
        if (command === "provider-first-select") {
          await connectBackground();
          const result = await chrome.runtime.sendMessage({
            kind: "fixture-command",
            runId: identity.runId,
            senderSessionId: identity.sessionId,
            command,
          });
          await reporter.result(JSON.stringify(result));
          return;
        }
        if (command === "background-summary") {
          const workspace = await nexus.create(WorkspaceToken, {
            callTimeout: 30_000,
          });
          await reporter.result(JSON.stringify(await workspace.summary()));
          return;
        }
        if (command === "background-increment") {
          const workspace = await nexus.create(WorkspaceToken);
          await reporter.result(String(await workspace.increment()));
          return;
        }
        if (command === "background-setting") {
          const workspace = await nexus.create(WorkspaceToken);
          await reporter.result(await workspace.setting());
          return;
        }
        if (command === "content-identity") {
          await reporter.result(
            JSON.stringify({ label, nonce, sessionId: identity.sessionId }),
          );
          return;
        }
        if (command === "document-route-facts") {
          await reporter.result(
            JSON.stringify({
              accepted: acceptedRoutes,
              invocationCount,
              sessionId: identity.sessionId,
              nonce,
            }),
          );
          return;
        }
        if (command === "content-hold") {
          const result = await chrome.runtime.sendMessage({
            kind: "fixture-command",
            runId: identity.runId,
            senderSessionId: identity.sessionId,
            command,
          });
          await reporter.result(JSON.stringify(result));
          return;
        }
        if (command === "pre-ready-port-close") {
          preReadyArmed = true;
          await reporter.barrier("pre-ready-armed");
          const result = await chrome.runtime.sendMessage({
            kind: "fixture-command",
            runId: identity.runId,
            senderSessionId: identity.sessionId,
            command,
          });
          await reporter.result(JSON.stringify(result));
          return;
        }
        if (command === "worker-pending") {
          const callTimeoutMs = 30_000;
          const workspace = await nexus.create(WorkspaceToken, {
            callTimeout: callTimeoutMs,
          });
          await reporter.barrier("worker-pending-call-started");
          const started = performance.now();
          try {
            await workspace.pending();
          } catch (error) {
            const settled = performance.now();
            await reporter.terminalResult(
              JSON.stringify({
                ...errorResult(error),
                callTimeoutMs,
                started,
                settled,
              }),
            );
          }
          return;
        }
        if (command === "worker-proxy-retain") {
          retainedWorkspace = await nexus.create(WorkspaceToken, {
            callTimeout: 30_000,
          });
          await reporter.result(
            JSON.stringify({ retained: await retainedWorkspace.summary() }),
          );
          return;
        }
        if (command === "worker-proxy-invoke") {
          if (!retainedWorkspace) {
            await reporter.result(
              JSON.stringify({ code: "E_FIXTURE_PROXY_ABSENT" }),
            );
            return;
          }
          try {
            await reporter.result(
              JSON.stringify({ old: await retainedWorkspace.summary() }),
            );
          } catch (error) {
            await reporter.terminalResult(JSON.stringify(errorResult(error)));
            nexus.safeRelease(retainedWorkspace);
            retainedWorkspace = undefined;
          }
          return;
        }
        if (command === "worker-proxy-fresh") {
          const created = await nexus.safeCreate(WorkspaceToken, {
            timeout: 5_000,
            callTimeout: 30_000,
          });
          if (created.isErr()) {
            await reporter.terminalResult(
              JSON.stringify(errorResult(created.error)),
            );
            return;
          }
          const workspace = created.value;
          const fresh = await workspace.summary();
          await reporter.terminalResult(JSON.stringify({ fresh }));
          return;
        }
        if (command === "worker-state-retain") {
          retainedState = await connectNexusStore(
            nexus,
            workspaceStateDefinition,
          );
          retainedStateUnsubscribe = retainedState.subscribe(() => {});
          await reporter.terminalResult(
            JSON.stringify({
              state: retainedState.getState(),
              status: retainedState.getStatus(),
            }),
          );
          return;
        }
        if (command === "worker-state-write") {
          if (!retainedState) throw new Error("worker State was not retained");
          const value = await retainedState.actions.increment();
          await reporter.result(
            JSON.stringify({ value, status: retainedState.getStatus() }),
          );
          return;
        }
        if (command === "worker-state-status") {
          await reporter.result(
            JSON.stringify(retainedState?.getStatus() ?? { type: "absent" }),
          );
          return;
        }
        if (command === "worker-state-fresh") {
          freshState = await connectNexusStore(nexus, workspaceStateDefinition);
          await reporter.terminalResult(
            JSON.stringify({
              state: freshState.getState(),
              status: freshState.getStatus(),
            }),
          );
          return;
        }
        if (command === "worker-state-cleanup") {
          const cleanupState = (
            state:
              | RemoteStore<WorkspaceState, WorkspaceStateActions>
              | undefined,
            unsubscribe: (() => void) | undefined,
          ) => {
            let error: string | null = null;
            try {
              unsubscribe?.();
            } catch (cause) {
              error = fixtureErrorCode(cause);
            }
            try {
              state?.destroy();
            } catch (cause) {
              error ??= fixtureErrorCode(cause);
            }
            let status: ReturnType<
              RemoteStore<WorkspaceState, WorkspaceStateActions>["getStatus"]
            > | null = null;
            try {
              status = state?.getStatus() ?? null;
            } catch (cause) {
              error ??= fixtureErrorCode(cause);
            }
            if (!state) error ??= "E_STATE_CLIENT_ABSENT";
            return { status, error };
          };
          const retained = cleanupState(
            retainedState,
            retainedStateUnsubscribe,
          );
          const fresh = cleanupState(freshState, undefined);
          retainedState = undefined;
          retainedStateUnsubscribe = undefined;
          freshState = undefined;
          await reporter.terminalResult(
            JSON.stringify({
              result: "worker-state-cleanup-result",
              retained,
              fresh,
            }),
          );
          return;
        }
        if (command === "worker-state-check") {
          const state = await connectNexusStore(
            nexus,
            workspaceStateDefinition,
          );
          await reporter.result(
            JSON.stringify({
              state: state.getState(),
              status: state.getStatus(),
            }),
          );
          return;
        }
        if (command === "worker-storage-write") {
          const workspace = await nexus.create(WorkspaceToken);
          const value = await workspace.setSetting("worker-durable");
          await reporter.result(JSON.stringify({ durable: value }));
          return;
        }
        if (command === "worker-storage-read") {
          const workspace = await nexus.create(WorkspaceToken);
          await reporter.result(
            JSON.stringify({ durable: await workspace.setting() }),
          );
          return;
        }
        if (command === "worker-capability-retain") {
          const workspace = await nexus.create(WorkspaceToken);
          const callback = await workspace.acceptCallback(
            async () => "callback-ok",
          );
          retainedCapability = await workspace.createCapability();
          await reporter.result(
            JSON.stringify({
              capability: await retainedCapability.ping(),
              callback,
            }),
          );
          return;
        }
        if (command === "worker-capability-invoke") {
          if (!retainedCapability)
            throw new Error("worker capability was not retained");
          try {
            await reporter.result(
              JSON.stringify({ capability: await retainedCapability.ping() }),
            );
          } catch (error) {
            await reporter.terminalResult(JSON.stringify(errorResult(error)));
          }
          return;
        }
        if (command === "worker-capability-fresh") {
          const workspace = await nexus.create(WorkspaceToken, {
            callTimeout: 30_000,
          });
          const callback = await workspace.acceptCallback(
            async () => "callback-fresh",
          );
          freshCapability = await workspace.createCapability();
          const value = await freshCapability.ping();
          await reporter.terminalResult(
            JSON.stringify({
              capability: value,
              callback,
              summary: await workspace.summary(),
            }),
          );
          return;
        }
        if (command === "worker-capability-fresh-release") {
          if (!freshCapability)
            throw new Error("fresh capability was not acquired");
          const released = nexus.safeRelease(freshCapability);
          await reporter.result(
            JSON.stringify(
              released.isErr()
                ? errorResult(released.error)
                : { released: true },
            ),
          );
          return;
        }
        if (command === "worker-capability-fresh-invoke") {
          if (!freshCapability)
            throw new Error("fresh capability was not acquired");
          try {
            await reporter.result(
              JSON.stringify({ capability: await freshCapability.ping() }),
            );
          } catch (error) {
            await reporter.terminalResult(JSON.stringify(errorResult(error)));
          }
          return;
        }
        if (command === "policy-deny" || command === "policy-allow") {
          const denyCalls = command === "policy-deny";
          const result = await chrome.runtime.sendMessage({
            kind: "policy",
            runId: identity.runId,
            senderSessionId: identity.sessionId,
            denyCalls,
          });
          if (!isControlResponse(result)) {
            await reporter.error(
              JSON.stringify({ code: "E_FIXTURE_PROTOCOL_RESPONSE_INVALID" }),
            );
            return;
          }
          await reporter.result(JSON.stringify(result));
          return;
        }
        if (command === "abort-acquire") {
          const controller = new AbortController();
          const pending = nexus.safeSelect(DocumentToolToken, {
            where: (context: any) =>
              context.app.label === "fixture-impossible-provider",
            wait: { signal: controller.signal },
          });
          await reporter.barrier("abort-started");
          controller.abort();
          const result = await pending;
          await reporter.result(
            JSON.stringify(
              result.isErr()
                ? { code: (result.error as Error & { code?: string }).code }
                : { code: "E_FIXTURE_UNEXPECTED_PROXY" },
            ),
          );
          return;
        }
        if (command === "security-counter") {
          const workspace = await nexus.create(WorkspaceToken);
          await reporter.result(JSON.stringify(await workspace.summary()));
          return;
        }
        if (isBackgroundCommand(command)) {
          const result = await chrome.runtime.sendMessage({
            kind: "fixture-command",
            runId: identity.runId,
            senderSessionId: identity.sessionId,
            command,
            ...(selectedSessionId === undefined
              ? {}
              : { sessionId: selectedSessionId }),
          });
          if (!isJsonSafeRecord(result)) {
            await reporter.error(
              JSON.stringify({ code: "E_FIXTURE_PROTOCOL_RESPONSE_INVALID" }),
            );
            return;
          }
          await reporter.result(JSON.stringify(result));
          return;
        }
        if (command === "identity-update") {
          await nexus.updateIdentity({
            app: {
              fixture: true,
              sessionId: identity.sessionId,
              runId: identity.runId,
              label: `${label}-updated`,
            },
          });
          await chrome.runtime.sendMessage({
            kind: "content-identity",
            runId: identity.runId,
            label: `${label}-updated`,
            sessionId: identity.sessionId,
            nonce,
          });
          await reporter.barrier("identity update");
          return;
        }
        await reporter.result(`unsupported:${command}`);
      } catch (error) {
        await reporter.error(JSON.stringify(errorResult(error)));
      }
    }
  },
});

function isBackgroundCommand(
  command: (typeof scenarioCommands)[number],
): boolean {
  return [
    "select-start",
    "provider-cardinality",
    "create-frame",
    "create-document",
    "create-concurrent",
    "multicast-create",
    "multicast-select",
    "reference-callback",
    "capability-retain",
    "capability-invoke",
    "capability-release",
    "identity-pinned",
    "multicast-bound-invoke",
    "multicast-rebind",
    "multicast-fail",
    "multicast-unavailable",
    "registry-facts",
    "identity-select-beta",
    "identity-constraint",
    "offscreen-create",
    "offscreen-close",
    "policy-deny",
    "policy-allow",
    "abort-acquire",
    "security-counter",
    "content-hold",
    "select-session",
    "worker-proxy-retain",
    "worker-proxy-invoke",
    "worker-proxy-fresh",
    "worker-state-retain",
    "worker-state-write",
    "worker-state-status",
    "worker-state-fresh",
    "worker-state-cleanup",
    "worker-storage-write",
    "worker-storage-read",
    "worker-capability-retain",
    "worker-capability-invoke",
    "worker-capability-fresh",
    "worker-capability-fresh-release",
    "worker-capability-fresh-invoke",
    "worker-state-check",
    "capability-proxy-invoke",
    "capability-reference-invoke",
    "pre-ready-port-close",
  ].includes(command);
}

function bridgeSessionId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("sessionId" in value))
    return undefined;
  const sessionId = value.sessionId;
  return typeof sessionId === "string" && /^[a-zA-Z0-9-]{36}$/.test(sessionId)
    ? sessionId
    : undefined;
}

function errorResult(error: unknown): Record<string, string> {
  return { code: fixtureErrorCode(error) };
}

function isJsonSafeRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.values(value).every((item) => isJsonSafeValue(item, new Set()))
  );
}

function isJsonSafeValue(value: unknown, seen: Set<object>): boolean {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value))
    return value.every((item) => isJsonSafeValue(item, seen));
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.values(value).every((item) => isJsonSafeValue(item, seen));
}

function isControlResponse(value: unknown): value is Record<string, unknown> {
  return isJsonSafeRecord(value) && typeof value.ok === "boolean";
}
