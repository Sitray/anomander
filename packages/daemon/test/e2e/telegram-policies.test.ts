import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
import { receiptReaderPrompt } from '../../src/processor/receipt-reader.ts';
import { textInterpreterPrompt } from '../../src/processor/text-interpreter.ts';

// End to end (PRD §15): policies (R-13 AC1), patterns noticed by code (R-13 AC2) and the
// supermarket view (R-11 AC2), through the fake Telegram API, the real bot and a SQLite file. The
// phraser fails, so S-1 goes out exactly as written in §12 (R-21 AC2).
const PRINCIPAL = 4242;
const principal = { chatId: PRINCIPAL };
const FIXTURES = resolve(import.meta.dirname, '../fixtures');
const recorded = (name: string): AssistantMessage =>
  JSON.parse(readFileSync(resolve(FIXTURES, `${name}.json`), 'utf8'));
// The recorded receipt is dated 29 October; today is 30 October in Madrid.
const NOW = new Date('2026-10-30T10:00:05.000Z');
const S11 = '¿Guardo la regla «Mercadona es supermercado»?';
const S12 = 'He notado que Mercadona siempre es supermercado. ¿Lo convierto en regla?';
const S35 = 'Vale, no guardo la regla.';
const S19 = 'Esa pregunta ya no está abierta.';
const SAVED = 'Hecho, he guardado la regla «Mercadona es supermercado».';
const S1 = 'Apuntado: 23,00 € en Mercadona (supermercado).';

let scratch: string;
let api: FakeTelegramApi;
let anomander: Anomander;
/** What the text interpreter answers, by message. */
let interpretations: Map<string, AssistantMessage>;

/** A recorded response whose JSON envelope is replaced. */
const answering = (envelope: unknown): AssistantMessage => ({
  ...recorded('text-interpreter/conversation'),
  content: [{ type: 'text', text: JSON.stringify(envelope) }],
});

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'anomander-e2e-policies-'));
  interpretations = new Map();
  api = await startFakeTelegramApi();
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: api.token,
    ANOMANDER_PRINCIPAL_CHAT_ID: String(PRINCIPAL),
    ANOMANDER_DB_PATH: join(scratch, 'anomander.db'),
    ANOMANDER_INBOX_DIR: join(scratch, 'inbox'),
    ANOMANDER_MODEL: 'openai/gpt-4o-mini',
    ANOMANDER_VISION_MODEL: 'openai/gpt-4o',
  });
  const complete = async (_model: string, context: Context): Promise<AssistantMessage> => {
    if (context.systemPrompt === receiptReaderPrompt()) return recorded('receipt-reader/adds-up');
    const [turn] = context.messages;
    if (context.systemPrompt === textInterpreterPrompt() && typeof turn?.content === 'string') {
      const { message } = JSON.parse(turn.content);
      const interpretation = interpretations.get(message);
      if (interpretation === undefined) throw new Error(`no interpretation for ${message}`);
      return interpretation;
    }
    return { ...answering({}), content: [], stopReason: 'error', errorMessage: 'offline' };
  };
  anomander = startAnomander(config, {
    complete,
    model: 'openai/gpt-4o-mini',
    visionModel: 'openai/gpt-4o',
    telegramApiRoot: api.apiRoot,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    now: () => NOW,
  });
  await anomander.started;
});

afterEach(async () => {
  await anomander.stop();
  await api.close();
  rmSync(scratch, { recursive: true, force: true });
});

const withDb = <T>(use: (db: Database.Database) => T): T => {
  const db = new Database(join(scratch, 'anomander.db'));
  try {
    return use(db);
  } finally {
    db.close();
  }
};
const query = <T>(sql: string): T[] => withDb((db) => db.prepare(sql).all() as T[]);

/** A policy declared before the test, as a rule stored by hand. */
const addPolicy = (merchant: string, category: string) =>
  withDb((db) => {
    const declaration = db
      .prepare(
        `INSERT INTO assertions (subject_type, predicate, value_json, mode, actor, source, status,
           created_at)
         VALUES ('policy', 'rule', '{}', 'declared', 'principal', 'telegram:1', 'current', ?)`,
      )
      .run(NOW.toISOString());
    db.prepare(
      'INSERT INTO policies (rule_json, declared_by_assertion_id, created_at) VALUES (?, ?, ?)',
    ).run(JSON.stringify({ merchant, category }), declaration.lastInsertRowid, NOW.toISOString());
  });

/** Sends `text`; resolves with the `count` messages sent after it. */
const say = async (text: string, count = 1) => {
  const before = api.sent.length;
  api.push(updates.text(principal, text));
  return (await api.waitForSent(before + count)).slice(before);
};

const press = async (question: SentMessage, data: string) => {
  const before = api.sent.length;
  api.push(updates.callbackQuery(principal, data, question.messageId));
  return (await api.waitForSent(before + 1)).at(-1);
};

const yesNo = (decisionId: number) => ({
  inline_keyboard: [
    [
      { text: 'Sí', callback_data: `decision:${decisionId}:0` },
      { text: 'No', callback_data: `decision:${decisionId}:1` },
    ],
  ],
});

/** The latest decision, once its message is recorded (R-17 AC2). */
/** The decisions other than the "Deshacer" and "Corregir" under each typed expense (R-7 AC4). */
const ASKED = "proposal_id NOT IN (SELECT id FROM proposals WHERE operation = 'amend_expense')";

const shownDecision = async () => {
  let id: number | undefined;
  await vi.waitFor(() => {
    [{ id } = { id: undefined }] = query<{ id: number }>(
      `SELECT id FROM pending_decisions WHERE channel_ref IS NOT NULL AND ${ASKED}
       ORDER BY id DESC LIMIT 1`,
    );
    expect(id).toBeDefined();
  });
  return id as number;
};

/** The policy "Mercadona es supermercado" as the processor points at it (R-13 AC1). */
const proposePolicy = (reply = 'Ya lo tengo: Mercadona va a supermercado.') => {
  interpretations.set(
    'Mercadona es supermercado',
    answering({ kind: 'policy', merchant: 'Mercadona', category: 'supermercado', reply }),
  );
  return say('Mercadona es supermercado');
};

/** "23 € Mercadona", with the category declared by the principal or only inferred. */
const spend = (merchant: string, basis: 'declared' | 'inferred') => {
  const text =
    basis === 'declared' ? `23 € ${merchant}, categoría supermercado` : `23 € ${merchant}`;
  const inference = (predicate: string, value_json: unknown, quote: string) => ({
    subject_type: 'expense',
    subject_id: null,
    predicate,
    value_json,
    mode: 'inferred',
    basis_json: { quote },
    confidence: 0.9,
  });
  interpretations.set(
    text,
    answering({
      kind: 'expense',
      inferences: [
        inference('total', 2300, '23 €'),
        inference('merchant', merchant, merchant),
        basis === 'declared'
          ? inference('declared_category', 'supermercado', 'categoría supermercado')
          : inference('category', 'supermercado', merchant),
      ],
    }),
  );
  return text;
};

/** Registers the same expense `times` times; resolves once every reply verified its action. */
const spendTimes = async (text: string, times: number) => {
  const verified = () => query("SELECT id FROM actions WHERE status = 'verified'");
  const expected = verified().length + times;
  for (let i = 0; i < times; i += 1) await say(text);
  await vi.waitFor(() => expect(verified()).toHaveLength(expected));
};

const policies = () => query('SELECT rule_json, active, revoked_at FROM policies ORDER BY id');

describe('policies over Telegram (R-13 AC1)', () => {
  it('"Sí" to S-11 stores the policy; the next Mercadona receipt is categorized by it and shows in supermarket_purchases (R-11 AC2)', async () => {
    addPolicy('Mercadona', 'restaurantes');

    const [question] = await proposePolicy();
    const decisionId = await shownDecision();

    expect(question?.text).toBe(S11);
    expect(question?.payload.reply_markup).toEqual(yesNo(decisionId));
    if (question === undefined) throw new Error('no question');

    const saved = await press(question, `decision:${decisionId}:0`);

    expect(saved?.text).toBe(SAVED);
    // The new rule supersedes the one it contradicts.
    expect(policies()).toEqual([
      {
        rule_json: JSON.stringify({ merchant: 'Mercadona', category: 'restaurantes' }),
        active: 0,
        revoked_at: NOW.toISOString(),
      },
      {
        rule_json: JSON.stringify({ merchant: 'Mercadona', category: 'supermercado' }),
        active: 1,
        revoked_at: null,
      },
    ]);
    // §13: declared only by the principal, from their message, answering the decision.
    const [proposal] = query<{ basis_json: string }>(
      "SELECT basis_json FROM proposals WHERE operation = 'create_policy'",
    );
    const { source } = JSON.parse(proposal?.basis_json ?? '{}');
    expect(source).toMatch(/^telegram:\d+$/);
    expect(
      query(`SELECT a.subject_type, a.predicate, a.value_json, a.mode, a.actor, a.source, a.status,
               a.supersedes_id, p.active
             FROM policies p JOIN assertions a ON a.id = p.declared_by_assertion_id
             ORDER BY p.id`),
    ).toEqual([
      expect.objectContaining({ source: 'telegram:1', status: 'refuted', active: 0 }),
      {
        subject_type: 'policy',
        predicate: 'rule',
        value_json: JSON.stringify({ merchant: 'Mercadona', category: 'supermercado' }),
        mode: 'declared',
        actor: 'principal',
        source,
        status: 'current',
        supersedes_id: 1,
        active: 1,
      },
    ]);
    expect(
      query(`SELECT p.status, d.status AS decision, d.answer_assertion_id, x.authorized_by
             FROM proposals p JOIN pending_decisions d ON d.proposal_id = p.id
             JOIN actions x ON x.proposal_id = p.id`),
    ).toEqual([
      {
        status: 'executed',
        decision: 'answered',
        answer_assertion_id: 2,
        authorized_by: 'principal',
      },
    ]);

    // R-5 AC1, R-6 AC1: the receipt takes the policy's category and is registered without asking;
    // R-11 AC2: its lines are in the view with no further action.
    const before = api.sent.length;
    api.putFile('receipt', pngBytes(1));
    api.push(updates.photo(principal, { fileId: 'receipt' }));
    const reply = (await api.waitForSent(before + 1)).at(-1);

    expect(reply?.text).toBe('Apuntado: 23,40 € en Mercadona (supermercado).');
    expect(reply?.payload.reply_markup).toBeUndefined();
    expect(query('SELECT category_basis, status FROM expenses WHERE document_id = 1')).toEqual([
      { category_basis: 'policy', status: 'current' },
    ]);
    expect(query('SELECT * FROM supermarket_purchases ORDER BY producto')).toEqual([
      {
        producto: 'ACEITE OLIVA 1L',
        cantidad: 1,
        precio_cents: 895,
        comercio: 'Mercadona',
        fecha: '2026-10-29',
        modo: 'corroborated',
      },
      {
        producto: 'FRUTA',
        cantidad: 1,
        precio_cents: 1267,
        comercio: 'Mercadona',
        fecha: '2026-10-29',
        modo: 'corroborated',
      },
      {
        producto: 'LECHE ENTERA 1L',
        cantidad: 2,
        precio_cents: 178,
        comercio: 'Mercadona',
        fecha: '2026-10-29',
        modo: 'corroborated',
      },
    ]);
  });

  it('"No" to S-11 replies S-35 and stores nothing', async () => {
    const [question] = await proposePolicy();
    const decisionId = await shownDecision();
    if (question === undefined) throw new Error('no question');

    const kept = await press(question, `decision:${decisionId}:1`);

    expect(kept?.text).toBe(S35);
    expect(policies()).toEqual([]);
    expect(query("SELECT id FROM assertions WHERE subject_type = 'policy'")).toEqual([]);
    expect(
      query(`SELECT p.status, d.status AS decision FROM proposals p
             JOIN pending_decisions d ON d.proposal_id = p.id`),
    ).toEqual([{ status: 'rejected', decision: 'answered' }]);
    expect(query('SELECT id FROM actions')).toEqual([]);
  });

  it('R-5 AC3: a merchant or category the principal did not write is not proposed', async () => {
    interpretations.set(
      'el súper de siempre es supermercado',
      answering({
        kind: 'policy',
        merchant: 'Mercadona',
        category: 'supermercado',
        reply: 'Vale.',
      }),
    );

    const [reply] = await say('el súper de siempre es supermercado');

    expect(reply?.text).toBe(
      'Algo ha fallado y no he podido procesar tu mensaje. ¿Me lo vuelves a enviar en un rato?',
    );
    expect(reply?.payload.reply_markup).toBeUndefined();
    expect(query('SELECT id FROM proposals')).toEqual([]);
  });

  it('a rule already active is not asked again: the reply is the phrased S-39 (R-21)', async () => {
    addPolicy('Mercadona', 'supermercado');

    const [reply] = await proposePolicy();

    expect(reply?.text).toBe('Ya lo tengo: Mercadona va a supermercado.');
    expect(reply?.payload.reply_markup).toBeUndefined();
    expect(query('SELECT id FROM proposals')).toEqual([]);
  });

  it('a phrased S-39 that drops the rule is replaced by S-39 verbatim (R-21 AC2)', async () => {
    addPolicy('Mercadona', 'supermercado');

    const [reply] = await proposePolicy('Esa ya la tengo guardada.');

    expect(reply?.text).toBe('Ya tengo la regla «Mercadona es supermercado».');
  });

  it('a rule already active with no phrased reply gets S-39 verbatim (R-21 AC2)', async () => {
    addPolicy('Mercadona', 'supermercado');
    interpretations.set(
      'Mercadona es supermercado',
      answering({ kind: 'policy', merchant: 'Mercadona', category: 'supermercado' }),
    );

    const [reply] = await say('Mercadona es supermercado');

    expect(reply?.text).toBe('Ya tengo la regla «Mercadona es supermercado».');
  });

  it('R-18: a rule naming a category that does not exist asks S-15 instead', async () => {
    interpretations.set(
      'Repsol es gasolina',
      answering({ kind: 'policy', merchant: 'Repsol', category: 'gasolina', reply: 'Vale.' }),
    );

    const [question] = await say('Repsol es gasolina');
    const decisionId = await shownDecision();

    expect(question?.text).toBe('¿Creo la categoría «gasolina»?');
    expect(question?.payload.reply_markup).toEqual(yesNo(decisionId));
    expect(query('SELECT operation FROM proposals')).toEqual([{ operation: 'create_category' }]);
    expect(policies()).toEqual([]);
  });
});

describe('patterns noticed by code (R-13 AC2)', () => {
  it('the third expense with a declared category sends S-12; "Sí" stores the policy', async () => {
    const text = spend('Mercadona', 'declared');
    await spendTimes(text, 2);
    expect(query(`SELECT id FROM pending_decisions WHERE ${ASKED}`)).toEqual([]);

    const [registered, offer] = await say(text, 2);
    const decisionId = await shownDecision();

    expect(registered?.text).toBe(S1);
    expect(offer?.text).toBe(S12);
    expect(offer?.payload.reply_markup).toEqual(yesNo(decisionId));
    if (offer === undefined) throw new Error('no offer');

    const saved = await press(offer, `decision:${decisionId}:0`);

    expect(saved?.text).toBe(SAVED);
    expect(policies()).toEqual([
      {
        rule_json: JSON.stringify({ merchant: 'Mercadona', category: 'supermercado' }),
        active: 1,
        revoked_at: null,
      },
    ]);
    expect(
      query(`SELECT a.mode, a.actor, a.source FROM policies p
             JOIN assertions a ON a.id = p.declared_by_assertion_id`),
    ).toEqual([{ mode: 'declared', actor: 'principal', source: `decision:${decisionId}:0` }]);
    const [proposal] = query<{ basis_json: string }>(
      "SELECT basis_json FROM proposals WHERE operation = 'create_policy'",
    );
    expect(JSON.parse(proposal?.basis_json ?? '{}')).toEqual({
      rule: 'R-13 AC2',
      expense_ids: [1, 2, 3],
    });
  });

  it('a rejected pattern is never offered again', async () => {
    const text = spend('Mercadona', 'declared');
    await spendTimes(text, 2);
    const [, offer] = await say(text, 2);
    const decisionId = await shownDecision();
    if (offer === undefined) throw new Error('no offer');

    const kept = await press(offer, `decision:${decisionId}:1`);
    await say(text);
    await vi.waitFor(() =>
      expect(query("SELECT id FROM actions WHERE status = 'verified'")).toHaveLength(4),
    );

    expect(kept?.text).toBe(S35);
    expect(query(`SELECT status FROM pending_decisions WHERE ${ASKED}`)).toEqual([
      { status: 'answered' },
    ]);
    expect(policies()).toEqual([]);
  });

  /** "no, es supermercado" as a typed correction (R-7 AC7) of expense `id`: its category declared. */
  const correctToSupermarket = (id: number) => {
    const text = 'no, es supermercado';
    interpretations.set(
      text,
      answering({
        kind: 'expense_correct',
        expense_id: id,
        inferences: [
          {
            subject_type: 'expense',
            subject_id: null,
            predicate: 'category',
            value_json: 'supermercado',
            mode: 'inferred',
            basis_json: { quote: 'supermercado' },
            confidence: 0.9,
          },
        ],
      }),
    );
    return text;
  };
  /** The "Deshacer" decision under the newest correction's reply (R-7 AC9). */
  const undoDecision = () => {
    const [undo] = query<{ id: number }>(
      `SELECT d.id FROM pending_decisions d JOIN proposals p ON p.id = d.proposal_id
       WHERE json_extract(p.payload_json, '$.restore') IS NOT NULL ORDER BY d.id DESC LIMIT 1`,
    );
    if (undo === undefined) throw new Error('no Deshacer');
    return undo.id;
  };
  /** Two declared Mercadona expenses and a third whose category is only inferred: no pattern yet. */
  const twoDeclaredOneInferred = async () => {
    await spendTimes(spend('Mercadona', 'declared'), 2);
    await spendTimes(spend('Mercadona', 'inferred'), 1);
    expect(query(`SELECT id FROM pending_decisions WHERE ${ASKED}`)).toEqual([]);
  };
  /** The correction of the third expense, its reply with "Deshacer" alone, then S-12. */
  const correctedIntoPattern = async () => {
    const [corrected, offer] = await say(correctToSupermarket(3), 2);
    const offerId = await shownDecision();
    if (corrected === undefined || offer === undefined) throw new Error('no reply or offer');
    const undoId = undoDecision();
    expect(corrected.text).toBe(S1.replace('Apuntado', 'Corregido'));
    expect(corrected.payload.reply_markup).toEqual({
      inline_keyboard: [[{ text: 'Deshacer', callback_data: `decision:${undoId}:0` }]],
    });
    expect(offer.text).toBe(S12);
    expect(offer.payload.reply_markup).toEqual(yesNo(offerId));
    expect(query('SELECT category_basis FROM expenses WHERE id = 3')).toEqual([
      { category_basis: 'declared' },
    ]);
    return { corrected, offer, offerId, undoId };
  };
  const offerState = (offerId: number) =>
    query(
      `SELECT d.status AS decision, p.status AS proposal FROM pending_decisions d
       JOIN proposals p ON p.id = d.proposal_id WHERE d.id = ${offerId}`,
    );

  // B79, R-7 AC9 with R-13 AC2 (decided by the principal on 2026-11-26: "Se retira"): the
  // "Deshacer" of a correction withdraws the S-12 it led to, closed as R-7 AC8 closes a question,
  // so a late "Sí" gets S-19 and stores no rule.
  it('a correction that completes a pattern carries "Deshacer"; using it withdraws its S-12', async () => {
    await twoDeclaredOneInferred();
    const { corrected, offer, offerId, undoId } = await correctedIntoPattern();

    const undone = await press(corrected, `decision:${undoId}:0`);

    expect(undone?.text).toBe(S1.replace('Apuntado:', 'Deshecho: vuelve a ser'));
    expect(query('SELECT category_basis, status FROM expenses WHERE id = 3')).toEqual([
      { category_basis: 'inferred', status: 'current' },
    ]);
    expect(offerState(offerId)).toEqual([{ decision: 'expired', proposal: 'rejected' }]);

    expect((await press(offer, `decision:${offerId}:0`))?.text).toBe(S19);
    expect(policies()).toEqual([]);
    expect(offerState(offerId)).toEqual([{ decision: 'expired', proposal: 'rejected' }]);
  });

  it('the S-12 of a correction not undone still stores the rule on "Sí"', async () => {
    await twoDeclaredOneInferred();
    const { offer, offerId } = await correctedIntoPattern();

    const saved = await press(offer, `decision:${offerId}:0`);

    expect(saved?.text).toBe(SAVED);
    expect(policies()).toEqual([
      {
        rule_json: JSON.stringify({ merchant: 'Mercadona', category: 'supermercado' }),
        active: 1,
        revoked_at: null,
      },
    ]);
  });

  it('an S-12 the undone correction did not lead to stays open, and its "Sí" stores the rule', async () => {
    await twoDeclaredOneInferred();
    const { corrected, offerId, undoId } = await correctedIntoPattern();
    // Another merchant's pattern, offered after that correction, rests on none of its expenses.
    const lidl = spend('Lidl', 'declared');
    await spendTimes(lidl, 2);
    const [, other] = await say(lidl, 2);
    let otherId: number | undefined;
    await vi.waitFor(() => {
      [{ id: otherId } = { id: undefined }] = query<{ id: number }>(
        `SELECT d.id FROM pending_decisions d JOIN proposals p ON p.id = d.proposal_id
         WHERE p.operation = 'create_policy' AND json_extract(p.payload_json, '$.merchant') = 'Lidl'
           AND d.channel_ref IS NOT NULL`,
      );
      expect(otherId).toBeDefined();
    });
    if (other === undefined || otherId === undefined) throw new Error('no offer');
    expect(other.text).toBe(S12.replace('Mercadona', 'Lidl'));

    await press(corrected, `decision:${undoId}:0`);

    expect(offerState(offerId)).toEqual([{ decision: 'expired', proposal: 'rejected' }]);
    expect(offerState(otherId)).toEqual([{ decision: 'open', proposal: 'asked' }]);
    expect((await press(other, `decision:${otherId}:0`))?.text).toBe(
      SAVED.replace('Mercadona', 'Lidl'),
    );
    expect(policies()).toEqual([
      {
        rule_json: JSON.stringify({ merchant: 'Lidl', category: 'supermercado' }),
        active: 1,
        revoked_at: null,
      },
    ]);
  });

  it('a merchant with a policy, or a category only inferred, is not offered', async () => {
    addPolicy('Lidl', 'supermercado');

    await spendTimes(spend('Mercadona', 'inferred'), 3);
    await spendTimes(spend('Lidl', 'declared'), 3);

    expect(query(`SELECT id FROM pending_decisions WHERE ${ASKED}`)).toEqual([]);
    expect(api.sent).toHaveLength(6);
  });
});
