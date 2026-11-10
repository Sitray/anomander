import type { ChatEvent, ChatRequest } from '@anomander/protocol';

// A `WebSocket` the tests (and the preview harness) drive by hand: nothing opens, answers or
// closes until told to, so every step of the chat client is observable.
export class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  /** Every socket created since the last `reset`, oldest first. */
  static instances: FakeWebSocket[] = [];

  static reset(): void {
    FakeWebSocket.instances = [];
  }

  /** The most recent socket; throws when none was created. */
  static get last(): FakeWebSocket {
    const socket = FakeWebSocket.instances.at(-1);
    if (socket === undefined) throw new Error('no WebSocket was created');
    return socket;
  }

  readonly url: string;
  readonly protocols: string[];
  readyState: number = FakeWebSocket.CONNECTING;
  /** The frames the client sent, as text. */
  sent: string[] = [];

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string | URL, protocols: string | string[] = []) {
    this.url = String(url);
    this.protocols = typeof protocols === 'string' ? [protocols] : [...protocols];
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error('the socket is not open');
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({} as CloseEvent);
  }

  /** The daemon accepted the connection. */
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({} as Event);
  }

  /** The daemon sent `event`. */
  receive(event: ChatEvent): void {
    this.receiveRaw(JSON.stringify(event));
  }

  receiveRaw(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  /** The connection was lost: the daemon stopped, or refused the token. */
  drop(): void {
    this.close();
  }

  /** The requests the client sent, parsed. */
  get requests(): ChatRequest[] {
    return this.sent.map((frame) => JSON.parse(frame) as ChatRequest);
  }

  /** The most recent request; throws when none was sent. */
  get lastRequest(): ChatRequest {
    const request = this.requests.at(-1);
    if (request === undefined) throw new Error('no request was sent');
    return request;
  }
}
