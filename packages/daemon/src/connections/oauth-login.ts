import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { clientMetadataFor, type OAuthEntry } from './oauth.ts';

// DK-11 OAuth: the app connecting itself to an HTTP server that asks for OAuth, run by the shell
// (`scripts/mcp-oauth.ts`), never by the daemon. The SDK finds the server's authorization server,
// registers the app with it (dynamic registration) and does the code flow with PKCE. The
// principal opens the authorization address in their browser, which comes back to a port of this
// machine, open only while this waits. The tokens go to the caller, which stores them.
//
// Requests go through a plain fetch: the server's configured headers never reach its
// authorization server.

export type OAuthOutcome =
  | { kind: 'connected'; entry: OAuthEntry }
  | { kind: 'denied' }
  | { kind: 'timed_out' };

export interface OAuthLoginOptions {
  /** The MCP server's address. */
  url: string;
  /** Has the principal open the authorization address. */
  open: (address: string) => Promise<void>;
  /** How long the principal has to come back. Default 5 minutes. */
  timeoutMs?: number;
}

export const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

/** The pages the browser shows when it comes back (es-ES, as the app). */
const PAGES = {
  connected: 'Ya puedes cerrar esta pestaña y volver a ANOMANDER.',
  refused: 'ANOMANDER no se ha conectado. Puedes cerrar esta pestaña.',
  wrong: 'Esta dirección no es para ANOMANDER.',
} as const;

type Answer = { code: string } | { error: string };

const page = (text: string) =>
  `<!doctype html><html lang="es"><meta charset="utf-8"><title>ANOMANDER</title><p>${text}</p></html>`;

/** Listens on a free port of `127.0.0.1` for the one redirect that carries `state`. */
const listenForRedirect = async (state: string) => {
  let answered: (answer: Answer) => void = () => {};
  const answer = new Promise<Answer>((resolve) => {
    answered = resolve;
  });
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const reply = (status: number, text: string) =>
      response
        .writeHead(status, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
        })
        .end(page(text));
    if (request.method !== 'GET' || url.pathname !== '/callback') {
      reply(404, PAGES.wrong);
      return;
    }
    // Any other page could send the browser here: only the right state counts.
    if (url.searchParams.get('state') !== state) {
      reply(400, PAGES.wrong);
      return;
    }
    const code = url.searchParams.get('code');
    if (code !== null && code !== '') {
      reply(200, PAGES.connected);
      answered({ code });
      return;
    }
    reply(200, PAGES.refused);
    answered({ error: url.searchParams.get('error') ?? 'no_code' });
  });
  await new Promise<void>((done, failed) => {
    server.once('error', failed);
    server.listen(0, '127.0.0.1', done);
  });
  const { port } = server.address() as AddressInfo;
  return {
    redirectUrl: `http://127.0.0.1:${port}/callback`,
    answer,
    close: async () => {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
};

export const connectWithOAuth = async (options: OAuthLoginOptions): Promise<OAuthOutcome> => {
  const { url, open, timeoutMs = OAUTH_TIMEOUT_MS } = options;
  const state = randomBytes(32).toString('base64url');
  const redirect = await listenForRedirect(state);
  try {
    let client: OAuthClientInformationMixed | undefined;
    let tokens: OAuthTokens | undefined;
    let verifier: string | undefined;
    let address: URL | undefined;
    const provider: OAuthClientProvider = {
      get redirectUrl() {
        return redirect.redirectUrl;
      },
      get clientMetadata() {
        return clientMetadataFor(redirect.redirectUrl);
      },
      state: () => state,
      clientInformation: () => client,
      saveClientInformation: (information) => {
        client = information;
      },
      tokens: () => tokens,
      saveTokens: (saved) => {
        tokens = saved;
      },
      redirectToAuthorization: (authorizationUrl) => {
        address = authorizationUrl;
      },
      saveCodeVerifier: (saved) => {
        verifier = saved;
      },
      codeVerifier: () => {
        if (verifier === undefined) throw new Error('no code verifier');
        return verifier;
      },
    };

    const started = await auth(provider, { serverUrl: url, fetchFn: fetch });
    if (started === 'REDIRECT') {
      if (address === undefined) throw new Error('the server gave no authorization address');
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<'late'>((done) => {
        timer = setTimeout(() => done('late'), timeoutMs);
      });
      // Waiting already: the browser may come back before `open` returns.
      const waited = Promise.race([redirect.answer, late]);
      await open(address.href);
      const answer = await waited;
      clearTimeout(timer);
      if (answer === 'late') return { kind: 'timed_out' };
      if ('error' in answer) return { kind: 'denied' };
      await auth(provider, { serverUrl: url, authorizationCode: answer.code, fetchFn: fetch });
    }
    if (client === undefined || tokens === undefined) {
      throw new Error('the server gave no tokens');
    }
    return { kind: 'connected', entry: { client, tokens, redirectUrl: redirect.redirectUrl } };
  } finally {
    await redirect.close();
  }
};
