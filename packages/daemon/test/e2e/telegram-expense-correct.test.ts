import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  type ChatEvent,
  type ChatReply,
  formatAmount,
  LOCAL_CHANNEL_PROTOCOL,
  strings,
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
/** Everything the daemon logged, with its fields (§16: no amount or text of the principal). */
let logs: unknown[];
/** What the text interpreter answers, by message, built from its input; an expense when absent. */
let interpretations: Map<string, (input: { expenses?: { id: number }[] }) => unknown>;
/** What the text interpreter waits for before it answers. */
let interpreting: Promise<void>;

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
  await interpreting;
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
      logger: {
        info: (...entry: unknown[]) => logs.push(entry),
        warn: (...entry: unknown[]) => logs.push(entry),
        error: (...entry: unknown[]) => logs.push(entry),
      },
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
  interpreting = Promise.resolve();
  logs = [];
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
  /** The event that answers `id`, once it came. */
  const answerTo = async (id: string): Promise<ChatEvent> => {
    let event: ChatEvent | undefined;
    await vi.waitFor(() => {
      event = events.find((candidate) => candidate.inReplyTo === id);
      expect(event).toBeDefined();
    });
    return event as ChatEvent;
  };
  /** Sends `request` and resolves with the event that answers it. */
  const send = (request: Record<string, unknown>): Promise<ChatEvent> => {
    const id = `m${nextId++}`;
    socket.send(JSON.stringify({ ...request, id }));
    return answerTo(id);
  };
  return {
    events,
    close: () => socket.close(),
    send,
    ask: async (request: Record<string, unknown>): Promise<ChatReply> => {
      const event = await send(request);
      if (event.type !== 'reply') throw new Error(`expected a reply, got ${JSON.stringify(event)}`);
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

  it('§16: a typed correction logs no amount the processor proposed', async () => {
    await registered();
    logs.length = 0;
    interpretations.set('no eran 23, eran 32', ({ expenses = [] }) =>
      correcting(expenses[0]?.id ?? null, 9900, 'eran 32'),
    );
    expect((await say('no eran 23, eran 32')).text).toBe(S7);
    expect(logs).not.toEqual([]);
    expect(JSON.stringify(logs)).not.toMatch(/9900/);
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

// DK-17 AC6 (docs/desktop-prd.md): "Corregir" and "Deshacer" on a row of the window's "Gastos"
// answer the expense's `amend_expense` question as its buttons in the chat do (R-7 AC4 to AC8).
describe('"Corregir" and "Deshacer" from the window\'s "Gastos" (DK-17 AC6)', () => {
  const S100 = `Deshecho: he quitado ${formatAmount(2340)} en Mercadona de tus gastos.`;

  /** The stored conversation, as the chat reads it (DK-16). */
  const stored = async (chat: Awaited<ReturnType<typeof appChat>>) => {
    const event = await chat.send({ type: 'history' });
    if (event.type !== 'history') throw new Error(`expected history, got ${event.type}`);
    return event.messages.map(({ from, door, text }) => ({ from, door, text }));
  };

  /** A receipt read and registered with "Apuntar" in Telegram: a current expense with lines. */
  const receiptRegistered = async () => {
    api.putFile('receipt', pngBytes(1));
    api.push(updates.photo({ chatId: PRINCIPAL }, { fileId: 'receipt' }));
    const [question] = await api.waitForSent(1);
    if (question === undefined) throw new Error('no question');
    await press(question, 'Apuntar');
    expect(query('SELECT status FROM expenses')).toEqual([{ status: 'current' }]);
    return query<{ id: number }>('SELECT id FROM expenses')[0]?.id;
  };

  it('undo_expense takes a typed expense out of the ledger as "Deshacer" does, and its reply is in the chat', async () => {
    const reply = await registered();
    const chat = await appChat();

    expect((await chat.ask({ type: 'undo_expense', expenseId: 1 })).text).toBe(S101);
    expect(gastos()).toEqual([]);
    expect(query('SELECT status FROM expenses')).toEqual([{ status: 'refuted' }]);
    // R-7 AC5: the question under the reply is answered by an action the principal authorized.
    expect(
      query(`SELECT p.status AS proposal, d.status AS decision, a.authorized_by
             FROM pending_decisions d JOIN proposals p ON p.id = d.proposal_id
             JOIN actions a ON a.proposal_id = p.id WHERE p.operation = 'amend_expense'`),
    ).toEqual([{ proposal: 'executed', decision: 'answered', authorized_by: 'principal' }]);
    // The reply is stored in the conversation, at the app's door, as a press there is.
    expect((await stored(chat)).slice(-2)).toEqual([
      { from: 'principal', door: 'app', text: '[botón: Deshacer]' },
      { from: 'anomander', door: 'app', text: S101 },
    ]);
    // Its delivery verifies the action (R-9 AC2).
    await vi.waitFor(() =>
      expect(
        query(`SELECT a.status FROM actions a JOIN proposals p ON p.id = a.proposal_id
               WHERE p.operation = 'amend_expense'`),
      ).toEqual([{ status: 'verified' }]),
    );
    // The buttons under the reply in Telegram are closed.
    expect(await press(reply, 'Corregir')).toBe(S19);
    chat.close();
  });

  it('an expense no longer current answers S-19 and nothing changes', async () => {
    await registered();
    const chat = await appChat();
    expect((await chat.ask({ type: 'undo_expense', expenseId: 1 })).text).toBe(S101);

    expect((await chat.ask({ type: 'undo_expense', expenseId: 1 })).text).toBe(S19);
    expect((await chat.ask({ type: 'correct_expense', expenseId: 1 })).text).toBe(S19);
    expect((await chat.ask({ type: 'correct_expense', expenseId: 99 })).text).toBe(S19);
    expect(query("SELECT id FROM pending_decisions WHERE status <> 'answered'")).toEqual([]);
    // Only the first undo acted.
    expect(
      query(`SELECT a.id FROM actions a JOIN proposals p ON p.id = a.proposal_id
             WHERE p.operation = 'amend_expense'`),
    ).toHaveLength(1);
    chat.close();
  });

  it('correct_expense asks S-7, and the next text in the app supersedes the declaration', async () => {
    const reply = await registered();
    const chat = await appChat();

    expect((await chat.ask({ type: 'correct_expense', expenseId: 1 })).text).toBe(S7);
    expect(query('SELECT status FROM pending_decisions')).toEqual([{ status: 'awaiting_text' }]);
    expect((await chat.ask({ type: 'text', text: 'total 28,40' })).text).toBe(S102(2840));

    expect(gastos()).toEqual([{ total_cents: 2840 }]);
    expect(totals()).toEqual([
      { value_json: '2300', mode: 'declared', status: 'refuted', supersedes: 0 },
      { value_json: '2300', mode: 'inferred', status: 'refuted', supersedes: 0 },
      { value_json: '2840', mode: 'declared', status: 'current', supersedes: 1 },
    ]);
    expect((await stored(chat)).slice(-4)).toEqual([
      { from: 'principal', door: 'app', text: '[botón: Corregir]' },
      { from: 'anomander', door: 'app', text: S7 },
      { from: 'principal', door: 'app', text: 'total 28,40' },
      { from: 'anomander', door: 'app', text: S102(2840) },
    ]);
    expect(await press(reply, 'Deshacer')).toBe(S19);
    chat.close();
  });

  it('a typed expense already corrected, whose question is answered, can be corrected again', async () => {
    const reply = await registered();
    expect(await press(reply, 'Corregir')).toBe(S7);
    expect((await say('total 28,40')).text).toBe(S102(2840));
    const chat = await appChat();

    expect((await chat.ask({ type: 'undo_expense', expenseId: 1 })).text).toBe(
      `Deshecho: he quitado ${formatAmount(2840)} de tus gastos.`,
    );
    expect(gastos()).toEqual([]);
    chat.close();
  });

  it('works on a registered receipt too: undone with S-100, or corrected as R-7 AC2 writes it', async () => {
    const expenseId = await receiptRegistered();
    const chat = await appChat();

    expect((await chat.ask({ type: 'correct_expense', expenseId })).text).toBe(S7);
    const corrected = (await chat.ask({ type: 'text', text: 'total 28,40' })).text;
    const [row] = query<{ category: string | null }>(
      'SELECT c.name AS category FROM expenses e LEFT JOIN categories c ON c.id = e.category_id',
    );
    expect(corrected).toBe(strings.corrected(2840, 'Mercadona', row?.category ?? null));
    expect(gastos()).toEqual([{ total_cents: 2840 }]);
    expect(
      query(`SELECT mode, status FROM assertions WHERE predicate = 'total' AND status = 'current'`),
    ).toEqual([{ mode: 'declared', status: 'current' }]);

    expect((await chat.ask({ type: 'undo_expense', expenseId })).text).toBe(
      `Deshecho: he quitado ${formatAmount(2840)} en Mercadona de tus gastos.`,
    );
    expect(gastos()).toEqual([]);
    chat.close();
  });

  it('undo_expense on a registered receipt replies S-100', async () => {
    const expenseId = await receiptRegistered();
    const chat = await appChat();
    expect((await chat.ask({ type: 'undo_expense', expenseId })).text).toBe(S100);
    expect(query('SELECT status FROM expenses')).toEqual([{ status: 'refuted' }]);
    chat.close();
  });

  it("both wait for the chat's turn that runs", async () => {
    await registered();
    await registered();
    const chat = await appChat();
    let release = (): void => {};
    interpreting = new Promise<void>((resolveHeld) => {
      release = resolveHeld;
    });
    const before = api.sent.length;
    api.push(updates.text({ chatId: PRINCIPAL }, '23 € cena'));
    await vi.waitFor(() => expect(interpreted).toHaveLength(3));

    const undone = chat.send({ type: 'undo_expense', expenseId: 1 });
    const correcting = chat.send({ type: 'correct_expense', expenseId: 2 });
    await new Promise((resolveLater) => setTimeout(resolveLater, 50));
    expect(chat.events).toEqual([]);
    expect(query('SELECT status FROM expenses WHERE id = 1')).toEqual([{ status: 'current' }]);
    release();
    await api.waitForSent(before + 1);

    expect(((await undone) as ChatReply).text).toBe(S101);
    expect(((await correcting) as ChatReply).text).toBe(S7);
    chat.close();
  });

  it('when the store cannot be written, answers S-22 and nothing changes', async () => {
    await registered();
    const chat = await appChat();
    const db = new Database(join(scratch, 'anomander.db'));
    db.exec('ALTER TABLE pending_decisions RENAME TO pending_decisions_moved');
    db.close();

    const failed = strings.processingFailed();
    expect((await chat.ask({ type: 'undo_expense', expenseId: 1 })).text).toBe(failed);
    expect((await chat.ask({ type: 'correct_expense', expenseId: 1 })).text).toBe(failed);
    expect(gastos()).toEqual([{ total_cents: 2300 }]);
    expect(query('SELECT status FROM pending_decisions_moved')).toEqual([{ status: 'open' }]);
    chat.close();
  });

  it('rejects a request without a whole positive id, or with fields it does not know', async () => {
    await registered();
    const chat = await appChat();
    for (const request of [
      { type: 'undo_expense' },
      { type: 'undo_expense', expenseId: '1' },
      { type: 'correct_expense', expenseId: 0 },
      { type: 'correct_expense', expenseId: 1.5 },
      { type: 'undo_expense', expenseId: 1, all: true },
    ]) {
      expect((await chat.send(request)).type).toBe('rejected');
    }
    expect(gastos()).toEqual([{ total_cents: 2300 }]);
    chat.close();
  });
});
