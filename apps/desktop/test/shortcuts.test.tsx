// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.tsx';
import { shell } from '../src/shell.ts';
import { strings } from '../src/strings.ts';
import { FakeWebSocket } from './fake-web-socket.ts';
import { runningSnapshot } from './fixtures.ts';

// DK-20 (B27): Cmd+, on macOS and Ctrl+, on Windows open the setup, as in any app, and close it
// again. The whole window against a mocked shell: never real Tauri.
vi.mock('../src/shell.ts', () => ({
  shell: {
    snapshot: vi.fn(),
    onSnapshot: vi.fn(),
    onStopTask: vi.fn(),
    onChatShown: vi.fn(),
    setThinking: vi.fn(),
    setTaskRunning: vi.fn(),
  },
}));

const mocked = vi.mocked(shell);

beforeEach(() => {
  FakeWebSocket.reset();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  mocked.onSnapshot.mockResolvedValue(() => {});
  mocked.onStopTask.mockResolvedValue(() => {});
  mocked.onChatShown.mockResolvedValue(() => {});
  mocked.setThinking.mockResolvedValue(undefined);
  mocked.setTaskRunning.mockResolvedValue(undefined);
  mocked.snapshot.mockResolvedValue(runningSnapshot());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  delete window.__ANOMANDER_PLATFORM__;
});

const open = async () => {
  render(<App />);
  await waitFor(() =>
    expect(screen.getByRole('status').textContent).not.toBe(strings.status.loading),
  );
  await act(async () => {});
};

const setupHeading = () => screen.queryByRole('heading', { name: strings.setup.title });
const press = (keys: { metaKey?: boolean; ctrlKey?: boolean }) =>
  fireEvent.keyDown(window, { key: ',', ...keys });

describe('the setup shortcut', () => {
  it('is Cmd+, on macOS: it opens the setup and closes it again; Ctrl+, does nothing', async () => {
    await open();

    press({ ctrlKey: true });
    expect(setupHeading()).toBeNull();

    press({ metaKey: true });
    expect(setupHeading()).toBeTruthy();

    press({ metaKey: true });
    expect(setupHeading()).toBeNull();
  });

  it('is Ctrl+, on Windows; Cmd+, does nothing', async () => {
    window.__ANOMANDER_PLATFORM__ = 'windows';
    await open();

    press({ metaKey: true });
    expect(setupHeading()).toBeNull();

    press({ ctrlKey: true });
    expect(setupHeading()).toBeTruthy();
  });
});
