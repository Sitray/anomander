import type { TextHandler } from '@anomander/protocol';
import type Database from 'better-sqlite3';
import {
  findAwaitingDecision,
  findDecisionsShownIn,
  findUsedCorrectionUndoShownIn,
  reopenStaleAwaiting,
} from '../store/decisions.ts';
import type { CorrectionHandler } from './correction.ts';

// R-17: every text has exactly one destination, decided by code in this order. Button presses
// (AC1) arrive through `createButtonHandler`; photos (AC4) never pass through here.

export interface TextRouterDeps {
  db: Database.Database;
  /** Correction handlers by proposal `operation` (R-7); decisions of other operations take no text. */
  corrections: Record<string, CorrectionHandler>;
  /** R-17 AC5: everything else, e.g. `createTextExpenseHandler`. */
  otherwise: TextHandler;
  now: () => Date;
}

export const createTextRouter =
  ({ db, corrections, otherwise, now }: TextRouterDeps): TextHandler =>
  async (message) => {
    // R-17 AC6: a decision awaiting text for 15 minutes is `open` again.
    reopenStaleAwaiting(db, now());
    const takesText = (decision: ReturnType<typeof findAwaitingDecision>) =>
      decision === null ? undefined : corrections[decision.operation];

    // AC2: a Telegram reply to a decision's message corrects that decision: the one shown there
    // that takes text, when the message shows more than one (R-7 AC4).
    if (message.replyTo !== undefined) {
      for (const decision of findDecisionsShownIn(db, message.replyTo)) {
        const correct = takesText(decision);
        if (correct !== undefined) return correct({ decision, message });
      }
      // B79 (decided by the principal on 2026-11-26: "Corrige el gasto"): a "Corregido…" whose
      // "Deshacer" was used still shows a recorded expense, so a reply to it corrects it again,
      // for the 7 days an unused one stays open (B85 (4), R-19 AC2); after them, AC5.
      const used = findUsedCorrectionUndoShownIn(db, message.replyTo, now());
      const correct = takesText(used);
      if (used !== null && correct !== undefined) return correct({ decision: used, message });
    }
    // AC3: otherwise the decision awaiting text takes it.
    const awaiting = findAwaitingDecision(db);
    const correct = takesText(awaiting);
    if (awaiting !== null && correct !== undefined) return correct({ decision: awaiting, message });
    // AC5: anything else goes to the processor.
    return otherwise(message);
  };
