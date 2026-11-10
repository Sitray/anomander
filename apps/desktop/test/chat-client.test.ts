import { type ChatReply, LOCAL_CHANNEL_PROTOCOL } from '@anomander/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ChatClientListener, createChatClient } from '../src/chat/chat-client.ts';
import { createFakeSocket, FakeWebSocket } from './fake-web-socket.ts';

const URL = 'ws://127.0.0.1:43210';
const TOKEN = 'launch-token-0123456789abcdefghijklmnop';

const listener = () => ({
  onConnection: vi.fn<ChatClientListener['onConnection']>(),
  onReply: vi.fn<ChatClientListener['onReply']>(),
  onDone: vi.fn<ChatClientListener['onDone']>(),
  onFailed: vi.fn<ChatClientListener['onFailed']>(),
});

let ids: number;
const start = (events = listener()) => {
  const client = createChatClient({
    url: URL,
    token: TOKEN,
    listener: events,
    createSocket: createFakeSocket,
    newId: () => `req-${++ids}`,
  });
  return { client, events, socket: FakeWebSocket.latest() };
};

const reply = (inReplyTo: string, overrides: Partial<ChatReply> = {}): ChatReply => ({
  type: 'reply',
  inReplyTo,
  channelRef: 'desktop:4b8f',
  text: '¡Hecho! He apuntado 23,00 € de la cena en restaurantes.',
  buttons: [],
  sentAt: '2026-11-10T20:00:00.000Z',
  ...overrides,
});

beforeEach(() => {
  ids = 0;
  FakeWebSocket.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('chat client (DK-3, DK-4)', () => {
  it('presents the token as the second subprotocol and never in the URL', () => {
    const { socket } = start();

    expect(socket.url).toBe(URL);
    expect(socket.url).not.toContain(TOKEN);
    expect(socket.protocols).toEqual([LOCAL_CHANNEL_PROTOCOL, TOKEN]);
  });

  it('reports the connection as connecting, then open', () => {
    const { events, socket } = start();
    expect(events.onConnection).toHaveBeenLastCalledWith('connecting');

    socket.open();

    expect(events.onConnection).toHaveBeenLastCalledWith('open');
  });

  it('sends a text with a fresh id and hands back its reply', () => {
    const { client, events, socket } = start();
    socket.open();

    const id = client.send({ type: 'text', text: '23 € cena' });

    expect(id).toBe('req-1');
    expect(socket.lastRequest()).toEqual({ type: 'text', id: 'req-1', text: '23 € cena' });
    socket.answer(reply('req-1'));
    expect(events.onReply).toHaveBeenCalledWith('req-1', reply('req-1'));
  });

  it('sends images as one receipt with their caption', () => {
    const { client, socket } = start();
    socket.open();
    const images = [
      { mimeType: 'image/jpeg', data: 'AAAA' },
      { mimeType: 'image/png', data: 'BBBB' },
    ];

    client.send({ type: 'receipt', images, caption: null });

    expect(socket.requests()).toEqual([{ type: 'receipt', id: 'req-1', images, caption: null }]);
  });

  it("sends a button press with the reply's channelRef", () => {
    const { client, socket } = start();
    socket.open();

    client.send({ type: 'button', data: 'confirm:yes', channelRef: 'desktop:4b8f' });

    expect(socket.lastRequest()).toEqual({
      type: 'button',
      id: 'req-1',
      data: 'confirm:yes',
      channelRef: 'desktop:4b8f',
    });
  });

  it('hands back a done for a request with no reply', () => {
    const { client, events, socket } = start();
    socket.open();
    const id = client.send({ type: 'text', text: 'hola' });

    socket.answer({ type: 'done', inReplyTo: id ?? '' });

    expect(events.onDone).toHaveBeenCalledWith('req-1');
    expect(events.onFailed).not.toHaveBeenCalled();
  });

  it('marks a rejected request as failed', () => {
    const { client, events, socket } = start();
    socket.open();
    client.send({ type: 'text', text: 'hola' });

    socket.answer({ type: 'rejected', inReplyTo: 'req-1' });

    expect(events.onFailed).toHaveBeenCalledWith('req-1', 'rejected');
  });

  it('fails every pending request when the socket closes mid-request', () => {
    const { client, events, socket } = start();
    socket.open();
    client.send({ type: 'text', text: 'uno' });
    client.send({ type: 'text', text: 'dos' });
    socket.answer(reply('req-1'));

    socket.drop();

    expect(events.onFailed).toHaveBeenCalledTimes(1);
    expect(events.onFailed).toHaveBeenCalledWith('req-2', 'disconnected');
    expect(events.onConnection).toHaveBeenLastCalledWith('connecting');
  });

  it('ignores answers to unknown requests and frames that are not events', () => {
    const { client, events, socket } = start();
    socket.open();
    client.send({ type: 'text', text: 'hola' });

    socket.answer(reply('someone-else'));
    socket.receive('not json');
    socket.receive(JSON.stringify({ type: 'surprise' }));
    socket.answer(reply('req-1'));
    socket.answer(reply('req-1'));

    expect(events.onReply).toHaveBeenCalledTimes(1);
  });

  it('refuses to send while the socket is not open', () => {
    const { client, socket } = start();

    expect(client.send({ type: 'text', text: 'hola' })).toBeNull();
    expect(socket.sent).toEqual([]);
  });

  it('reconnects to the same channel after the daemon drops it', () => {
    vi.useFakeTimers();
    const { socket } = start();
    socket.open();

    socket.drop();
    vi.advanceTimersByTime(1000);

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.latest().protocols).toEqual([LOCAL_CHANNEL_PROTOCOL, TOKEN]);
  });

  it('stops for good once closed, failing what was pending', () => {
    vi.useFakeTimers();
    const { client, events, socket } = start();
    socket.open();
    client.send({ type: 'text', text: 'hola' });

    client.close();
    socket.drop();
    vi.advanceTimersByTime(60_000);

    expect(socket.closedByClient).toBe(true);
    expect(events.onFailed).toHaveBeenCalledWith('req-1', 'disconnected');
    expect(events.onFailed).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(events.onConnection).toHaveBeenLastCalledWith('closed');
  });
});
