import { buttons } from '@anomander/protocol';
import type Database from 'better-sqlite3';
import { openAmendDecisionOf, openAmendExpenseDecision } from '../store/amend-expense.ts';
import { loadDecision, reopenStaleAwaiting } from '../store/decisions.ts';

// DK-17 AC6 (docs/desktop-prd.md): "Deshacer" and "Corregir" on a row of the window's "Gastos"
// press the expense's own `amend_expense` button (R-7 AC4 to AC8), so the chat's button handler
// answers them: no other way to undo or correct an expense is written here.

/** Which of the expense's buttons a row presses. */
export type RowOption = 'undo' | 'correct';

/** The label of the button a row presses, in the daemon's language. */
export const rowLabel = (option: RowOption): string =>
  option === 'undo' ? buttons.undo : buttons.correct;

export interface RowPress {
  expenseId: number;
  option: RowOption;
  now: string;
}

const isCurrent = (db: Database.Database, expenseId: number): boolean =>
  db
    .prepare<[number], { id: number }>(
      "SELECT id FROM expenses WHERE id = ? AND status = 'current'",
    )
    .get(expenseId) !== undefined;

/**
 * The button data (`decision:<id>:<option index>`) a row's press stands for, or `null` when the
 * expense is not current (R-7 AC8: S-19, nothing changes). It is the question under the expense's
 * reply in the chat while that one is open, so answering it here closes its buttons there. A
 * registered receipt, or a typed expense whose question was answered or expired, has none open: the
 * row asks one of its own, `asked` as that reply's was, and the press answers it at once. That one
 * is shown in no message, so 15 minutes awaiting text close it (`reopenStaleAwaiting`).
 */
export const rowButton = (db: Database.Database, press: RowPress): string | null => {
  if (!isCurrent(db, press.expenseId)) return null;
  // R-17 AC6 before choosing the question, as the button handler applies it: a row's own question
  // left waiting 15 minutes is closed, so this press asks a new one instead of pressing a closed one.
  reopenStaleAwaiting(db, new Date(press.now));
  const label = rowLabel(press.option);
  const open = openAmendDecisionOf(db, press.expenseId);
  const index = open === null ? -1 : (loadDecision(db, open)?.options.indexOf(label) ?? -1);
  if (open !== null && index >= 0) return `decision:${open}:${index}`;
  const options = [buttons.undo, buttons.correct];
  const asked = openAmendExpenseDecision(db, {
    expenseId: press.expenseId,
    source: 'desktop:gastos',
    question: label,
    options,
    now: press.now,
    rule: 'DK-17 AC6',
  });
  return `decision:${asked}:${options.indexOf(label)}`;
};
