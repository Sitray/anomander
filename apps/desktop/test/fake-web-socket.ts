import type { ChatEvent, ChatRequest } from '@anomander/protocol';
import type { SocketLike } from '../src/chat/chat-client.ts';

/** A WebSocket the tests drive by hand: they open it, answer it and close it. */
export class FakeWebSocket implements SocketLike {
  static instances: FakeWebSocket[] = [];

  static reset(): void {
    FakeWebSocket.instances = [];
  }

  static latest(): FakeWebSocket {
    const socket = FakeWebSocket.instances.at(-1);
    if (socket === undefined) throw new Error('no socket was created');
    return socket;
  }

  readyState = 0;
  sent: string[] = [];
  closedByClient = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  readonly url: string;
  readonly protocols: string[];

  constructor(url: string, protocols: string[]) {
    this.url = url;
    this.protocols = protocols;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closedByClient = true;
    this.readyState = 3;
  }

  /** The requests the client sent, parsed. */
  requests(): ChatRequest[] {
    return this.sent.map((frame) => JSON.parse(frame) as ChatRequest);
  }

  lastRequest(): ChatRequest {
    const request = this.requests().at(-1);
    if (request === undefined) throw new Error('nothing was sent');
    return request;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  answer(event: ChatEvent): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }

  receive(data: unknown): void {
    this.onmessage?.({ data });
  }

  /** The other end went away, as when the daemon stops. */
  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

export const createFakeSocket = (url: string, protocols: string[]): FakeWebSocket =>
  new FakeWebSocket(url, protocols);
