// @vitest-environment jsdom
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { StopReason } from '../src/shell.ts';
import { strings } from '../src/strings.ts';
import { emitSnapshot, renderApp } from './harness.tsx';
import { shellMock } from './shell-mock.ts';
import { running, stopped } from './snapshots.ts';

vi.mock('../src/shell.ts', async () => ({ shell: (await import('./shell-mock.ts')).shellMock }));

const status = () => screen.getByRole('status');

describe('status (DK-6 AC1, DK-1 AC2, DK-2)', () => {
  it('shows the daemon running, with a stop button', async () => {
    await renderApp(running());

    expect(status().textContent).toContain(strings.state.running);
    fireEvent.click(screen.getByRole('button', { name: strings.stop }));
    expect(shellMock.stopDaemon).toHaveBeenCalledTimes(1);
  });

  it('shows the daemon starting', async () => {
    await renderApp(
      running({ daemon: { state: 'starting', reason: null, lastError: null }, channel: null }),
    );

    expect(status().textContent).toContain(strings.state.starting);
  });

  it.each<[StopReason, string]>([
    ['already_running', strings.reason.already_running],
    ['bot_in_use', strings.reason.bot_in_use],
    ['stopped_by_principal', strings.reason.stopped_by_principal],
  ])('says why it stopped when the reason is %s, with a start button', async (reason, text) => {
    await renderApp(stopped({ reason }));

    expect(screen.getByText(text)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: strings.start }));
    expect(shellMock.startDaemon).toHaveBeenCalledTimes(1);
  });

  it('shows the last error verbatim, in a monospace block, after giving up', async () => {
    const lastError = 'Error: ETIMEDOUT api.telegram.org:443 <retry 3/3>';
    await renderApp(stopped({ state: 'failing', reason: 'gave_up', lastError }));

    expect(status().textContent).toContain(strings.state.failing);
    expect(screen.getByText(strings.reason.gave_up)).toBeTruthy();
    const block = screen.getByText(lastError);
    expect(block.closest('pre')).not.toBeNull();
    expect(block.textContent).toBe(lastError);
  });

  it('says what is missing and leads to setup when not configured', async () => {
    await renderApp(
      stopped(
        { reason: 'not_configured' },
        {
          hasTelegramBotToken: false,
          principalChatId: null,
          model: null,
          visionModel: null,
          providerKeys: [],
        },
      ),
    );

    expect(screen.getByText(strings.reason.not_configured)).toBeTruthy();
    expect(screen.queryByRole('button', { name: strings.start })).toBeNull();
  });

  it('follows the snapshots the shell emits', async () => {
    await renderApp(running());

    emitSnapshot(stopped({ state: 'failing', reason: 'bot_in_use' }));

    expect(status().textContent).toContain(strings.state.failing);
    expect(screen.getByText(strings.reason.bot_in_use)).toBeTruthy();
  });

  it('says so when the shell cannot start the daemon', async () => {
    await renderApp(stopped({ reason: 'stopped_by_principal' }));
    shellMock.startDaemon.mockRejectedValueOnce(new Error('spawn failed'));

    fireEvent.click(screen.getByRole('button', { name: strings.start }));

    expect(await screen.findByText(strings.startFailed)).toBeTruthy();
  });
});
