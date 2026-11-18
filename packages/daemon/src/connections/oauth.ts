import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import type { Logger } from '../processor/text-interpreter.ts';

// DK-11 OAuth: an HTTP server the principal connected with OAuth in the app. The app keeps the
// client and its tokens in the Keychain and hands them over at the daemon's start in
// `ANOMANDER_MCP_OAUTH`, one entry by server name. The daemon connects with them through the SDK's
// `authProvider`, and after a token refresh prints the whole set on one line of its output, which
// the app stores and never echoes, as it does the model login (DK-5 AC1).
//
// The daemon never opens a browser and never registers a client: a server whose tokens no longer
// work is left out until the principal connects it again in the app.

/** The start of the line the shell reads: `supervisor.rs` knows it too. */
export const MCP_OAUTH_LINE = 'anomander mcp-oauth ';

export interface OAuthEntry {
  client: OAuthClientInformationMixed;
  tokens: OAuthTokens;
  /** The address the client was registered with: its authorization server checks it. */
  redirectUrl: string;
}

export type OAuthSet = Record<string, OAuthEntry>;

/** What the app registers itself as: a public client, which proves itself with PKCE. */
export const clientMetadataFor = (redirectUrl: string): OAuthClientMetadata => ({
  client_name: 'ANOMANDER',
  redirect_uris: [redirectUrl],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
});

const entrySchema = z.looseObject({
  client: z.looseObject({ client_id: z.string().min(1) }),
  tokens: z.looseObject({ access_token: z.string().min(1), token_type: z.string().min(1) }),
  redirectUrl: z.string().min(1),
});

/** Prints the set for the shell, on one line: `JSON.stringify` writes no line break. */
export const printOAuthForShell =
  (write: (text: string) => void = (text) => process.stdout.write(text)) =>
  (entries: OAuthSet): void =>
    write(`${MCP_OAUTH_LINE}${JSON.stringify(entries)}\n`);

export interface OAuthKeeper {
  /** The provider of a server connected with OAuth; `undefined` for any other. */
  providerFor(server: string): OAuthClientProvider | undefined;
}

export const createOAuthKeeper = (
  initial: OAuthSet,
  send: (entries: OAuthSet) => void,
): OAuthKeeper => {
  let entries: OAuthSet = { ...initial };
  const change = (next: OAuthSet) => {
    send(next);
    entries = next;
  };

  return {
    providerFor: (server) => {
      const first = Object.hasOwn(entries, server) ? entries[server] : undefined;
      if (first === undefined) return undefined;
      // Kept after the tokens are dropped: the SDK must never register a new client here.
      const { client, redirectUrl } = first;
      // What else the app keeps in the entry (the server's address) stays as it was.
      const current = () => (Object.hasOwn(entries, server) ? entries[server] : undefined);
      return {
        get redirectUrl() {
          return redirectUrl;
        },
        get clientMetadata() {
          return clientMetadataFor(redirectUrl);
        },
        clientInformation: () => client,
        tokens: () => current()?.tokens,
        saveTokens: (tokens) => {
          change({ ...entries, [server]: { ...first, tokens } });
        },
        invalidateCredentials: () => {
          if (current() === undefined) return;
          const { [server]: _gone, ...rest } = entries;
          change(rest);
        },
        redirectToAuthorization: () => {
          throw new Error('connect the server with OAuth again in the app');
        },
        saveCodeVerifier: () => {},
        codeVerifier: () => {
          throw new Error('connect the server with OAuth again in the app');
        },
      };
    },
  };
};

/**
 * The keeper of what the app handed over. What is not a set, and every entry that is not one,
 * is left out and logged by server name: the text holds tokens and is never quoted.
 */
export const oauthKeeperFrom = (
  handed: string | undefined,
  send: (entries: OAuthSet) => void,
  logger: Logger,
): OAuthKeeper => {
  let parsed: unknown = {};
  if (handed !== undefined) {
    try {
      parsed = JSON.parse(handed);
    } catch {
      parsed = undefined;
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    logger.error('ANOMANDER_MCP_OAUTH is not a JSON object; no server is connected with OAuth');
    return createOAuthKeeper({}, send);
  }
  const entries: OAuthSet = {};
  for (const [server, entry] of Object.entries(parsed)) {
    const checked = entrySchema.safeParse(entry);
    if (checked.success) {
      entries[server] = checked.data as unknown as OAuthEntry;
    } else {
      logger.error('an OAuth entry is not valid; that server is connected without it', { server });
    }
  }
  return createOAuthKeeper(entries, send);
};

/**
 * `base` with a server's configured headers added to the requests for its own origin only: the
 * SDK sends its OAuth requests through the same fetch, and they may go to another origin.
 * Headers the request sets itself (the SDK's bearer token) win.
 */
export const originScopedFetch = (
  serverUrl: string,
  headers: Record<string, string>,
  base: FetchLike = fetch,
): FetchLike => {
  const origin = new URL(serverUrl).origin;
  return (url, init) => {
    const target = new URL(url instanceof URL ? url.href : String(url));
    if (target.origin !== origin) return base(url, init);
    const merged = new Headers(init?.headers);
    for (const [name, value] of Object.entries(headers)) {
      if (!merged.has(name)) merged.set(name, value);
    }
    return base(url, { ...init, headers: merged });
  };
};
