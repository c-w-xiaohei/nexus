import {
  chromeTarget,
  type ChromeAdapterModel,
  usingContentScript,
} from "@nexus-js/chrome";
import type {
  Asyncified,
  ConnectionWhere,
  NexusInstance,
} from "@nexus-js/core";
import { connectNexusStore, type RemoteStore } from "@nexus-js/core/state";
import { defineContentScript } from "wxt/utils/define-content-script";
import {
  DocumentToolToken,
  DocumentRelayToken,
  DocumentRouteToken,
  FixtureAdminToken,
  type FixtureAppMeta,
  type DocumentRouteFacts,
  TargetedContentAdminToken,
  WorkspaceToken,
  type WorkspaceCapability,
  type WorkspaceService,
} from "../shared/contracts";
import { AddressedAdminToken } from "../shared/addressed-contracts";
import { AddressedPageToken } from "../shared/addressed-contracts";
import {
  isPreRouteCommand,
  isScenarioCommand,
  scenarioCommands,
  type ScenarioCommand,
} from "../shared/scenario";
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
  type WorkspaceStore,
} from "../shared/workspace-state";

type FixtureChromeModel = ChromeAdapterModel<FixtureAppMeta>;
type FixtureWhere = ConnectionWhere<FixtureChromeModel>;
type FixtureContext = Parameters<FixtureWhere>[0];
type FixtureNexus = NexusInstance<FixtureChromeModel>;
type ContentCommandReporter = Pick<
  ReturnType<typeof createReporter>,
  "barrier" | "result" | "error" | "terminalResult"
>;

type MainContentState = {
  client: RemoteStore<WorkspaceStore> | undefined;
  unsubscribe: (() => void) | undefined;
  subscriptionSequence: number;
};

type WorkerContentState = {
  retained: RemoteStore<WorkspaceStore> | undefined;
  retainedUnsubscribe: (() => void) | undefined;
  fresh: RemoteStore<WorkspaceStore> | undefined;
};

type WorkerProxyHandles = {
  retained: Asyncified<WorkspaceService> | undefined;
};

type WorkerCapabilityHandles = {
  retained: Asyncified<WorkspaceCapability> | undefined;
  fresh: Asyncified<WorkspaceCapability> | undefined;
};

type ContentRouteProbe = {
  readonly facts: () => DocumentRouteFacts;
  readonly recordInvocation: () => void;
  readonly armPreReadyClose: () => Promise<void>;
};

export default defineContentScript({
  matches: ["http://127.0.0.1:4173/*", "http://127.0.0.1:4174/*"],
  allFrames: true,
  world: "ISOLATED",
  runAt: "document_start",
  /** Bootstrap the content fixture, providers, State mirror, and command queue. */
  main() {
    const searchParams = new URLSearchParams(location.search);
    const label = searchParams.get("frame") ?? "main";
    const maybeIdentity = fixtureIdentity(`content:${label}`);
    if (!maybeIdentity) return;
    const identity = maybeIdentity;
    configureFixtureLogger(identity, identity.runId);
    const reporter = createReporter(identity);
    const autoInitiate = searchParams.get("auto-initiate") === "true";
    const nonce = crypto.randomUUID();
    const declaredFrameId = searchParams.get("declared-frame");
    const nexus = usingContentScript<FixtureAppMeta>({
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
    const mainState: MainContentState = {
      client: undefined,
      unsubscribe: undefined,
      subscriptionSequence: 0,
    };
    const workerState: WorkerContentState = {
      retained: undefined,
      retainedUnsubscribe: undefined,
      fresh: undefined,
    };
    const workerProxy: WorkerProxyHandles = { retained: undefined };
    const workerCapability: WorkerCapabilityHandles = {
      retained: undefined,
      fresh: undefined,
    };
    const routeProbe = createContentRouteProbe(
      reporter,
      identity.sessionId,
      nonce,
    );
    if (label === "main") {
      nexus.provide(DocumentRelayToken, {
        identity: async () => {
          routeProbe.recordInvocation();
          return { label, nonce, sessionId: identity.sessionId };
        },
        echo: async (value) => {
          routeProbe.recordInvocation();
          return `${label}:${value}`;
        },
      });
    }
    nexus.provide(
      DocumentToolToken,
      {
        identity: async () => {
          routeProbe.recordInvocation();
          return { label, nonce, sessionId: identity.sessionId };
        },
        echo: async (value) => {
          routeProbe.recordInvocation();
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
        ...routeProbe.facts(),
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
        mainState.client = await connectNexusStore(
          nexus,
          workspaceStateDefinition,
          { target: chromeTarget.background() },
        );
        const state = mainState.client;
        mainState.unsubscribe = state.subscribe(() => {
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
              subscriptionSequence: ++mainState.subscriptionSequence,
              error: null,
            }),
          );
        });
        const status = state.getStatus();
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
            state: state.getState(),
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
      commandQueue = commandQueue.then(async () => {
        const context = {
          command: scenarioCommand,
          sequence: command.sequence,
        };
        const commandReporter = {
          ...reporter,
          ...reporter.commandReporter((event) => {
            if (event.kind !== "result" && event.kind !== "error") return;
            const result = {
              kind: event.kind,
              runId: identity.runId,
              command: context.command,
              sequence: context.sequence,
              participant: identity.participant,
              sessionId: identity.sessionId,
              value: event.value,
            };
            if (window.top === window) {
              window.dispatchEvent(
                new CustomEvent("nexus-e2e-result", { detail: result }),
              );
              return;
            }
            const origin = parentOrigin(document.referrer);
            if (origin) window.parent.postMessage(result, origin);
          }),
        };
        await runCommand(scenarioCommand, commandReporter);
      });
    });

    /** Connect to the background workspace service and report its generation. */
    async function connectBackground(
      commandReporter: ContentCommandReporter = reporter,
    ): Promise<void> {
      await reporter.barrier("content-connect");
      const workspace = await nexus
        .connect({ target: chromeTarget.background() })
        .then((connection) => connection.get(WorkspaceToken));
      const summary = await workspace.summary();
      await commandReporter.result(
        `background:${summary.generation}:${summary.nonce}`,
      );
    }

    /** Serialize fixture command execution through the content-script queue. */
    async function runCommand(
      command: (typeof scenarioCommands)[number],
      reporter: ReturnType<typeof createReporter>,
    ): Promise<void> {
      try {
        if (
          await runContentStateCommand(
            command,
            mainState,
            reporter,
            identity.sessionId,
          )
        )
          return;
        if (
          await runContentBackgroundCommand(
            command,
            nexus,
            reporter,
            label,
            nonce,
            identity.runId,
            identity.sessionId,
            routeProbe,
            connectBackground,
          )
        )
          return;
        if (await runFixtureAdminCommand(command, nexus, reporter)) return;
        if (await runWorkerProxyCommand(command, nexus, workerProxy, reporter))
          return;
        if (await runWorkerStateCommand(command, nexus, workerState, reporter))
          return;
        if (await runWorkerStorageCommand(command, nexus, reporter)) return;
        if (
          await runWorkerCapabilityCommand(
            command,
            nexus,
            workerCapability,
            reporter,
          )
        )
          return;
        if (await runContentControlCommand(command, nexus, reporter)) return;
        const result = await runTargetedCommand(
          command,
          identity.runId,
          identity.sessionId,
        );
        if (result) {
          await reporter.result(JSON.stringify(result));
          return;
        }
        if (
          await runIdentityUpdateCommand(
            command,
            nexus,
            reporter,
            label,
            identity.runId,
            identity.sessionId,
            nonce,
          )
        )
          return;
        await reporter.result(`unsupported:${command}`);
      } catch (error) {
        await reporter.error(JSON.stringify(errorResult(error)));
      }
    }
  },
});

/** Observe native content routes and expose deterministic fixture facts. */
function createContentRouteProbe(
  reporter: ReturnType<typeof createReporter>,
  sessionId: string,
  nonce: string,
): ContentRouteProbe {
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

  return {
    /** Return current route counters and the identity captured by this probe. */
    facts: () => ({
      accepted: acceptedRoutes,
      invocationCount,
      sessionId,
      nonce,
    }),
    /** Count a service invocation observed through the route. */
    recordInvocation: () => {
      invocationCount += 1;
    },
    /** Arm the next accepted route for deterministic pre-ready closure testing. */
    armPreReadyClose: async () => {
      preReadyArmed = true;
      await reporter.barrier("pre-ready-armed");
    },
  };
}

/** Handle commands that exercise content-to-background connection behavior. */
async function runContentBackgroundCommand(
  command: ScenarioCommand,
  nexus: FixtureNexus,
  reporter: ContentCommandReporter,
  label: string,
  nonce: string,
  runId: string,
  sessionId: string,
  routeProbe: ContentRouteProbe,
  connectBackground: (reporter?: ContentCommandReporter) => Promise<void>,
): Promise<boolean> {
  if (command === "content-connect") {
    await connectBackground(reporter);
    return true;
  }
  if (command === "provider-first-select") {
    await connectBackground(reporter);
    const admin = await nexus
      .connect({ target: chromeTarget.background() })
      .then((connection) => connection.get(TargetedContentAdminToken));
    await reporter.result(JSON.stringify(await admin.providerFirstSelect()));
    return true;
  }
  if (command === "background-summary") {
    const workspace = (
      await nexus.connect({ target: chromeTarget.background() })
    ).get(WorkspaceToken, {
      callTimeout: 30_000,
    });
    await reporter.result(JSON.stringify(await workspace.summary()));
    return true;
  }
  if (command === "background-increment") {
    const workspace = await nexus
      .connect({ target: chromeTarget.background() })
      .then((connection) => connection.get(WorkspaceToken));
    await reporter.result(String(await workspace.increment()));
    return true;
  }
  if (command === "background-setting") {
    const workspace = await nexus
      .connect({ target: chromeTarget.background() })
      .then((connection) => connection.get(WorkspaceToken));
    await reporter.result(await workspace.setting());
    return true;
  }
  if (command === "content-identity") {
    await reporter.result(JSON.stringify({ label, nonce, sessionId }));
    return true;
  }
  if (command === "document-route-facts") {
    await reporter.result(JSON.stringify(routeProbe.facts()));
    return true;
  }
  if (command === "content-hold") {
    const admin = await nexus
      .connect({ target: chromeTarget.background() })
      .then((connection) => connection.get(TargetedContentAdminToken));
    await reporter.result(JSON.stringify(await admin.contentHold(label)));
    return true;
  }
  if (command !== "pre-ready-port-close") return false;
  await routeProbe.armPreReadyClose();
  // This must create the first native route while the content listener is
  // armed, before an admin Nexus proxy can establish one.
  const result = await chrome.runtime.sendMessage({
    kind: "fixture-command",
    runId,
    senderSessionId: sessionId,
    command,
  });
  await reporter.result(JSON.stringify(result));
  return true;
}

/** Forward capability, multicast, offscreen, and policy commands to the admin service. */
async function runFixtureAdminCommand(
  command: ScenarioCommand,
  nexus: FixtureNexus,
  reporter: ContentCommandReporter,
): Promise<boolean> {
  if (
    command !== "multicast-bound-invoke" &&
    command !== "multicast-fail" &&
    command !== "capability-invoke" &&
    command !== "capability-proxy-invoke" &&
    command !== "capability-reference-invoke" &&
    command !== "capability-release" &&
    command !== "identity-pinned" &&
    command !== "offscreen-create" &&
    command !== "offscreen-close" &&
    command !== "ui-popup-target" &&
    command !== "ui-options-target" &&
    command !== "ui-offscreen-target" &&
    command !== "ui-retained-call" &&
    command !== "identity-constraint" &&
    command !== "addressed-call-alpha" &&
    command !== "addressed-call-beta" &&
    command !== "addressed-call-alpha-twice" &&
    command !== "addressed-call-absent" &&
    command !== "addressed-direct-alpha" &&
    command !== "addressed-retain-alpha" &&
    command !== "addressed-invoke-retained"
  )
    return false;
  if (command === "identity-constraint") {
    const admin = await nexus
      .connect({ target: chromeTarget.background() })
      .then((connection) => connection.get(TargetedContentAdminToken));
    await reporter.result(JSON.stringify(await admin.identityConstraint()));
    return true;
  }
  if (command === "addressed-direct-alpha") {
    const connection = await nexus.connect({
      target: chromeTarget.extensionPage({ endpointId: "alpha" }),
    });
    await reporter.result(
      JSON.stringify(await connection.get(AddressedPageToken).identity()),
    );
    return true;
  }
  if (
    command === "addressed-call-alpha" ||
    command === "addressed-call-beta" ||
    command === "addressed-call-alpha-twice" ||
    command === "addressed-call-absent" ||
    command === "addressed-retain-alpha" ||
    command === "addressed-invoke-retained"
  ) {
    const admin = await nexus
      .connect({ target: chromeTarget.background() })
      .then((connection) => connection.get(AddressedAdminToken));
    const result =
      command === "addressed-call-alpha"
        ? await admin.callPage("alpha")
        : command === "addressed-call-beta"
          ? await admin.callPage("beta")
          : command === "addressed-call-alpha-twice"
            ? await admin.callPageTwice("alpha")
            : command === "addressed-call-absent"
              ? await admin.callAbsentPage("alpha")
              : command === "addressed-retain-alpha"
                ? await admin.retainPage("alpha")
                : await admin.invokeRetainedPage();
    await reporter.result(JSON.stringify(result));
    return true;
  }
  const admin = await nexus
    .connect({ target: chromeTarget.background() })
    .then((connection) => connection.get(FixtureAdminToken));
  const result =
    command === "multicast-bound-invoke"
      ? await admin.multicastBoundInvoke()
      : command === "multicast-fail"
        ? await admin.multicastFail()
        : command === "capability-invoke"
          ? await admin.capabilityInvoke()
          : command === "capability-proxy-invoke"
            ? await admin.capabilityProxyInvoke()
            : command === "capability-reference-invoke"
              ? await admin.capabilityReferenceInvoke()
              : command === "capability-release"
                ? await admin.capabilityRelease()
                : command === "identity-pinned"
                  ? await admin.identityPinned()
                  : command === "offscreen-create"
                    ? await admin.createOffscreen()
                    : command === "offscreen-close"
                      ? await admin.closeOffscreen()
                      : command === "ui-popup-target"
                        ? await admin.popupTargetCall()
                        : command === "ui-options-target"
                          ? await admin.optionsTargetCall()
                          : command === "ui-offscreen-target"
                            ? await admin.offscreenTargetCall()
                            : await admin.retainedUiCall();
  await reporter.result(JSON.stringify(result));
  return true;
}

/** Exercise durable storage through the background workspace service. */
async function runWorkerStorageCommand(
  command: ScenarioCommand,
  nexus: FixtureNexus,
  reporter: ContentCommandReporter,
): Promise<boolean> {
  if (command === "worker-storage-write") {
    const workspace = await nexus
      .connect({ target: chromeTarget.background() })
      .then((connection) => connection.get(WorkspaceToken));
    await reporter.result(
      JSON.stringify({ durable: await workspace.setSetting("worker-durable") }),
    );
    return true;
  }
  if (command !== "worker-storage-read") return false;
  const workspace = await nexus
    .connect({ target: chromeTarget.background() })
    .then((connection) => connection.get(WorkspaceToken));
  await reporter.result(JSON.stringify({ durable: await workspace.setting() }));
  return true;
}

/** Exercise call policy and cancellation behavior from the content context. */
async function runContentControlCommand(
  command: ScenarioCommand,
  nexus: FixtureNexus,
  reporter: ContentCommandReporter,
): Promise<boolean> {
  if (command === "policy-deny" || command === "policy-allow") {
    const admin = await nexus
      .connect({ target: chromeTarget.background() })
      .then((connection) => connection.get(FixtureAdminToken));
    await reporter.result(
      JSON.stringify(await admin.setCallPolicy(command === "policy-deny")),
    );
    return true;
  }
  if (command === "abort-acquire") {
    const controller = new AbortController();
    const pending = nexus
      .safeConnect({
        target: chromeTarget.background(),
        signal: controller.signal,
      })
      .then((result) =>
        result.andThen((connection) => connection.safeGet(DocumentToolToken)),
      );
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
    return true;
  }
  if (command !== "security-counter") return false;
  const workspace = await nexus
    .connect({ target: chromeTarget.background() })
    .then((connection) => connection.get(WorkspaceToken));
  await reporter.result(JSON.stringify(await workspace.summary()));
  return true;
}

/** Publish a content identity update and wait for its observation barrier. */
async function runIdentityUpdateCommand(
  command: ScenarioCommand,
  nexus: FixtureNexus,
  reporter: ContentCommandReporter,
  label: string,
  runId: string,
  sessionId: string,
  nonce: string,
): Promise<boolean> {
  if (command !== "identity-update") return false;
  await nexus.updateIdentity({
    app: { fixture: true, sessionId, runId, label: `${label}-updated` },
  });
  await chrome.runtime.sendMessage({
    kind: "content-identity",
    runId,
    label: `${label}-updated`,
    sessionId,
    nonce,
  });
  await reporter.barrier("identity update");
  return true;
}

/** Execute State commands owned by the main content-script mirror. */
async function runContentStateCommand(
  command: ScenarioCommand,
  state: MainContentState,
  reporter: ContentCommandReporter,
  sessionId: string,
): Promise<boolean> {
  if (command === "state-content-action") {
    if (!state.client) {
      await reporter.result(
        JSON.stringify({
          result: "state-action-result",
          participant: "main",
          sessionId,
          status: null,
          state: null,
          error: "E_STATE_CLIENT_ABSENT",
        }),
      );
      return true;
    }
    const value = await state.client.actions.increment();
    await reporter.result(
      JSON.stringify({
        result: "state-action-result",
        participant: "main",
        sessionId,
        status: state.client.getStatus(),
        state: state.client.getState(),
        value,
        error: null,
      }),
    );
    return true;
  }
  if (command !== "state-client-cleanup") return false;
  const client = state.client;
  if (client) {
    state.unsubscribe?.();
    client.destroy();
  }
  await reporter.result(
    JSON.stringify({
      result: "state-client-cleanup-result",
      participant: "main",
      sessionId,
      status: client ? client.getStatus() : null,
      state: null,
      error: client ? null : "E_STATE_CLIENT_ABSENT",
    }),
  );
  state.client = undefined;
  state.unsubscribe = undefined;
  return true;
}

/** Exercise retained and fresh worker service proxies across worker lifecycle events. */
async function runWorkerProxyCommand(
  command: ScenarioCommand,
  nexus: FixtureNexus,
  handles: WorkerProxyHandles,
  reporter: ContentCommandReporter,
): Promise<boolean> {
  if (command === "worker-pending") {
    const callTimeoutMs = 30_000;
    const workspace = (
      await nexus.connect({ target: chromeTarget.background() })
    ).get(WorkspaceToken, {
      callTimeout: callTimeoutMs,
    });
    await reporter.barrier("worker-pending-call-started");
    const started = performance.now();
    try {
      await workspace.pending();
    } catch (error) {
      await reporter.terminalResult(
        JSON.stringify({
          ...errorResult(error),
          callTimeoutMs,
          started,
          settled: performance.now(),
        }),
      );
    }
    return true;
  }
  if (command === "worker-proxy-retain") {
    const retained = (
      await nexus.connect({ target: chromeTarget.background() })
    ).get(WorkspaceToken, {
      callTimeout: 30_000,
    });
    handles.retained = retained;
    await reporter.result(
      JSON.stringify({ retained: await retained.summary() }),
    );
    return true;
  }
  if (command === "worker-proxy-invoke") {
    if (!handles.retained) {
      await reporter.result(JSON.stringify({ code: "E_FIXTURE_PROXY_ABSENT" }));
      return true;
    }
    try {
      await reporter.result(
        JSON.stringify({ old: await handles.retained.summary() }),
      );
    } catch (error) {
      await reporter.terminalResult(JSON.stringify(errorResult(error)));
      nexus.safeRelease(handles.retained);
      handles.retained = undefined;
    }
    return true;
  }
  if (command !== "worker-proxy-fresh") return false;
  const created = await nexus
    .safeConnect({
      target: chromeTarget.background(),
      timeout: 5_000,
    })
    .then((result) =>
      result.andThen((connection) =>
        connection.safeGet(WorkspaceToken, { callTimeout: 30_000 }),
      ),
    );
  if (created.isErr()) {
    await reporter.terminalResult(JSON.stringify(errorResult(created.error)));
    return true;
  }
  await reporter.terminalResult(
    JSON.stringify({ fresh: await created.value.summary() }),
  );
  return true;
}

/** Exercise retained, fresh, and cleaned-up worker State mirrors. */
async function runWorkerStateCommand(
  command: ScenarioCommand,
  nexus: FixtureNexus,
  state: WorkerContentState,
  reporter: ContentCommandReporter,
): Promise<boolean> {
  if (command === "worker-state-retain") {
    state.retained = await connectNexusStore(nexus, workspaceStateDefinition, {
      target: chromeTarget.background(),
    });
    state.retainedUnsubscribe = state.retained.subscribe(() => {});
    await reporter.terminalResult(
      JSON.stringify({
        state: state.retained.getState(),
        status: state.retained.getStatus(),
      }),
    );
    return true;
  }
  if (command === "worker-state-write") {
    if (!state.retained) throw new Error("worker State was not retained");
    const value = await state.retained.actions.increment();
    await reporter.result(
      JSON.stringify({ value, status: state.retained.getStatus() }),
    );
    return true;
  }
  if (command === "worker-state-status") {
    await reporter.result(
      JSON.stringify(state.retained?.getStatus() ?? { type: "absent" }),
    );
    return true;
  }
  if (command === "worker-state-fresh") {
    state.fresh = await connectNexusStore(nexus, workspaceStateDefinition, {
      target: chromeTarget.background(),
    });
    await reporter.terminalResult(
      JSON.stringify({
        state: state.fresh.getState(),
        status: state.fresh.getStatus(),
      }),
    );
    return true;
  }
  if (command !== "worker-state-cleanup") return false;
  const retained = cleanupState(state.retained, state.retainedUnsubscribe);
  const fresh = cleanupState(state.fresh, undefined);
  state.retained = undefined;
  state.retainedUnsubscribe = undefined;
  state.fresh = undefined;
  await reporter.terminalResult(
    JSON.stringify({ result: "worker-state-cleanup-result", retained, fresh }),
  );
  return true;
}

/** Release a worker State mirror and report cleanup failures and final status. */
function cleanupState(
  state: RemoteStore<WorkspaceStore> | undefined,
  unsubscribe: (() => void) | undefined,
) {
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
  let status: ReturnType<RemoteStore<WorkspaceStore>["getStatus"]> | null =
    null;
  try {
    status = state?.getStatus() ?? null;
  } catch (cause) {
    error ??= fixtureErrorCode(cause);
  }
  if (!state) error ??= "E_STATE_CLIENT_ABSENT";
  return { status, error };
}

/** Exercise retained remote capabilities and explicit capability release. */
async function runWorkerCapabilityCommand(
  command: ScenarioCommand,
  nexus: FixtureNexus,
  handles: WorkerCapabilityHandles,
  reporter: ContentCommandReporter,
): Promise<boolean> {
  if (command === "worker-capability-retain") {
    const workspace = await nexus
      .connect({ target: chromeTarget.background() })
      .then((connection) => connection.get(WorkspaceToken));
    const callback = await workspace.acceptCallback(async () => "callback-ok");
    handles.retained = await workspace.createCapability();
    await reporter.result(
      JSON.stringify({ capability: await handles.retained.ping(), callback }),
    );
    return true;
  }
  if (command === "worker-capability-invoke") {
    if (!handles.retained)
      throw new Error("worker capability was not retained");
    try {
      await reporter.result(
        JSON.stringify({ capability: await handles.retained.ping() }),
      );
    } catch (error) {
      await reporter.terminalResult(JSON.stringify(errorResult(error)));
    }
    return true;
  }
  if (command === "worker-capability-fresh") {
    const workspace = (
      await nexus.connect({ target: chromeTarget.background() })
    ).get(WorkspaceToken, {
      callTimeout: 30_000,
    });
    const callback = await workspace.acceptCallback(
      async () => "callback-fresh",
    );
    handles.fresh = await workspace.createCapability();
    await reporter.terminalResult(
      JSON.stringify({
        capability: await handles.fresh.ping(),
        callback,
        summary: await workspace.summary(),
      }),
    );
    return true;
  }
  if (command === "worker-capability-fresh-release") {
    if (!handles.fresh) throw new Error("fresh capability was not acquired");
    const released = nexus.safeRelease(handles.fresh);
    await reporter.result(
      JSON.stringify(
        released.isErr() ? errorResult(released.error) : { released: true },
      ),
    );
    return true;
  }
  if (command !== "worker-capability-fresh-invoke") return false;
  if (!handles.fresh) throw new Error("fresh capability was not acquired");
  try {
    await reporter.result(
      JSON.stringify({ capability: await handles.fresh.ping() }),
    );
  } catch (error) {
    await reporter.terminalResult(JSON.stringify(errorResult(error)));
  }
  return true;
}

/** Send pre-route commands through the background control bridge. */
async function runTargetedCommand(
  command: (typeof scenarioCommands)[number],
  runId: string,
  senderSessionId: string,
): Promise<Record<string, unknown> | undefined> {
  // These operations intentionally test routing before this content context
  // has a Nexus route; acquiring the admin proxy would create that route.
  /** Send one pre-route command through the extension background bridge. */
  const invoke = () =>
    chrome.runtime.sendMessage({
      kind: "fixture-command",
      runId,
      senderSessionId,
      command,
    });
  return isPreRouteCommand(command) ? invoke() : undefined;
}

/** Accept only the local fixture origins when forwarding results to a parent frame. */
function parentOrigin(referrer: string): string | undefined {
  try {
    const origin = new URL(referrer).origin;
    return origin === "http://127.0.0.1:4173" ||
      origin === "http://127.0.0.1:4174"
      ? origin
      : undefined;
  } catch {
    // Same-origin frames can omit referrer under browser privacy policy.
    return location.origin === "http://127.0.0.1:4173"
      ? location.origin
      : undefined;
  }
}

/** Normalize a content fixture failure to the stable error-code result shape. */
function errorResult(error: unknown): Record<string, string> {
  return { code: fixtureErrorCode(error) };
}
