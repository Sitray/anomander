// @vitest-environment jsdom
import { OAUTH_CONNECTIONS } from '@anomander/protocol';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionsScreen } from '../src/connections/ConnectionsScreen.tsx';
import type {
  ConnectionInput,
  ConnectionServer,
  ConnectionsView,
  OAuthConnect,
} from '../src/shell.ts';
import { strings } from '../src/strings.ts';
import { CONNECTIONS, NO_CONNECTIONS } from './fixtures.ts';

// DK-11 AC12 (T8): the ready-made connections, one "Conectar" each, and the form behind
// "Avanzado". A remote one is saved by its address and then connected with OAuth, through the
// same two calls as the form and the row's "Conectar con OAuth".
afterEach(cleanup);

const { connections: text } = strings;

const notion = (oauth: boolean, name = 'Notion'): ConnectionServer => ({
  name,
  kind: 'http',
  url: 'https://mcp.notion.com/mcp',
  values: [],
  readOnly: [],
  oauth,
});

const renderScreen = async ({
  views = [NO_CONNECTIONS],
  save = async () => ({ servers: [notion(false)], invalid: null }),
  connect = async () => ({ outcome: 'connected' }),
  oauth = true,
}: {
  views?: ConnectionsView[];
  save?: (server: ConnectionInput) => Promise<ConnectionsView>;
  connect?: () => Promise<OAuthConnect>;
  oauth?: boolean;
} = {}) => {
  let read = 0;
  const load = vi.fn(async () => views[Math.min(read++, views.length - 1)] ?? NO_CONNECTIONS);
  const onSave = vi.fn(save);
  const onConnectOAuth = vi.fn(async (_name: string) => connect());
  render(
    <ConnectionsScreen
      load={load}
      onSave={onSave}
      onRemove={async () => NO_CONNECTIONS}
      {...(oauth ? { onConnectOAuth } : {})}
      onForgetOAuth={async () => NO_CONNECTIONS}
      onClose={() => {}}
    />,
  );
  await waitFor(() => expect(screen.queryByText(text.loading)).toBeNull());
  return { load, onSave, onConnectOAuth };
};

const cards = () => screen.getByRole('list', { name: text.connectors });
const card = (title: string): HTMLElement =>
  within(cards())
    .getAllByRole('listitem')
    .find((item) => item.textContent?.startsWith(title)) as HTMLElement;
const click = (name: string): void => {
  fireEvent.click(screen.getByRole('button', { name }));
};

describe('the ready-made connections', () => {
  it('are Notion, Linear and Atlassian by their own addresses, and web search', async () => {
    expect(OAUTH_CONNECTIONS).toEqual([
      { name: 'Notion', url: 'https://mcp.notion.com/mcp' },
      { name: 'Linear', url: 'https://mcp.linear.app/mcp' },
      { name: 'Atlassian', url: 'https://mcp.atlassian.com/v2/mcp' },
    ]);
    await renderScreen();

    for (const title of ['Notion', 'Linear', 'Atlassian', text.webSearch]) {
      expect(
        within(card(title)).getByRole('button', { name: text.connectFor(title) }),
      ).toBeTruthy();
    }
    expect(within(card('Linear')).getByText(text.connectorAbout.Linear)).toBeTruthy();
  });

  it('saves the server by its address with no tool read-only, then connects it with OAuth', async () => {
    let answer: (value: OAuthConnect) => void = () => {};
    const { onSave, onConnectOAuth, load } = await renderScreen({
      views: [NO_CONNECTIONS, { servers: [notion(true)], invalid: null }],
      connect: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });

    click(text.connectFor('Notion'));

    await waitFor(() => expect(onConnectOAuth).toHaveBeenCalledWith('Notion'));
    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave.mock.calls[0]?.[0]).toEqual({
      name: 'Notion',
      kind: 'http',
      url: 'https://mcp.notion.com/mcp',
      values: [],
      readOnly: [],
    });
    expect(screen.getByRole('status').textContent).toBe(text.authorizing);
    // One connection at a time: every other card waits.
    expect(
      (screen.getByRole('button', { name: text.connectFor('Linear') }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    answer({ outcome: 'connected' });

    await waitFor(() => expect(within(card('Notion')).getByText(text.connectorConnected)));
    expect(load).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: text.connectFor('Notion') })).toBeNull();
  });

  it('shows one already connected as such, and connects one saved but not authorized without saving it again', async () => {
    const { onSave, onConnectOAuth } = await renderScreen({
      views: [{ servers: [notion(false, 'my notes')], invalid: null }],
    });

    click(text.connectFor('Notion'));

    await waitFor(() => expect(onConnectOAuth).toHaveBeenCalledWith('my notes'));
    expect(onSave).not.toHaveBeenCalled();
    cleanup();

    await renderScreen({ views: [{ servers: [notion(true)], invalid: null }] });
    expect(within(card('Notion')).getByText(text.connectorConnected)).toBeTruthy();
    expect(screen.queryByRole('button', { name: text.connectFor('Notion') })).toBeNull();
    expect(screen.getByRole('button', { name: text.connectFor('Linear') })).toBeTruthy();
  });

  it('shows what the shell says when saving is refused, and authorizes nothing', async () => {
    const { onConnectOAuth } = await renderScreen({
      save: async () => {
        throw 'there is already a server named Notion';
      },
    });

    click(text.connectFor('Notion'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(text.connectorRejected('Notion'));
    expect(alert.textContent).toContain('there is already a server named Notion');
    expect(onConnectOAuth).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: text.connectFor('Notion') })).toBeTruthy();
  });

  it('offers no remote one where the app cannot connect with OAuth', async () => {
    await renderScreen({ oauth: false });

    expect(within(cards()).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByRole('button', { name: text.connectFor(text.webSearch) })).toBeTruthy();
  });
});

describe('the form behind "Avanzado"', () => {
  it('is hidden until asked for, and stays open after going to the form and back', async () => {
    await renderScreen({ views: [CONNECTIONS] });
    const advanced = screen.getByRole('button', { name: text.advanced });
    expect(advanced.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: text.add })).toBeNull();

    click(text.advanced);
    expect(advanced.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(text.advancedNote)).toBeTruthy();
    click(text.add);
    expect(screen.getByRole('heading', { name: text.newTitle })).toBeTruthy();

    click(text.cancel);
    expect(screen.getByRole('button', { name: text.advanced }).getAttribute('aria-expanded')).toBe(
      'true',
    );
    click(text.advanced);
    expect(screen.queryByRole('button', { name: text.add })).toBeNull();
  });
});
