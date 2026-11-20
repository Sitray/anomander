// A stand-in for `pi-web-access` over stdio, started by `test/desktop/local-channel.test.ts`
// with the web search connection's read-only tools (T17). It reaches nothing: each tool answers
// what it was asked, so a test can see the call arrived.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'pi-web-access', version: '0.48.0' });
server.registerTool(
  'web_search',
  {
    description: 'Search the web for sources or answers. Full results are stored for later.',
    inputSchema: { query: z.string() },
  },
  async ({ query }) => ({ content: [{ type: 'text', text: `results for: ${query}` }] }),
);
server.registerTool(
  'fetch_content',
  { description: 'Fetch web pages.', inputSchema: { url: z.string() } },
  async ({ url }) => ({ content: [{ type: 'text', text: `page: ${url}` }] }),
);
server.registerTool(
  'source_check',
  { description: 'Gather cited web passages about a claim.', inputSchema: { claim: z.string() } },
  async ({ claim }) => ({ content: [{ type: 'text', text: `checked: ${claim}` }] }),
);
await server.connect(new StdioServerTransport());
