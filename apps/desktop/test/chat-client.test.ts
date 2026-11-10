import { type ChatReply, LOCAL_CHANNEL_PROTOCOL } from '@anomander/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ChatClient,
  type ConnectionState,
  createChatClient,
  type Outcome,
} from '../src/chat/chat-client.ts';
import { FakeWebSocket } from './fake-web-socket.ts';

// DK-3 and DK-4: the window's side of the local channel, against a WebSocket driven by hand.
const TOKEN = 'window-test-token-0123456789abcdefghij';
const CHANNEL = { url: 'ws://127.0.0.1:4312', token: TOKEN };

const reply = (inReplyTo: string, overrides: Partial<ChatReply> = {}): ChatReply => ({
  type: 'reply',
  inReplyTo,
  channelRef: 'desktop:reply-1',
  text: 'Apuntado: 23,00 € en restaurantes.',
  buttons: [],
  sentAt: '2026-11-10T10:00:00.000Z',
  ...overrides,
});

let connections: ConnectionState[];
let outcomes: [string, Outcome][];
let client: ChatClient;

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.reset();
  connections = [];
  outcomes = [];
  client = createChatClient({
    createSocket: (url, protocols) => new FakeWebSocket(url, protocols),
    onConnection: (state) => connections.push(state),
    onOutcome: (id, outcome) => outcomes.push([id, outcome]),
  });
});

afterEach(() => {
  client.dispose();
  vi.useRealTimers();
});

const connected = (): FakeWebSocket => {
  client.setChannel(CHANNEL);
  FakeWebSocket.last.open();
  return FakeWebSocket.last;
};

const sent = (id: string | null): string => {
  if (id === null) throw new Error('the request was not sent');
  return id;
};

describe('connecting', () => {
  it('presents the token as the second subprotocol and never in the URL (DK-3 AC3)', () => {
    client.setChannel(CHANNEL);

    expect(FakeWebSocket.last.protocols).toEqual([LOCAL_CHANNEL_PROTOCOL, TOKEN]);
    expect(FakeWebSocket.last.url).toBe('ws://127.0.0.1:4312');
    expect(FakeWebSocket.last.url).not.toContain(TOKEN);
  });

  it('reports connecting, then open once the daemon accepts', () => {
    connected();

    expect(connections).toEqual(['connecting', 'open']);
  });

  it('does not connect again for the same channel in a new snapshot', () => {
    connected();
    client.setChannel({ ...CHANNEL });

    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('connects to the new channel when a restarted daemon has a new port', () => {
    const first = connected();
    client.setChannel({ url: 'ws://127.0.0.1:5999', token: TOKEN });

    expect(first.readyState).toBe(FakeWebSocket.CLOSED);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.last.url).toBe('ws://127.0.0.1:5999');
    expect(FakeWebSocket.last.protocols).toEqual([LOCAL_CHANNEL_PROTOCOL, TOKEN]);
  });

  it('goes offline and closes the socket when the channel is gone', () => {
    const socket = connected();
    client.setChannel(null);

    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    expect(connections.at(-1)).toBe('offline');
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('connects again after a lost connection, waiting longer each time', () => {
    connected().drop();
    expect(connections.at(-1)).toBe('connecting');
    expect(FakeWebSocket.instances).toHaveLength(1);

    vi.advanceTimersByTime(250);
    expect(FakeWebSocket.instances).toHaveLength(2);

    FakeWebSocket.last.drop();
    vi.advanceTimersByTime(250);
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(250);
    expect(FakeWebSocket.instances).toHaveLength(3);

    FakeWebSocket.last.open();
    expect(connections.at(-1)).toBe('open');
  });

  it('starts the wait over once a connection opened', () => {
    connected().drop();
    vi.advanceTimersByTime(250);
    FakeWebSocket.last.drop();
    vi.advanceTimersByTime(500);
    FakeWebSocket.last.open();
    FakeWebSocket.last.drop();

    vi.advanceTimersByTime(250);
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it('stops connecting once disposed', () => {
    connected().drop();
    client.dispose();

    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

describe('requests', () => {
  it('sends a text and reports its reply (DK-4 AC1)', () => {
    const socket = connected();
    const id = sent(client.send({ type: 'text', text: '23 € cena' }));

    expect(socket.requests).toEqual([{ type: 'text', id, text: '23 € cena' }]);
    expect(outcomes).toEqual([]);

    const answer = reply(id);
    socket.receive(answer);
    expect(outcomes).toEqual([[id, { type: 'reply', reply: answer }]]);
  });

  it('sends several images as one receipt (DK-4 AC2)', () => {
    const socket = connected();
    const images = [
      { mimeType: 'image/png', data: 'AAAA' },
      { mimeType: 'image/jpeg', data: 'BBBB' },
    ];
    const id = sent(client.send({ type: 'receipt', images, caption: null }));

    expect(socket.requests).toEqual([{ type: 'receipt', id, images, caption: null }]);
  });

  it("sends a button press with its reply's channelRef (DK-4 AC3)", () => {
    const socket = connected();
    const id = sent(client.send({ type: 'button', data: 'yes:7', channelRef: 'desktop:reply-1' }));

    expect(socket.requests).toEqual([
      { type: 'button', id, data: 'yes:7', channelRef: 'desktop:reply-1' },
    ]);
  });

  it('gives every request its own id, short enough for the daemon', () => {
    const socket = connected();
    client.send({ type: 'text', text: 'uno' });
    client.send({ type: 'text', text: 'dos' });

    const [first, second] = socket.requests.map((request) => request.id);
    expect(first).not.toBe(second);
    expect(first?.length).toBeLessThanOrEqual(64);
  });

  it('reports a request handled without a reply as done', () => {
    const socket = connected();
    const id = sent(client.send({ type: 'text', text: 'hola' }));
    socket.receive({ type: 'done', inReplyTo: id });

    expect(outcomes).toEqual([[id, { type: 'done' }]]);
  });

  it('reports a rejected request: nothing was done with it', () => {
    const socket = connected();
    const id = sent(client.send({ type: 'text', text: 'hola' }));
    socket.receive({ type: 'rejected', inReplyTo: id });

    expect(outcomes).toEqual([[id, { type: 'rejected' }]]);
  });

  it('reports a request in flight when the connection is lost as unknown, not as unsent', () => {
    const socket = connected();
    const id = sent(client.send({ type: 'text', text: '23 € cena' }));
    socket.drop();

    expect(outcomes).toEqual([[id, { type: 'unknown' }]]);
  });

  it('reports a request in flight when the channel changes as unknown', () => {
    connected();
    const id = sent(client.send({ type: 'text', text: '23 € cena' }));
    client.setChannel({ url: 'ws://127.0.0.1:5999', token: TOKEN });

    expect(outcomes).toEqual([[id, { type: 'unknown' }]]);
  });

  it('sends nothing, and says so, while the connection is not open', () => {
    client.setChannel(CHANNEL);

    expect(client.send({ type: 'text', text: 'hola' })).toBeNull();
    expect(FakeWebSocket.last.sent).toEqual([]);
    expect(outcomes).toEqual([]);
  });

  it('reports each request once: a late answer after a lost connection is ignored', () => {
    const socket = connected();
    const id = sent(client.send({ type: 'text', text: 'hola' }));
    socket.drop();
    socket.receive(reply(id));

    expect(outcomes).toEqual([[id, { type: 'unknown' }]]);
  });

  it('ignores frames that are not events, and answers to requests it did not send', () => {
    const socket = connected();
    const id = sent(client.send({ type: 'text', text: 'hola' }));
    socket.receiveRaw('not json');
    socket.receiveRaw(JSON.stringify({ type: 'surprise' }));
    socket.receiveRaw(new ArrayBuffer(4));
    socket.receive(reply('someone-else'));
    socket.receive({ type: 'rejected', inReplyTo: null });

    expect(outcomes).toEqual([]);
    socket.receive({ type: 'done', inReplyTo: id });
    expect(outcomes).toEqual([[id, { type: 'done' }]]);
  });
});
