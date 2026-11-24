// What the daemon's log never shows (security audit M3, B8). `scrubbing-logger.ts` takes them out
// of every line; this module only says which values they are.
import type { Config } from './config.ts';

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

/** What the daemon can get after its start: a model login, or the OAuth state of connections. */
export type AcquiredKind = 'login' | 'oauth';

export interface SecretList {
  /** Every secret known now: those of the start and those acquired since. For the log. */
  current: () => readonly string[];
  /** Replaces the secrets of the start, as more of the configuration is read. */
  setFromStart: (secrets: readonly string[]) => void;
  /**
   * B42: adds the secrets of `value`, a login (one `Credential` or a set of them by provider)
   * or an OAuth set, by the same fields as the start's. The only way a later secret gets in.
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
      const found = stringLeaves(value, kind === 'login' ? isLoginSecret : isOAuthSecret);
      for (const secret of nonBlank(found)) acquired.add(secret);
    },
  };
};
