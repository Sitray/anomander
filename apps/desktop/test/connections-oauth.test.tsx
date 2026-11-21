// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionsScreen } from '../src/connections/ConnectionsScreen.tsx';
import type { ConnectionsView, OAuthConnect } from '../src/shell.ts';
import { strings } from '../src/strings.ts';
import { CONNECTIONS } from './fixtures.ts';

// DK-11 OAuth: an HTTP server connected with OAuth from the connections screen. The screen only
// learns whether tokens are kept, never a token.
afterEach(cleanup);

const { connections: text } = strings;

const CONNECTED: ConnectionsView = {
  ...CONNECTIONS,
  servers: CONNECTIONS.servers.map((server) =>
    server.kind === 'http' ? { ...server, oauth: true } : server,
  ),
};

const renderScreen = async (
  connect: () => Promise<OAuthConnect>,
  views: ConnectionsView[] = [CONNECTIONS, CONNECTED],
) => {
  let read = 0;
  const load = vi.fn(async () => views[Math.min(read++, views.length - 1)] ?? CONNECTIONS);
  const onConnectOAuth = vi.fn(async (_name: string) => connect());
  const onForgetOAuth = vi.fn(async (_name: string) => CONNECTIONS);
  const onClose = vi.fn();
  render(
    <ConnectionsScreen
      load={load}
      onSave={async () => CONNECTIONS}
      onRemove={async () => CONNECTIONS}
      onConnectOAuth={onConnectOAuth}
      onForgetOAuth={onForgetOAuth}
      onClose={onClose}
    />,
  );
  await waitFor(() => expect(screen.queryByText(text.loading)).toBeNull());
  return { load, onConnectOAuth, onForgetOAuth, onClose };
};

const row = (name: string) =>
  within(screen.getByRole('list', { name: text.servers }))
    .getAllByRole('listitem')
    .find((item) => item.textContent?.startsWith(name)) as HTMLElement;

describe('connecting a server with OAuth', () => {
  it('is offered for a server reached by its address only', async () => {
    await renderScreen(async () => ({ outcome: 'connected' }));

    expect(
      within(row('remote')).getByRole('button', { name: text.connectOAuthFor('remote') }),
    ).toBeTruthy();
    expect(
      within(row('notes')).queryByRole('button', { name: text.connectOAuthFor('notes') }),
    ).toBeNull();
    expect(screen.queryByText(text.oauthConnected)).toBeNull();
  });

  it('asks to authorize in the browser meanwhile, then says it is connected', async () => {
    let answer: (value: OAuthConnect) => void = () => {};
    const { onConnectOAuth } = await renderScreen(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );

    fireEvent.click(screen.getByRole('button', { name: text.connectOAuthFor('remote') }));

    expect(onConnectOAuth).toHaveBeenCalledWith('remote');
    expect(screen.getByRole('status').textContent).toBe(text.authorizing);
    expect(
      (screen.getByRole('button', { name: text.connectOAuthFor('remote') }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    // Nothing else changes the file meanwhile: a save would start the daemon again.
    for (const name of [
      text.editServer('remote'),
      text.removeServer('notes'),
      text.connectFor('Notion'),
    ]) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
    }
    answer({ outcome: 'connected' });

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(text.oauthOutcome.connected),
    );
    expect(within(row('remote')).getByText(text.oauthConnected)).toBeTruthy();
    expect(
      within(row('remote')).getByRole('button', { name: text.reconnectOAuthFor('remote') }),
    ).toBeTruthy();
  });

  it('says why it did not connect', async () => {
    for (const outcome of ['denied', 'timed_out'] as const) {
      await renderScreen(async () => ({ outcome }), [CONNECTIONS]);
      fireEvent.click(screen.getByRole('button', { name: text.connectOAuthFor('remote') }));
      await waitFor(() =>
        expect(screen.getByRole('status').textContent).toBe(text.oauthOutcome[outcome]),
      );
      expect(screen.queryByText(text.oauthConnected)).toBeNull();
      cleanup();
    }
  });

  it('shows what the shell said when it failed', async () => {
    await renderScreen(async () => {
      throw new Error('could not connect with OAuth: ECONNREFUSED');
    });
    fireEvent.click(screen.getByRole('button', { name: text.connectOAuthFor('remote') }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(text.oauthFailed);
    expect(alert.textContent).toContain('ECONNREFUSED');
  });

  it('says it is connected even when the list cannot be read again', async () => {
    const { load } = await renderScreen(async () => ({ outcome: 'connected' }));
    load.mockRejectedValueOnce(new Error('mcp.json could not be read'));
    fireEvent.click(screen.getByRole('button', { name: text.connectOAuthFor('remote') }));

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(text.oauthOutcome.connected),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('can be left while the browser waits', async () => {
    const { onClose } = await renderScreen(() => new Promise(() => {}));
    fireEvent.click(screen.getByRole('button', { name: text.connectOAuthFor('remote') }));

    fireEvent.keyDown(screen.getByRole('heading', { name: text.title }), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: text.close }));

    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('forgetting the OAuth tokens of a server', () => {
  it('is offered once connected, and drops them', async () => {
    const { onForgetOAuth } = await renderScreen(
      async () => ({ outcome: 'connected' }),
      [CONNECTED],
    );
    expect(
      within(row('notes')).queryByRole('button', { name: text.forgetOAuthFor('notes') }),
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: text.forgetOAuthFor('remote') }));

    await waitFor(() => expect(onForgetOAuth).toHaveBeenCalledWith('remote'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(text.oauthForgotten));
    expect(screen.queryByText(text.oauthConnected)).toBeNull();
  });
});
