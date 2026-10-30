import type { AssertionDraft, ExpenseMode, ExpenseStatus } from './ontology.ts';

export interface ProposedReceiptExpense {
  merchant: string;
  occurred_on: string;
  total_cents: number;
  lines: readonly { amount_cents: number }[];
}

export interface ExistingExpense {
  merchant: string;
  occurred_on: string;
  total_cents: number;
  status: ExpenseStatus;
}

export interface ConsistencyContext {
  /** Today as `YYYY-MM-DD` in the configured time zone (see `todayIn`). */
  today: string;
  existingExpenses: readonly ExistingExpense[];
}

export const consistencyCheckNames = ['lines_sum_to_total', 'valid_date', 'no_duplicate'] as const;
export type ConsistencyCheckName = (typeof consistencyCheckNames)[number];

export interface ConsistencyResult {
  checks: Record<ConsistencyCheckName, boolean>;
  linesSumCents: number;
  duplicateOf: ExistingExpense | null;
  passed: boolean;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const isCalendarDate = (value: string): boolean => {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
};

const normalizeMerchant = (name: string): string => name.trim().toLowerCase();

/** Today's date as `YYYY-MM-DD` in `timeZone` at the instant `now`. */
export const todayIn = (timeZone: string, now: Date): string => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
};

/** R-4: the deterministic checks every proposed receipt expense goes through. */
export const checkConsistency = (
  expense: ProposedReceiptExpense,
  context: ConsistencyContext,
): ConsistencyResult => {
  const amounts = expense.lines.map((line) => line.amount_cents);
  const linesSumCents = amounts.reduce((sum, amount) => sum + amount, 0);
  const allIntegers = [...amounts, expense.total_cents].every(Number.isSafeInteger);
  const merchant = normalizeMerchant(expense.merchant);
  const duplicateOf =
    context.existingExpenses.find(
      (other) =>
        other.status === 'current' &&
        normalizeMerchant(other.merchant) === merchant &&
        other.occurred_on === expense.occurred_on &&
        other.total_cents === expense.total_cents,
    ) ?? null;
  const checks = {
    lines_sum_to_total: allIntegers && linesSumCents === expense.total_cents,
    valid_date:
      isCalendarDate(expense.occurred_on) &&
      isCalendarDate(context.today) &&
      expense.occurred_on <= context.today,
    no_duplicate: duplicateOf === null,
  };
  return { checks, linesSumCents, duplicateOf, passed: Object.values(checks).every(Boolean) };
};

/** An inference already stored, which a confirmation points at. */
export interface AssertionRef {
  id: number;
  subject_type: string;
  subject_id: number | null;
  predicate: string;
  value_json: AssertionDraft['value_json'];
}

export interface Corroboration {
  expenseMode: Extract<ExpenseMode, 'corroborated'>;
  confirmedIds: number[];
  confirmations: AssertionDraft[];
}

/**
 * R-4 AC4 and §7.2: when every check passed, code confirms each extracted inference. Returns
 * null when any check failed: nothing is corroborated.
 */
export const corroborate = (
  result: ConsistencyResult,
  inferences: readonly AssertionRef[],
  at: string,
): Corroboration | null => {
  if (!result.passed) return null;
  return {
    expenseMode: 'corroborated',
    confirmedIds: inferences.map((inference) => inference.id),
    confirmations: inferences.map((inference) => ({
      subject_type: inference.subject_type,
      subject_id: inference.subject_id,
      predicate: inference.predicate,
      value_json: inference.value_json,
      mode: 'confirmed',
      actor: 'code',
      source: 'code:consistency_check',
      basis_json: { checks: [...consistencyCheckNames] },
      confidence: null,
      valid_at: at,
      expires_at: null,
      status: 'current',
      supersedes_id: null,
      confirms_id: inference.id,
    })),
  };
};
