import type Database from 'better-sqlite3';
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

const SELECT_MEMORY = `SELECT a.id, t.text, a.mode
  FROM assertions a JOIN memory_texts t ON t.assertion_id = a.id
  WHERE ${CURRENT_MEMORY}`;

const isCurrentMemory = (db: Database.Database, id: number): boolean =>
  db
    .prepare<[number]>(`SELECT 1 FROM assertions a WHERE a.id = ? AND ${CURRENT_MEMORY}`)
    .get(id) !== undefined;

/**
 * R-23 AC2, AC3: stores the fact as a `memory` assertion about the principal and its text and
 * quote in `memory_texts`, in one transaction. It is `declared` by the principal only when the
 * processor says they said it and the quote is in the message; otherwise `inferred` by the
 * processor. When it replaces a current memory, it supersedes it and the old one is `refuted`;
 * a `replaces` that names no current memory is ignored and the fact is stored as new. Returns
 * the new memory's id.
 */
export const saveMemory = (db: Database.Database, capture: MemoryCapture): number =>
  db.transaction(() => {
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
    if (replaced !== null) {
      db.prepare("UPDATE assertions SET status = 'refuted' WHERE id = ?").run(replaced);
    }
    return id;
  })();

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
 * they were remembered. A message with no words matches none.
 */
export const memoriesForPrompt = (db: Database.Database, message: string): Memory[] => {
  const { count } = db
    .prepare<[], { count: number }>(
      `SELECT count(*) AS count FROM assertions a WHERE ${CURRENT_MEMORY}`,
    )
    .get() ?? { count: 0 };
  if (count <= MEMORY_PROMPT_LIMIT) return listMemories(db);
  const query = matchQuery(message);
  if (query === null) return [];
  return db
    .prepare<[string, number], Memory>(
      `SELECT id, text, mode FROM (
         ${SELECT_MEMORY} AND a.id IN (
           SELECT s.rowid FROM memory_search s
           JOIN assertions a ON a.id = s.rowid
           WHERE memory_search MATCH ? AND ${CURRENT_MEMORY}
           ORDER BY s.rank LIMIT ?))
       ORDER BY id`,
    )
    .all(query, MEMORY_PROMPT_LIMIT);
};

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
