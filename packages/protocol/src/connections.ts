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
