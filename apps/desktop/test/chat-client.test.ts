import {
  type ChatReply,
  type ChatStoredMessage,
  LOCAL_CHANNEL_PROTOCOL,
} from '@anomander/protocol';
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

  it('keeps the route of a reply only as DK-13 sends it: a look or a task, with its words', () => {
    const socket = connected();
    const routes = [
      { to: 'screen', task: '¿Qué ves?', extra: 'dropped' },
      { to: 'computer', task: 'Abre Chrome' },
      { to: 'connect', task: 'Apunta el hotel' },
      { to: 'computer', task: '  ' },
      { to: 'screen' },
      'screen',
    ];
    const ids = routes.map(() => sent(client.send({ type: 'text', text: 'mira' })));
    routes.forEach((route, index) => {
      socket.receive({ ...reply(ids[index] as string), route } as never);
    });

    const replies = outcomes.map(([, outcome]) =>
      outcome.type === 'reply' ? outcome.reply : null,
    );
    expect(replies.map((received) => received?.route)).toEqual([
      { to: 'screen', task: '¿Qué ves?' },
      { to: 'computer', task: 'Abre Chrome' },
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(replies.slice(2).some((received) => received === null || 'route' in received)).toBe(
      false,
    );
  });
  it('keeps the offer of a reply only as DK-11 AC13 sends it: the web search', () => {
    const socket = connected();
    const offers = ['web_search', 'notion', 42];
    const ids = offers.map(() => sent(client.send({ type: 'text', text: 'busca' })));
    offers.forEach((offer, index) => {
      socket.receive({ ...reply(ids[index] as string), offer } as never);
    });

    const replies = outcomes.map(([, outcome]) =>
      outcome.type === 'reply' ? outcome.reply : null,
    );
    expect(replies[0]?.offer).toBe('web_search');
    expect(replies.slice(1).some((received) => received === null || 'offer' in received)).toBe(
      false,
    );
  });
});

describe('the stored conversation (DK-16)', () => {
  const STORED: ChatStoredMessage[] = [
    {
      id: 7,
      from: 'principal',
      door: 'telegram',
      text: '23 € cena',
      buttons: [],
      channelRef: null,
      at: '2026-11-20T10:00:00.000Z',
    },
    {
      id: 8,
      from: 'anomander',
      door: 'telegram',
      text: 'Apuntado: 23,00 € en restaurantes.',
      buttons: [{ label: 'Deshacer', data: 'undo:1' }],
      channelRef: 'telegram:4242:99',
      at: '2026-11-20T10:00:01.000Z',
    },
  ];

  beforeEach(() => {
    // Every frame is answered by hand here.
    FakeWebSocket.history = null;
  });

  it('asks for it and resolves with its messages, oldest first, never as an outcome', async () => {
    const socket = connected();
    const asked = client.requestHistory();

    const request = socket.lastRequest;
    expect(request).toEqual({ type: 'history', id: request.id });
    socket.receive({ type: 'history', inReplyTo: request.id, messages: STORED });

    expect(await asked).toEqual(STORED);
    expect(outcomes).toEqual([]);
  });

  it('resolves with nothing when it was rejected, lost, or could not be asked', async () => {
    const socket = connected();
    const rejected = client.requestHistory();
    socket.receive({ type: 'rejected', inReplyTo: socket.lastRequest.id });
    const lost = client.requestHistory();
    socket.drop();

    expect(await rejected).toBeNull();
    expect(await lost).toBeNull();
    expect(await client.requestHistory()).toBeNull();
  });

  it('erases it: done once the daemon says so, and never as an outcome', async () => {
    const socket = connected();
    const cleared = client.clearHistory();

    const request = socket.lastRequest;
    expect(request).toEqual({ type: 'clear_history', id: request.id });
    socket.receive({ type: 'done', inReplyTo: request.id });

    expect(await cleared).toBe('done');
    expect(outcomes).toEqual([]);
  });

  it('says when it was not erased, and when it cannot know', async () => {
    const socket = connected();
    const rejected = client.clearHistory();
    socket.receive({ type: 'rejected', inReplyTo: socket.lastRequest.id });
    const lost = client.clearHistory();
    socket.drop();

    expect(await rejected).toBe('not_done');
    expect(await lost).toBe('unknown');
    expect(await client.clearHistory()).toBe('not_done');
  });

  it("takes the daemon's failure reply as nothing read and nothing erased, never as an outcome", async () => {
    // The daemon answers both with `processingFailed` when its database fails (DK-16).
    const socket = connected();
    const read = client.requestHistory();
    socket.receive(reply(socket.lastRequest.id, { text: 'No he podido procesarlo.' }));
    const erased = client.clearHistory();
    socket.receive(reply(socket.lastRequest.id, { text: 'No he podido procesarlo.' }));

    expect(await read).toBeNull();
    expect(await erased).toBe('not_done');
    expect(outcomes).toEqual([]);
  });
});

describe('the memories and the history (DK-18)', () => {
  const MEMORY = { id: 3, text: 'Se llama Eric', mode: 'declared' } as const;
  const ACTION = {
    id: 12,
    what: 'screen',
    door: 'app',
    task: '¿Qué pone aquí?',
    outcome: 'answer',
    at: '2026-11-24T10:00:00.000Z',
  } as const;

  it('asks for each list and resolves with what the window can show, never as an outcome', async () => {
    const socket = connected();
    const memories = client.requestMemories();
    const asked = socket.lastRequest;
    expect(asked).toEqual({ type: 'memories', id: asked.id });
    socket.receive({
      type: 'memories',
      inReplyTo: asked.id,
      // A memory of a mode the window does not know is not shown.
      memories: [MEMORY, { id: 4, text: 'x', mode: 'confirmed' } as never],
    });
    const actions = client.requestActions();
    const listed = socket.lastRequest;
    expect(listed).toEqual({ type: 'actions', id: listed.id });
    socket.receive({
      type: 'actions',
      inReplyTo: listed.id,
      actions: [ACTION, { ...ACTION, id: 'x' } as never],
    });

    expect(await memories).toEqual([MEMORY]);
    expect(await actions).toEqual([ACTION]);
    expect(outcomes).toEqual([]);
  });

  it("resolves with nothing when rejected, lost, not asked, or the daemon's failure reply", async () => {
    const socket = connected();
    const rejected = client.requestMemories();
    socket.receive({ type: 'rejected', inReplyTo: socket.lastRequest.id });
    const failed = client.requestActions();
    socket.receive(reply(socket.lastRequest.id, { text: 'No he podido procesarlo.' }));
    const lost = client.requestMemories();
    socket.drop();

    expect(await rejected).toBeNull();
    expect(await failed).toBeNull();
    expect(await lost).toBeNull();
    expect(await client.requestActions()).toBeNull();
    expect(outcomes).toEqual([]);
  });

  it('forgets one memory or one action by its id: done, not done, or unknown', async () => {
    const socket = connected();
    const memory = client.forgetMemory(3);
    expect(socket.lastRequest).toEqual({
      type: 'forget_memory',
      id: socket.lastRequest.id,
      memoryId: 3,
    });
    socket.receive({ type: 'done', inReplyTo: socket.lastRequest.id });
    const action = client.forgetAction(12);
    expect(socket.lastRequest).toEqual({
      type: 'forget_action',
      id: socket.lastRequest.id,
      actionId: 12,
    });
    socket.receive(reply(socket.lastRequest.id, { text: 'No he podido procesarlo.' }));
    const lost = client.forgetAction(12);
    socket.drop();

    expect(await memory).toBe('done');
    expect(await action).toBe('not_done');
    expect(await lost).toBe('unknown');
    expect(await client.forgetMemory(3)).toBe('not_done');
    expect(outcomes).toEqual([]);
  });
});
