import { WEB_SEARCH_CONNECTION } from '@anomander/protocol';
import { describe, expect, it, vi } from 'vitest';
import { ADD_LIMIT_MS, addWebSearch, webSearchInput } from '../src/connections/web-search.ts';
import type { ConnectionInput, ConnectionsView } from '../src/shell.ts';
import { strings } from '../src/strings.ts';
import { NO_CONNECTIONS } from './fixtures.ts';

// DK-11 AC13: the setup and every chat press add the web search through `addWebSearch`; a save
// restarts the daemon, so two calls at once must not save twice.
describe('addWebSearch', () => {
  it('saves once when called again while the first add runs, and both hear it was saved', async () => {
    let view: ConnectionsView = NO_CONNECTIONS;
    let finish: () => void = () => {};
    const connections = vi.fn(async () => view);
    const saveConnection = vi.fn(
      (server: ConnectionInput) =>
        new Promise<ConnectionsView>((resolve) => {
          finish = () => {
            view = {
              servers: [{ ...server, url: '', oauth: false } as never],
              invalid: null,
            };
            resolve(view);
          };
        }),
    );
    const shell = { connections, saveConnection };

    const first = addWebSearch(shell);
    const second = addWebSearch(shell);
    await vi.waitFor(() => expect(saveConnection).toHaveBeenCalledOnce());
    finish();

    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(saveConnection).toHaveBeenCalledOnce();
    expect(saveConnection).toHaveBeenCalledWith(webSearchInput());
    expect(connections).toHaveBeenCalledOnce();
    // Once over, a later call reads the file again and finds the server there.
    expect(await addWebSearch(shell)).toBe(false);
    expect(view.servers.map((server) => server.name)).toEqual([WEB_SEARCH_CONNECTION.name]);
    expect(saveConnection).toHaveBeenCalledOnce();
  });
  it('rejects for both callers when the add fails, and a later call saves again', async () => {
    const connections = vi.fn(async () => NO_CONNECTIONS);
    let fail: (error: Error) => void = () => {};
    const saveConnection = vi
      .fn<(server: ConnectionInput) => Promise<ConnectionsView>>()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => (fail = reject)))
      .mockImplementationOnce(async () => NO_CONNECTIONS);
    const shell = { connections, saveConnection };

    const first = addWebSearch(shell);
    const second = addWebSearch(shell);
    await vi.waitFor(() => expect(saveConnection).toHaveBeenCalledOnce());
    fail(new Error('mcp.json is not valid JSON'));

    await expect(first).rejects.toThrow('mcp.json is not valid JSON');
    await expect(second).rejects.toThrow('mcp.json is not valid JSON');
    expect(await addWebSearch(shell)).toBe(true);
    expect(saveConnection).toHaveBeenCalledTimes(2);
  });

  it('gives a joined call the same answer when the server was already there', async () => {
    const present: ConnectionsView = {
      servers: [{ ...webSearchInput(), url: '', oauth: false } as never],
      invalid: null,
    };
    let read: (view: ConnectionsView) => void = () => {};
    const connections = vi.fn(() => new Promise<ConnectionsView>((resolve) => (read = resolve)));
    const saveConnection = vi.fn(async () => present);
    const shell = { connections, saveConnection };

    const first = addWebSearch(shell);
    const second = addWebSearch(shell);
    read(present);

    expect(await Promise.all([first, second])).toEqual([false, false]);
    expect(connections).toHaveBeenCalledOnce();
    expect(saveConnection).not.toHaveBeenCalled();
  });

  it('adds through its own shell when another shell is adding: after it, never with its answer', async () => {
    let finish: () => void = () => {};
    const busy = {
      connections: vi.fn(async () => NO_CONNECTIONS),
      saveConnection: vi.fn(
        () => new Promise<ConnectionsView>((resolve) => (finish = () => resolve(NO_CONNECTIONS))),
      ),
    };
    const present: ConnectionsView = {
      servers: [{ ...webSearchInput(), url: '', oauth: false } as never],
      invalid: null,
    };
    const other = {
      connections: vi.fn(async () => present),
      saveConnection: vi.fn(async () => present),
    };

    const first = addWebSearch(busy);
    const second = addWebSearch(other);
    await vi.waitFor(() => expect(busy.saveConnection).toHaveBeenCalledOnce());
    // One add at a time: the other shell waits for the add under way.
    expect(other.connections).not.toHaveBeenCalled();
    finish();

    expect(await first).toBe(true);
    expect(await second).toBe(false);
    expect(other.connections).toHaveBeenCalledOnce();
    expect(other.saveConnection).not.toHaveBeenCalled();
  });

  it('B41: adds through its own shell once the add before it failed, and only the first hears why', async () => {
    let fail: (error: Error) => void = () => {};
    const failing = {
      connections: vi.fn(async () => NO_CONNECTIONS),
      saveConnection: vi.fn(
        () => new Promise<ConnectionsView>((_resolve, reject) => (fail = reject)),
      ),
    };
    const other = {
      connections: vi.fn(async () => NO_CONNECTIONS),
      saveConnection: vi.fn(async () => NO_CONNECTIONS),
    };

    const first = addWebSearch(failing);
    const second = addWebSearch(other);
    await vi.waitFor(() => expect(failing.saveConnection).toHaveBeenCalledOnce());
    expect(other.connections).not.toHaveBeenCalled();
    fail(new Error('No se ha podido guardar.'));

    await expect(first).rejects.toThrow('No se ha podido guardar.');
    expect(await second).toBe(true);
    expect(other.saveConnection).toHaveBeenCalledExactlyOnceWith(webSearchInput());
  });

  it('gives up on an add that never answers; the next call adds once that add is over', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let view: ConnectionsView = NO_CONNECTIONS;
      let finish: () => void = () => {};
      const connections = vi.fn(async () => view);
      const saveConnection = vi.fn(
        (server: ConnectionInput) =>
          new Promise<ConnectionsView>((resolve) => {
            finish = () => {
              view = { servers: [{ ...server, url: '', oauth: false } as never], invalid: null };
              resolve(view);
            };
          }),
      );
      const shell = { connections, saveConnection };

      const hung = addWebSearch(shell);
      const failed = expect(hung).rejects.toThrow(strings.connections.webSearchTimedOut);
      await vi.advanceTimersByTimeAsync(ADD_LIMIT_MS - 1);
      expect(addWebSearch(shell)).toBe(hung);
      await vi.advanceTimersByTimeAsync(1);
      await failed;

      // The save given up on still runs: a second one would write the same server again.
      const again = addWebSearch(shell);
      await vi.advanceTimersByTimeAsync(0);
      expect(saveConnection).toHaveBeenCalledOnce();
      finish();

      expect(await again).toBe(false);
      expect(saveConnection).toHaveBeenCalledOnce();
      expect(connections).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up on a call that waits on an add that never answers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const saveConnection = vi.fn(() => new Promise<ConnectionsView>(() => {}));
      const shell = { connections: vi.fn(async () => NO_CONNECTIONS), saveConnection };

      const hung = addWebSearch(shell).catch((error: Error) => error.message);
      await vi.advanceTimersByTimeAsync(ADD_LIMIT_MS);
      expect(await hung).toBe(strings.connections.webSearchTimedOut);
      const waiting = addWebSearch(shell).catch((error: Error) => error.message);
      await vi.advanceTimersByTimeAsync(ADD_LIMIT_MS);

      expect(await waiting).toBe(strings.connections.webSearchTimedOut);
      expect(saveConnection).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
