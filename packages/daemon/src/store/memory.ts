import { AsyncLocalStorage } from 'node:async_hooks';
import type Database from 'better-sqlite3';
import type { Logger } from '../processor/ports.ts';
import { forgetTurnsHolding } from './conversation.ts';
import { insertAssertion } from './expenses.ts';

// Rows of PRD §13 for conversation memory (R-23). Each memory is an assertion about the
// principal with predicate `memory`; its text and quote live only in `memory_texts` (indexed by
// `memory_search`), so forgetting erases them without touching the append-only ledger. Nothing
// here logs a memory's text or quote (R-23 AC8).

/** R-23 AC4: beyond this many current memories, the prompt gets only the best FTS5 matches. */
export const MEMORY_PROMPT_LIMIT = 50;

// The assertion points at where its text lives instead of holding it.
const MEMORY_VALUE = { text_in: 'memory_texts' };
const INFERENCE_BASIS = { quote_in: 'memory_texts' };

export type MemoryMode = 'declared' | 'inferred';

export interface Memory {
  /** The id of its `memory` assertion. */
  id: number;
  text: string;
  mode: MemoryMode;
}

/** A lasting fact about the principal the processor took from one of their messages. */
export interface MemoryCapture {
  /** The fact, as the processor worded it. */
  text: string;
  /** The words of the message it rests on. */
  quote: string;
  /** Whether the processor says the principal said it. */
  said: boolean;
  /** The processor's confidence; stored only when the memory is inferred (§7.2). */
  confidence: number;
  /** The principal's message the fact was taken from. */
  message: string;
  /** The principal's message, `telegram:<message_id>`. */
  source: string;
  /** The id of the current memory this fact replaces, if any (R-23 AC3). */
  replaces: number | null;
  receivedAt: string;
  now: string;
}

// Case-insensitive and whitespace-normalized, like the phrased-reply check (R-21).
const normalize = (text: string): string =>
  text.replace(/\s+/g, ' ').trim().toLocaleLowerCase('es-ES');

/**
 * R-23 AC2, AC4: a non-empty quote that appears in the message, ignoring case and spacing. A
 * memory is `declared` only when its quote passes, and an expense inference is kept only then.
 */
export const quotedFrom = (quote: string, message: string): boolean => {
  const normalized = normalize(quote);
  return normalized !== '' && normalize(message).includes(normalized);
};

const principalId = (db: Database.Database): number => {
  const row = db
    .prepare<[], { id: number }>("SELECT id FROM entities WHERE kind = 'principal'")
    .get();
  if (row === undefined) throw new Error('the principal entity is missing');
  return row.id;
};

const CURRENT_MEMORY = `a.subject_type = 'principal' AND a.predicate = 'memory'
  AND a.status = 'current'`;

const SELECT_MEMORY_WHERE = `SELECT a.id, t.text, a.mode
  FROM assertions a JOIN memory_texts t ON t.assertion_id = a.id
  WHERE`;
const SELECT_MEMORY = `${SELECT_MEMORY_WHERE} ${CURRENT_MEMORY}`;

/** Lowercase, single-spaced and without accents, so a match ignores all three. */
const folded = (text: string): string => normalize(text).normalize('NFD').replace(/\p{M}/gu, '');

/**
 * Whether `text` holds `words` as whole words: no letter or digit right before or after them, so
 * "sí" is not in "así" nor "23" in "123". Ignores case, spacing and accents. Empty words match
 * nothing.
 */
const saysWords = (words: string): ((text: string) => boolean) => {
  const wanted = folded(words);
  if (wanted === '') return () => false;
  const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u');
  return (text) => pattern.test(folded(text));
};

/**
 * A line the daemon wrote for the principal, such as `[botón: Sí]` or `[foto de ticket]`: not
 * their own words, so a quote is never matched against it.
 */
export const isMarkerLine = (text: string): boolean => text.startsWith('[');

/**
 * DK-18: a phrase of fewer words than this is too common to find a mention of it inside other
 * words ("sí", "hola"): only a message that is exactly it mentions it.
 */
export const MENTION_MIN_WORDS = 3;

const wordsOf = (text: string): string[] => folded(text).match(/[\p{L}\p{N}]+/gu) ?? [];

/** DK-18: whether a message holds `phrase` as whole words; `null` for a phrase too short to tell. */
export const saysPhrase = (phrase: string): ((text: string) => boolean) | null =>
  wordsOf(phrase).length >= MENTION_MIN_WORDS ? saysWords(phrase) : null;

/** DK-18: whether a message is `phrase` and nothing else, ignoring case, accents and punctuation. */
export const isExactly = (phrase: string): ((text: string) => boolean) => {
  const wanted = wordsOf(phrase).join(' ');
  return (text) => wanted !== '' && wordsOf(text).join(' ') === wanted;
};

/**
 * R-23 AC3: erases a replaced memory's text and quote from `memory_texts` and the turns of the
 * stored conversation (R-16 AC3) where the principal said it, so its old fact is kept nowhere: a
 * principal's message that holds the quote (their own words, never a marker line) or the text,
 * and a reply that holds the text, each matched as whole words, ignoring case, spacing and
 * accents; a matched message takes its turn with it. The rest of the conversation stays. With
 * `mentioned` (DK-18 AC4), a text or quote of fewer than `MENTION_MIN_WORDS` words takes only a
 * principal's own message that is exactly it. In the caller's transaction; the caller
 * checkpoints the WAL after it. Returns how to tell a message that holds those words.
 */
const eraseReplacedText = (db: Database.Database, id: number, mentioned = false): TurnHolds => {
  const row = db
    .prepare<[number], { text: string; quote: string }>(
      'SELECT text, quote FROM memory_texts WHERE assertion_id = ?',
    )
    .get(id);
  let holds: TurnHolds = () => false;
  if (row !== undefined) {
    const saysText = mentioned ? saysPhrase(row.text) : saysWords(row.text);
    const saysQuote = mentioned ? saysPhrase(row.quote) : saysWords(row.quote);
    const isText = isExactly(row.text);
    const isQuote = isExactly(row.quote);
    holds = ({ from, text }) => {
      const own = from === 'principal' && !isMarkerLine(text);
      const byText = saysText === null ? own && isText(text) : saysText(text);
      const byQuote = own && (saysQuote === null ? isQuote(text) : saysQuote(text));
      return byText || byQuote;
    };
    forgetTurnsHolding(db, holds);
  }
  db.prepare('DELETE FROM memory_texts WHERE assertion_id = ?').run(id);
  return holds;
};

/** Whether a message of the stored conversation holds a replaced memory's words. */
export type TurnHolds = (message: { from: 'principal' | 'anomander'; text: string }) => boolean;

/**
 * B55, B81 (R-23 AC3): how to tell the words of the memories replaced while one turn is
 * answered, gathered for that turn only. The message that replaces a memory is stored after it,
 * with the reply it got (`recentTurns.add`), so the erase above cannot find it; its own turn
 * asks here (`replacingIn`). A turn stored meanwhile by another door never sees them, and a turn
 * that fails before it is stored takes them with it.
 */
const replacedInTurn = new AsyncLocalStorage<TurnHolds[]>();

/**
 * B81: runs `answer`, the handler of one turn, and returns its result with the words of every
 * memory `saveMemory` replaced while it ran, for that turn to be matched against.
 */
export const replacingIn = async <T>(
  answer: () => Promise<T>,
): Promise<{ result: T; replaced: readonly TurnHolds[] }> => {
  const replaced: TurnHolds[] = [];
  const result = await replacedInTurn.run(replaced, answer);
  return { result, replaced };
};

/**
 * B55: whether the turn about to be stored, the principal's `message` and its `reply`, says one
 * of the memories its own handler `replaced`, so it is not stored.
 */
export const turnSaysReplacedMemory = (
  replaced: readonly TurnHolds[],
  message: string,
  reply: string,
): boolean =>
  replaced.some(
    (holds) =>
      holds({ from: 'principal', text: message }) || holds({ from: 'anomander', text: reply }),
  );

const isCurrentMemory = (db: Database.Database, id: number): boolean =>
  db
    .prepare<[number]>(`SELECT 1 FROM assertions a WHERE a.id = ? AND ${CURRENT_MEMORY}`)
    .get(id) !== undefined;

/**
 * R-23 AC2, AC3: stores the fact as a `memory` assertion about the principal and its text and
 * quote in `memory_texts`, in one transaction. It is `declared` by the principal only when the
 * processor says they said it and the quote is in the message; otherwise `inferred` by the
 * processor. When it replaces a current memory, it supersedes it, the old one is `refuted` and
 * its text is erased as a forget erases it (AC6, AC7), with the turns of the stored conversation
 * that hold its text or quote, so no outdated text is ever kept; a
 * `replaces` that names no current memory is ignored and the fact is stored as new. Returns the
 * new memory's id. A replacement made outside any turn's scope (`replacingIn`) is warned to
 * `logger`, once, by the fact alone (B83).
 */
export const saveMemory = (
  db: Database.Database,
  capture: MemoryCapture,
  logger?: Pick<Logger, 'warn'>,
): number => {
  const { id, replaced, holds } = db.transaction(() => {
    const declared = capture.said && quotedFrom(capture.quote, capture.message);
    const replaced =
      capture.replaces !== null && isCurrentMemory(db, capture.replaces) ? capture.replaces : null;
    const id = insertAssertion(
      db,
      {
        subject_type: 'principal',
        subject_id: principalId(db),
        predicate: 'memory',
        value_json: MEMORY_VALUE,
        mode: declared ? 'declared' : 'inferred',
        actor: declared ? 'principal' : 'processor',
        source: capture.source,
        basis_json: declared ? null : INFERENCE_BASIS,
        confidence: declared ? null : capture.confidence,
        valid_at: capture.receivedAt,
        expires_at: null,
        status: 'current',
        supersedes_id: replaced,
        confirms_id: null,
      },
      capture.now,
    );
    db.prepare('INSERT INTO memory_texts (assertion_id, text, quote) VALUES (?, ?, ?)').run(
      id,
      capture.text,
      capture.quote,
    );
    let holds: TurnHolds | null = null;
    if (replaced !== null) {
      db.prepare("UPDATE assertions SET status = 'refuted' WHERE id = ?").run(replaced);
      holds = eraseReplacedText(db, replaced);
    }
    return { id, replaced, holds };
  })();
  // B81: only the turn this runs in is matched against the old words (`replacingIn`).
  // B83: with no turn's scope (a caller outside `recordingTurns`, or a handler that lost its
  // async context) no turn can be matched, so it is said instead of kept silently. There is no
  // fallback: the door of the turn to come is not known here, and handing the words to whatever
  // turn is stored next would let them suppress a turn of another door or outlive a turn that
  // failed, which B81 rules out. Only the fact and the new memory's id are logged (R-23 AC8).
  if (holds !== null) {
    const scope = replacedInTurn.getStore();
    if (scope !== undefined) scope.push(holds);
    else {
      logger?.warn('replaced memory not matched against its turn: no turn scope', {
        memoryId: id,
      });
    }
  }
  // The checkpoint cannot run inside the transaction (see forgetMemories).
  if (replaced !== null) db.pragma('wal_checkpoint(TRUNCATE)');
  return id;
};

/** R-23 AC5: every current memory, in the order it was remembered. */
export const listMemories = (db: Database.Database): Memory[] =>
  db.prepare<[], Memory>(`${SELECT_MEMORY} ORDER BY a.id`).all();

// Each word of the message becomes a quoted FTS5 term, so no operator, column filter or quote
// in the principal's text is ever read as query syntax. Any word may match.
const matchQuery = (message: string): string | null => {
  const words = message.match(/[\p{L}\p{N}]+/gu);
  return words === null ? null : words.map((word) => `"${word}"`).join(' OR ');
};

/**
 * R-23 AC4: the memories a conversation reply receives. All current memories when there are at
 * most 50; beyond that, the 50 the message matches best in `memory_search` (bm25), in the order
 * they were remembered. A message with no words matches none. With `only`, just the memories of
 * that mode, chosen the same way among them.
 */
export const memoriesForPrompt = (
  db: Database.Database,
  message: string,
  only?: MemoryMode,
): Memory[] => {
  const current = only === undefined ? CURRENT_MEMORY : `${CURRENT_MEMORY} AND a.mode = ?`;
  const modes = only === undefined ? [] : [only];
  const { count } = db
    .prepare<string[], { count: number }>(
      `SELECT count(*) AS count FROM assertions a WHERE ${current}`,
    )
    .get(...modes) ?? { count: 0 };
  if (count <= MEMORY_PROMPT_LIMIT) {
    return db
      .prepare<string[], Memory>(`${SELECT_MEMORY_WHERE} ${current} ORDER BY a.id`)
      .all(...modes);
  }
  const query = matchQuery(message);
  if (query === null) return [];
  return db
    .prepare<(string | number)[], Memory>(
      `SELECT id, text, mode FROM (
         ${SELECT_MEMORY_WHERE} ${current} AND a.id IN (
           SELECT s.rowid FROM memory_search s
           JOIN assertions a ON a.id = s.rowid
           WHERE memory_search MATCH ? AND ${current}
           ORDER BY s.rank LIMIT ?))
       ORDER BY id`,
    )
    .all(...modes, query, ...modes, MEMORY_PROMPT_LIMIT);
};

/**
 * A memory as a look at the screen and a step on the computer read it (DK-14 AC1): what the
 * principal said about themselves, never what the processor deduced.
 */
export interface MemoryNote {
  text: string;
  mode: 'declared';
}

/**
 * DK-14 AC1: the memories a look at the screen and a step on the computer receive, chosen as
 * `memoriesForPrompt` chooses among the `declared` ones only, without their ids: those ways only
 * read them, they never pick one to forget. An `inferred` memory never reaches them: its quote
 * need not be the principal's words, so it could carry an instruction into a way that acts
 * (security audit M5).
 */
export const memoryNotesFor = (db: Database.Database, words: string): MemoryNote[] =>
  memoriesForPrompt(db, words, 'declared').map(({ text }) => ({ text, mode: 'declared' }));

/**
 * DK-18 AC4 (decided by the principal on 2026-11-24: "Solo los mensajes que lo contienen"): forgets
 * one current memory from the app's "Memoria" as `forgetMemories` does, and of the stored
 * conversation only the turns that say it, as a replaced memory's (R-23 AC3), except that a text
 * or quote of fewer than 3 words takes only a principal's message that is exactly it. Then the WAL
 * is checkpointed. Returns whether it was a current memory; one that is not is left alone.
 */
export const forgetMemoryAndItsTurns = (db: Database.Database, id: number): boolean => {
  const forgotten = db.transaction(() => {
    if (!isCurrentMemory(db, id)) return false;
    eraseReplacedText(db, id, true);
    db.prepare("UPDATE assertions SET status = 'expired' WHERE id = ?").run(id);
    return true;
  })();
  if (forgotten) db.pragma('wal_checkpoint(TRUNCATE)');
  return forgotten;
};

/**
 * B55: whether memory `id` was forgotten (`expired`), by a "Sí" that then failed halfway or by
 * "Olvidar" in the app; a replaced one (`refuted`) was not.
 */
export const isForgottenMemory = (db: Database.Database, id: number): boolean =>
  db
    .prepare<[number]>(
      "SELECT 1 FROM assertions WHERE id = ? AND predicate = 'memory' AND status = 'expired'",
    )
    .get(id) !== undefined;

/**
 * R-23 AC6, AC7: forgets the given current memories. In one transaction each one's text and
 * quote are deleted from `memory_texts` (the triggers remove them from `memory_search`) and its
 * assertion becomes `expired`, the mark that something was remembered and forgotten. Then the
 * WAL is checkpointed and truncated so the erased text survives in no file; with
 * `secure_delete` and FTS5 `secure-delete` on, the freed pages hold zeros. Ids that are not
 * current memories are left alone. Returns the ids forgotten.
 */
export const forgetMemories = (db: Database.Database, ids: readonly number[]): number[] => {
  const forgotten = db.transaction(() =>
    ids.filter((id) => {
      if (!isCurrentMemory(db, id)) return false;
      db.prepare('DELETE FROM memory_texts WHERE assertion_id = ?').run(id);
      db.prepare("UPDATE assertions SET status = 'expired' WHERE id = ?").run(id);
      return true;
    }),
  )();
  if (forgotten.length > 0) db.pragma('wal_checkpoint(TRUNCATE)');
  return forgotten;
};
