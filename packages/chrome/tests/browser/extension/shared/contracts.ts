import { Token, type RefWrapper } from "@nexus-js/core";

export interface FixtureAppMeta {
  readonly fixture: boolean;
  readonly sessionId: string;
  readonly runId?: string;
  readonly label?: string;
  readonly declaredFrameId?: number;
}

export interface WorkspaceService {
  summary(): Promise<WorkspaceSummary>;
  increment(): Promise<number>;
  setting(): Promise<string>;
  setSetting(value: string): Promise<string>;
  pending(): Promise<string>;
  worker(): Promise<WorkerFacts>;
  createCapability(): Promise<RefWrapper<WorkspaceCapability>>;
  acceptCallback(callback: () => Promise<string>): Promise<string>;
}

export interface WorkspaceCapability {
  ping(): Promise<string>;
}

export interface DocumentToolService {
  identity(): Promise<DocumentIdentity>;
  echo(value: string): Promise<string>;
  fail(): Promise<never>;
  hold(): Promise<string>;
  acceptCallback(callback: () => Promise<string>): Promise<string>;
  createReference(): Promise<RefWrapper<DocumentReference>>;
  useReference(reference: DocumentReference): Promise<string>;
}

export interface DocumentRelayService {
  identity(): Promise<DocumentIdentity>;
  echo(value: string): Promise<string>;
}

export interface DocumentRouteFacts {
  readonly accepted: number;
  readonly invocationCount: number;
  readonly sessionId: string;
  readonly nonce: string;
}

export interface DocumentRouteService {
  facts(): Promise<DocumentRouteFacts>;
}

export interface DocumentReference {
  label(): Promise<string>;
}

export interface SessionService {
  session(): Promise<string>;
}

export interface FixtureAdminService {
  setCallPolicy(denyCalls: boolean): Promise<PolicyState>;
  multicastBoundInvoke(): Promise<MulticastIdentitiesResult | FixtureError>;
  multicastFail(): Promise<MulticastFailureResult | FixtureError>;
  capabilityInvoke(): Promise<CapabilityResult | FixtureError>;
  capabilityProxyInvoke(): Promise<IdentityResult | FixtureError>;
  capabilityReferenceInvoke(): Promise<ReferenceResult | FixtureError>;
  capabilityRelease(): Promise<FixtureError>;
  identityPinned(): Promise<IdentityResult | FixtureError>;
  createOffscreen(): Promise<OffscreenRequestAcknowledgement>;
  closeOffscreen(): Promise<OffscreenRequestAcknowledgement>;
}

export interface RelayAdminService {
  registerCurrentDocument(): Promise<RelayAdminResponse>;
  refreshCurrentDocument(): Promise<RelayAdminResponse>;
  setPolicyMode(mode: "allow" | "deny"): Promise<RelayAdminResponse>;
}

export interface TargetedContentAdminService {
  providerFirstSelect(): Promise<IdentityResult | FixtureError>;
  contentHold(label: string): Promise<FixtureError>;
  identityConstraint(): Promise<FixtureError>;
}

export interface FixtureError extends Record<string, unknown> {
  readonly code: string;
}

export interface IdentityResult {
  readonly identity: DocumentIdentity;
}

export interface ReferenceResult {
  readonly reference: string;
}

export interface CapabilityResult extends IdentityResult, ReferenceResult {}

export interface MulticastIdentitiesResult {
  readonly identities: readonly MulticastIdentityResult[];
}

export type MulticastIdentityResult =
  | { readonly status: "fulfilled"; readonly value: DocumentIdentity }
  | {
      readonly status: "rejected";
      readonly reason: {
        readonly message: string;
        readonly code?: string;
        readonly name?: string;
      };
    };

export interface MulticastFailureResult {
  readonly results: readonly MulticastFailureEntry[];
}

export type MulticastFailureEntry =
  | { readonly status: "fulfilled"; readonly value: never }
  | {
      readonly status: "rejected";
      readonly reason: {
        readonly message: string;
        readonly code?: string;
        readonly name?: string;
      };
    };

export interface PolicyState {
  readonly denyCalls: boolean;
  readonly counter: number;
}

/** Acknowledge a lifecycle request without leaking its runtime-only result. */
export interface OffscreenRequestAcknowledgement {
  readonly requested: true;
}

export interface RelayAdminResponse {
  readonly result: RelayAdminResult;
}

export type RelayAdminResult =
  | {
      readonly ok: true;
      readonly type: "relay-register-result" | "relay-refresh-result";
      readonly relayTokenId: "nexus-e2e:document-relay";
      readonly backgroundSessionId: string;
    }
  | {
      readonly ok: true;
      readonly type: "relay-policy-mode-result";
      readonly mode: "allow" | "deny";
      readonly backgroundSessionId: string;
    }
  | {
      readonly ok: false;
      readonly type: "fixture-error";
      readonly code: string;
      readonly message: null;
    };

export interface WorkspaceSummary {
  readonly counter: number;
  readonly setting: string;
  readonly generation: number;
  readonly nonce: string;
  readonly sessionId: string;
}

export interface WorkerFacts {
  readonly generation: number;
  readonly nonce: string;
  readonly sessionId: string;
}

export interface DocumentIdentity {
  readonly label: string;
  readonly nonce: string;
  readonly sessionId: string;
}

export const WorkspaceToken = new Token<WorkspaceService>(
  "nexus-e2e:workspace",
);
export const DocumentToolToken = new Token<DocumentToolService>(
  "nexus-e2e:document-tool",
);
export const DocumentRelayToken = new Token<DocumentRelayService>(
  "nexus-e2e:document-relay",
);
export const DocumentRouteToken = new Token<DocumentRouteService>(
  "nexus-e2e:document-route",
);
export const SessionToken = new Token<SessionService>("nexus-e2e:session");
export const FixtureAdminToken = new Token<FixtureAdminService>(
  "nexus-e2e:fixture-admin",
);
export const RelayAdminToken = new Token<RelayAdminService>(
  "nexus-e2e:relay-admin",
);
export const TargetedContentAdminToken = new Token<TargetedContentAdminService>(
  "nexus-e2e:targeted-content-admin",
);
