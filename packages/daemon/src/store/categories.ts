import type Database from 'better-sqlite3';
import { categoryIdOf } from './expenses.ts';

// R-18: categories are created only by the principal, after "Sí" to S-15.

/**
 * R-18 AC2: the category, lowercase and unique. A category created meanwhile (two S-15 for the
 * same name) is reused. Returns its id.
 */
export const createCategory = (db: Database.Database, name: string, now: string): number => {
  const lowercase = name.toLowerCase();
  db.prepare('INSERT INTO categories (name, created_at) VALUES (?, ?) ON CONFLICT DO NOTHING').run(
    lowercase,
    now,
  );
  const id = categoryIdOf(db, lowercase);
  if (id === null) throw new Error('category was not stored');
  return id;
};

/**
 * R-18 AC3: the expense registered without a category takes the one the principal declared in its
 * message. The declaration is already in the ledger (`registerTextExpense` stores the declared
 * category even when it does not exist), so no assertion is added. Returns whether it changed: an
 * expense that has a category by now, or is no longer current, keeps it.
 */
export const assignDeclaredCategory = (
  db: Database.Database,
  expenseId: number,
  categoryId: number,
): boolean =>
  db
    .prepare(
      `UPDATE expenses SET category_id = ?, category_basis = 'declared'
       WHERE id = ? AND category_id IS NULL AND status = 'current'`,
    )
    .run(categoryId, expenseId).changes === 1;
