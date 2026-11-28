// @vitest-environment jsdom
import type { ChatConnectionGrant, ChatRequest } from '@anomander/protocol';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionsScreen } from '../src/connections/ConnectionsScreen.tsx';
import { strings } from '../src/strings.ts';
import { FakeWebSocket } from './fake-web-socket.ts';
import { CHANNEL, CONNECTIONS, NO_CONNECTIONS } from './fixtures.ts';

// DK-24 AC3: the tools allowed with "Permitir siempre", listed under their server in
// "Conexiones", each with "Quitar". The daemon keeps them; the window asks on its own connection.
const { connections: text } = strings;
const CREATE: ChatConnectionGrant = {
  id: 4,
  server: 'notes',
  tool: 'create',
  at: '2026-11-25T09:00:00.000Z',
};
const DELETE: ChatConnectionGrant = { ...CREATE, id: 5, tool: 'delete' };
/** Of a server no longer in the file: the daemon drops it at its next start. */
const GONE: ChatConnectionGrant = { ...CREATE, id: 6, server: 'old' };

beforeEach(() => {
  FakeWebSocket.reset();
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

/** "Conexiones" open with a running daemon, its grants answered with `grants`. */
const openWith = async (grants: ChatConnectionGrant[], view = CONNECTIONS) => {
  render(
    <ConnectionsScreen
      load={async () => view}
      onSave={async () => view}
      onRemove={async () => NO_CONNECTIONS}
      onClose={() => {}}
      channel={CHANNEL}
    />,
  );
  await waitFor(() => expect(screen.queryByText(text.loading)).toBeNull());
  const socket = FakeWebSocket.last;
  act(() => socket.open());
  const listed = await requestOf(socket, 'connection_grants');
  act(() => socket.receive({ type: 'connection_grants', inReplyTo: listed.id, grants }));
  return socket;
};

const allowedOf = (server: string) =>
  screen.getByRole('list', { name: text.alwaysAllowedIn(server) });

describe('the tools allowed always (DK-24 AC3)', () => {
  it('lists them under their server, each with "Quitar"', async () => {
    await openWith([CREATE, DELETE, GONE]);

    const tools = within(await waitFor(() => allowedOf('notes'))).getAllByRole('listitem');
    expect(tools.map((tool) => tool.textContent)).toEqual([
      `create${text.revokeGrant}`,
      `delete${text.revokeGrant}`,
    ]);
    expect(screen.getByText(text.alwaysAllowed)).toBeTruthy();
    expect(screen.queryByRole('list', { name: text.alwaysAllowedIn('remote') })).toBeNull();
    expect(screen.queryByRole('list', { name: text.alwaysAllowedIn('old') })).toBeNull();
  });

  it('"Quitar" sends its revoke and reads them again', async () => {
    const socket = await openWith([CREATE, DELETE]);

    fireEvent.click(
      await screen.findByRole('button', { name: text.revokeGrantFor('create', 'notes') }),
    );

    const revoke = await requestOf(socket, 'revoke_connection_grant');
    expect(revoke.grantId).toBe(4);
    act(() => socket.receive({ type: 'done', inReplyTo: revoke.id }));
    const again = await requestOf(socket, 'connection_grants', 2);
    act(() => socket.receive({ type: 'connection_grants', inReplyTo: again.id, grants: [DELETE] }));
    await waitFor(() =>
      expect(within(allowedOf('notes')).getAllByRole('listitem')).toHaveLength(1),
    );
  });

  it('says so when it was not removed, or when it cannot know', async () => {
    const socket = await openWith([CREATE]);
    const quit = () =>
      fireEvent.click(screen.getByRole('button', { name: text.revokeGrantFor('create', 'notes') }));

    await waitFor(() => allowedOf('notes'));
    quit();
    const refused = await requestOf(socket, 'revoke_connection_grant');
    act(() => socket.receive({ type: 'rejected', inReplyTo: refused.id }));
    expect((await screen.findByRole('alert')).textContent).toBe(text.revokeGrantFailed);

    quit();
    await requestOf(socket, 'revoke_connection_grant', 2);
    act(() => socket.close());
    expect((await screen.findByRole('alert')).textContent).toBe(text.revokeGrantUnknown);
  });

  it('B67: a read the connection lost says nothing once it closed, and it reads again on open', async () => {
    render(
      <ConnectionsScreen
        load={async () => CONNECTIONS}
        onSave={async () => CONNECTIONS}
        onRemove={async () => NO_CONNECTIONS}
        onClose={() => {}}
        channel={CHANNEL}
      />,
    );
    await waitFor(() => expect(screen.queryByText(text.loading)).toBeNull());
    const socket = FakeWebSocket.last;
    act(() => socket.open());
    await requestOf(socket, 'connection_grants');

    await act(async () => socket.close());

    expect(screen.queryByText(text.grantsFailed)).toBeNull();
    // It connects again by itself after a short wait.
    await waitFor(() => expect(FakeWebSocket.last).not.toBe(socket));
    const reopened = FakeWebSocket.last;
    act(() => reopened.open());
    const again = await requestOf(reopened, 'connection_grants');
    act(() => reopened.receive({ type: 'connection_grants', inReplyTo: again.id, grants: [CREATE] }));
    await waitFor(() =>
      expect(within(allowedOf('notes')).getAllByRole('listitem')).toHaveLength(1),
    );
  });

  it('shows none and asks nothing without a running daemon', async () => {
    render(
      <ConnectionsScreen
        load={async () => CONNECTIONS}
        onSave={async () => CONNECTIONS}
        onRemove={async () => NO_CONNECTIONS}
        onClose={() => {}}
        channel={null}
      />,
    );
    await waitFor(() => expect(screen.queryByText(text.loading)).toBeNull());

    expect(screen.queryByRole('list', { name: text.alwaysAllowedIn('notes') })).toBeNull();
    expect(FakeWebSocket.instances.every((socket) => socket.sent.length === 0)).toBe(true);
  });
});
