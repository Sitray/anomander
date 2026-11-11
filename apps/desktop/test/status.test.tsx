// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonStatus } from '../src/shell.ts';
import { StatusBar, type StatusBarProps } from '../src/status/StatusBar.tsx';
import { strings } from '../src/strings.ts';
import { RUNNING, STARTING, stopped } from './fixtures.ts';

// DK-1 AC2, DK-2 AC2, DK-6: what the window says about the daemon, and what it offers to do.
afterEach(cleanup);

const renderStatus = (daemon: DaemonStatus, overrides: Partial<StatusBarProps> = {}) => {
  const props: StatusBarProps = {
    daemon,
    busy: null,
    commandError: null,
    setupOpen: false,
    connectionsOpen: false,
    onStart: vi.fn(),
    onStop: vi.fn(),
    onToggleSetup: vi.fn(),
    onToggleConnections: vi.fn(),
    onDismissError: vi.fn(),
    ...overrides,
  };
  render(<StatusBar {...props} />);
  return props;
};

const { status } = strings;
const FAILING: DaemonStatus = { state: 'failing', reason: null, lastError: 'boom' };

describe('wording and action', () => {
  it.each<[string, DaemonStatus, string, string | null, string]>([
    ['running', RUNNING, status.running, null, status.stop],
    ['starting', STARTING, status.starting, null, status.stop],
    ['failing', FAILING, status.failing, status.failingDetail, status.stop],
    [
      'not configured',
      stopped('not_configured'),
      status.notConfigured,
      status.reasons.not_configured,
      status.configure,
    ],
    [
      'another daemon on this data',
      stopped('already_running'),
      status.stopped,
      status.reasons.already_running,
      status.start,
    ],
    [
      'the bot in use elsewhere',
      stopped('bot_in_use'),
      status.stopped,
      status.reasons.bot_in_use,
      status.start,
    ],
    ['gave up', stopped('gave_up', 'boom'), status.stopped, status.reasons.gave_up, status.start],
    [
      'stopped by the principal',
      stopped('stopped_by_principal'),
      status.stopped,
      status.reasons.stopped_by_principal,
      status.start,
    ],
    [
      'failed before it ran',
      stopped(null, 'spawn node ENOENT'),
      status.stopped,
      status.failedToStart,
      status.start,
    ],
    ['stopped, nothing known', stopped(null), status.stopped, null, status.start],
  ])('%s', (_name, daemon, title, detail, action) => {
    renderStatus(daemon);

    expect(screen.getByRole('status').textContent).toBe(title);
    if (detail !== null) expect(screen.getByText(detail)).toBeTruthy();
    expect(screen.getByRole('button', { name: action })).toBeTruthy();
    for (const other of [status.start, status.stop, status.configure]) {
      if (other !== action) expect(screen.queryByRole('button', { name: other })).toBeNull();
    }
  });

  it('starts, stops and leads to the setup', () => {
    const start = renderStatus(stopped('stopped_by_principal'));
    fireEvent.click(screen.getByRole('button', { name: status.start }));
    expect(start.onStart).toHaveBeenCalledOnce();
    cleanup();

    const stop = renderStatus(RUNNING);
    fireEvent.click(screen.getByRole('button', { name: status.stop }));
    expect(stop.onStop).toHaveBeenCalledOnce();
    cleanup();

    const configure = renderStatus(stopped('not_configured'));
    fireEvent.click(screen.getByRole('button', { name: status.configure }));
    expect(configure.onToggleSetup).toHaveBeenCalledOnce();
  });

  it('always offers the setup, and the way back from it', () => {
    const props = renderStatus(RUNNING);
    fireEvent.click(screen.getByRole('button', { name: status.openSetup }));
    expect(props.onToggleSetup).toHaveBeenCalledOnce();
    cleanup();

    renderStatus(RUNNING, { setupOpen: true });
    expect(screen.getByRole('button', { name: status.closeSetup })).toBeTruthy();
  });

  it('always offers the connections, and the way back from them', () => {
    const props = renderStatus(RUNNING);
    fireEvent.click(screen.getByRole('button', { name: status.openConnections }));
    expect(props.onToggleConnections).toHaveBeenCalledOnce();
    expect(props.onToggleSetup).not.toHaveBeenCalled();
    cleanup();

    renderStatus(RUNNING, { connectionsOpen: true });
    expect(screen.getByRole('button', { name: status.closeSetup })).toBeTruthy();
    expect(screen.getByRole('button', { name: status.openSetup })).toBeTruthy();
  });

  it('shows a command in progress and takes no second one', () => {
    const props = renderStatus(stopped('stopped_by_principal'), { busy: 'start' });
    const button = screen.getByRole<HTMLButtonElement>('button', { name: status.startBusy });

    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(props.onStart).not.toHaveBeenCalled();
  });
});

describe('the last error (DK-1 AC2)', () => {
  it('is shown verbatim', () => {
    const line = '  Error: connect ECONNREFUSED 127.0.0.1:443 <html>&amp;';
    renderStatus(stopped('gave_up', line));

    expect(screen.getByLabelText(status.lastError).textContent).toBe(line);
    expect(screen.queryByRole('button', { name: status.showAll })).toBeNull();
  });

  it('is collapsed when long, and opens whole', () => {
    const line = `Error: ${'no se pudo abrir la base de datos '.repeat(9)}`.trim();
    renderStatus(stopped(null, line));

    const toggle = screen.getByRole('button', { name: status.showAll });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByLabelText(status.lastError).textContent).toBe(line);

    fireEvent.click(toggle);
    expect(
      screen.getByRole('button', { name: status.showLess }).getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('is not shown while the daemon runs', () => {
    renderStatus({ state: 'running', reason: null, lastError: 'an old failure' });

    expect(screen.queryByLabelText(status.lastError)).toBeNull();
  });
});

describe('a failed command', () => {
  it('shows what failed and the error of the shell', () => {
    const props = renderStatus(stopped('stopped_by_principal'), {
      commandError: { command: 'start', message: 'the shell failed: no free port' },
    });

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(status.startFailed);
    expect(alert.textContent).toContain('the shell failed: no free port');

    fireEvent.click(screen.getByRole('button', { name: status.dismiss }));
    expect(props.onDismissError).toHaveBeenCalledOnce();
  });

  it('names a failed stop', () => {
    renderStatus(RUNNING, { commandError: { command: 'stop', message: 'nope' } });

    expect(screen.getByRole('alert').textContent).toContain(status.stopFailed);
  });
});
