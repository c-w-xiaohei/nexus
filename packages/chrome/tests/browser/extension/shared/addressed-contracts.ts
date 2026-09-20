import { Token } from "@nexus-js/core";

export interface AddressedPageService {
  identity(): Promise<{
    readonly endpointId: string;
    readonly sessionId: string;
  }>;
  echo(value: string): Promise<string>;
}

export interface AddressedPageMetrics {
  readonly nativeOnConnectCount: number;
  readonly nexusReadyOnConnectCount: number;
  readonly providerInvocationCount: number;
  readonly connectionIds: readonly string[];
}

export interface AddressedAdminService {
  callPage(endpointId: string): Promise<unknown>;
  callPageTwice(endpointId: string): Promise<readonly unknown[]>;
  callAbsentPage(endpointId: string): Promise<{ readonly code: string }>;
  retainPage(endpointId: string): Promise<unknown>;
  invokeRetainedPage(): Promise<unknown>;
}

export const AddressedPageToken = new Token<AddressedPageService>(
  "nexus-e2e:addressed-page",
);
export const AddressedAdminToken = new Token<AddressedAdminService>(
  "nexus-e2e:addressed-admin",
);
