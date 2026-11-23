// DK-11 AC11: the web search connection, as the setup, the chat and Conexiones add it.
import { WEB_SEARCH_CONNECTION } from '@anomander/protocol';
import type { ConnectionInput, ConnectionsView } from '../shell.ts';

/** The server `Internet` as `mcp.json` gets it: the preset, whole. */
export const webSearchInput = (): ConnectionInput => {
  const { name, command, args, env, readOnly } = WEB_SEARCH_CONNECTION;
  return {
    name,
    kind: 'process',
    command,
    args: [...args],
    values: Object.entries(env).map(([valueName, value]) => ({ name: valueName, value })),
    readOnly: [...readOnly],
  };
};

/** Once a server has the preset's name it is the web search, edited or removed like any other. */
export const hasWebSearch = (view: ConnectionsView): boolean =>
  view.servers.some((server) => server.name === WEB_SEARCH_CONNECTION.name);

export interface WebSearchShell {
  connections: () => Promise<ConnectionsView>;
  saveConnection: (server: ConnectionInput) => Promise<ConnectionsView>;
}

/** Adds the web search, unless a server already has its name; rejects with the shell's message. */
export const addWebSearch = async (shell: WebSearchShell): Promise<void> => {
  if (hasWebSearch(await shell.connections())) return;
  await shell.saveConnection(webSearchInput());
};
