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

/** Every string anywhere in `value`, however deep, or only those of the fields `named`. */
const stringLeaves = (value: unknown, named?: ReadonlySet<string>): string[] => {
  if (typeof value === 'string') return named === undefined ? [value] : [];
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([name, inner]) =>
    named?.has(name) && typeof inner === 'string' ? [inner] : stringLeaves(inner, named),
  );
};

/**
 * The fields of the model login that hold a secret (pi-ai's `Credential`, the shape of
 * `auth.json`): the rest is metadata such as `enterpriseUrl` or an account ID.
 */
const LOGIN_SECRETS = new Set(['key', 'access', 'refresh']);

/**
 * The fields of a connection's OAuth state that hold a secret: the rest, such as the client's
 * name, its grant types, its redirect address or the server's, is ordinary text.
 */
const OAUTH_SECRETS = new Set(['access_token', 'refresh_token', 'id_token', 'client_secret']);

/**
 * The secrets of a variable that holds JSON: every string in it, however deep, or only those of
 * the fields `named`. When it is not JSON nothing reads it, yet it may still hold tokens, so the
 * whole of it is one.
 */
const jsonSecrets = (raw: string | undefined, named?: ReadonlySet<string>): string[] => {
  if (raw === undefined) return [];
  try {
    return stringLeaves(JSON.parse(raw), named);
  } catch {
    return [raw];
  }
};

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
  const providerKeys = Object.entries(env)
    .filter(([name]) => PROVIDER_KEY.test(name) || PROVIDER_CREDENTIALS.has(name))
    .map(([, value]) => value);
  return [
    config.telegram?.botToken,
    config.apiToken,
    config.localToken,
    ...providerKeys,
    // The Keychain items by name: every value is secret, no name is.
    ...jsonSecrets(config.mcpSecrets),
    ...jsonSecrets(config.authJson, LOGIN_SECRETS),
    ...jsonSecrets(config.mcpOAuth, OAUTH_SECRETS),
  ].filter((secret): secret is string => secret !== undefined && secret.trim() !== '');
};
