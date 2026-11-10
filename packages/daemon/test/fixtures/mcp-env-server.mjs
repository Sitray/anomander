// A real MCP server over stdio, started by `test/connections/mcp-client.test.ts`: its one tool
// answers the names of the environment variables this process was given.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'env', version: '1.0.0' });
server.registerTool(
  'names',
  { description: 'The names of my environment variables' },
  async () => ({
    content: [{ type: 'text', text: Object.keys(process.env).sort().join(',') }],
  }),
);
await server.connect(new StdioServerTransport());
