// DK-11, T17: the connections ANOMANDER offers ready-made, as the app adds them to `mcp.json`.

/** The npm package of the web search connection. */
export const WEB_SEARCH_PACKAGE = 'pi-web-access';

/**
 * B9: the one version of it that runs. The daemon depends on this exact version, so
 * `pnpm-lock.yaml` pins it and everything it brings, and a server that names it is started from
 * that installed copy (`packages/daemon/src/connections/web-search.ts`).
 */
export const WEB_SEARCH_VERSION = '0.48.0';

/**
 * Search the web without the computer: `pi-web-access` (MIT) as a local MCP server. `mcp.json`
 * keeps it as the `npx` line any MCP client can run, with its version in sight; the daemon does
 * not run `npx` for it: it starts the copy installed with it, whose dependencies the lockfile
 * pins, with its own `node`. Files written before keep working, since the line is the same.
 * Outside ANOMANDER, `-y` only lets `npx` fetch that version without a question nobody would
 * see, and `npm_config_ignore_scripts` keeps npm from running an install script of it or of what
 * it brings. With no key and no `web-search.json` it searches only through Exa's hosted MCP
 * (`mcp.exa.ai`).
 *
 * A search and paging through its stored results run without asking; reading a page always
 * asks, with its exact address, and so does a search that picks its provider, goes through a
 * proxy or reads the pages it found (`asksWith`). Once one has answered, no other server is
 * called unasked (DK-11 AC4). `source_check` asks.
 */
export const WEB_SEARCH_CONNECTION = {
  name: 'Internet',
  command: 'npx',
  args: ['-y', `${WEB_SEARCH_PACKAGE}@${WEB_SEARCH_VERSION}`],
  env: { npm_config_ignore_scripts: 'true' },
  readOnly: ['web_search', 'get_search_content'],
  /**
   * By tool, the arguments that make a call ask even when the tool is marked read-only. The
   * daemon applies them to any server that runs the package, whatever the file says.
   */
  asksWith: {
    web_search: ['provider', 'proxy', 'includeContent'],
    fetch_content: ['url', 'urls'],
  },
} as const satisfies {
  name: string;
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  readOnly: readonly string[];
  asksWith: Readonly<Record<string, readonly string[]>>;
};

/**
 * DK-11 AC12 (T8): remote MCP servers connected with one press. Each is saved by its address and
 * then connected with OAuth: the app registers itself with the server's authorization server
 * (dynamic client registration), as "Conectar con OAuth" does for any server. Atlassian is its
 * v2 endpoint, the one that publishes its protected-resource metadata. No tool is marked
 * read-only: every call waits for "Permitir" until the principal marks one by hand.
 */
export const OAUTH_CONNECTIONS = [
  { name: 'Notion', url: 'https://mcp.notion.com/mcp' },
  { name: 'Linear', url: 'https://mcp.linear.app/mcp' },
  { name: 'Atlassian', url: 'https://mcp.atlassian.com/v2/mcp' },
] as const satisfies readonly { name: string; url: string }[];

export type OAuthConnectionName = (typeof OAUTH_CONNECTIONS)[number]['name'];
