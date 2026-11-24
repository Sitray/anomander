// @vitest-environment jsdom
import type { ChatAction, ChatMemory, ChatRequest } from '@anomander/protocol';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryScreen } from '../src/memory/MemoryScreen.tsx';
import type { LocalChannel } from '../src/shell.ts';
import { strings } from '../src/strings.ts';
import { FakeWebSocket } from './fake-web-socket.ts';
import { CHANNEL, replyTo } from './fixtures.ts';

// DK-18: the window's "Memoria", against a WebSocket driven by hand.
const { memory: text } = strings;
const NAME: ChatMemory = { id: 3, text: 'Se llama Eric', mode: 'declared' };
const GUESS: ChatMemory = { id: 9, text: 'Suele cenar fuera los viernes', mode: 'inferred' };
const LOOK: ChatAction = {
  id: 11,
  what: 'screen',
  door: 'app',
  task: '¿Qué pone en este correo?',
  outcome: 'answer',
  at: '2026-11-23T09:00:00.000Z',
};
const SEARCH: ChatAction = {
  id: 10,
  what: 'connect',
  door: 'telegram',
  task: 'Busca vuelos a Lisboa',
  outcome: 'stopped',
  at: '2026-11-22T18:30:00.000Z',
};

beforeEach(() => {
  FakeWebSocket.reset();
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

let onClose: ReturnType<typeof vi.fn<() => void>>;
let onForgotten: ReturnType<typeof vi.fn<() => void>>;

const renderMemory = (channel: LocalChannel | null = CHANNEL) => {
  onClose = vi.fn<() => void>();
  onForgotten = vi.fn<() => void>();
  return render(<MemoryScreen channel={channel} onClose={onClose} onForgotten={onForgotten} />);
};

/** The request of `type` the window sent `nth` (from 1), once it did. */
const requestOf = async <T extends ChatRequest['type']>(
  socket: FakeWebSocket,
  type: T,
  nth = 1,
): Promise<ChatRequest & { type: T }> => {
  let found: ChatRequest | undefined;
  await waitFor(() => {
    found = socket.requests.filter((request) => request.type === type)[nth - 1];
    expect(found).toBeDefined();
  });
  return found as ChatRequest & { type: T };
};

/** A Memoria open, its lists answered with `memories` and `actions`. */
const shown = async (memories = [NAME, GUESS], actions = [LOOK, SEARCH], nth = 1) => {
  const socket = FakeWebSocket.last;
  const listed = await requestOf(socket, 'memories', nth);
  act(() => socket.receive({ type: 'memories', inReplyTo: listed.id, memories }));
  const done = await requestOf(socket, 'actions', nth);
  act(() => socket.receive({ type: 'actions', inReplyTo: done.id, actions }));
  await waitFor(() => expect(screen.queryByText(text.loading)).toBeNull());
  return socket;
};

const openMemory = async (memories?: ChatMemory[], actions?: ChatAction[]) => {
  renderMemory();
  act(() => FakeWebSocket.last.open());
  return shown(memories, actions);
};

const section = (name: string) => screen.getByRole('region', { name });
const known = () => section(text.known);
const done = () => section(text.done);
const items = (region: HTMLElement) =>
  within(region)
    .queryAllByRole('listitem')
    .map((item) => item.textContent);

describe('Memoria (DK-18)', () => {
  it('lists what I know, each marked "Me lo dijiste" or "Lo deduje", and what I did', async () => {
    await openMemory();

    expect(screen.getByRole('heading', { name: text.title })).toBeTruthy();
    expect(items(known())).toEqual([
      expect.stringContaining(NAME.text),
      expect.stringContaining(GUESS.text),
    ]);
    const [name, guess] = within(known()).getAllByRole('listitem');
    expect(within(name as HTMLElement).getByText(text.declared)).toBeTruthy();
    expect(within(guess as HTMLElement).getByText(text.inferred)).toBeTruthy();
    // When, what, the door, the words and how it ended; the latest first, as the daemon sends.
    const [look, search] = within(done()).getAllByRole('listitem') as HTMLElement[];
    for (const shownText of [
      text.when(LOOK.at),
      text.what.screen,
      LOOK.task,
      text.outcome('answer'),
    ]) {
      expect(within(look as HTMLElement).getByText(shownText)).toBeTruthy();
    }
    expect(within(look as HTMLElement).queryByText(text.viaTelegram)).toBeNull();
    expect(within(search as HTMLElement).getByText(text.viaTelegram)).toBeTruthy();
    expect(within(search as HTMLElement).getByText(text.outcome('stopped'))).toBeTruthy();
    // Each item can be forgotten, named by its words.
    expect(screen.getByRole('button', { name: text.forgetLabel(NAME.text) })).toBeTruthy();
    expect(screen.getByRole('button', { name: text.forgetLabel(LOOK.task) })).toBeTruthy();
  });

  it('says when there is nothing in either list', async () => {
    await openMemory([], []);

    expect(within(known()).getByText(text.knownNone)).toBeTruthy();
    expect(within(done()).getByText(text.doneNone)).toBeTruthy();
  });

  it('asks before forgetting a memory, sends nothing on no, then forgets it and reads both lists again', async () => {
    const socket = await openMemory();
    fireEvent.click(screen.getByRole('button', { name: text.forgetLabel(NAME.text) }));

    expect(screen.getByText(text.confirmMemory)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: text.keep }));
    expect(screen.queryByText(text.confirmMemory)).toBeNull();
    expect(socket.requests.map(({ type }) => type)).toEqual(['memories', 'actions']);

    fireEvent.click(screen.getByRole('button', { name: text.forgetLabel(NAME.text) }));
    fireEvent.click(screen.getByRole('button', { name: text.confirmYes }));
    const forget = await requestOf(socket, 'forget_memory');
    expect(forget).toEqual({ type: 'forget_memory', id: forget.id, memoryId: NAME.id });
    expect(screen.getByRole('button', { name: text.forgetting })).toBeTruthy();
    expect(onForgotten).not.toHaveBeenCalled();

    act(() => socket.receive({ type: 'done', inReplyTo: forget.id }));
    await shown([GUESS], [LOOK, SEARCH], 2);
    expect(items(known())).toEqual([expect.stringContaining(GUESS.text)]);
    expect(screen.queryByText(text.confirmMemory)).toBeNull();
    // The stored conversation went with it: the chat reads it again.
    expect(onForgotten).toHaveBeenCalledTimes(1);
  });

  it('forgets an action the same way, without touching the chat', async () => {
    const socket = await openMemory();
    fireEvent.click(screen.getByRole('button', { name: text.forgetLabel(LOOK.task) }));
    expect(screen.getByText(text.confirmAction)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: text.confirmYes }));
    const forget = await requestOf(socket, 'forget_action');
    expect(forget).toEqual({ type: 'forget_action', id: forget.id, actionId: LOOK.id });

    act(() => socket.receive({ type: 'done', inReplyTo: forget.id }));
    await shown([NAME, GUESS], [SEARCH], 2);
    expect(items(done())).toEqual([expect.stringContaining(SEARCH.task)]);
    expect(onForgotten).not.toHaveBeenCalled();
  });

  it('keeps the item and says so when it was not forgotten, or that it cannot know', async () => {
    const socket = await openMemory();
    fireEvent.click(screen.getByRole('button', { name: text.forgetLabel(NAME.text) }));
    fireEvent.click(screen.getByRole('button', { name: text.confirmYes }));
    const forget = await requestOf(socket, 'forget_memory');
    // The daemon's failure reply (S-22) when its database fails.
    act(() => socket.receive(replyTo(forget.id, { text: 'Algo ha fallado.' })));

    expect((await screen.findByRole('alert')).textContent).toBe(text.forgetFailed);
    expect(items(known())).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: text.forgetLabel(LOOK.task) }));
    fireEvent.click(screen.getByRole('button', { name: text.confirmYes }));
    await requestOf(socket, 'forget_action');
    act(() => socket.drop());
    // Closed while it reconnects; the window says it cannot know once it is back.
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    act(() => FakeWebSocket.last.open());
    await shown([NAME, GUESS], [LOOK, SEARCH], 1);
    expect((await screen.findByRole('alert')).textContent).toBe(text.forgetUnknown);
    expect(onForgotten).not.toHaveBeenCalled();
  });

  it('says when a list cannot be read, and reads it again on Reintentar', async () => {
    renderMemory();
    act(() => FakeWebSocket.last.open());
    const socket = FakeWebSocket.last;
    const listed = await requestOf(socket, 'memories');
    act(() => socket.receive(replyTo(listed.id, { text: 'Algo ha fallado.' })));
    const doneList = await requestOf(socket, 'actions');
    act(() => socket.receive({ type: 'actions', inReplyTo: doneList.id, actions: [LOOK] }));
    await waitFor(() => expect(screen.queryByText(text.loading)).toBeNull());

    expect(within(known()).getByText(text.failed)).toBeTruthy();
    expect(items(done())).toHaveLength(1);
    fireEvent.click(within(known()).getByRole('button', { name: text.retry }));
    const again = await requestOf(socket, 'memories', 2);
    act(() => socket.receive({ type: 'memories', inReplyTo: again.id, memories: [NAME] }));
    await waitFor(() => expect(items(known())).toEqual([expect.stringContaining(NAME.text)]));
    // Only the list that failed is read again.
    expect(socket.requests.filter(({ type }) => type === 'actions')).toHaveLength(1);
  });

  it('without a channel says ANOMANDER is not running, and asks nothing', () => {
    renderMemory(null);

    expect(screen.getByText(text.closed)).toBeTruthy();
    expect(screen.queryByRole('region', { name: text.known })).toBeNull();
    expect(FakeWebSocket.instances).toEqual([]);
  });

  it('while the connection is not open says it is connecting, without the lists', () => {
    renderMemory();

    expect(screen.getByText(text.connecting)).toBeTruthy();
    expect(screen.queryByRole('region', { name: text.known })).toBeNull();
  });

  it('closes on its button, and on Escape once no question is open', async () => {
    await openMemory();
    fireEvent.click(screen.getByRole('button', { name: text.forgetLabel(NAME.text) }));
    fireEvent.keyDown(screen.getByText(text.confirmMemory), { key: 'Escape' });
    expect(screen.queryByText(text.confirmMemory)).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByRole('heading', { name: text.title }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: text.close }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
