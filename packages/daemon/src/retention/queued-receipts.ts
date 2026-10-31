import type Database from 'better-sqlite3';
import { idOf, insertAssertion } from '../store/expenses.ts';
import { openPendingDecision } from '../store/receipts.ts';

// Rows of PRD §13 for receipts that wait for the daily AI budget (R-8 AC2 to AC5, R-12) and for
// the retention job (R-19). Besides the queue fields, only `status` columns change here.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const plus = (iso: string, ms: number): string => new Date(Date.parse(iso) + ms).toISOString();

/** R-8 AC2: a queued receipt is kept 24 hours after `received_at`. */
export const queuedKeepUntil = (receivedAt: string): string => plus(receivedAt, DAY);
/** R-8 AC4: "Sí" keeps it until it is read, at most 7 days after `received_at`. */
export const longestKeepUntil = (receivedAt: string): string => plus(receivedAt, 7 * DAY);
/** R-8 AC3: S-13 goes out 1 hour before `keep_until`. */
export const NOTICE_BEFORE_MS = HOUR;

export interface QueuedReceipt {
  documentId: number;
  /** The principal's message: the source of the caption's declarations. */
  channelRef: string;
  receivedAt: string;
  caption: string | null;
  now: string;
}

/**
 * R-8 AC2: the document stays `queued` with its images and gets `keep_until`; a `keep_until`
 * marks it as waiting for the budget. The caption is observed with it, so it can still be read
 * as a declaration (R-3 AC5) when the receipt is read on another day.
 */
export const queueReceipt = (db: Database.Database, receipt: QueuedReceipt): void =>
  db.transaction(() => {
    db.prepare(
      "UPDATE documents SET keep_until = ? WHERE id = ? AND status = 'queued' AND keep_until IS NULL",
    ).run(queuedKeepUntil(receipt.receivedAt), receipt.documentId);
    if (receipt.caption === null) return;
    insertAssertion(
      db,
      {
        subject_type: 'document',
        subject_id: receipt.documentId,
        predicate: 'caption',
        value_json: receipt.caption,
        mode: 'observed',
        actor: 'source',
        source: receipt.channelRef,
        basis_json: null,
        confidence: null,
        valid_at: receipt.receivedAt,
        expires_at: null,
        status: 'current',
        supersedes_id: null,
        confirms_id: null,
      },
      receipt.now,
    );
  })();

export interface WaitingReceipt {
  documentId: number;
  channelRef: string;
  receivedAt: string;
  caption: string | null;
}

/** A receipt that waits for the budget, as it arrived; `null` when it no longer waits. */
export const findWaitingReceipt = (
  db: Database.Database,
  documentId: number,
): WaitingReceipt | null => {
  const row = db
    .prepare<[number], { source: string; received_at: string; caption: string | null }>(
      `SELECT d.source, d.received_at,
              (SELECT value_json FROM assertions
               WHERE subject_type = 'document' AND subject_id = d.id AND predicate = 'caption'
               ORDER BY id DESC LIMIT 1) AS caption
       FROM documents d
       WHERE d.id = ? AND d.status = 'queued' AND d.keep_until IS NOT NULL`,
    )
    .get(documentId);
  if (row === undefined) return null;
  return {
    documentId,
    channelRef: row.source,
    receivedAt: row.received_at,
    caption: row.caption === null ? null : (JSON.parse(row.caption) as string),
  };
};

/** R-12 AC3: the receipts that wait and may still be read, in arrival order. */
export const listWaitingReceipts = (db: Database.Database, now: string): number[] =>
  db
    .prepare<[string], { id: number }>(
      `SELECT id FROM documents
       WHERE status = 'queued' AND keep_until IS NOT NULL AND keep_until > ?
       ORDER BY received_at, id`,
    )
    .all(now)
    .map((row) => row.id);

export interface UnreadReceipt {
  id: number;
  received_at: string;
}

const KEEP_RECEIPT_OF = `SELECT id FROM proposals
  WHERE operation = 'keep_receipt' AND json_extract(payload_json, '$.document_id') = ?`;

/**
 * R-8 AC3: the receipts still unread within 1 hour of `keep_until` that were never asked about.
 * Asking once is enough: after "Sí" the receipt is already kept as long as it can be.
 */
export const listReceiptsToAsk = (db: Database.Database, now: Date): UnreadReceipt[] =>
  db
    .prepare<[string, string], UnreadReceipt>(
      `SELECT d.id, d.received_at FROM documents d
       WHERE d.status = 'queued' AND d.keep_until > ? AND d.keep_until <= ?
         AND NOT EXISTS (
           SELECT 1 FROM proposals p
           WHERE p.operation = 'keep_receipt'
             AND json_extract(p.payload_json, '$.document_id') = d.id)
       ORDER BY d.received_at, d.id`,
    )
    .all(now.toISOString(), new Date(now.getTime() + NOTICE_BEFORE_MS).toISOString());

/** R-8 AC5, R-19 AC3: the queued receipts whose `keep_until` has passed. */
export const listExpiredReceipts = (db: Database.Database, now: string): UnreadReceipt[] =>
  db
    .prepare<[string], UnreadReceipt>(
      `SELECT id, received_at FROM documents
       WHERE status = 'queued' AND keep_until IS NOT NULL AND keep_until <= ?
       ORDER BY received_at, id`,
    )
    .all(now);

export interface KeepReceiptQuestion {
  documentId: number;
  receivedAt: string;
  /** S-13, as sent. */
  question: string;
  options: readonly string[];
  now: string;
}

/** R-8 AC3: a `keep_receipt` proposal, `asked`, and its pending decision. Returns the decision. */
export const openKeepReceiptDecision = (db: Database.Database, ask: KeepReceiptQuestion): number =>
  db.transaction(() => {
    const matterId = idOf(
      db,
      "SELECT id FROM matters WHERE title = 'Keep my expenses' AND status IN ('open', 'active', 'waiting')",
    );
    const proposal = db
      .prepare(
        `INSERT INTO proposals (matter_id, operation, payload_json, basis_json, status, created_at)
         VALUES (?, 'keep_receipt', ?, ?, 'asked', ?)`,
      )
      .run(
        matterId,
        JSON.stringify({ document_id: ask.documentId }),
        JSON.stringify({ received_at: ask.receivedAt, rule: 'R-8 AC3' }),
        ask.now,
      );
    return openPendingDecision(db, {
      proposalId: Number(proposal.lastInsertRowid),
      question: ask.question,
      options: ask.options,
      now: ask.now,
    });
  })();

/** A receipt that left the queue no longer needs an answer: its open question expires. */
export const closeKeepReceiptDecisions = (db: Database.Database, documentId: number): void =>
  db.transaction(() => {
    db.prepare(
      `UPDATE pending_decisions SET status = 'expired'
       WHERE status IN ('open', 'awaiting_text') AND proposal_id IN (${KEEP_RECEIPT_OF})`,
    ).run(documentId);
    db.prepare(
      `UPDATE proposals SET status = 'rejected'
       WHERE status = 'asked' AND id IN (${KEEP_RECEIPT_OF})`,
    ).run(documentId);
  })();

/** R-8 AC5: the images are gone; the receipt is `discarded` unread. */
export const discardReceipt = (db: Database.Database, documentId: number, now: string): boolean =>
  db.transaction(() => {
    const changed = db
      .prepare(
        `UPDATE documents SET status = 'discarded', image_deleted_at = ?
         WHERE id = ? AND status = 'queued'`,
      )
      .run(now, documentId).changes;
    closeKeepReceiptDecisions(db, documentId);
    return changed === 1;
  })();

/** R-8 AC4: "Sí" keeps a queued receipt until 7 days after `received_at`. */
export const keepReceiptLonger = (db: Database.Database, documentId: number): string | null => {
  const row = db
    .prepare<[number], { received_at: string }>(
      "SELECT received_at FROM documents WHERE id = ? AND status = 'queued'",
    )
    .get(documentId);
  if (row === undefined) return null;
  const keepUntil = longestKeepUntil(row.received_at);
  db.prepare('UPDATE documents SET keep_until = ? WHERE id = ?').run(keepUntil, documentId);
  return keepUntil;
};

/**
 * R-19 AC1: inferences still `current` that no registered expense rests on (directly or through
 * a purchase line), created before `before`, become `expired`. Returns how many.
 */
export const expireLooseInferences = (db: Database.Database, before: string): number =>
  db
    .prepare(
      `UPDATE assertions SET status = 'expired'
       WHERE mode = 'inferred' AND status = 'current' AND created_at < ?
         AND NOT EXISTS (
           SELECT 1 FROM expenses e
           WHERE assertions.subject_type = 'expense' AND e.id = assertions.subject_id
             AND e.status = 'current')
         AND NOT EXISTS (
           SELECT 1 FROM purchase_lines l JOIN expenses e ON e.id = l.expense_id
           WHERE assertions.subject_type = 'purchase_line' AND l.id = assertions.subject_id
             AND e.status = 'current')`,
    )
    .run(before).changes;

/**
 * R-19 AC2: decisions still `open` created before `before` become `expired` and their proposal
 * `rejected`. No expense is created: the provisional `pending` row of a receipt is `refuted`.
 * Returns how many decisions expired.
 */
export const expireOpenDecisions = (db: Database.Database, before: string): number =>
  db.transaction(() => {
    const stale = db
      .prepare<[string], { id: number; proposal_id: number | null }>(
        "SELECT id, proposal_id FROM pending_decisions WHERE status = 'open' AND created_at < ?",
      )
      .all(before);
    const expire = db.prepare(
      "UPDATE pending_decisions SET status = 'expired' WHERE id = ? AND status = 'open'",
    );
    const reject = db.prepare(
      "UPDATE proposals SET status = 'rejected' WHERE id = ? AND status IN ('proposed', 'authorized', 'asked')",
    );
    const refute = db.prepare(
      `UPDATE expenses SET status = 'refuted'
       WHERE status = 'pending' AND document_id = (
         SELECT json_extract(payload_json, '$.document_id') FROM proposals
         WHERE id = ? AND operation = 'register_expense')`,
    );
    for (const decision of stale) {
      expire.run(decision.id);
      if (decision.proposal_id === null) continue;
      reject.run(decision.proposal_id);
      refute.run(decision.proposal_id);
    }
    return stale.length;
  })();
