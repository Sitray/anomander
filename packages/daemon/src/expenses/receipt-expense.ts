import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type AskReason,
  type ConsistencyResult,
  categorize,
  checkAuthority,
  checkConsistency,
  todayIn,
} from '@anomander/core';
import {
  buttons,
  decisionButtons,
  formatAmount,
  type PrincipalReceipt,
  type ReceiptHandler,
  type Reply,
  strings,
  UNCATEGORIZED,
} from '@anomander/protocol';
import type Database from 'better-sqlite3';
import type { AiBudget } from '../budget/ai-budget.ts';
import type {
  Inferred,
  ReceiptRead,
  ReceiptReader,
  ReceiptReaderImage,
} from '../processor/receipt-reader.ts';
import type { ReplyPhraser } from '../processor/reply-phraser.ts';
import type { Logger } from '../processor/text-interpreter.ts';
import { findWaitingReceipt, queueReceipt } from '../retention/queued-receipts.ts';
import {
  listActivePolicies,
  listCategories,
  readExpense,
  recordReplyDelivery,
  type StoredExpense,
} from '../store/expenses.ts';
import {
  createReceiptDocument,
  finishReading,
  insertReceiptExpense,
  listActivePermissions,
  listCurrentExpenses,
  openPendingDecision,
  type ReceiptExpenseRegistration,
  recordDecisionMessage,
} from '../store/receipts.ts';
import { writtenIn } from './declarations.ts';

// PRD §10 for a receipt photo: observe (R-3 AC1), read (processor, R-3 AC2), delete the images
// (R-8 AC1), check consistency (R-4), categorize (R-5), check authority (R-6), then act and
// verify (R-9) or ask the principal (R-6 AC2).

export interface ReceiptExpenseDeps {
  db: Database.Database;
  reader: ReceiptReader;
  /** `ANOMANDER_INBOX_DIR`: where the images wait until they are read (R-8). */
  inboxDir: string;
  /** `TZ`: today is computed there (R-4 AC2). */
  timeZone: string;
  now: () => Date;
  /** The assertion source of the vision processor's inferences, e.g. `processor:openai/gpt-4o`. */
  processorSource: string;
  /** Words S-1 and S-2 (R-21). */
  phraser: ReplyPhraser;
  logger: Logger;
  /**
   * The daily AI budget (R-12). Reading a receipt reserves its processor call here, so the
   * reader itself must not count it again. Without a budget, every receipt is read at once.
   */
  budget?: AiBudget;
}

// Image files get generated names; nothing a sender chose ever reaches the file system.
const extensionOf = (mimeType: string): string => {
  if (mimeType === 'image/jpeg') return 'jpg';
  const subtype = (mimeType.split('/')[1] ?? '').toLowerCase().replace(/[^a-z0-9+-]/g, '');
  return subtype === '' ? 'bin' : subtype.slice(0, 16);
};
const mimeTypeOf = (fileName: string): string => {
  const extension = fileName.slice(fileName.indexOf('.') + 1);
  return extension === 'jpg' ? 'image/jpeg' : `image/${extension}`;
};
const imageIndex = (fileName: string): number => Number(fileName.slice(0, fileName.indexOf('.')));

const ALL_OPTIONS = [buttons.register, buttons.correct, buttons.discard];

/** The §12 question for an AskReason of `checkAuthority`, built from the stored row. */
const questionFor = (
  reason: AskReason,
  stored: StoredExpense,
  consistency: ConsistencyResult,
): { question: string; options: string[] } => {
  const merchant = stored.merchant ?? '';
  switch (reason) {
    case 'lines_mismatch':
      return {
        question: strings.linesMismatch(stored.lines_sum_cents, stored.total_cents),
        options: ALL_OPTIONS,
      };
    case 'duplicate': {
      // S-4 names the expense already recorded; it uses only "Apuntar" and "Descartar".
      const earlier = consistency.duplicateOf ?? { ...stored, merchant };
      return {
        question: strings.duplicate(earlier.total_cents, earlier.merchant, earlier.occurred_on),
        options: [buttons.register, buttons.discard],
      };
    }
    // The reader only returns calendar dates, so an invalid date is one after today.
    case 'invalid_date':
      return {
        question: strings.futureReceipt(stored.total_cents, merchant, stored.occurred_on),
        options: ALL_OPTIONS,
      };
    case 'needs_confirmation':
      return {
        question: strings.confirmCategory(
          stored.total_cents,
          merchant,
          stored.occurred_on,
          stored.category,
        ),
        options: ALL_OPTIONS,
      };
  }
};

export interface ReceiptExpenseCycle {
  /** A receipt the principal sent. `null` means nothing to send: S-10 went out earlier today. */
  onReceipt(receipt: PrincipalReceipt): Promise<Reply | null>;
  /** Reads a queued receipt (R-12 AC3); `null` while the budget still refuses. */
  readQueued(documentId: number): Promise<Reply | null>;
}

export const createReceiptExpenseCycle = (deps: ReceiptExpenseDeps): ReceiptExpenseCycle => {
  const { db, reader, inboxDir, timeZone, now, processorSource, phraser, logger, budget } = deps;

  const folderOf = (documentId: number) => join(inboxDir, String(documentId));

  /** §10 step 1, R-3 AC1: the document and its images, `queued` until read. */
  const receive = async (receipt: PrincipalReceipt): Promise<number> => {
    const images = await Promise.all(
      receipt.images.map(async (image) => ({ mimeType: image.mimeType, data: await image.load() })),
    );
    const documentId = createReceiptDocument(db, {
      source: receipt.channelRef,
      receivedAt: receipt.receivedAt,
      mimeTypes: images.map((image) => image.mimeType),
      now: now().toISOString(),
    });
    const folder = folderOf(documentId);
    await mkdir(folder, { recursive: true });
    await Promise.all(
      images.map((image, index) =>
        writeFile(join(folder, `${index + 1}.${extensionOf(image.mimeType)}`), image.data),
      ),
    );
    return documentId;
  };

  /**
   * The daily AI budget (R-12 AC2, R-8 AC2): whether a receipt is read now or stays queued with
   * its images on disk. A yes reserves the reader's processor call against today's cap.
   */
  const mayReadNow = (_documentId: number): boolean => budget === undefined || budget.tryConsume();

  /** R-8 AC2, R-12 AC2: queued for 24 hours; S-10 once that day, nothing after it. */
  const queue = (receipt: PrincipalReceipt, documentId: number): Reply | null => {
    queueReceipt(db, {
      documentId,
      channelRef: receipt.channelRef,
      receivedAt: receipt.receivedAt,
      caption: receipt.caption,
      now: now().toISOString(),
    });
    logger.info('daily AI budget exhausted; receipt queued', { documentId });
    return budget?.claimLimitNotice() === true ? { text: strings.aiLimitReached() } : null;
  };

  /** §10 step 2 and R-8 AC1: read the images, then delete them whatever the outcome. */
  const read = async (documentId: number, caption: string | null) => {
    const folder = folderOf(documentId);
    let status: 'read' | 'unreadable' = 'unreadable';
    try {
      const files = (await readdir(folder)).sort((a, b) => imageIndex(a) - imageIndex(b));
      const images: ReceiptReaderImage[] = await Promise.all(
        files.map(async (file) => ({
          mimeType: mimeTypeOf(file),
          data: new Uint8Array(await readFile(join(folder, file))),
        })),
      );
      const reading = await reader({
        images,
        caption,
        today: todayIn(timeZone, now()),
        categories: listCategories(db),
      });
      if (reading.kind === 'read') status = 'read';
      return reading;
    } finally {
      await rm(folder, { recursive: true, force: true });
      finishReading(db, documentId, status, now().toISOString());
    }
  };

  /** A caption value counts as declared only if the principal actually wrote it (R-3 AC5). */
  const declaredIn = (
    receipt: PrincipalReceipt,
    stated: Inferred<string> | null,
  ): string | null => {
    if (stated === null) return null;
    const value = stated.value.trim();
    if (receipt.caption !== null && writtenIn(receipt.caption, value)) return value;
    logger.info('declared value not written in the caption; ignored', {
      channelRef: receipt.channelRef,
      predicate: stated.inference.predicate,
    });
    return null;
  };

  const register = async (
    receipt: PrincipalReceipt,
    documentId: number,
    reading: ReceiptRead,
  ): Promise<Reply> => {
    const declaredMerchant = declaredIn(receipt, reading.declaredMerchant);
    const declaredCategory = declaredIn(receipt, reading.declaredCategory)?.toLowerCase() ?? null;
    const merchant = declaredMerchant ?? reading.merchant.value.trim();
    const lines = reading.lines.map(({ inference, value }) => ({ ...value, inference }));

    // §10 step 4, R-5: a caption category wins, then a policy, then an existing inferred one.
    const categorization = categorize({
      merchant,
      policies: listActivePolicies(db),
      categories: listCategories(db),
      declaredCategory,
      suggestedCategory: reading.category?.value ?? null,
    });
    if (categorization.missingDeclaredCategory !== null) {
      // R-18 AC3 asks S-15 here; that arrives in M4, so the expense stays uncategorized.
      logger.info('declared category does not exist; proposed without a category', {
        channelRef: receipt.channelRef,
        category: categorization.missingDeclaredCategory,
      });
    }

    // §10 step 3, R-4: lines sum to the total, a valid date, no duplicate.
    const consistency = checkConsistency(
      {
        merchant,
        occurred_on: reading.occurredOn.value,
        total_cents: reading.total.value,
        lines,
      },
      { today: todayIn(timeZone, now()), existingExpenses: listCurrentExpenses(db) },
    );

    // §10 step 6, R-6: the authority check is code.
    const authority = checkAuthority(
      {
        operation: 'register_expense',
        expense: {
          kind: 'receipt',
          checks: consistency.checks,
          category_basis: categorization.basis,
        },
      },
      { permissions: listActivePermissions(db, now()), now: now() },
    );
    if (authority.decision === 'reject' || authority.level === 'free') {
      throw new Error(`receipt expense cannot be registered: ${JSON.stringify(authority)}`);
    }

    const categoryBasis = categorization.basis;
    const registration: ReceiptExpenseRegistration = {
      documentId,
      channelRef: receipt.channelRef,
      receivedAt: receipt.receivedAt,
      processorSource,
      now: now().toISOString(),
      merchant,
      occurred_on: reading.occurredOn.value,
      total_cents: reading.total.value,
      category: categorization.category,
      category_basis: categoryBasis,
      // §10: only the inferences the expense rests on survive.
      extracted: [
        ...(declaredMerchant === null ? [reading.merchant.inference] : []),
        reading.occurredOn.inference,
        reading.total.inference,
      ],
      lines,
      categoryInference:
        categoryBasis === 'inferred' ? (reading.category?.inference ?? null) : null,
      declared: {
        merchant: declaredMerchant,
        category: categoryBasis === 'declared' ? declaredCategory : null,
      },
      consistency,
      authorizedBy: authority.decision === 'execute' ? authority.authorized_by : null,
    };

    if (authority.decision === 'execute') {
      // §10 steps 7 and 8, R-6 AC1, R-9: act, then reply from the row read back.
      const { expenseId, actionId } = insertReceiptExpense(db, registration);
      const stored = readExpense(db, expenseId);
      const reference =
        stored.merchant === null
          ? strings.registeredNoMerchant(stored.total_cents, stored.category)
          : strings.registered(stored.total_cents, stored.merchant, stored.category);
      const text = await phraser({
        reference,
        facts: [
          formatAmount(stored.total_cents),
          ...(stored.merchant === null ? [] : [stored.merchant]),
          stored.category ?? UNCATEGORIZED,
        ],
        message: receipt.caption ?? '',
      });
      return {
        text,
        onDelivered: (delivery) => {
          if (
            actionId === null ||
            !recordReplyDelivery(db, actionId, delivery, text, now().toISOString())
          ) {
            logger.warn('reply delivery already recorded', { actionId });
          }
        },
      };
    }

    // R-6 AC2, AC3: a pending expense and a decision, asked verbatim with its buttons.
    const { reason } = authority;
    const { decisionId, question, options } = db.transaction(() => {
      const { expenseId, proposalId } = insertReceiptExpense(db, registration);
      const asked = questionFor(reason, readExpense(db, expenseId), consistency);
      const id = openPendingDecision(db, { proposalId, ...asked, now: now().toISOString() });
      return { decisionId: id, ...asked };
    })();
    return {
      text: question,
      buttons: decisionButtons(decisionId, options),
      onDelivered: (delivery) => {
        if (!recordDecisionMessage(db, decisionId, delivery.channelRef)) {
          logger.warn('decision message already recorded', { decisionId });
        }
      },
    };
  };

  const readAndRegister = async (receipt: PrincipalReceipt, documentId: number) => {
    const reading = await read(documentId, receipt.caption);
    if (reading.kind === 'unreadable') {
      // R-3 AC3: S-5, verbatim, and no expense.
      logger.info('receipt not read', { channelRef: receipt.channelRef, reason: reading.reason });
      return { text: strings.unreadableReceipt() };
    }
    return register(receipt, documentId, reading);
  };

  return {
    onReceipt: async (receipt) => {
      const documentId = await receive(receipt);
      if (!mayReadNow(documentId)) return queue(receipt, documentId);
      return readAndRegister(receipt, documentId);
    },
    readQueued: async (documentId) => {
      const waiting = findWaitingReceipt(db, documentId);
      if (waiting === null) throw new Error(`receipt ${documentId} is not waiting to be read`);
      if (!mayReadNow(documentId)) return null;
      // The images are already on disk; the rest of the cycle is the same (R-12 AC3).
      const { channelRef, receivedAt, caption } = waiting;
      return readAndRegister({ images: [], caption, channelRef, receivedAt }, documentId);
    },
  };
};

/** The `ReceiptHandler` of the front door; a receipt queued after the day's S-10 gets no reply. */
export const createReceiptExpenseHandler = (deps: ReceiptExpenseDeps): ReceiptHandler =>
  createReceiptExpenseCycle(deps).onReceipt;
