import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
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
//
// RFC 9207: the redirect names the authorization server that sent it (`iss`), so a code from
// another server is never sent to this one's token endpoint (mix-up). When the server's metadata
// says it sends `iss`, the redirect must carry it; when the redirect carries one, it must be the
// metadata's `issuer`. Otherwise the login fails.

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

type Answer = { code: string } | { error: string } | { wrongIssuer: true };

/** The authorization server's metadata as it was served. */
type RawMetadata = Record<string, unknown>;

/**
 * Whether the redirect's `iss` (RFC 9207 §2.4) is the authorization server's own. `discovered`
 * says the SDK found metadata: if the document as served was not kept, whether the server sends
 * `iss` is unknown, and a redirect without one fails.
 */
const issuerAccepted = (
  metadata: RawMetadata | undefined,
  discovered: boolean,
  iss: string | null,
): boolean => {
  if (iss === null) {
    if (metadata === undefined) return !discovered;
    return metadata.authorization_response_iss_parameter_supported !== true;
  }
  return typeof metadata?.issuer === 'string' && iss === metadata.issuer;
};

const METADATA_PATHS = [
  '/.well-known/oauth-authorization-server',
  '/.well-known/openid-configuration',
] as const;

/**
 * A plain fetch that keeps the first authorization server metadata it gets, the one the SDK
 * takes. The SDK drops the fields it does not know from OpenID discovery metadata, RFC 9207's
 * among them, so the check reads the document as served. The SDK follows a same-origin redirect
 * itself, through this fetch again, so the address a metadata address redirects to counts too.
 */
const keepingMetadata = (keep: (metadata: RawMetadata) => void) => {
  const redirectedTo = new Set<string>();
  return async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const response = await fetch(input, init);
    const address = new URL(input);
    const isMetadata =
      redirectedTo.has(address.href) ||
      METADATA_PATHS.some(
        (path) => address.pathname.startsWith(path) || address.pathname.endsWith(path),
      );
    const location = response.headers.get('location');
    if (isMetadata && response.status >= 300 && response.status < 400 && location !== null) {
      redirectedTo.add(new URL(location, address).href);
    }
    if (response.ok && isMetadata) {
      try {
        const metadata: unknown = await response.clone().json();
        if (typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)) {
          keep(metadata as RawMetadata);
        }
      } catch {
        // Not JSON: the SDK refuses it on its own.
      }
    }
    return response;
  };
};

const page = (text: string) =>
  `<!doctype html><html lang="es"><meta charset="utf-8"><title>ANOMANDER</title><p>${text}</p></html>`;

/**
 * Listens on a free port of `127.0.0.1` for the one redirect that carries `state`; `accepts`
 * judges its `iss`.
 */
const listenForRedirect = async (state: string, accepts: (iss: string | null) => boolean) => {
  let answered: (answer: Answer) => void = () => {};
  const answer = new Promise<Answer>((resolve) => {
    answered = resolve;
  });
  const server: Server = createServer((request, response) => {
    const reply = (status: number, text: string) =>
      response
        .writeHead(status, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
        })
        .end(page(text));
    // A request target that is not a URL must not end the wait.
    const url = URL.parse(request.url ?? '/', 'http://127.0.0.1');
    if (url === null) {
      reply(400, PAGES.wrong);
      return;
    }
    if (request.method !== 'GET' || url.pathname !== '/callback') {
      reply(404, PAGES.wrong);
      return;
    }
    // Any other page could send the browser here: only the right state counts.
    if (url.searchParams.get('state') !== state) {
      reply(400, PAGES.wrong);
      return;
    }
    // The right state from the wrong server: the login is over, and its code is never used.
    if (!accepts(url.searchParams.get('iss'))) {
      reply(400, PAGES.refused);
      answered({ wrongIssuer: true });
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
  // What the SDK discovered, kept so the code goes back to the server whose `iss` was checked.
  let discovery: OAuthDiscoveryState | undefined;
  let metadata: RawMetadata | undefined;
  const fetchFn = keepingMetadata((served) => {
    metadata ??= served;
  });
  const redirect = await listenForRedirect(state, (iss) =>
    issuerAccepted(metadata, discovery?.authorizationServerMetadata !== undefined, iss),
  );
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
      saveDiscoveryState: (saved) => {
        discovery = saved;
      },
      discoveryState: () => discovery,
    };

    const started = await auth(provider, { serverUrl: url, fetchFn });
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
      if ('wrongIssuer' in answer) {
        throw new Error('the redirect came from another authorization server');
      }
      if ('error' in answer) return { kind: 'denied' };
      await auth(provider, { serverUrl: url, authorizationCode: answer.code, fetchFn });
    }
    if (client === undefined || tokens === undefined) {
      throw new Error('the server gave no tokens');
    }
    return { kind: 'connected', entry: { client, tokens, redirectUrl: redirect.redirectUrl } };
  } finally {
    await redirect.close();
  }
};
