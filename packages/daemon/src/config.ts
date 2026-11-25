import { BlockList, isIP } from 'node:net';
import { DEFAULT_CURRENCY, hasCents, isCurrency, type Locale } from '@anomander/protocol';
import { z } from 'zod';

// PRD §14.4, plus the read API of the read access draft (docs/read-access-prd.md §8). Every
// variable and default of the configuration table; secrets come only from the environment (`.env`)
// or, under the desktop app, from the line it hands over on stdin (DK-5 AC2, `supervised.ts`),
// which `main.ts` lays over the environment before calling `loadConfig`.

/** A provider-qualified model ID such as `openai/gpt-4o-mini` (R-15 AC1). */
export interface ModelId {
  provider: string;
  id: string;
}

/** Splits at the first `/`: `openrouter/anthropic/x` is provider `openrouter`, id `anthropic/x`. */
export const parseModelId = (value: string): ModelId => {
  const slash = value.indexOf('/');
  const provider = value.slice(0, slash);
  const id = value.slice(slash + 1);
  if (slash < 0 || provider === '' || id === '') {
    throw new Error(`model ID must be provider-qualified, as in openai/gpt-4o-mini: ${value}`);
  }
  return { provider, id };
};

/** Telegram's front door: both variables, or neither. */
export interface TelegramConfig {
  botToken: string;
  /** `ANOMANDER_PRINCIPAL_CHAT_ID`. */
  principalChatId: number;
}

export interface Config {
  /**
   * `TELEGRAM_BOT_TOKEN` and `ANOMANDER_PRINCIPAL_CHAT_ID`. While unset, nothing polls or sends to
   * Telegram, and the local channel (`localToken`) is the only front door.
   */
  telegram: TelegramConfig | undefined;
  dbPath: string;
  /** Unset until `.env` names it; the daemon then starts the setup guide instead (R-28). */
  model: ModelId | undefined;
  visionModel: ModelId | undefined;
  dailyAiCallLimit: number;
  /** `ANOMANDER_PROCESSOR_TIMEOUT_SECONDS`, in milliseconds (R-22 AC2). */
  processorTimeoutMs: number;
  weeklySummaryCron: string;
  retentionCron: string;
  inboxDir: string;
  /** `ANOMANDER_AUTH_PATH`: the model login credentials (R-27 AC5). */
  authPath: string;
  timeZone: string;
  /**
   * `ANOMANDER_CURRENCY`: the principal's currency (ISO 4217), the one new expenses are written in
   * (DK-25). The expenses already stored keep theirs.
   */
  currency: string;
  /** `ANOMANDER_LOCALE`: the language of every text the principal reads and the model answers in. */
  locale: Locale;
  /** `ANOMANDER_API_TOKEN`: while unset, the read API is off and no port opens (RA-2 AC1). */
  apiToken: string | undefined;
  /** `ANOMANDER_API_HOST`: the address the read API binds to (RA-2 AC3). */
  apiHost: string;
  apiPort: number;
  /**
   * `ANOMANDER_LOCAL_TOKEN`: the token the desktop app generated for this launch (DK-3 AC2).
   * While unset, the local channel is off and no port opens.
   */
  localToken: string | undefined;
  /** `ANOMANDER_LOCAL_PORT`: the port of the local channel, always on `127.0.0.1` (DK-3 AC1). */
  localPort: number;
  /**
   * `ANOMANDER_MCP_CONFIG`: the file with the servers the principal connected (DK-11). The
   * desktop app sets it; while unset there are no connections.
   */
  mcpConfigPath: string | undefined;
  /**
   * `ANOMANDER_MCP_SECRETS`: the values the desktop app keeps in the Keychain for that file, as a
   * JSON object. Read by `loadConnectionsConfig`.
   */
  mcpSecrets: string | undefined;
  /**
   * `ANOMANDER_AUTH_JSON`: the model login the desktop app keeps in the Keychain, in the shape of
   * `auth.json` (DK-5 AC1). While set, the daemon keeps the login in memory and hands every change
   * back to the app; while unset, it uses the file at `authPath`.
   */
  authJson: string | undefined;
  /**
   * `ANOMANDER_MCP_OAUTH`: the clients and tokens of the servers the principal connected with
   * OAuth in the desktop app, as a JSON object by server name (DK-11). Read by `oauthKeeperFrom`.
   */
  mcpOAuth: string | undefined;
}

const modelId = z.string().transform((value, ctx) => {
  try {
    return parseModelId(value);
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: (error as Error).message });
    return z.NEVER;
  }
});

const isTimeZone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

const NOT_A_PORT = 'must be a port from 1 to 65535';

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  ANOMANDER_PRINCIPAL_CHAT_ID: z
    .string()
    .regex(/^-?\d+$/, 'must be an integer')
    .transform(Number)
    .pipe(z.int())
    .optional(),
  ANOMANDER_DB_PATH: z.string().default('./data/anomander.db'),
  ANOMANDER_MODEL: modelId.optional(),
  ANOMANDER_VISION_MODEL: modelId.optional(),
  ANOMANDER_DAILY_AI_CALL_LIMIT: z
    .string()
    .regex(/^\d+$/, 'must be a non-negative integer')
    .default('200')
    .transform(Number),
  ANOMANDER_PROCESSOR_TIMEOUT_SECONDS: z
    .string()
    .regex(/^[1-9]\d*$/, 'must be a positive integer')
    .default('60')
    .transform(Number),
  ANOMANDER_WEEKLY_SUMMARY_CRON: z.string().default('0 20 * * 0'),
  ANOMANDER_RETENTION_CRON: z.string().default('0 3 * * *'),
  ANOMANDER_INBOX_DIR: z.string().default('./data/inbox'),
  ANOMANDER_AUTH_PATH: z.string().default('./data/auth.json'),
  TZ: z.string().refine(isTimeZone, 'must be an IANA time zone').default('Europe/Madrid'),
  // Euros by default, so Docker and existing installs keep them; the desktop app sets it (DK-25).
  ANOMANDER_CURRENCY: z
    .string()
    .transform((value) => value.toUpperCase())
    .refine(isCurrency, { error: 'must be an ISO 4217 currency, such as EUR', abort: true })
    // Amounts are kept in hundredths (`total_cents`): a currency needs exactly two decimals.
    .refine(hasCents, {
      error: (issue) => `must have two decimals, as EUR or USD do: ${String(issue.input)} has not`,
    })
    .default(DEFAULT_CURRENCY),
  // Spanish by default, so Docker and existing installs keep speaking it; the desktop app sets it.
  ANOMANDER_LOCALE: z.enum(['es', 'en']).default('es'),
  // Security audit M4: long enough that guessing it, even at the read API's pace, is hopeless.
  ANOMANDER_API_TOKEN: z.string().min(32, 'must have at least 32 characters').optional(),
  ANOMANDER_API_HOST: z
    .string()
    .refine((value) => isIP(value) !== 0, 'must be an IP address')
    .default('127.0.0.1'),
  ANOMANDER_API_ALLOW_PLAIN_HTTP: z.string().regex(/^1$/, 'must be 1 when set').optional(),
  ANOMANDER_API_PORT: z
    .string()
    .regex(/^\d+$/, NOT_A_PORT)
    .default('4311')
    .transform(Number)
    .pipe(z.int().min(1, NOT_A_PORT).max(65535, NOT_A_PORT)),
  // DK-3 AC2: it travels as a WebSocket subprotocol, so only characters a header token allows.
  ANOMANDER_LOCAL_TOKEN: z
    .string()
    .min(32, 'must have at least 32 characters')
    .regex(/^[A-Za-z0-9._~+-]+$/, 'must use only letters, digits and . _ ~ + -')
    .optional(),
  ANOMANDER_LOCAL_PORT: z
    .string()
    .default('4312')
    .transform(Number)
    .pipe(z.int().min(1, NOT_A_PORT).max(65535, NOT_A_PORT)),
  ANOMANDER_MCP_CONFIG: z.string().min(1).optional(),
  ANOMANDER_MCP_SECRETS: z.string().min(1).optional(),
  ANOMANDER_AUTH_JSON: z.string().min(1).optional(),
  ANOMANDER_MCP_OAUTH: z.string().min(1).optional(),
});

type EnvKey = keyof typeof envSchema.shape;

/** Where to get each required variable, for the log of a daemon that cannot start (R-28 AC5). */
const HINTS: Partial<Record<EnvKey, string>> = {
  TELEGRAM_BOT_TOKEN: 'the token @BotFather gives when you create the bot',
  ANOMANDER_PRINCIPAL_CHAT_ID: 'your Telegram user ID, which @userinfobot tells you',
};
const hinted = (key: EnvKey) => (HINTS[key] === undefined ? key : `${key} (${HINTS[key]})`);

/** Telegram is one front door: both of these, or neither. */
const TELEGRAM_KEYS = ['TELEGRAM_BOT_TOKEN', 'ANOMANDER_PRINCIPAL_CHAT_ID'] as const;
/** Without either front door nobody could talk to the daemon, so it does not start. */
const NO_DOOR = `no front door. Set ${TELEGRAM_KEYS.map(hinted).join(' and ')} for Telegram, or ANOMANDER_LOCAL_TOKEN for the desktop app's chat`;

/** This machine's own addresses: what the read API may bind to without TLS. */
const LOOPBACK = new BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');
const isLoopback = (host: string): boolean =>
  LOOPBACK.check(host, isIP(host) === 6 ? 'ipv6' : 'ipv4');

/**
 * Security audit M4: the read API speaks plain HTTP only, so off this machine its token would
 * travel readable. While the API is on, a host elsewhere needs ANOMANDER_API_ALLOW_PLAIN_HTTP=1.
 */
const plainHttpOffHost = (input: Partial<Record<EnvKey, string>>): string | undefined => {
  const host = input.ANOMANDER_API_HOST;
  if (input.ANOMANDER_API_TOKEN === undefined || host === undefined || isIP(host) === 0) {
    return undefined;
  }
  if (isLoopback(host) || input.ANOMANDER_API_ALLOW_PLAIN_HTTP !== undefined) return undefined;
  return `ANOMANDER_API_HOST ${host} is not this machine and the read API has no TLS: set ANOMANDER_API_ALLOW_PLAIN_HTTP=1 to send the token over plain HTTP anyway`;
};

/**
 * `ANOMANDER_AUTH_PATH` alone, for `pnpm run login` and `pnpm run logout`, which need no bot or
 * model (R-27 AC7). An empty value counts as unset, as in `loadConfig`.
 */
export const loadAuthPath = (env: Record<string, string | undefined>): string =>
  envSchema.shape.ANOMANDER_AUTH_PATH.parse(env.ANOMANDER_AUTH_PATH || undefined);

/** Reads §14.4 from `env`. An empty value counts as unset, so its default applies. */
export const loadConfig = (env: Record<string, string | undefined>): Config => {
  const keys = Object.keys(envSchema.shape) as EnvKey[];
  const input = Object.fromEntries(
    keys.flatMap((key) => (env[key] ? [[key, env[key]]] : [])),
  ) as Partial<Record<EnvKey, string>>;
  const parsed = envSchema.safeParse(input);
  // Half of Telegram is a mistake, not a choice: the half that is set names the missing one.
  const telegramSet = TELEGRAM_KEYS.filter((key) => input[key] !== undefined);
  const missing = telegramSet.length === 1 ? TELEGRAM_KEYS.filter((key) => !input[key]) : [];
  const noDoor = telegramSet.length === 0 && input.ANOMANDER_LOCAL_TOKEN === undefined;
  const offHost = plainHttpOffHost(input);
  if (!parsed.success || missing.length > 0 || noDoor || offHost !== undefined) {
    const invalid = [
      ...(parsed.error?.issues ?? []).map((issue) => `${String(issue.path[0])} ${issue.message}`),
      ...(offHost === undefined ? [] : [offHost]),
    ];
    const problems = [
      ...(missing.length > 0 ? [`missing configuration: ${missing.map(hinted).join(', ')}`] : []),
      ...(noDoor ? [`missing configuration: ${NO_DOOR}`] : []),
      ...(invalid.length > 0 ? [`invalid configuration: ${invalid.join('; ')}`] : []),
    ];
    throw new Error(problems.join('. '));
  }
  const values = parsed.data;
  const { TELEGRAM_BOT_TOKEN: botToken, ANOMANDER_PRINCIPAL_CHAT_ID: principalChatId } = values;
  return {
    telegram:
      botToken === undefined || principalChatId === undefined
        ? undefined
        : { botToken, principalChatId },
    dbPath: values.ANOMANDER_DB_PATH,
    model: values.ANOMANDER_MODEL,
    visionModel: values.ANOMANDER_VISION_MODEL,
    dailyAiCallLimit: values.ANOMANDER_DAILY_AI_CALL_LIMIT,
    processorTimeoutMs: values.ANOMANDER_PROCESSOR_TIMEOUT_SECONDS * 1000,
    weeklySummaryCron: values.ANOMANDER_WEEKLY_SUMMARY_CRON,
    retentionCron: values.ANOMANDER_RETENTION_CRON,
    inboxDir: values.ANOMANDER_INBOX_DIR,
    authPath: values.ANOMANDER_AUTH_PATH,
    timeZone: values.TZ,
    currency: values.ANOMANDER_CURRENCY,
    locale: values.ANOMANDER_LOCALE,
    apiToken: values.ANOMANDER_API_TOKEN,
    apiHost: values.ANOMANDER_API_HOST,
    apiPort: values.ANOMANDER_API_PORT,
    localToken: values.ANOMANDER_LOCAL_TOKEN,
    localPort: values.ANOMANDER_LOCAL_PORT,
    mcpConfigPath: values.ANOMANDER_MCP_CONFIG,
    mcpSecrets: values.ANOMANDER_MCP_SECRETS,
    authJson: values.ANOMANDER_AUTH_JSON,
    mcpOAuth: values.ANOMANDER_MCP_OAUTH,
  };
};
