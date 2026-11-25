// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.tsx';
import { type Snapshot, shell } from '../src/shell.ts';
import { strings } from '../src/strings.ts';
import { FakeWebSocket } from './fake-web-socket.ts';
import { FILLED_SETUP, NO_CONNECTIONS, runningSnapshot } from './fixtures.ts';

// DK-22 (B29): the notifications can show their content or only say there is something, a
// setting of the setup saved at once in the shell. The whole window against a mocked shell, as
// `app.test.tsx`: never real Tauri.
vi.mock('../src/shell.ts', () => ({
  shell: {
    snapshot: vi.fn(),
    saveSetup: vi.fn(),
    setNotifications: vi.fn(),
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

describe('what a notification shows (DK-22, B29)', () => {
  const openSetup = async (snapshot: Snapshot) => {
    await open(snapshot);
    fireEvent.click(screen.getByRole('button', { name: strings.status.openSetup }));
  };
  const option = (name: string) => screen.getByRole<HTMLInputElement>('radio', { name });

  it('S-165: the setup offers "Mostrar contenido" and "Solo avisar"; showing the content is the default', async () => {
    await openSetup(runningSnapshot({ setup: FILLED_SETUP }));

    expect(screen.getByRole('group', { name: strings.notifications.title })).toBeTruthy();
    expect(option(strings.notifications.content).checked).toBe(true);
    expect(option(strings.notifications.noticeOnly).checked).toBe(false);
  });

  it('S-166: choosing "Solo avisar" saves it at once in the shell, and the setup shows it chosen', async () => {
    const chosen = runningSnapshot({ setup: { ...FILLED_SETUP, notifications: 'notice_only' } });
    mocked.setNotifications.mockResolvedValue(chosen);
    await openSetup(runningSnapshot({ setup: FILLED_SETUP }));

    fireEvent.click(option(strings.notifications.noticeOnly));

    expect(mocked.setNotifications).toHaveBeenCalledWith('notice_only');
    await waitFor(() => expect(option(strings.notifications.noticeOnly).checked).toBe(true));
    expect(mocked.saveSetup).not.toHaveBeenCalled();
  });

  it('S-167: says so when it could not be saved, and keeps what was in force', async () => {
    mocked.setNotifications.mockRejectedValue('disk full');
    await openSetup(runningSnapshot({ setup: FILLED_SETUP }));

    fireEvent.click(option(strings.notifications.noticeOnly));

    expect(await screen.findByText(strings.notifications.failed)).toBeTruthy();
    expect(option(strings.notifications.content).checked).toBe(true);
  });
});
