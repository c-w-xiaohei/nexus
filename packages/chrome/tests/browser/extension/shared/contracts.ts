import { Token } from "@nexus-js/core";

export interface WorkspaceService {
  summary(): Promise<WorkspaceSummary>;
  increment(): Promise<number>;
  setting(): Promise<string>;
  setSetting(value: string): Promise<string>;
  pending(): Promise<string>;
  worker(): Promise<WorkerFacts>;
  createCapability(): Promise<WorkspaceCapability>;
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
  createReference(): Promise<DocumentReference>;
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

export interface ExportService {
  exportWorkspace(): Promise<string>;
}

export interface AuditService {
  audit(): Promise<string>;
}

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
export const ExportToken = new Token<ExportService>("nexus-e2e:export");
export const AuditToken = new Token<AuditService>("nexus-e2e:audit");
