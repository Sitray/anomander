// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.tsx';
import { type Snapshot, shell } from '../src/shell.ts';
import { strings } from '../src/strings.ts';
import { FakeWebSocket } from './fake-web-socket.ts';
import {
  FILLED_SETUP,
  replyTo,
  runningSnapshot,
  STARTING,
  stoppedSnapshot,
  TOKEN,
} from './fixtures.ts';

// The whole window against a mocked shell: never real Tauri.
vi.mock('../src/shell.ts', () => ({
  shell: {
    snapshot: vi.fn(),
    saveSetup: vi.fn(),
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
  },
}));

const mocked = vi.mocked(shell);
/** Sends the window a snapshot, as the shell's event does. */
let emit: (snapshot: Snapshot) => void;
let unlisten: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  FakeWebSocket.reset();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  unlisten = vi.fn();
  emit = () => {
    throw new Error('the window is not listening to the shell');
  };
  mocked.onSnapshot.mockImplementation(async (handler) => {
    emit = (snapshot) => act(() => handler(snapshot));
    return unlisten;
  });
  mocked.startDaemon.mockResolvedValue(undefined);
  mocked.stopDaemon.mockResolvedValue(undefined);
  mocked.setThinking.mockResolvedValue(undefined);
  mocked.notifyReply.mockResolvedValue(undefined);
  mocked.reveal.mockResolvedValue(undefined);
  mocked.setTaskRunning.mockResolvedValue(undefined);
  mocked.onStopTask.mockResolvedValue(() => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

const open = async (snapshot: Snapshot) => {
  mocked.snapshot.mockResolvedValue(snapshot);
  const view = render(<App />);
  await waitFor(() =>
    expect(screen.getByRole('status').textContent).not.toBe(strings.status.loading),
  );
  // The status is on screen before the effects of that render ran: let them (the chat connects,
  // the setup opens by itself).
  await act(async () => {});
  return view;
};

const setupHeading = () => screen.queryByRole('heading', { name: strings.setup.title });
const composer = (): HTMLTextAreaElement => screen.getByLabelText(strings.chat.message);

describe('opening', () => {
  it('shows the daemon running and connects the chat with the channel of the shell', async () => {
    await open(runningSnapshot());

    expect(screen.getByRole('status').textContent).toBe(strings.status.running);
    expect(FakeWebSocket.last.url).toBe('ws://127.0.0.1:4312');
    expect(FakeWebSocket.last.protocols.at(1)).toBe(TOKEN);
    expect(setupHeading()).toBeNull();
  });

  it('says it is loading until the shell answers', () => {
    mocked.snapshot.mockReturnValue(new Promise(() => {}));
    render(<App />);

    expect(screen.getByRole('status').textContent).toBe(strings.status.loading);
  });

  it('says when the shell cannot be reached, and tries again when asked', async () => {
    mocked.snapshot.mockRejectedValueOnce('ipc is gone');
    render(<App />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(strings.status.shellUnreachable);
    expect(alert.textContent).toContain('ipc is gone');

    mocked.snapshot.mockResolvedValue(runningSnapshot());
    fireEvent.click(screen.getByRole('button', { name: strings.status.retry }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(strings.status.running),
    );
  });

  it('stops listening to the shell when the window goes away', async () => {
    const view = await open(runningSnapshot());
    view.unmount();

    await waitFor(() => expect(unlisten).toHaveBeenCalled());
  });
});

describe('snapshots', () => {
  it('follows the events of the shell', async () => {
    await open(runningSnapshot());
    emit(stoppedSnapshot('bot_in_use'));

    expect(screen.getByRole('status').textContent).toBe(strings.status.stopped);
    expect(screen.getByText(strings.status.reasons.bot_in_use)).toBeTruthy();
    expect(composer().disabled).toBe(true);
  });

  it('prefers an event over an older first snapshot', async () => {
    let answer: (snapshot: Snapshot) => void = () => {};
    mocked.snapshot.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    render(<App />);
    await waitFor(() => expect(mocked.onSnapshot).toHaveBeenCalled());
    await act(async () => {});

    emit(runningSnapshot());
    await act(async () => answer(stoppedSnapshot('stopped_by_principal')));

    expect(screen.getByRole('status').textContent).toBe(strings.status.running);
  });
});

describe('commands', () => {
  it('starts and stops the daemon', async () => {
    await open(stoppedSnapshot('stopped_by_principal'));
    fireEvent.click(screen.getByRole('button', { name: strings.status.start }));
    await waitFor(() => expect(mocked.startDaemon).toHaveBeenCalledOnce());

    emit(runningSnapshot());
    fireEvent.click(await screen.findByRole('button', { name: strings.status.stop }));
    await waitFor(() => expect(mocked.stopDaemon).toHaveBeenCalledOnce());
  });

  it('shows the error of a command that failed', async () => {
    mocked.startDaemon.mockRejectedValue('the shell failed: no free port on 127.0.0.1');
    await open(stoppedSnapshot('stopped_by_principal'));
    fireEvent.click(screen.getByRole('button', { name: strings.status.start }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(strings.status.startFailed);
    expect(alert.textContent).toContain('the shell failed: no free port on 127.0.0.1');
  });
});

describe('the setup', () => {
  it('opens by itself when the daemon is not configured', async () => {
    await open(stoppedSnapshot('not_configured'));

    expect(setupHeading()).toBeTruthy();
  });

  it('opens by itself when the daemon becomes not configured later', async () => {
    await open(runningSnapshot());
    emit(stoppedSnapshot('not_configured'));

    expect(setupHeading()).toBeTruthy();
  });

  it('stays closed once the principal closed it, while nothing changes', async () => {
    await open(stoppedSnapshot('not_configured'));
    fireEvent.click(screen.getByRole('button', { name: strings.setup.cancel }));
    expect(setupHeading()).toBeNull();

    emit(stoppedSnapshot('not_configured'));
    expect(setupHeading()).toBeNull();
    expect(screen.getByText(strings.chat.disabled.notConfigured)).toBeTruthy();
  });

  it('opens and closes from the status area', async () => {
    await open(runningSnapshot());
    fireEvent.click(screen.getByRole('button', { name: strings.status.openSetup }));
    expect(setupHeading()).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: strings.status.closeSetup }));
    expect(setupHeading()).toBeNull();
  });

  it('saves through the shell and goes back to the chat', async () => {
    await open(stoppedSnapshot('not_configured'));
    mocked.saveSetup.mockResolvedValue({
      daemon: STARTING,
      channel: null,
      setup: FILLED_SETUP,
    });
    fireEvent.change(screen.getByLabelText(strings.setup.botToken), {
      target: { value: '123456:secret' },
    });
    fireEvent.change(screen.getByLabelText(strings.setup.chatId), { target: { value: '4242' } });
    fireEvent.click(screen.getByRole('button', { name: strings.setup.save }));

    await waitFor(() => expect(setupHeading()).toBeNull());
    expect(mocked.saveSetup).toHaveBeenCalledWith({
      telegramBotToken: '123456:secret',
      principalChatId: '4242',
      model: '',
      visionModel: '',
      providerKeys: {},
    });
    expect(screen.getByRole('status').textContent).toBe(strings.status.starting);
  });

  it('prefers an event that arrived while saving over the result of the save', async () => {
    await open(stoppedSnapshot('stopped_by_principal'));
    let finish: (snapshot: Snapshot) => void = () => {};
    mocked.saveSetup.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: strings.status.openSetup }));
    fireEvent.click(screen.getByRole('button', { name: strings.setup.save }));
    await waitFor(() => expect(mocked.saveSetup).toHaveBeenCalled());

    emit(runningSnapshot());
    await act(async () => finish({ daemon: STARTING, channel: null, setup: FILLED_SETUP }));

    await waitFor(() => expect(setupHeading()).toBeNull());
    expect(screen.getByRole('status').textContent).toBe(strings.status.running);
  });

  it('keeps the conversation while the setup is open', async () => {
    await open(runningSnapshot());
    act(() => FakeWebSocket.last.open());
    fireEvent.change(composer(), { target: { value: '23 € cena' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    await waitFor(() => expect(FakeWebSocket.last.sent).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: strings.status.openSetup }));
    fireEvent.click(screen.getByRole('button', { name: strings.status.closeSetup }));

    expect(screen.getByText('23 € cena')).toBeTruthy();
  });
});

describe('thinking', () => {
  const thinking = () => mocked.setThinking.mock.calls.map(([value]) => value);

  it('tells the shell while an answer is owed, so the menu bar shows it', async () => {
    await open(runningSnapshot());
    act(() => FakeWebSocket.last.open());
    expect(thinking()).not.toContain(true);

    fireEvent.change(composer(), { target: { value: '23 € cena' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    await waitFor(() => expect(thinking().at(-1)).toBe(true));

    act(() => FakeWebSocket.last.receive(replyTo(FakeWebSocket.last.lastRequest.id)));
    await waitFor(() => expect(thinking().at(-1)).toBe(false));
  });

  it('stops when the window goes away while an answer is owed', async () => {
    const view = await open(runningSnapshot());
    act(() => FakeWebSocket.last.open());
    fireEvent.change(composer(), { target: { value: '23 € cena' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    await waitFor(() => expect(thinking().at(-1)).toBe(true));

    view.unmount();

    expect(thinking().at(-1)).toBe(false);
  });
});

describe('notifications', () => {
  it('hands every answer to the shell, which notifies when the window is not in front', async () => {
    await open(runningSnapshot());
    act(() => FakeWebSocket.last.open());
    fireEvent.change(composer(), { target: { value: '23 € cena' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    await waitFor(() => expect(FakeWebSocket.last.sent).toHaveLength(1));
    expect(mocked.notifyReply).not.toHaveBeenCalled();

    const text = 'Apuntado: 23,00 € en cena.';
    act(() => FakeWebSocket.last.receive(replyTo(FakeWebSocket.last.lastRequest.id, { text })));

    await waitFor(() => expect(mocked.notifyReply).toHaveBeenCalledTimes(1));
    expect(mocked.notifyReply).toHaveBeenCalledWith(text);
  });

  it('does not notify a request the daemon handled without an answer', async () => {
    await open(runningSnapshot());
    act(() => FakeWebSocket.last.open());
    fireEvent.change(composer(), { target: { value: '23 € cena' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    await waitFor(() => expect(FakeWebSocket.last.sent).toHaveLength(1));

    act(() =>
      FakeWebSocket.last.receive({ type: 'done', inReplyTo: FakeWebSocket.last.lastRequest.id }),
    );
    await act(async () => {});

    expect(mocked.notifyReply).not.toHaveBeenCalled();
  });
});
