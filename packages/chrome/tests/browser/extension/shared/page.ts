import type { NexusInstance } from "@nexus-js/core";
import { connectNexusStore, type RemoteStore } from "@nexus-js/core/state";
import {
  DocumentRelayToken,
  DocumentToolToken,
  RelayAdminToken,
  SessionToken,
  WorkspaceToken,
  type DocumentRelayService,
} from "./contracts";
import {
  createReporter,
  fixtureErrorCode,
  fixtureIdentity,
  hasStateClientFlag,
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
  const resultOutput =
    document.querySelector<HTMLOutputElement>("[data-result]") ??
    document.body.appendChild(document.createElement("output"));
  resultOutput.dataset.result = "";
  const reporter = createReporter(identity);
  const sessionProvider = { session: async () => identity.sessionId };
  nexus.provide(SessionToken, sessionProvider);
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
    const workspace = await nexus.create(WorkspaceToken);
    if (capability === "popup") {
      // This lifecycle probe records which replacement worker the popup reached.
      await reporter.result(JSON.stringify(await workspace.summary()));
    }
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
    const relayAdmin = await nexus.create(RelayAdminToken);
    const registration = await relayAdmin.registerCurrentDocument();
    if (registration.result.ok) {
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
  let nextCommandSequence = 0;
  let commandQueue = Promise.resolve();
  document.addEventListener("click", (event) => {
    const element = event.target as HTMLElement | null;
    const command = element?.dataset.command;
    if (!command) return;
    let mode: "allow" | "deny" | undefined;
    if (command === "relay-policy-mode") {
      const requestedMode = element?.dataset.mode;
      if (requestedMode === "allow" || requestedMode === "deny") {
        mode = requestedMode;
      }
    }
    const context = { command, sequence: ++nextCommandSequence };
    commandQueue = commandQueue.then(async () => {
      const commandReporter = reporter.commandReporter((event) => {
        if (event.kind !== "result" && event.kind !== "error") return;
        resultOutput.value = JSON.stringify({
          kind: event.kind,
          runId: identity.runId,
          command: context.command,
          sequence: context.sequence,
          participant,
          sessionId: identity.sessionId,
          value: event.value,
        });
        resultOutput.dataset.sequence = String(context.sequence);
      });
      await runPageCommand(
        context.command,
        mode,
        nexus,
        commandReporter,
        status,
        identity.sessionId,
        identity.runId,
        sessionProvider,
        state,
        handles,
        capability,
        unsubscribe,
      );
    });
  });
}

async function runPageCommand(
  command: string,
  mode: "allow" | "deny" | undefined,
  nexus: NexusInstance<any>,
  reporter: {
    readonly result: (value: string) => Promise<void>;
    readonly error: (value: string) => Promise<void>;
  },
  status: Element | null,
  sessionId: string,
  runId: string,
  sessionProvider: { readonly session: () => Promise<string> },
  state: RemoteStore<WorkspaceState, WorkspaceStateActions> | undefined,
  handles: {
    relay: DocumentRelayService | undefined;
    freshRelay: DocumentRelayService | undefined;
  },
  capability: "popup" | "options" | "workspace" | "offscreen",
  unsubscribe: (() => void) | undefined,
): Promise<void> {
  try {
    if (command === "state-ui-action") {
      if (state) {
        const value = await state.actions.increment();
        status && (status.textContent = `state:${value}`);
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
      const relayAdmin = await nexus.create(RelayAdminToken);
      const response =
        command === "relay-register"
          ? await relayAdmin.registerCurrentDocument()
          : command === "relay-refresh"
            ? await relayAdmin.refreshCurrentDocument()
            : await relayAdmin.setPolicyMode(mode!);
      if (command === "relay-register" && response.result.ok) {
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
      const result = { session: await sessionProvider.session() };
      await reporter.result(
        JSON.stringify(
          state
            ? { ...result, status: state.getStatus(), state: state.getState() }
            : result,
        ),
      );
      return;
    }
  } catch (error) {
    await reporter.error(sanitizeFixtureError(error));
  }
}
