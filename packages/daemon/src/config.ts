import { z } from 'zod';

// PRD §14.4. Every variable and default of the configuration table; secrets come only from
// the environment (`.env`).

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
  model: ModelId;
  visionModel: ModelId;
  dailyAiCallLimit: number;
  /** `ANOMANDER_PROCESSOR_TIMEOUT_SECONDS`, in milliseconds (R-22 AC2). */
  processorTimeoutMs: number;
  weeklySummaryCron: string;
  retentionCron: string;
  inboxDir: string;
  timeZone: string;
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

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string(),
  ANOMANDER_PRINCIPAL_CHAT_ID: z
    .string()
    .regex(/^-?\d+$/, 'must be an integer')
    .transform(Number)
    .pipe(z.int()),
  ANOMANDER_DB_PATH: z.string().default('./data/anomander.db'),
  ANOMANDER_MODEL: modelId,
  ANOMANDER_VISION_MODEL: modelId,
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
  TZ: z.string().refine(isTimeZone, 'must be an IANA time zone').default('Europe/Madrid'),
});

type EnvKey = keyof typeof envSchema.shape;

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
      ...(missing.length > 0 ? [`missing configuration: ${missing.join(', ')}`] : []),
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
    timeZone: values.TZ,
  };
};
