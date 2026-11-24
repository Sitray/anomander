import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  type ChatEvent,
  type ChatReply,
  formatAmount,
  LOCAL_CHANNEL_PROTOCOL,
} from '@anomander/protocol';
import {
  type FakeTelegramApi,
  pngBytes,
  type SentMessage,
  startFakeTelegramApi,
  updates,
} from '@anomander/telegram/fake-telegram-api';
import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Anomander, startAnomander } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { CORRECTION_INTERPRETER_PROMPT } from '../../src/processor/correction-interpreter.ts';
import { RECEIPT_READER_PROMPT } from '../../src/processor/receipt-reader.ts';
import { replyPhraserPrompt } from '../../src/processor/reply-phraser.ts';

// End to end (PRD §15): undoing and correcting a typed expense (R-7 AC4 to AC8), through the fake
// Telegram API and the local channel of a started daemon, a SQLite file and recorded processor
// responses.
const PRINCIPAL = 4242;
const TOKEN = 'expense-correct-test-token-0123456789abcdef';
const FIXTURES = resolve(import.meta.dirname, '../fixtures');
const recorded = (path: string): AssistantMessage =>
  JSON.parse(readFileSync(resolve(FIXTURES, `${path}.json`), 'utf8'));
const NOW = new Date('2026-10-30T10:00:05.000Z');

const S2 = `Apuntado: ${formatAmount(2300)} (restaurantes).`;
const S7 = '¿Qué cambio? Escríbelo, por ejemplo: total 28,40';
const S19 = 'Esa pregunta ya no está abierta.';
const S101 = `Deshecho: he quitado ${formatAmount(2300)} de tus gastos.`;
const S102 = (cents: number) => `Corregido: ${formatAmount(cents)} (restaurantes).`;
const S103 = `¿Qué gasto corrijo? Dímelo con su importe, por ejemplo: el de ${formatAmount(2340)}.`;
const S104 = 'No encuentro un gasto reciente que corregir.';

let scratch: string;
let api: FakeTelegramApi;
let anomander: Anomander;
let clock: Date;
/** The user turns the text interpreter received, parsed. */
let interpreted: { message: string; expenses?: unknown }[];
/** What the text interpreter answers, by message, built from its input; an expense when absent. */
let interpretations: Map<string, (input: { expenses?: { id: number }[] }) => unknown>;

const answering = (envelope: unknown): AssistantMessage => ({
  ...recorded('text-interpreter/conversation'),
  content: [{ type: 'text', text: JSON.stringify(envelope) }],
});

/** An `expense_correct` answer: the expense it points at and the new total with its quote. */
const correcting = (expenseId: number | null, total: number, quote: string) => ({
  kind: 'expense_correct',
  expense_id: expenseId,
  inferences: [
    {
      subject_type: 'expense',
      subject_id: null,
      predicate: 'total',
      value_json: total,
      mode: 'inferred',
      basis_json: { quote },
      confidence: 0.9,
    },
  ],
});

const complete = async (_model: string, context: Context): Promise<AssistantMessage> => {
  if (context.systemPrompt === RECEIPT_READER_PROMPT) {
    return recorded('receipt-reader/lines-mismatch');
  }
  if (context.systemPrompt === CORRECTION_INTERPRETER_PROMPT) {
    return recorded('correction-interpreter/total-28-40');
  }
  // R-21 AC2: a wording without the facts is not sent, so the replies are the §12 strings.
  if (context.systemPrompt === replyPhraserPrompt()) return answering('vale');
  const [turn] = context.messages;
  if (typeof turn?.content !== 'string') throw new Error('no user turn');
  const input = JSON.parse(turn.content);
  interpreted.push(input);
  const answer = interpretations.get(input.message);
  return answer === undefined
    ? recorded('text-interpreter/expense-23-space-euro')
    : answering(answer(input));
};

const start = async () => {
  anomander = startAnomander(
    {
      ...loadConfig({
        TELEGRAM_BOT_TOKEN: api.token,
        ANOMANDER_PRINCIPAL_CHAT_ID: String(PRINCIPAL),
        ANOMANDER_DB_PATH: join(scratch, 'anomander.db'),
        ANOMANDER_MODEL: 'openai/gpt-4o-mini',
        ANOMANDER_VISION_MODEL: 'openai/gpt-4o-mini',
        ANOMANDER_LOCAL_TOKEN: TOKEN,
      }),
      localPort: 0,
    },
    {
      complete,
      model: 'openai/gpt-4o-mini',
      telegramApiRoot: api.apiRoot,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      now: () => clock,
    },
  );
  await anomander.started;
};

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-e2e-correct-'));
  api = await startFakeTelegramApi();
  clock = NOW;
  interpreted = [];
  interpretations = new Map();
  await start();
});

afterEach(async () => {
  await anomander.stop();
  await api.close();
  rmSync(scratch, { recursive: true, force: true });
});

const query = <T>(sql: string): T[] => {
  const db = new Database(join(scratch, 'anomander.db'), { readonly: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
};

/** Sends a text in Telegram; resolves with the reply. */
const say = async (text: string) => {
  const before = api.sent.length;
  api.push(updates.text({ chatId: PRINCIPAL }, text));
  const reply = (await api.waitForSent(before + 1)).at(-1);
  if (reply === undefined) throw new Error('no reply');
  return reply;
};

/** The labels and data of the buttons under a Telegram message. */
const buttonsOf = (message: SentMessage): { text: string; callback_data: string }[] =>
  (
    message.payload.reply_markup as
      | { inline_keyboard: { text: string; callback_data: string }[][] }
      | undefined
  )?.inline_keyboard.flat() ?? [];

/** Presses the button labelled `label` under `message` in Telegram; resolves with the reply. */
const press = async (message: SentMessage, label: string) => {
  const button = buttonsOf(message).find(({ text }) => text === label);
  if (button === undefined) throw new Error(`no ${label} button`);
  const before = api.sent.length;
  api.push(updates.callbackQuery({ chatId: PRINCIPAL }, button.callback_data, message.messageId));
  return (await api.waitForSent(before + 1)).at(-1)?.text;
};

/** "23 € cena" registered in Telegram, its reply delivered and its question recorded. */
const registered = async () => {
  const reply = await say('23 € cena');
  expect(reply.text).toBe(S2);
  await vi.waitFor(() =>
    expect(query('SELECT id FROM pending_decisions WHERE channel_ref IS NOT NULL')).toHaveLength(1),
  );
  return reply;
};

const gastos = () => query<{ total_cents: number }>('SELECT total_cents FROM gastos');

/** The `total` assertions of the expense, oldest first. */
const totals = () =>
  query<{ value_json: string; mode: string; status: string; supersedes: number | null }>(
    `SELECT value_json, mode, status, supersedes_id IS NOT NULL AS supersedes FROM assertions
     WHERE subject_type = 'expense' AND predicate = 'total' ORDER BY id`,
  );

/** A WebSocket client of the local channel, as the desktop app's window is. */
const appChat = async () => {
  const address = await anomander.localChannel;
  if (address === undefined) throw new Error('the local channel did not start');
  const socket = new WebSocket(`ws://${address.host}:${address.port}`, [
    LOCAL_CHANNEL_PROTOCOL,
    TOKEN,
  ]);
  const events: ChatEvent[] = [];
  socket.addEventListener('message', (message) => events.push(JSON.parse(String(message.data))));
  await new Promise<void>((opened) => socket.addEventListener('open', () => opened()));
  let nextId = 1;
  return {
    close: () => socket.close(),
    ask: async (request: Record<string, unknown>): Promise<ChatReply> => {
      const id = `m${nextId++}`;
      socket.send(JSON.stringify({ ...request, id }));
      let event: ChatEvent | undefined;
      await vi.waitFor(() => {
        event = events.find((candidate) => candidate.inReplyTo === id);
        expect(event).toBeDefined();
      });
      if (event?.type !== 'reply')
        throw new Error(`expected a reply, got ${JSON.stringify(event)}`);
      return event;
    },
  };
};

describe('undoing and correcting a typed expense', () => {
  it('R-7 AC4: "Apuntado…" carries "Deshacer" and "Corregir", in Telegram and in the app', async () => {
    const reply = await registered();
    expect(buttonsOf(reply).map(({ text }) => text)).toEqual(['Deshacer', 'Corregir']);
    expect(query('SELECT status FROM pending_decisions')).toEqual([{ status: 'open' }]);

    const chat = await appChat();
    const answer = await chat.ask({ type: 'text', text: '23 € cena' });
    chat.close();
    expect(answer.text).toBe(S2);
    expect(answer.buttons.map((button) => button.label)).toEqual(['Deshacer', 'Corregir']);
  });

  it('R-7 AC5: "Deshacer" takes the expense out of the ledger and replies S-101; pressed again, S-19', async () => {
    const reply = await registered();

    expect(await press(reply, 'Deshacer')).toBe(S101);
    expect(gastos()).toEqual([]);
    expect(query('SELECT status FROM expenses')).toEqual([{ status: 'refuted' }]);
    // Nothing is deleted: the declaration and the reading of it stay in the ledger.
    expect(totals()).toEqual([
      { value_json: '2300', mode: 'declared', status: 'current', supersedes: 0 },
      { value_json: '2300', mode: 'inferred', status: 'current', supersedes: 0 },
    ]);

    expect(await press(reply, 'Deshacer')).toBe(S19);
    expect(await press(reply, 'Corregir')).toBe(S19);
  });

  it('R-7 AC5: "Deshacer" pressed in the app does the same, and Telegram then gets S-19', async () => {
    const chat = await appChat();
    const answer = await chat.ask({ type: 'text', text: '23 € cena' });
    const undo = answer.buttons.find((button) => button.label === 'Deshacer');
    if (undo === undefined || !('data' in undo)) throw new Error('no Deshacer button');

    const undone = await chat.ask({
      type: 'button',
      data: undo.data,
      channelRef: answer.channelRef,
    });
    expect(undone.text).toBe(S101);
    expect(gastos()).toEqual([]);

    api.push(updates.callbackQuery({ chatId: PRINCIPAL }, undo.data, 1));
    expect((await api.waitForSent(1)).at(-1)?.text).toBe(S19);
    chat.close();
  });

  it('R-7 AC6: "Corregir" asks S-7, and the text supersedes the declaration with a new declared one', async () => {
    const reply = await registered();

    expect(await press(reply, 'Corregir')).toBe(S7);
    expect((await say('total 28,40')).text).toBe(S102(2840));

    expect(gastos()).toEqual([{ total_cents: 2840 }]);
    // R-7 AC2: the old declaration is superseded and refuted, with the reading of it; never
    // updated or deleted.
    expect(totals()).toEqual([
      { value_json: '2300', mode: 'declared', status: 'refuted', supersedes: 0 },
      { value_json: '2300', mode: 'inferred', status: 'refuted', supersedes: 0 },
      { value_json: '2840', mode: 'declared', status: 'current', supersedes: 1 },
    ]);
    expect(
      query(`SELECT o.mode FROM assertions n JOIN assertions o ON o.id = n.supersedes_id
             WHERE n.predicate = 'total'`),
    ).toEqual([{ mode: 'declared' }]);
    expect(query('SELECT status FROM pending_decisions')).toEqual([{ status: 'answered' }]);
    // The question is answered: its buttons are closed.
    expect(await press(reply, 'Deshacer')).toBe(S19);
    expect(gastos()).toEqual([{ total_cents: 2840 }]);
  });

  it('R-17 AC2: a Telegram reply to an "Apuntado…" that also asks S-15 corrects the expense', async () => {
    const inference = (predicate: string, value_json: unknown, quote: string) => ({
      subject_type: 'expense',
      subject_id: null,
      predicate,
      value_json,
      mode: 'inferred',
      basis_json: { quote },
      confidence: 0.95,
    });
    interpretations.set('40 € categoría gasolina', () => ({
      kind: 'expense',
      inferences: [
        inference('total', 4000, '40 €'),
        inference('declared_category', 'gasolina', 'categoría gasolina'),
      ],
    }));
    const reply = await say('40 € categoría gasolina');
    expect(buttonsOf(reply).map(({ text }) => text)).toEqual(['Sí', 'No', 'Deshacer', 'Corregir']);
    await vi.waitFor(() =>
      expect(query('SELECT id FROM pending_decisions WHERE channel_ref IS NOT NULL')).toHaveLength(
        2,
      ),
    );

    const before = api.sent.length;
    api.push(
      updates.text({ chatId: PRINCIPAL }, 'total 28,40', { replyToMessageId: reply.messageId }),
    );
    const [corrected] = (await api.waitForSent(before + 1)).slice(before);

    expect(corrected?.text).toBe(`Corregido: ${formatAmount(2840)} (sin clasificar).`);
    expect(gastos()).toEqual([{ total_cents: 2840 }]);
    // S-15 is still asked.
    expect(
      query(`SELECT p.operation, d.status FROM pending_decisions d
             JOIN proposals p ON p.id = d.proposal_id ORDER BY d.id`),
    ).toEqual([
      { operation: 'create_category', status: 'open' },
      { operation: 'amend_expense', status: 'answered' },
    ]);
  });

  it('R-7 AC7: "no eran 23, eran 32" corrects the latest expense, and its buttons are closed', async () => {
    const reply = await registered();
    interpretations.set('no eran 23, eran 32', ({ expenses = [] }) =>
      correcting(expenses[0]?.id ?? null, 3200, 'eran 32'),
    );

    expect((await say('no eran 23, eran 32')).text).toBe(S102(3200));

    // The interpreter was given the recent current expenses to point at.
    expect(interpreted.at(-1)?.expenses).toEqual([
      {
        id: 1,
        total_cents: 2300,
        merchant: null,
        category: 'restaurantes',
        occurred_on: '2026-10-30',
      },
    ]);
    expect(gastos()).toEqual([{ total_cents: 3200 }]);
    expect(totals()).toEqual([
      { value_json: '2300', mode: 'declared', status: 'refuted', supersedes: 0 },
      { value_json: '2300', mode: 'inferred', status: 'refuted', supersedes: 0 },
      { value_json: '3200', mode: 'declared', status: 'current', supersedes: 1 },
    ]);
    expect(await press(reply, 'Deshacer')).toBe(S19);
    expect(gastos()).toEqual([{ total_cents: 3200 }]);
  });

  it('R-7 AC7: a value whose quote is not in the message changes nothing (S-7)', async () => {
    await registered();
    interpretations.set('no eran 23', ({ expenses = [] }) =>
      correcting(expenses[0]?.id ?? null, 4500, 'eran 45'),
    );

    expect((await say('no eran 23')).text).toBe(S7);
    expect(gastos()).toEqual([{ total_cents: 2300 }]);
    expect(totals()).toHaveLength(2);
  });

  it('R-7 AC7: when it is not clear which expense, it asks S-103 and changes nothing', async () => {
    await registered();
    interpretations.set('eran 32', () => correcting(null, 3200, 'eran 32'));
    expect((await say('eran 32')).text).toBe(S103);
    // An id it was not given is no clearer.
    interpretations.set('eran 32', () => correcting(99, 3200, 'eran 32'));
    expect((await say('eran 32')).text).toBe(S103);
    expect(gastos()).toEqual([{ total_cents: 2300 }]);
  });

  it('R-7 AC7: with no recent expense, it replies S-104', async () => {
    interpretations.set('eran 32', () => correcting(null, 3200, 'eran 32'));
    expect((await say('eran 32')).text).toBe(S104);
    expect(interpreted.at(-1)?.expenses).toEqual([]);
  });

  it('R-7 AC8: a question left 7 days expires (R-19 AC2) and its buttons get S-19', async () => {
    const reply = await registered();
    await anomander.stop();
    clock = new Date(NOW.getTime() + 8 * 86_400_000);
    await start();

    await vi.waitFor(() =>
      expect(query('SELECT status FROM pending_decisions')).toEqual([{ status: 'expired' }]),
    );
    expect(await press(reply, 'Deshacer')).toBe(S19);
    expect(gastos()).toEqual([{ total_cents: 2300 }]);
  });

  it('R-6 AC3: a receipt question keeps exactly "Apuntar", "Corregir" and "Descartar"', async () => {
    api.putFile('receipt', pngBytes(1));
    api.push(updates.photo({ chatId: PRINCIPAL }, { fileId: 'receipt' }));
    const [question] = await api.waitForSent(1);
    if (question === undefined) throw new Error('no question');
    expect(buttonsOf(question).map(({ text }) => text)).toEqual([
      'Apuntar',
      'Corregir',
      'Descartar',
    ]);
  });
});
