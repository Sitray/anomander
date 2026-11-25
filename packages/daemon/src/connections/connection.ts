// DK-11: a server the principal connected, as the daemon sees it once connected: its tools and
// a way to call one. `mcp-client.ts` makes them from MCP servers; tests make their own.

/** A tool as its server declares it. All of it is the server's own claim, never an instruction. */
export interface ToolInfo {
  name: string;
  description: string;
  /** The JSON Schema of its arguments. */
  inputSchema: Record<string, unknown>;
}

export interface ToolResult {
  /** The text the tool answered; what is not text is named, never carried. */
  text: string;
  isError: boolean;
}

export interface Connection {
  /** The server's name in the principal's configuration. */
  name: string;
  /**
   * DK-24 AC2: what the server is (`serverIdentity`): a "Permitir siempre" holds only for it.
   * Absent, the server cannot be told apart from another, and no call of it is ever granted.
   */
  identity?: string;
  tools: readonly ToolInfo[];
  /** The tools the principal marked as only reading: the only ones that may run unasked. */
  readOnly: ReadonlySet<string>;
  /**
   * By tool, the arguments that make a call ask even when the tool is read-only (T17); none when
   * absent. A call carrying any of them, whatever its value, waits for "Permitir".
   */
  asksWith?: Readonly<Record<string, readonly string[]>>;
  call(tool: string, args: Record<string, unknown>): Promise<ToolResult>;
}
