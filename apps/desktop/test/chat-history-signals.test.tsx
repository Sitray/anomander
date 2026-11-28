// @vitest-environment jsdom
import type { ChatStoredMessage } from '@anomander/protocol';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatScreen } from '../src/chat/ChatScreen.tsx';
import { FakeWebSocket } from './fake-web-socket.ts';
import { CHANNEL, RUNNING } from './fixtures.ts';

// B56: each sign that the stored conversation may have changed asks for it once, and a change
// made while a request was under way is asked for again once it comes.
const stored = (id: number, text: string): ChatStoredMessage => ({
  id,
  text,
  from: 'principal',
  door: 'app',
  buttons: [],
  channelRef: null,
  at: '2026-11-20T10:00:00.000Z',
});
const BEFORE = [stored(1, 'uno'), stored(2, 'dos'), stored(3, 'olvidar esto')];
const AFTER = [stored(1, 'uno'), stored(2, 'dos')];

let visibility: DocumentVisibilityState = 'visible';
beforeEach(() => {
  FakeWebSocket.reset();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, 'visibilityState');
});

const shownTexts = () =>
  within(screen.getByRole('log'))
    .getAllByRole('listitem')
    .map((i) => i.querySelector('.message-text')?.textContent);
const asks = (s: FakeWebSocket) => s.requests.filter((r) => r.type === 'history');
const visibilityTo = (state: DocumentVisibilityState) => {
  visibility = state;
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
};
const answer = (s: FakeWebSocket, n: number, messages: ChatStoredMessage[]) =>
  act(() => s.receive({ type: 'history', inReplyTo: asks(s)[n]?.id ?? '', messages }));

const setup = async () => {
  let shell: () => void = () => {};
  let changed: () => void = () => {};
  FakeWebSocket.history = null;
  render(
    <ChatScreen
      daemon={RUNNING}
      channel={CHANNEL}
      subscribeShown={(f) => {
        shell = f;
        return () => {};
      }}
      subscribeStoredChanged={(f) => {
        changed = f;
        return () => {};
      }}
    />,
  );
  const socket = FakeWebSocket.last;
  act(() => socket.open());
  await waitFor(() => expect(asks(socket)).toHaveLength(1));
  answer(socket, 0, BEFORE);
  await waitFor(() => expect(shownTexts()).toEqual(['uno', 'dos', 'olvidar esto']));
  return { socket, shell: () => act(() => shell()), changed: () => act(() => changed()) };
};

describe('the signs that the stored conversation changed (B56)', () => {
  it('a forget in Memoria while a history request is under way still ends with the erased turn gone', async () => {
    const { socket, changed } = await setup();
    changed();
    await waitFor(() => expect(asks(socket)).toHaveLength(2));
    changed(); // the forget lands while #2 is in flight
    answer(socket, 1, BEFORE); // #2 was read before the forget
    await waitFor(() => expect(asks(socket)).toHaveLength(3));
    answer(socket, 2, AFTER);
    await waitFor(() => expect(shownTexts()).toEqual(['uno', 'dos']));
  });

  it('a forget in Memoria within 1 s of the last request still asks again', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(5_000_000);
    try {
      const { socket, changed } = await setup();
      changed();
      await waitFor(() => expect(asks(socket)).toHaveLength(2));
      answer(socket, 1, BEFORE);
      await act(async () => {});
      now.mockReturnValue(5_000_100);
      changed();
      await waitFor(() => expect(asks(socket)).toHaveLength(3));
      answer(socket, 2, AFTER);
      await waitFor(() => expect(shownTexts()).toEqual(['uno', 'dos']));
    } finally {
      now.mockRestore();
    }
  });

  it('hidden then shown within 1 s of the last answer reloads', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(7_000_000);
    try {
      const { socket } = await setup();
      now.mockReturnValue(7_000_200);
      visibilityTo('hidden');
      visibilityTo('visible');
      await waitFor(() => expect(asks(socket)).toHaveLength(2));
      answer(socket, 1, AFTER);
      await waitFor(() => expect(shownTexts()).toEqual(['uno', 'dos']));
    } finally {
      now.mockRestore();
    }
  });

  it('one show signalled by hidden, the shell, then visible asks once', async () => {
    const { socket, shell } = await setup();
    visibilityTo('hidden');
    shell();
    visibilityTo('visible');
    await act(async () => {});
    expect(asks(socket)).toHaveLength(2);
    answer(socket, 1, BEFORE);
    await act(async () => {});
    shell();
    await act(async () => {});
    expect(asks(socket)).toHaveLength(2);
  });

  it('hidden and shown again while a history request is still under way asks again once it comes', async () => {
    const { socket } = await setup();
    visibilityTo('hidden');
    visibilityTo('visible');
    await waitFor(() => expect(asks(socket)).toHaveLength(2));
    // #2 still in flight: window hidden, a forget made in Telegram, window shown again
    visibilityTo('hidden');
    visibilityTo('visible');
    await act(async () => {});
    answer(socket, 1, BEFORE); // read before the forget
    await act(async () => {});
    await act(async () => {});
    const n = asks(socket).length;
    if (n === 3) answer(socket, 2, AFTER);
    await act(async () => {});
    expect({ asks: n, shown: shownTexts() }).toEqual({ asks: 3, shown: ['uno', 'dos'] });
  });
});
