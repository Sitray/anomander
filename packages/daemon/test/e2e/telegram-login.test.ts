import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  type FakeTelegramApi,
  type SentMessage,
  startFakeTelegramApi,
  updates,
} from '@anomander/telegram/fake-telegram-api';
import type {
  AssistantMessage,
  AuthInteraction,
  Context,
  Credential,
  CredentialStore,
} from '@earendil-works/pi-ai';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { type Anomander, startAnomander } from '../../src/app.ts';
import { createFileCredentialStore } from '../../src/auth/file-credential-store.ts';
import type { ModelLogin } from '../../src/auth/telegram-login.ts';
import { loadConfig } from '../../src/config.ts';
import { TEXT_INTERPRETER_PROMPT } from '../../src/processor/text-interpreter.ts';

// End to end (PRD §15): model login from Telegram (R-27 AC1-AC4, AC6, R-17 AC7) through the fake
// Telegram API and the real bot. pi-ai's `models.login` is a fake that drives the same
// interaction a provider's flow does; no test reaches a real provider.
const PRINCIPAL = 4242;
const principal = { chatId: PRINCIPAL };
const FIXTURES = resolve(import.meta.dirname, '../fixtures');
const CONVERSATION: AssistantMessage = JSON.parse(
  readFileSync(resolve(FIXTURES, 'text-interpreter/conversation.json'), 'utf8'),
);
const AUTH_URL = 'https://auth.openai.com/oauth/authorize?state=s';
const PASTED_CODE = 'http://127.0.0.1:1455/auth/callback?code=pasted-code&state=s';
const TOKEN: Credential = {
  type: 'oauth',
  access: 'access-token',
  refresh: 'refresh-token',
  expires: 1,
};
const LOGIN_TIMEOUT_MS = 300;

let scratch: string;
let api: FakeTelegramApi;
let anomander: Anomander;
let store: CredentialStore;
type Log = (message: string, fields?: Record<string, unknown>) => void;
let logger: { info: Mock<Log>; warn: Mock<Log>; error: Mock<Log> };
/** The user turns the text interpreter received, parsed. */
let interpreted: Record<string, unknown>[];
/** What the fake `models.login` does for each provider. */
let flows: Map<string, (interaction: AuthInteraction) => Promise<Credential>>;
/** The interaction of every login started, in order. */
let interactions: AuthInteraction[];

/** ChatGPT's flow: pi-ai shows the link and waits for the address the browser failed to open. */
const chatGptFlow = async (interaction: AuthInteraction): Promise<Credential> => {
  interaction.notify({ type: 'auth_url', url: AUTH_URL });
  const address = await interaction.prompt({
    type: 'manual_code',
    message: 'Paste the redirect URL',
    ...(interaction.signal === undefined ? {} : { signal: interaction.signal }),
  });
  if (address !== PASTED_CODE) throw new Error('wrong address');
  return TOKEN;
};

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-e2e-login-'));
  interpreted = [];
  interactions = [];
  flows = new Map([['openai', chatGptFlow]]);
  api = await startFakeTelegramApi();
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: api.token,
    ANOMANDER_PRINCIPAL_CHAT_ID: String(PRINCIPAL),
    ANOMANDER_DB_PATH: join(scratch, 'anomander.db'),
    ANOMANDER_INBOX_DIR: join(scratch, 'inbox'),
    ANOMANDER_AUTH_PATH: join(scratch, 'auth.json'),
    ANOMANDER_MODEL: 'openai/gpt-4o-mini',
    ANOMANDER_VISION_MODEL: 'openai/gpt-4o',
    TZ: 'Europe/Madrid',
  });
  store = createFileCredentialStore(config.authPath);
  const complete = async (_model: string, context: Context): Promise<AssistantMessage> => {
    const [turn] = context.messages;
    if (context.systemPrompt === TEXT_INTERPRETER_PROMPT && typeof turn?.content === 'string') {
      interpreted.push(JSON.parse(turn.content));
      return CONVERSATION;
    }
    return { ...CONVERSATION, content: [], stopReason: 'error', errorMessage: 'offline' };
  };
  // pi-ai's `models.login` runs the provider's flow and persists what it returns.
  const models: ModelLogin = {
    login: async (providerId, _type, interaction) => {
      interactions.push(interaction);
      const flow = flows.get(providerId);
      if (flow === undefined) throw new Error(`no flow for ${providerId}`);
      const credential = await flow(interaction);
      await store.modify(providerId, async () => credential);
      return credential;
    },
    logout: (providerId) => store.delete(providerId),
  };
  logger = { info: vi.fn<Log>(), warn: vi.fn<Log>(), error: vi.fn<Log>() };
  anomander = startAnomander(config, {
    complete,
    model: 'openai/gpt-4o-mini',
    visionModel: 'openai/gpt-4o',
    telegramApiRoot: api.apiRoot,
    logger,
    login: {
      models,
      credentials: store,
      getDeviceId: () => '00000000-0000-4000-8000-000000000000',
      timeoutMs: LOGIN_TIMEOUT_MS,
    },
  });
  await anomander.started;
});

afterEach(async () => {
  await anomander.stop();
  await api.close();
  rmSync(scratch, { recursive: true, force: true });
});

/** Pushes an update and resolves with the message the bot sends next. */
const next = async (update: ReturnType<typeof updates.text>): Promise<SentMessage> => {
  const before = api.sent.length;
  api.push(update);
  const sent = await api.waitForSent(before + 1);
  return sent.at(-1) as SentMessage;
};

/** The inline keyboard of a sent message, as `{ text, callback_data | url }` rows. */
const keyboardOf = (message: SentMessage) =>
  (message.payload.reply_markup as { inline_keyboard: Record<string, string>[][] } | undefined)
    ?.inline_keyboard;

/** Presses the account button `data` under the bot message `message`. */
const press = (data: string, message: SentMessage) =>
  updates.callbackQuery(principal, data, message.messageId);

const logged = () =>
  JSON.stringify([
    ...logger.info.mock.calls,
    ...logger.warn.mock.calls,
    ...logger.error.mock.calls,
  ]);

const waitUntil = async (ready: () => boolean) => {
  for (let i = 0; i < 100 && !ready(); i++) await new Promise((r) => setTimeout(r, 20));
  expect(ready()).toBe(true);
};

describe('model login from Telegram (R-27)', () => {
  it('AC1, R-17 AC7: /login replies S-60 with one button per account and never reaches the processor', async () => {
    const reply = await next(updates.text(principal, '/login'));

    expect(reply.text).toBe('¿Con qué cuenta me conecto?');
    expect(keyboardOf(reply)).toEqual([
      [
        { text: 'ChatGPT', callback_data: 'login:openai' },
        { text: 'Kimi Code', callback_data: 'login:kimi-coding' },
      ],
    ]);
    expect(interpreted).toEqual([]);
  });

  it('AC2-AC4: ChatGPT sends S-62 with Abrir; the pasted address is deleted, never logged or a recent turn, and S-64 follows', async () => {
    const choose = await next(updates.text(principal, '/login'));
    const link = await next(press('login:openai', choose));

    expect(link.text).toBe(
      'Abre el enlace y acepta. Cuando el navegador dé error, copia la dirección completa de esa página y pégamela aquí.',
    );
    expect(keyboardOf(link)).toEqual([[{ text: 'Abrir', url: AUTH_URL }]]);

    const pasted = updates.text(principal, PASTED_CODE);
    const connected = await next(pasted);

    expect(connected.text).toBe('Conectado con tu cuenta de ChatGPT.');
    expect(api.deleted).toEqual([{ chatId: PRINCIPAL, messageId: pasted.message?.message_id }]);
    expect(await store.read('openai')).toEqual(TOKEN);

    // R-17 AC5 still holds afterwards, and nothing of the login is a recent turn (R-16 AC3).
    const chat = await next(updates.text(principal, 'hola'));
    expect(chat.text).toBe(
      '¡Hola! Cuando quieras, dime un gasto, por ejemplo: 23,40 en Mercadona.',
    );
    expect(interpreted).toHaveLength(1);
    expect(interpreted[0]?.message).toBe('hola');
    expect(interpreted[0]?.recent).toEqual([]);
    expect(logged()).not.toContain('pasted-code');
    expect(logged()).not.toContain('access-token');
  });

  it('AC2: Kimi Code sends S-63 with the device code and an Abrir link, and needs nothing pasted', async () => {
    flows.set('kimi-coding', async (interaction) => {
      interaction.notify({
        type: 'device_code',
        userCode: 'ABCD-1234',
        verificationUri: 'https://www.kimi.com/code/authorize_device?user_code=ABCD-1234',
      });
      return TOKEN;
    });
    const choose = await next(updates.text(principal, '/login'));
    const code = await next(press('login:kimi-coding', choose));

    expect(code.text).toBe('Abre el enlace y escribe este código: ABCD-1234');
    expect(keyboardOf(code)).toEqual([
      [{ text: 'Abrir', url: 'https://www.kimi.com/code/authorize_device?user_code=ABCD-1234' }],
    ]);
    const [connected] = (await api.waitForSent(3)).slice(2);
    expect(connected?.text).toBe('Conectado con tu cuenta de Kimi Code.');
  });

  it('AC4: a login that fails replies S-65', async () => {
    flows.set('openai', async (interaction) => {
      interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/authorize' });
      await interaction.prompt({ type: 'manual_code', message: 'Paste the URL' });
      throw new Error('OAuth state mismatch');
    });
    const choose = await next(updates.text(principal, '/login'));
    const link = await next(press('login:openai', choose));
    expect(link.text).toBe(
      'Abre el enlace y acepta. Cuando el navegador dé error, copia la dirección completa de esa página y pégamela aquí.',
    );

    const failed = await next(updates.text(principal, 'http://127.0.0.1:1455/auth/callback?x'));

    expect(failed.text).toBe(
      'No he podido conectar con tu cuenta de ChatGPT. Puedes intentarlo otra vez con /login.',
    );
    expect(await store.list()).toEqual([]);
  });

  it('AC4: a login with no answer for its timeout is abandoned and replies S-65', async () => {
    const choose = await next(updates.text(principal, '/login'));
    await next(press('login:openai', choose));

    const [failed] = (await api.waitForSent(3, LOGIN_TIMEOUT_MS * 10)).slice(2);

    expect(failed?.text).toBe(
      'No he podido conectar con tu cuenta de ChatGPT. Puedes intentarlo otra vez con /login.',
    );
    expect(interactions[0]?.signal?.aborted).toBe(true);
    // The login no longer waits: the next text goes to the processor.
    await next(updates.text(principal, 'hola'));
    expect(interpreted.map(({ message }) => message)).toEqual(['hola']);
  });

  it('AC4: /login during a login abandons the running one first', async () => {
    const choose = await next(updates.text(principal, '/login'));
    await next(press('login:openai', choose));

    const again = await next(updates.text(principal, '/login'));

    expect(again.text).toBe('¿Con qué cuenta me conecto?');
    await waitUntil(() => interactions[0]?.signal?.aborted === true);
    // Abandoned by the principal, not failed: no S-65 follows.
    await new Promise((r) => setTimeout(r, 100));
    expect(api.sent.map(({ text }) => text)).not.toContain(
      'No he podido conectar con tu cuenta de ChatGPT. Puedes intentarlo otra vez con /login.',
    );
  });

  it('AC6: /logout offers the connected accounts and pressing one deletes its credentials (S-67)', async () => {
    await store.modify('openai', async () => TOKEN);
    await store.modify('kimi-coding', async () => TOKEN);

    const choose = await next(updates.text(principal, '/logout'));

    expect(choose.text).toBe('¿Qué cuenta desconecto?');
    expect(keyboardOf(choose)).toEqual([
      [
        { text: 'ChatGPT', callback_data: 'logout:openai' },
        { text: 'Kimi Code', callback_data: 'logout:kimi-coding' },
      ],
    ]);
    const done = await next(press('logout:openai', choose));

    expect(done.text).toBe('Hecho, he desconectado tu cuenta de ChatGPT.');
    expect(await store.list()).toEqual([{ providerId: 'kimi-coding', type: 'oauth' }]);
    expect(interpreted).toEqual([]);
  });

  it('AC6: /logout with no connected account replies S-68', async () => {
    const reply = await next(updates.text(principal, '/logout'));

    expect(reply.text).toBe('No hay ninguna cuenta conectada.');
    expect(keyboardOf(reply)).toBeUndefined();
  });
});
