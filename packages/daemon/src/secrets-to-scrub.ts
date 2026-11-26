// What the daemon's log never shows (security audit M3, B8). `scrubbing-logger.ts` takes them out
// of every line; this module only says which values they are.
import type { CredentialStore } from '@earendil-works/pi-ai';
import { rememberingLogins } from './auth/remembering-logins.ts';
import { credentialStoreFor } from './auth/shell-credential-store.ts';
import type { Config } from './config.ts';
import { type OAuthSet, printOAuthForShell } from './connections/oauth.ts';

/** A provider key as the desktop app names it, such as `OPENAI_API_KEY` (`setup.rs`). */
const PROVIDER_KEY = /^[A-Z][A-Z0-9_]*_API_KEY$/;

/** The other variables pi-ai reads a model provider's credential from (`env-api-keys.js`). */
const PROVIDER_CREDENTIALS = new Set([
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_OAUTH_TOKEN',
  'COPILOT_GITHUB_TOKEN',
  'HF_TOKEN',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
]);

/** Whether a variable named `name` holds a model provider's credential. */
const isProviderCredential = (name: string): boolean =>
  PROVIDER_KEY.test(name) || PROVIDER_CREDENTIALS.has(name);

/** Every string anywhere in `value`, however deep, or only those of the fields `named` accepts. */
const stringLeaves = (value: unknown, named?: (name: string) => boolean): string[] => {
  if (typeof value === 'string') return named === undefined ? [value] : [];
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([name, inner]) =>
    named?.(name) && typeof inner === 'string' ? [inner] : stringLeaves(inner, named),
  );
};

/**
 * The fields of the model login that hold a secret (pi-ai's `Credential`, the shape of
 * `auth.json`): its `key`, `access` and `refresh`, and in the `env` of an API-key login the
 * variables named as a provider credential, such as `AWS_SECRET_ACCESS_KEY`. The rest is
 * metadata such as `enterpriseUrl` or an account ID.
 */
const LOGIN_FIELDS = new Set(['key', 'access', 'refresh']);
const isLoginSecret = (name: string): boolean =>
  LOGIN_FIELDS.has(name) || isProviderCredential(name);

/**
 * The fields of a connection's OAuth state that hold a secret: the rest, such as the client's
 * name, its grant types, its redirect address or the server's, is ordinary text.
 */
const OAUTH_FIELDS = new Set(['access_token', 'refresh_token', 'id_token', 'client_secret']);
const isOAuthSecret = (name: string): boolean => OAUTH_FIELDS.has(name);

/**
 * The secrets of a variable that holds JSON: every string in it, however deep, or only those of
 * the fields `named`. When it is not JSON nothing reads it, yet it may still hold tokens, so the
 * whole of it is one.
 */
const jsonSecrets = (raw: string | undefined, named?: (name: string) => boolean): string[] => {
  if (raw === undefined) return [];
  try {
    return stringLeaves(JSON.parse(raw), named);
  } catch {
    return [raw];
  }
};

/**
 * A token field as a JSON text quotes it, such as `"access_token":"…"` of a token response or
 * `"refresh":"…"` of a login, its value still escaped and its closing quote, when there is one,
 * captured apart. Read from text, so a response that is not JSON still gives its tokens up.
 */
const QUOTED_TOKEN =
  /"(?:access_token|refresh_token|id_token|access|refresh)"\s*:\s*"((?:[^"\\]|\\.)*)("?)/g;

/**
 * A token field of a form, such as `access_token=…&` of a token response, its value still
 * URL-encoded.
 */
const FORM_TOKEN = /(?<![\w])(?:access_token|refresh_token|id_token)=([^&\s"';,]+)/g;

/** The characters a token is written with: base64url, a JWT's dots, `/`, `+`, `=` and `~`. */
const TOKEN_START = /^[\w.~+/=-]+/;

/** A form's value, decoded; as written when it does not decode. */
const formDecoded = (encoded: string): string => {
  try {
    return decodeURIComponent(encoded.replaceAll('+', ' '));
  } catch {
    return encoded;
  }
};

/**
 * The tokens `text` quotes as JSON or as a form. A JSON value with no closing quote was cut short,
 * as in a body that did not parse: its token is what it starts with, up to the first character no
 * token holds.
 */
const tokensIn = (text: string): string[] => [
  ...[...text.matchAll(QUOTED_TOKEN)].map(([, token = '', closed]) =>
    closed === '"' ? unquoted(token) : (TOKEN_START.exec(token)?.[0] ?? ''),
  ),
  ...[...text.matchAll(FORM_TOKEN)].map(([, token = '']) => formDecoded(token)),
];

/** The token a JSON string holds, unescaped; as written when it does not read as JSON. */
const unquoted = (escaped: string): string => {
  try {
    return String(JSON.parse(`"${escaped}"`));
  } catch {
    return escaped;
  }
};

/**
 * B82: the fields of a failure that hold a secret: those of a login and of an OAuth set, but for
 * `key` and `*_API_KEY`. A failed refresh has no API key to quote, so those are ordinary text
 * there (`key: 'openai-codex'` names the provider); a provider key of the environment is already
 * one of the start's. The other provider credentials, such as `AWS_SESSION_TOKEN`, stay secret.
 */
const isFailureSecret = (name: string): boolean =>
  name === 'access' || name === 'refresh' || PROVIDER_CREDENTIALS.has(name) || isOAuthSecret(name);

/**
 * B51: the tokens a failure quotes, however deep: in a field named as a secret (`isFailureSecret`),
 * or quoted as JSON or as a form in any text of it, its message and its causes included (an
 * `Error` keeps those out of its own fields). A failed refresh's error may quote the tokens it got.
 */
const quotedTokens = (value: unknown, seen = new Set<object>()): string[] => {
  if (typeof value === 'string') return tokensIn(value);
  if (typeof value !== 'object' || value === null || seen.has(value)) return [];
  seen.add(value);
  const own: [string, unknown][] =
    value instanceof Error
      ? [
          ['message', value.message],
          ['cause', value.cause],
          ...(value instanceof AggregateError
            ? [['errors', value.errors] as [string, unknown]]
            : []),
        ]
      : [];
  return [...own, ...Object.entries(value)].flatMap(([name, inner]) =>
    typeof inner === 'string' && isFailureSecret(name) ? [inner] : quotedTokens(inner, seen),
  );
};

/** A blank value is never a secret: it would match everywhere. */
const nonBlank = (secrets: readonly (string | undefined)[]): string[] =>
  secrets.filter((secret): secret is string => secret !== undefined && secret.trim() !== '');

/** Every model provider's key or credential in `env`. */
const providerKeysOf = (env: Record<string, string | undefined>): (string | undefined)[] =>
  Object.entries(env)
    .filter(([name]) => isProviderCredential(name))
    .map(([, value]) => value);

/**
 * What is known before the configuration is read (B45, R1-002): every provider key of `env` and
 * every value `handed` over on stdin, which holds secrets only, each taken whole.
 */
export const secretsBeforeConfig = (
  env: Record<string, string | undefined>,
  handed: Record<string, string> = {},
): string[] => [...new Set(nonBlank([...providerKeysOf(env), ...Object.values(handed)]))];

/**
 * Every secret of `config` and of `env`, the environment with the handover laid over it as
 * `loadConfig` read it: the configuration's tokens, every model provider's key, every string of
 * `ANOMANDER_MCP_SECRETS`, and the keys and tokens of the model login and of the connections'
 * OAuth. A blank value is never one: it would match everywhere.
 */
export const secretsToScrub = (
  config: Config,
  env: Record<string, string | undefined>,
): string[] => {
  return nonBlank([
    config.telegram?.botToken,
    config.apiToken,
    config.localToken,
    ...providerKeysOf(env),
    // The Keychain items by name: every value is secret, no name is.
    ...jsonSecrets(config.mcpSecrets),
    ...jsonSecrets(config.authJson, isLoginSecret),
    ...jsonSecrets(config.mcpOAuth, isOAuthSecret),
  ]);
};

/**
 * What the daemon can get after its start: a model login, the OAuth state of connections, or a
 * failure that may quote new tokens it never got whole (B51).
 */
export type AcquiredKind = 'login' | 'oauth' | 'failure';

export interface SecretList {
  /** Every secret known now: those of the start and those acquired since. For the log. */
  current: () => readonly string[];
  /** Replaces the secrets of the start, as more of the configuration is read. */
  setFromStart: (secrets: readonly string[]) => void;
  /**
   * B42: adds the secrets of `value`, a login (one `Credential` or a set of them by provider)
   * or an OAuth set, by the same fields as the start's, or the tokens a failure quotes (B51).
   * The only way a later secret gets in.
   */
  acquire: (kind: AcquiredKind, value: unknown) => void;
}

/**
 * The secrets the log hides. Those acquired are kept for the life of the daemon: a rotated
 * token may still be valid, and a line may quote it.
 */
export const createSecretList = (): SecretList => {
  let start: readonly string[] = [];
  const acquired = new Set<string>();
  return {
    current: () => (acquired.size === 0 ? start : [...start, ...acquired]),
    setFromStart: (secrets) => {
      start = [...secrets];
    },
    acquire: (kind, value) => {
      const found =
        kind === 'failure'
          ? quotedTokens(value)
          : stringLeaves(value, kind === 'login' ? isLoginSecret : isOAuthSecret);
      for (const secret of nonBlank(found)) acquired.add(secret);
    },
  };
};

/**
 * What `main.ts` hands the daemon, wired to `list` (B42): the model login's store, which tells it
 * every login it reads or writes, and the printer of the connections' OAuth set, which tells it
 * a refreshed set before the shell gets it. `write` is the daemon's output.
 */
export const secretTellingStores = (
  list: SecretList,
  config: Pick<Config, 'authJson' | 'authPath'>,
  write?: (text: string) => void,
): { credentials: CredentialStore; printOAuth: (entries: OAuthSet) => void } => {
  const print = printOAuthForShell(write);
  return {
    credentials: rememberingLogins(credentialStoreFor(config, write), list.acquire),
    printOAuth: (entries) => {
      list.acquire('oauth', entries);
      print(entries);
    },
  };
};
