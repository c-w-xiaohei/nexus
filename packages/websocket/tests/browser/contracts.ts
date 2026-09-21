import { Token, type RefWrapper } from "@nexus-js/core";
import { createStoreToken } from "@nexus-js/core/state";

export interface EchoService {
  echo(value: string): Promise<string>;
  invokeCallback(
    value: string,
    callback: (value: string) => Promise<void>,
  ): Promise<void>;
}

export interface CounterRef {
  increment(): number;
  current(): number;
}

export interface RefService {
  openCounter(): Promise<RefWrapper<CounterRef>>;
}

export interface CounterStore {
  count: number;
  increment(by: number): number;
}

export const EchoToken = new Token<EchoService>("websocket:browser:echo");
export const RefToken = new Token<RefService>("websocket:browser:ref");
export const CounterStoreToken = createStoreToken<CounterStore>(
  "websocket:browser:state",
);
