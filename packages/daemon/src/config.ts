import { isIP } from 'node:net';
import { z } from 'zod';

// PRD §14.4, plus the read API of the read access draft (docs/read-access-prd.md §8). Every
// variable and default of the configuration table; secrets come only from the environment (`.env`).

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

export interface Config {
  telegramBotToken: string;
  principalChatId: number;
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
  TELEGRAM_BOT_TOKEN: z.string(),
  ANOMANDER_PRINCIPAL_CHAT_ID: z
    .string()
    .regex(/^-?\d+$/, 'must be an integer')
    .transform(Number)
    .pipe(z.int()),
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
  ANOMANDER_API_TOKEN: z.string().optional(),
  ANOMANDER_API_HOST: z
    .string()
    .refine((value) => isIP(value) !== 0, 'must be an IP address')
    .default('127.0.0.1'),
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
});

type EnvKey = keyof typeof envSchema.shape;

/** Where to get each required variable, for the log of a daemon that cannot start (R-28 AC5). */
const HINTS: Partial<Record<EnvKey, string>> = {
  TELEGRAM_BOT_TOKEN: 'the token @BotFather gives when you create the bot',
  ANOMANDER_PRINCIPAL_CHAT_ID: 'your Telegram user ID, which @userinfobot tells you',
};
const hinted = (key: EnvKey) => (HINTS[key] === undefined ? key : `${key} (${HINTS[key]})`);

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
  if (!parsed.success) {
    const missing = keys.filter(
      (key) => input[key] === undefined && !envSchema.shape[key].safeParse(undefined).success,
    );
    const invalid = parsed.error.issues
      .filter((issue) => !missing.includes(issue.path[0] as EnvKey))
      .map((issue) => `${String(issue.path[0])} ${issue.message}`);
    const problems = [
      ...(missing.length > 0 ? [`missing configuration: ${missing.map(hinted).join(', ')}`] : []),
      ...(invalid.length > 0 ? [`invalid configuration: ${invalid.join('; ')}`] : []),
    ];
    throw new Error(problems.join('. '));
  }
  const values = parsed.data;
  return {
    telegramBotToken: values.TELEGRAM_BOT_TOKEN,
    principalChatId: values.ANOMANDER_PRINCIPAL_CHAT_ID,
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
    apiToken: values.ANOMANDER_API_TOKEN,
    apiHost: values.ANOMANDER_API_HOST,
    apiPort: values.ANOMANDER_API_PORT,
    localToken: values.ANOMANDER_LOCAL_TOKEN,
    localPort: values.ANOMANDER_LOCAL_PORT,
    mcpConfigPath: values.ANOMANDER_MCP_CONFIG,
    mcpSecrets: values.ANOMANDER_MCP_SECRETS,
  };
};
