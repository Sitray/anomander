import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

// DK-11 OAuth: an authorization server and an MCP server that asks for its tokens, on this machine
// only. The authorization server may run on its own origin, as real ones often do.

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

const close = async (server: Server) => {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
};

const body = async (request: IncomingMessage): Promise<string> => {
  let text = '';
  for await (const chunk of request) text += chunk;
  return text;
};

const challengeOf = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

export interface SeenRequest {
  origin: 'mcp' | 'auth';
  method: string;
  path: string;
  /** Every header but the standard ones, by lowercase name. */
  headers: Record<string, string>;
  body: string;
}

export interface OAuthFixture {
  /** The MCP server's address. */
  mcpUrl: string;
  /** The authorization server's origin. */
  authBase: string;
  seen: SeenRequest[];
  /** The access token the MCP server takes now. */
  access(): string;
  /** The refresh token the authorization server takes now; `undefined` once revoked. */
  refresh(): string | undefined;
  /** From now on the access token is refused, as after it expired. */
  expireAccess(): void;
  /** From now on the refresh token is refused too. */
  revokeRefresh(): void;
  close(): Promise<void>;
}

const STANDARD = new Set([
  'host',
  'connection',
  'content-length',
  'content-type',
  'accept',
  'accept-encoding',
  'accept-language',
  'user-agent',
  'sec-fetch-mode',
  'mcp-protocol-version',
]);

/** `separateOrigin`: the authorization server listens on another port than the MCP server. */
export const startOAuthServer = async (
  options: { separateOrigin?: boolean } = {},
): Promise<OAuthFixture> => {
  const seen: SeenRequest[] = [];
  let generation = 1;
  let accessValid = true;
  let refreshValid = true;
  /** What each code was issued for. */
  const codes = new Map<string, { challenge: string; redirectUri: string; clientId: string }>();
  let mcpUrl = '';
  let authBase = '';

  const record = async (origin: 'mcp' | 'auth', request: IncomingMessage) => {
    const text = await body(request);
    const headers = Object.fromEntries(
      Object.entries(request.headers)
        .filter(([name]) => !STANDARD.has(name))
        .map(([name, value]) => [name, String(value)]),
    );
    const url = new URL(request.url ?? '/', 'http://localhost');
    seen.push({ origin, method: request.method ?? '', path: url.pathname, headers, body: text });
    return { text, url };
  };

  const json = (response: import('node:http').ServerResponse, status: number, value: unknown) =>
    response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));

  const auth = async (
    request: IncomingMessage,
    response: import('node:http').ServerResponse,
  ): Promise<void> => {
    const { text, url } = await record('auth', request);
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      json(response, 200, {
        issuer: authBase,
        authorization_endpoint: `${authBase}/authorize`,
        token_endpoint: `${authBase}/token`,
        registration_endpoint: `${authBase}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
      return;
    }
    if (url.pathname === '/register' && request.method === 'POST') {
      const asked = JSON.parse(text) as Record<string, unknown>;
      json(response, 201, { ...asked, client_id: 'client-1', client_id_issued_at: 1 });
      return;
    }
    if (url.pathname === '/authorize') {
      // The browser's part: the test plays the principal with `authorize`.
      const code = `code-${codes.size + 1}`;
      codes.set(code, {
        challenge: url.searchParams.get('code_challenge') ?? '',
        redirectUri: url.searchParams.get('redirect_uri') ?? '',
        clientId: url.searchParams.get('client_id') ?? '',
      });
      const back = new URL(url.searchParams.get('redirect_uri') ?? '');
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      response.writeHead(302, { Location: back.href }).end();
      return;
    }
    if (url.pathname === '/token' && request.method === 'POST') {
      const form = new URLSearchParams(text);
      if (form.get('grant_type') === 'authorization_code') {
        const issued = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        if (
          issued === undefined ||
          issued.challenge !== challengeOf(form.get('code_verifier') ?? '') ||
          issued.redirectUri !== form.get('redirect_uri') ||
          issued.clientId !== form.get('client_id')
        ) {
          json(response, 400, { error: 'invalid_grant' });
          return;
        }
      } else if (form.get('grant_type') === 'refresh_token') {
        if (!refreshValid || form.get('refresh_token') !== `refresh-${generation}`) {
          json(response, 400, { error: 'invalid_grant' });
          return;
        }
        generation += 1;
        accessValid = true;
      } else {
        json(response, 400, { error: 'unsupported_grant_type' });
        return;
      }
      json(response, 200, {
        access_token: `access-${generation}`,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: `refresh-${generation}`,
      });
      return;
    }
    response.writeHead(404).end();
  };

  const mcp = async (
    request: IncomingMessage,
    response: import('node:http').ServerResponse,
  ): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/.well-known/oauth-protected-resource') {
      await record('mcp', request);
      json(response, 200, { resource: mcpUrl, authorization_servers: [authBase] });
      return;
    }
    if (url.pathname !== '/mcp') {
      // One origin for both: the rest is the authorization server's.
      if (options.separateOrigin !== true) {
        await auth(request, response);
        return;
      }
      await record('mcp', request);
      response.writeHead(404).end();
      return;
    }
    if (!accessValid || request.headers.authorization !== `Bearer access-${generation}`) {
      await record('mcp', request);
      response
        .writeHead(401, {
          'WWW-Authenticate': `Bearer resource_metadata="${new URL(mcpUrl).origin}/.well-known/oauth-protected-resource"`,
        })
        .end();
      return;
    }
    seen.push({
      origin: 'mcp',
      method: request.method ?? '',
      path: url.pathname,
      headers: Object.fromEntries(
        Object.entries(request.headers)
          .filter(([name]) => !STANDARD.has(name))
          .map(([name, value]) => [name, String(value)]),
      ),
      body: '',
    });
    const server = new McpServer({ name: 'remote', version: '1.0.0' });
    server.registerTool(
      'search',
      { description: 'Searches', inputSchema: { query: z.string() } },
      async ({ query }) => ({ content: [{ type: 'text', text: `found: ${query}` }] }),
    );
    const transport = new StreamableHTTPServerTransport({});
    response.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request, response);
  };

  const mcpServer = createServer((request, response) => void mcp(request, response));
  const mcpBase = await listen(mcpServer);
  mcpUrl = `${mcpBase}/mcp`;
  let authServer: Server | undefined;
  if (options.separateOrigin === true) {
    authServer = createServer((request, response) => void auth(request, response));
    authBase = await listen(authServer);
  } else {
    authBase = mcpBase;
  }

  return {
    mcpUrl,
    authBase,
    seen,
    access: () => `access-${generation}`,
    refresh: () => (refreshValid ? `refresh-${generation}` : undefined),
    expireAccess: () => {
      accessValid = false;
    },
    revokeRefresh: () => {
      refreshValid = false;
    },
    close: async () => {
      await close(mcpServer);
      if (authServer !== undefined) await close(authServer);
    },
  };
};

/**
 * The principal's part in the browser: opens the authorization address, lets the server send
 * them back, and follows that redirect to the app. Returns the page the app answered.
 */
export const authorize = async (
  address: string,
  change?: (back: URL) => URL,
): Promise<{ status: number; text: string }> => {
  const sent = await fetch(address, { redirect: 'manual' });
  const location = sent.headers.get('location');
  if (location === null) throw new Error(`the authorization server answered ${sent.status}`);
  const back = change === undefined ? new URL(location) : change(new URL(location));
  const answered = await fetch(back);
  return { status: answered.status, text: await answered.text() };
};
