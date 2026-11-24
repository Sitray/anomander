// DK-11 AC11: the web search connection, as the setup, the chat and Conexiones add it.
import { WEB_SEARCH_CONNECTION } from '@anomander/protocol';
import type { ConnectionInput, ConnectionsView } from '../shell.ts';
import { strings } from '../strings.ts';

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

/**
 * An add that has not answered by then is given up on: the window can add again, and the setup
 * says it could not (DK-11 AC13). A save reads `mcp.json` and restarts the daemon; it never takes
 * this long unless the shell is stuck.
 */
export const ADD_LIMIT_MS = 30_000;

/** The add under way: there is one `mcp.json`, so one add at a time for the whole window. */
let adding: { shell: WebSearchShell; promise: Promise<boolean> } | null = null;

/** The same shell, though handed as a new object: the window builds one per call. */
const sameShell = (one: WebSearchShell, other: WebSearchShell): boolean =>
  one.connections === other.connections && one.saveConnection === other.saveConnection;

/** One add through `shell`, rejected once `ADD_LIMIT_MS` passed without an answer. */
const addOnce = (shell: WebSearchShell): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(strings.connections.webSearchTimedOut)),
      ADD_LIMIT_MS,
    );
  });
  const add = (async () => {
    if (hasWebSearch(await shell.connections())) return false;
    await shell.saveConnection(webSearchInput());
    return true;
  })();
  return Promise.race([add, limit]).finally(() => clearTimeout(timer));
};

/**
 * Adds the web search, unless a server already has its name: `true` when it was saved, which
 * starts the daemon again. Rejects with the shell's message, or after `ADD_LIMIT_MS` without an
 * answer. A call through the same shell while an add is under way joins it, so the file is saved
 * and the daemon restarted once; a call through another shell adds after it, with its own.
 */
export const addWebSearch = (shell: WebSearchShell): Promise<boolean> => {
  if (adding !== null && sameShell(adding.shell, shell)) return adding.promise;
  // Started at once when nothing is under way: the file is read before the call returns.
  const started =
    adding === null ? addOnce(shell) : adding.promise.catch(() => {}).then(() => addOnce(shell));
  const current = {
    shell,
    promise: started.finally(() => {
      if (adding === current) adding = null;
    }),
  };
  adding = current;
  return current.promise;
};
