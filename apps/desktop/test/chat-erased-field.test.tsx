// @vitest-environment jsdom
import { type ChatStoredMessage, strings as replies } from '@anomander/protocol';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatScreen } from '../src/chat/ChatScreen.tsx';
import { strings } from '../src/strings.ts';
import { FakeWebSocket } from './fake-web-socket.ts';
import { CHANNEL, RUNNING, replyTo } from './fixtures.ts';

// B56: a reply the daemon says erased the stored conversation (`erased`) shows the stored one
// again, whatever it answers; anything else in `erased`, or only the words of a forget answered to
// a text, keeps the chat as it is.
const stored = (id: number, text: string): ChatStoredMessage => ({
  id,
  text,
  from: 'principal',
  door: 'app',
  buttons: [],
  channelRef: null,
  at: '2026-11-20T10:00:00.000Z',
});
const BEFORE = [stored(1, 'uno'), stored(2, 'olvidar esto')];
beforeEach(() => {
  FakeWebSocket.reset();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const shownTexts = () =>
  within(screen.getByRole('log'))
    .getAllByRole('listitem')
    .map((i) => i.querySelector('.message-text')?.textContent);
const typed = async (text: string) => {
  FakeWebSocket.history = BEFORE;
  render(<ChatScreen daemon={RUNNING} channel={CHANNEL} />);
  const socket = FakeWebSocket.last;
  act(() => socket.open());
  await waitFor(() => expect(shownTexts()).toEqual(['uno', 'olvidar esto']));
  fireEvent.change(screen.getByLabelText(strings.chat.message), { target: { value: text } });
  fireEvent.keyDown(screen.getByLabelText(strings.chat.message), { key: 'Enter' });
  await waitFor(() => expect(socket.requests.some((r) => r.type === 'text')).toBe(true));
  const sent = socket.requests.filter((r) => r.type === 'text').at(-1) as { id: string };
  return { socket, id: sent.id };
};

describe('a reply that erased the stored conversation (B56)', () => {
  it('a typed answer the daemon says erased the conversation shows the stored one again', async () => {
    const { socket, id } = await typed('sí');
    FakeWebSocket.history = [stored(3, 'sí'), stored(4, 'Listo.')];
    act(() => socket.receive(replyTo(id, { text: 'Listo.', erased: 'conversation' })));
    await waitFor(() => expect(shownTexts()).toEqual(['sí', 'Listo.']));
  });
  it.each([true, 'memories', 'Conversation', null])(
    'erased: %s from the daemon never reloads',
    async (value) => {
      const { socket, id } = await typed('hola');
      FakeWebSocket.history = [stored(9, 'RELOADED')];
      act(() => socket.receive(replyTo(id, { text: replies.forgotten(), erased: value } as never)));
      await act(async () => {});
      expect(shownTexts()).toEqual(['uno', 'olvidar esto', 'hola', replies.forgotten()]);
    },
  );
  it('a typed answer with the words of a history erase and no field keeps the chat', async () => {
    const { socket, id } = await typed('borra');
    FakeWebSocket.history = [stored(9, 'RELOADED')];
    act(() => socket.receive(replyTo(id, { text: replies.historyForgotten() })));
    await act(async () => {});
    expect(shownTexts()).toEqual(['uno', 'olvidar esto', 'borra', replies.historyForgotten()]);
  });
});
