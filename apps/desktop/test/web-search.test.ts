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
});
