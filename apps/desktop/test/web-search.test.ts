import { WEB_SEARCH_CONNECTION } from '@anomander/protocol';
import { describe, expect, it, vi } from 'vitest';
import { addWebSearch, webSearchInput } from '../src/connections/web-search.ts';
import type { ConnectionInput, ConnectionsView } from '../src/shell.ts';
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
});
