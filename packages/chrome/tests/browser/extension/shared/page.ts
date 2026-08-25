import type { NexusInstance } from "@nexus-js/core";
import { connectNexusStore, type RemoteStore } from "@nexus-js/core/state";
import {
  AuditToken,
  DocumentRelayToken,
  DocumentToolToken,
  ExportToken,
  SessionToken,
  WorkspaceToken,
  type DocumentRelayService,
} from "./contracts";
import {
  createReporter,
  fixtureErrorCode,
  fixtureIdentity,
  hasStateClientFlag,
  publishSession,
  sanitizeFixtureError,
  sendRunInit,
} from "./runtime";
import {
  workspaceStateDefinition,
  type WorkspaceState,
  type WorkspaceStateActions,
} from "./workspace-state";

export async function startPage(
  participant: string,
  nexus: NexusInstance<any>,
  capability: "popup" | "options" | "workspace" | "offscreen",
  sessionId: string,
): Promise<void> {
  const identity = fixtureIdentity(participant, window.location, sessionId);
  if (!identity) return;
  const reporter = createReporter(identity);
  nexus.provide(SessionToken, { session: async () => identity.sessionId });
  if (capability === "workspace") {
    nexus.provide(AuditToken, {
      audit: async () => `audit:${identity.sessionId}`,
    });
  }
  if (capability === "offscreen") {
    nexus.provide(ExportToken, { exportWorkspace: async () => "export:ready" });
  }
  if (capability === "offscreen") {
    void nexus.ready();
  } else {
    await nexus.ready();
  }
  if (capability === "offscreen") {
    await chrome.runtime.sendMessage({
      kind: "offscreen-init",
      runId: identity.runId,
      sessionId: identity.sessionId,
    });
  } else {
    await sendRunInit(
      identity.runId,
      undefined,
      capability === "popup" || capability === "workspace"
        ? { participant: capability, sessionId: identity.sessionId }
        : undefined,
    );
  }
  // Offscreen is selected by the background after its ready acknowledgement.
  if (capability !== "offscreen") {
    await nexus.create(WorkspaceToken);
  }
  const state =
    capability === "popup" ||
    (capability === "workspace" &&
      hasStateClientFlag(window.location, identity.runId))
      ? await connectNexusStore(nexus, workspaceStateDefinition)
      : undefined;
  const handles: {
    relay: DocumentRelayService | undefined;
    freshRelay: DocumentRelayService | undefined;
  } = {
    relay: undefined,
    freshRelay: undefined,
  };
  let unsubscribe: (() => void) | undefined;
  if (capability === "popup" || capability === "workspace") {
    const registration = await chrome.runtime.sendMessage({
      kind: "relay-register",
      runId: identity.runId,
      senderSessionId: identity.sessionId,
    });
    if (registration?.result?.ok) {
      const selected = await nexus.safeCreate(DocumentRelayToken);
      if (!selected.isErr()) handles.relay = selected.value;
    }
  }
  if (state) {
    const observe = async () => {
      const status = state.getStatus();
      await reporter.result(
        JSON.stringify({
          result: `state-observed-v${status.type === "ready" ? status.version : "unknown"}`,
          participant,
          sessionId: identity.sessionId,
          status,
          storeInstanceId:
            status.type === "ready" ? status.storeInstanceId : null,
          version: status.type === "ready" ? status.version : null,
          state: { count: state.getState().count },
          subscriptionSequence: ++subscriptionSequence,
          actionResult: null,
          error: null,
        }),
      );
    };
    let subscriptionSequence = 0;
    unsubscribe = state.subscribe((next) => {
      void reporter.result(
        JSON.stringify({ type: "state-subscription", count: next.count }),
      );
      void observe();
    });
    const initialStatus = state.getStatus();
    if (capability === "popup") {
      await reporter.result(
        JSON.stringify({
          type: "state-baseline",
          status: initialStatus,
          count: state.getState().count,
        }),
      );
    }
    await reporter.result(
      JSON.stringify({
        result: "state-client-ready",
        participant,
        clientSessionId: identity.sessionId,
        sessionId: identity.sessionId,
        status: initialStatus,
        storeInstanceId:
          initialStatus.type === "ready" ? initialStatus.storeInstanceId : null,
        version: initialStatus.type === "ready" ? initialStatus.version : null,
        state: { count: state.getState().count },
        subscriptionSequence,
        error: null,
      }),
    );
  }
  await reporter.barrier("provider-live");
  if (capability === "offscreen") {
    await chrome.runtime.sendMessage({
      kind: "ui-ready",
      runId: identity.runId,
      sessionId: identity.sessionId,
      participant,
    });
  }

  const status = document.querySelector("[data-status]");
  if (status) status.textContent = `${participant}:ready:${identity.sessionId}`;
  document.addEventListener("click", (event) => {
    const element = event.target as HTMLElement | null;
    const command = element?.dataset.command;
    if (!command) return;
    let mode: "allow" | "deny" | undefined;
    if (command === "relay-policy-mode") {
      const requestedMode = element?.dataset.mode;
      if (requestedMode !== "allow" && requestedMode !== "deny") {
        void reporter.result(
          JSON.stringify({
            result: "relay-policy-mode-result",
            participant,
            sessionId: identity.sessionId,
            status: "error",
            state: null,
            error: "E_FIXTURE_CONTROL_REJECTED",
          }),
        );
        return;
      }
      mode = requestedMode;
    }
    void runPageCommand(
      command,
      mode,
      nexus,
      reporter,
      status,
      identity.sessionId,
      identity.runId,
      state,
      handles,
      capability,
      unsubscribe,
    );
  });
}

async function runPageCommand(
  command: string,
  mode: "allow" | "deny" | undefined,
  nexus: NexusInstance<any>,
  reporter: ReturnType<typeof createReporter>,
  status: Element | null,
  sessionId: string,
  runId: string,
  state: RemoteStore<WorkspaceState, WorkspaceStateActions> | undefined,
  handles: {
    relay: DocumentRelayService | undefined;
    freshRelay: DocumentRelayService | undefined;
  },
  capability: "popup" | "options" | "workspace" | "offscreen",
  unsubscribe: (() => void) | undefined,
): Promise<void> {
  try {
    if (command === "state-ui-action" || command === "increment") {
      if (state) {
        const value = await state.actions.increment();
        status && (status.textContent = `state:${value}`);
        await reporter.result(JSON.stringify({ type: "state-action", value }));
        await reporter.result(
          JSON.stringify({
            result: "state-action-result",
            participant: capability,
            sessionId,
            status: state.getStatus(),
            state: state.getState(),
            error: null,
            value,
          }),
        );
        return;
      }
      await reporter.result(
        JSON.stringify({
          result: "state-action-result",
          participant: capability,
          sessionId,
          status: null,
          state: null,
          error: "E_STATE_CLIENT_ABSENT",
        }),
      );
      return;
    }
    if (command === "state-client-cleanup") {
      let destroyedStatus: ReturnType<
        NonNullable<typeof state>["getStatus"]
      > | null = null;
      if (state) {
        unsubscribe?.();
        state.destroy();
        destroyedStatus = state.getStatus();
      }
      const released = handles.relay
        ? nexus.safeRelease(handles.relay)
        : undefined;
      const releasedFresh = handles.freshRelay
        ? nexus.safeRelease(handles.freshRelay)
        : undefined;
      const releaseErrors = [
        released?.isErr() ? sanitizeFixtureError(released.error) : undefined,
        releasedFresh?.isErr()
          ? sanitizeFixtureError(releasedFresh.error)
          : undefined,
      ].filter((error): error is string => error !== undefined);
      const releaseError =
        releaseErrors.length > 1 ? releaseErrors : releaseErrors[0];
      handles.relay = undefined;
      handles.freshRelay = undefined;
      await reporter.result(
        JSON.stringify({
          result: "state-client-cleanup-result",
          participant: capability,
          sessionId,
          status: destroyedStatus,
          state: null,
          error: state
            ? (releaseError ?? null)
            : (releaseError ?? "E_STATE_CLIENT_ABSENT"),
        }),
      );
      return;
    }
    if (command === "relay-local-call") {
      const workspace = await nexus.create(WorkspaceToken);
      await reporter.result(
        JSON.stringify({
          result: "relay-local-result",
          participant: capability,
          sessionId,
          status: "ready",
          state: null,
          identity: await workspace.summary(),
          error: null,
        }),
      );
      return;
    }
    if (command === "relay-fresh-call") {
      if (handles.freshRelay) {
        const released = nexus.safeRelease(handles.freshRelay);
        handles.freshRelay = undefined;
        if (released.isErr()) {
          await reporter.result(
            JSON.stringify({
              result: "relay-fresh-result",
              participant: capability,
              sessionId,
              status: "error",
              state: null,
              error: sanitizeFixtureError(released.error),
            }),
          );
          return;
        }
      }
      const fresh = await nexus.safeCreate(DocumentRelayToken);
      if (fresh.isErr()) throw fresh.error;
      handles.freshRelay = fresh.value;
    }
    if (
      command === "relay-call" ||
      command === "relay-old-call" ||
      command === "relay-fresh-call"
    ) {
      const relay =
        command === "relay-fresh-call" ? handles.freshRelay : handles.relay;
      if (!relay) throw new Error("Relay proxy is not available");
      const result =
        command === "relay-call"
          ? "relay-call-result"
          : command === "relay-old-call"
            ? "relay-old-result"
            : "relay-fresh-result";
      let identityResult;
      try {
        identityResult = await relay.identity();
      } catch (error) {
        await reporter.error(
          JSON.stringify({
            result,
            participant: capability,
            sessionId,
            status: "error",
            state: null,
            identity: null,
            error: {
              code: fixtureErrorCode(error),
              message: sanitizeFixtureError(error),
            },
          }),
        );
        return;
      }
      await reporter.result(
        JSON.stringify({
          result,
          participant: capability,
          sessionId,
          status: "ready",
          state: null,
          identity: identityResult,
          error: null,
        }),
      );
      return;
    }
    if (
      command === "relay-register" ||
      command === "relay-policy-mode" ||
      command === "relay-refresh"
    ) {
      if (command === "relay-policy-mode" && mode === undefined) {
        await reporter.result(
          JSON.stringify({
            result: "relay-policy-mode-result",
            participant: capability,
            sessionId,
            status: "error",
            state: null,
            error: "E_FIXTURE_CONTROL_REJECTED",
          }),
        );
        return;
      }
      const message =
        command === "relay-register"
          ? ({
              kind: "relay-register",
              runId,
              senderSessionId: sessionId,
            } as const)
          : command === "relay-refresh"
            ? ({
                kind: "relay-refresh",
                runId,
                senderSessionId: sessionId,
              } as const)
            : {
                kind: "relay-policy-mode",
                runId,
                senderSessionId: sessionId,
                mode,
              };
      const response = await chrome.runtime.sendMessage(message);
      if (command === "relay-register" && response?.result?.ok) {
        if (handles.relay) {
          const released = nexus.safeRelease(handles.relay);
          handles.relay = undefined;
          if (released.isErr()) {
            await reporter.result(
              JSON.stringify({
                result: "relay-register-result",
                participant: capability,
                sessionId,
                status: "error",
                state: null,
                error: sanitizeFixtureError(released.error),
              }),
            );
            return;
          }
        }
        const selected = await nexus.safeCreate(DocumentRelayToken);
        if (selected.isErr()) {
          await reporter.result(
            JSON.stringify({
              result: "relay-register-result",
              participant: capability,
              sessionId,
              status: "error",
              state: null,
              error: sanitizeFixtureError(selected.error),
            }),
          );
          return;
        }
        handles.relay = selected.value;
      }
      await reporter.result(JSON.stringify(response));
      return;
    }
    if (command === "setting") {
      const workspace = await nexus.create(WorkspaceToken);
      const value = await workspace.setting();
      status && (status.textContent = value);
      await reporter.result(`setting:${value}`);
      return;
    }
    if (command === "set-setting") {
      const workspace = await nexus.create(WorkspaceToken);
      const value = await workspace.setSetting("options-updated");
      status && (status.textContent = value);
      await reporter.result(`setting:${value}`);
      return;
    }
    if (command === "session") {
      const result = await chrome.runtime.sendMessage({
        kind: "ui-session",
        runId,
        sessionId,
      });
      await reporter.result(
        JSON.stringify(
          state
            ? { ...result, status: state.getStatus(), state: state.getState() }
            : result,
        ),
      );
      return;
    }
    if (command === "export") {
      const exportService = await nexus.safeSelect(ExportToken);
      const value = exportService.isErr()
        ? "export:no-match"
        : await exportService.value.exportWorkspace();
      status && (status.textContent = value);
      await reporter.result(value);
      return;
    }
    if (command === "audit") {
      const audit = await chrome.runtime.sendMessage({
        kind: "ui-audit",
        runId,
        sessionId,
      });
      const value =
        typeof audit.audit === "string" ? audit.audit : JSON.stringify(audit);
      status && (status.textContent = value);
      await reporter.result(value);
    }
  } catch (error) {
    await reporter.error(sanitizeFixtureError(error));
  }
}

export { publishSession, SessionToken, DocumentToolToken };
