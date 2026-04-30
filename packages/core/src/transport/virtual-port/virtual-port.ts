import type { IPort } from "../types/port";
import type { VirtualPortProtocol } from "./protocol";

type SendData = (payload: unknown, transfer?: Transferable[]) => void;
type SendClose = () => void;

class VirtualPort implements IPort {
  private readonly messageHandlers = new Set<(message: unknown) => void>();
  private readonly disconnectHandlers = new Set<() => void>();
  private closed = false;

  constructor(
    private readonly sendData: SendData,
    private readonly sendClose: SendClose,
  ) {}

  postMessage(message: unknown, transfer?: Transferable[]): void {
    if (this.closed) return;
    this.sendData(message, transfer);
  }

  onMessage(handler: (message: unknown) => void): void {
    this.messageHandlers.add(handler);
  }

  onDisconnect(handler: () => void): void {
    this.disconnectHandlers.add(handler);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.sendClose();
    this.notifyDisconnect();
  }

  receive(message: VirtualPortProtocol.DataMessage): void {
    if (this.closed) return;
    for (const handler of this.messageHandlers) handler(message.payload);
  }

  disconnect(): void {
    if (this.closed) return;
    this.closed = true;
    this.notifyDisconnect();
  }

  isClosed(): boolean {
    return this.closed;
  }

  private notifyDisconnect(): void {
    for (const handler of this.disconnectHandlers) handler();
  }
}

export const createVirtualPort = (
  sendData: SendData,
  sendClose: SendClose,
): IPort & {
  receive(message: VirtualPortProtocol.DataMessage): void;
  disconnect(): void;
  isClosed(): boolean;
} => new VirtualPort(sendData, sendClose);
