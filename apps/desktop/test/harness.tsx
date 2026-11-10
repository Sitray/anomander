import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { App } from '../src/App.tsx';
import type { Snapshot } from '../src/shell.ts';
import { strings } from '../src/strings.ts';
import { FakeWebSocket } from './fake-web-socket.ts';
import { emit, resetShell } from './shell-mock.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Renders the window against the mocked shell, with a fake `WebSocket` as the browser's. */
export const renderApp = async (initial: Snapshot) => {
  resetShell(initial);
  FakeWebSocket.reset();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  const view = render(<App />);
  await screen.findByRole('banner');
  return view;
};

/** Renders the window and opens the chat's socket. */
export const renderConnected = async (initial: Snapshot) => {
  const view = await renderApp(initial);
  const socket = FakeWebSocket.latest();
  act(() => socket.open());
  return { view, socket };
};

export const emitSnapshot = (snapshot: Snapshot): void => act(() => emit(snapshot));

export const composer = (): HTMLTextAreaElement => screen.getByLabelText(strings.composerLabel);
