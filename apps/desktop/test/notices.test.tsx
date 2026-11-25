// @vitest-environment jsdom
import type { ChatNotice } from '@anomander/protocol';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.tsx';
import { type Snapshot, shell } from '../src/shell.ts';
import { strings } from '../src/strings.ts';
import { FakeWebSocket } from './fake-web-socket.ts';
import { NO_CONNECTIONS, runningSnapshot } from './fixtures.ts';

// DK-22 (B14): what ANOMANDER sends unasked reaches the window as a `notice`, shown in the chat
// and handed to the shell to notify. The whole window against a mocked shell, as
// `app.test.tsx`: never real Tauri.
vi.mock('../src/shell.ts', () => ({
  shell: {
    snapshot: vi.fn(),
    saveSetup: vi.fn(),
    connections: vi.fn(),
    saveConnection: vi.fn(),
    removeConnection: vi.fn(),
    importLedger: vi.fn(),
    subscriptions: vi.fn(),
    connectSubscription: vi.fn(),
    answerLogin: vi.fn(),
    disconnectSubscription: vi.fn(),
    onLoginStep: vi.fn(),
    startDaemon: vi.fn(),
    stopDaemon: vi.fn(),
    onSnapshot: vi.fn(),
    setThinking: vi.fn(),
    notifyReply: vi.fn(),
    captureScreen: vi.fn(),
    performAction: vi.fn(),
    reveal: vi.fn(),
    setTaskRunning: vi.fn(),
    onStopTask: vi.fn(),
    onChatShown: vi.fn(),
  },
}));

const mocked = vi.mocked(shell);

beforeEach(() => {
  FakeWebSocket.reset();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  mocked.onSnapshot.mockResolvedValue(() => {});
  mocked.setThinking.mockResolvedValue(undefined);
  mocked.notifyReply.mockResolvedValue(undefined);
  mocked.setTaskRunning.mockResolvedValue(undefined);
  mocked.onStopTask.mockResolvedValue(() => {});
  mocked.onChatShown.mockResolvedValue(() => {});
  mocked.onLoginStep.mockResolvedValue(() => {});
  mocked.connections.mockResolvedValue(NO_CONNECTIONS);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

const open = async (snapshot: Snapshot) => {
  mocked.snapshot.mockResolvedValue(snapshot);
  render(<App />);
  await waitFor(() =>
    expect(screen.getByRole('status').textContent).not.toBe(strings.status.loading),
  );
  await act(async () => {});
};

const REMINDER = 'Recordatorio: llamar a mamá.';
const notice = (overrides: Partial<ChatNotice> = {}): ChatNotice => ({
  type: 'notice',
  inReplyTo: null,
  channelRef: 'desktop:notice-1',
  text: REMINDER,
  buttons: [],
  sentAt: '2026-10-30T10:00:05.000Z',
  ...overrides,
});

describe('a message ANOMANDER sends unasked (DK-22, B14)', () => {
  it('S-163: shows in the chat as its message and is handed to the shell to notify', async () => {
    await open(runningSnapshot());
    act(() => FakeWebSocket.last.open());

    act(() => FakeWebSocket.last.receive(notice()));

    expect(screen.getByText(REMINDER)).toBeTruthy();
    await waitFor(() => expect(mocked.notifyReply).toHaveBeenCalledWith(REMINDER));
    expect(mocked.notifyReply).toHaveBeenCalledTimes(1);
  });

  it('S-164: its buttons answer it, as the buttons of a reply do', async () => {
    await open(runningSnapshot());
    act(() => FakeWebSocket.last.open());

    act(() =>
      FakeWebSocket.last.receive(
        notice({
          text: '¿Borro la foto del ticket?',
          buttons: [
            { label: 'Sí', data: 'decision:7:0' },
            { label: 'No', data: 'decision:7:1' },
          ],
        }),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Sí' }));

    expect(FakeWebSocket.last.lastRequest).toMatchObject({
      type: 'button',
      data: 'decision:7:0',
      channelRef: 'desktop:notice-1',
    });
  });

  it('S-169 AC3: one that arrives before the saved conversation is shown after it, once', async () => {
    FakeWebSocket.history = null;
    await open(runningSnapshot());
    const socket = FakeWebSocket.last;
    act(() => socket.open());
    const asked = socket.lastRequest;
    expect(asked.type).toBe('history');

    act(() => socket.receive(notice()));
    await act(async () =>
      socket.receive({
        type: 'history',
        inReplyTo: asked.id,
        messages: [
          {
            id: 1,
            from: 'anomander',
            door: 'app',
            text: 'Apuntado: 23,00 € en cena.',
            buttons: [],
            channelRef: 'desktop:old',
            at: '2026-10-29T20:00:00.000Z',
          },
          {
            id: 2,
            from: 'anomander',
            door: 'app',
            text: REMINDER,
            buttons: [],
            channelRef: 'desktop:notice-1',
            at: '2026-10-30T10:00:05.000Z',
          },
        ],
      }),
    );

    const shown = screen.getAllByText(/Apuntado: 23,00 € en cena\.|Recordatorio: llamar a mamá\./);
    expect(shown.map((element) => element.textContent)).toEqual([
      'Apuntado: 23,00 € en cena.',
      REMINDER,
    ]);
  });

  it('S-169 AC3: one the saved conversation does not hold yet stays after it', async () => {
    FakeWebSocket.history = null;
    await open(runningSnapshot());
    const socket = FakeWebSocket.last;
    act(() => socket.open());
    const asked = socket.lastRequest;

    act(() => socket.receive(notice()));
    await act(async () =>
      socket.receive({
        type: 'history',
        inReplyTo: asked.id,
        messages: [
          {
            id: 1,
            from: 'anomander',
            door: 'telegram',
            text: 'Apuntado: 23,00 € en cena.',
            buttons: [],
            channelRef: 'telegram:5',
            at: '2026-10-29T20:00:00.000Z',
          },
        ],
      }),
    );

    const shown = screen.getAllByText(/Apuntado: 23,00 € en cena\.|Recordatorio: llamar a mamá\./);
    expect(shown.map((element) => element.textContent)).toEqual([
      'Apuntado: 23,00 € en cena.',
      REMINDER,
    ]);
  });
});
