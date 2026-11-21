// DK-11, T17: the connections ANOMANDER offers ready-made, as the app adds them to `mcp.json`.

/** The npm package of the web search connection. */
export const WEB_SEARCH_PACKAGE = 'pi-web-access';

/**
 * Search the web without the computer: `pi-web-access` (MIT) as a local MCP server. Pinned, so
 * what runs is the version that was read, never whatever npm calls latest; `-y` only lets `npx`
 * fetch that version without a question nobody would see, and `npm_config_ignore_scripts` keeps
 * npm from running an install script of it or of what it brings (those are not pinned). With no
 * key and no `web-search.json` it searches only through Exa's hosted MCP (`mcp.exa.ai`).
 *
 * A search and paging through its stored results run without asking; reading a page always
 * asks, with its exact address, and so does a search that picks its provider, goes through a
 * proxy or reads the pages it found (`asksWith`). Once one has answered, no other server is
 * called unasked (DK-11 AC4). `source_check` asks.
 */
export const WEB_SEARCH_CONNECTION = {
  name: 'Internet',
  command: 'npx',
  args: ['-y', `${WEB_SEARCH_PACKAGE}@0.48.0`],
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
