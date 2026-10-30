import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type AssertionRef,
  assertionDraftSchema,
  checkConsistency,
  corroborate,
  type ExistingExpense,
  type ProposedReceiptExpense,
  todayIn,
} from '../src/index.ts';

const receipt = (overrides: Partial<ProposedReceiptExpense> = {}): ProposedReceiptExpense => ({
  merchant: 'Mercadona',
  occurred_on: '2026-10-29',
  total_cents: 2340,
  lines: [{ amount_cents: 178 }, { amount_cents: 2162 }],
  ...overrides,
});

const existing = (overrides: Partial<ExistingExpense> = {}): ExistingExpense => ({
  merchant: 'Mercadona',
  occurred_on: '2026-10-29',
  total_cents: 2340,
  status: 'current',
  ...overrides,
});

const context = { today: '2026-10-30', existingExpenses: [] as ExistingExpense[] };

describe('R-4 consistency checks', () => {
  it('AC1: fails when the lines are one cent off, and reports their sum', () => {
    const result = checkConsistency(receipt({ total_cents: 2341 }), context);

    expect(result.checks.lines_sum_to_total).toBe(false);
    expect(result.linesSumCents).toBe(2340);
    expect(result.passed).toBe(false);
  });

  it('AC2: rejects a date later than today', () => {
    const result = checkConsistency(receipt({ occurred_on: '2026-10-31' }), context);

    expect(result.checks.valid_date).toBe(false);
    expect(result.passed).toBe(false);
  });

  it.each(['2026-02-30', '2025-02-29', '29/10/2026'])(
    'AC2: rejects the invalid date %j',
    (occurred_on) => {
      expect(checkConsistency(receipt({ occurred_on }), context).checks.valid_date).toBe(false);
    },
  );

  it('AC2: today is computed in the configured time zone', () => {
    const lateEvening = new Date('2026-10-30T23:30:00Z');

    expect(todayIn('Europe/Madrid', lateEvening)).toBe('2026-10-31');
    expect(todayIn('UTC', lateEvening)).toBe('2026-10-30');
    expect(todayIn('America/New_York', lateEvening)).toBe('2026-10-30');
  });

  it('AC3: a current expense with the same merchant, date and total is a duplicate', () => {
    const duplicate = existing({ merchant: '  MERCADONA ' });
    const result = checkConsistency(receipt(), { ...context, existingExpenses: [duplicate] });

    expect(result.checks.no_duplicate).toBe(false);
    expect(result.duplicateOf).toEqual(duplicate);
    expect(result.passed).toBe(false);
  });

  it.each([
    ['another total', existing({ total_cents: 2341 })],
    ['a refuted expense', existing({ status: 'refuted' })],
  ])('AC3: %s is not a duplicate', (_label, other) => {
    const result = checkConsistency(receipt(), { ...context, existingExpenses: [other] });

    expect(result.checks.no_duplicate).toBe(true);
    expect(result.duplicateOf).toBeNull();
  });

  it('AC5: for any lines and total, the check accepts iff the lines sum to the total', () => {
    const cents = fc.integer({ min: -1_000_000, max: 1_000_000 });
    // Totals near the sum (off by a few cents or exact) as well as arbitrary ones.
    const totalFor = (sum: number) =>
      fc.oneof(
        fc.integer({ min: -3, max: 3 }).map((offset) => sum + offset),
        cents,
      );
    const linesAndTotal = fc
      .array(cents, { maxLength: 30 })
      .chain((amounts) =>
        totalFor(amounts.reduce((acc, amount) => acc + amount, 0)).map(
          (total) => [amounts, total] as const,
        ),
      );
    fc.assert(
      fc.property(linesAndTotal, ([amounts, total]) => {
        const lines = amounts.map((amount_cents) => ({ amount_cents }));
        const result = checkConsistency(receipt({ lines, total_cents: total }), context);
        const sum = amounts.reduce((acc, amount) => acc + amount, 0);

        expect(result.checks.lines_sum_to_total).toBe(sum === total);
      }),
    );
  });
});

describe('R-4 AC4 corroboration (§7.2)', () => {
  const inferences: AssertionRef[] = [
    { id: 11, subject_type: 'expense', subject_id: 5, predicate: 'total', value_json: 2340 },
    {
      id: 12,
      subject_type: 'expense',
      subject_id: 5,
      predicate: 'merchant',
      value_json: 'Mercadona',
    },
  ];
  const at = '2026-10-30T10:00:00Z';

  it('creates one confirmed assertion by code per inference and marks the expense corroborated', () => {
    const consistency = checkConsistency(receipt(), context);
    const result = corroborate(consistency, inferences, at);

    expect(result).toEqual({
      expenseMode: 'corroborated',
      confirmedIds: [11, 12],
      confirmations: inferences.map((inference) => ({
        subject_type: 'expense',
        subject_id: 5,
        predicate: inference.predicate,
        value_json: inference.value_json,
        mode: 'confirmed',
        actor: 'code',
        source: 'code:consistency_check',
        basis_json: { checks: ['lines_sum_to_total', 'valid_date', 'no_duplicate'] },
        confidence: null,
        valid_at: at,
        expires_at: null,
        status: 'current',
        supersedes_id: null,
        confirms_id: inference.id,
      })),
    });
    for (const confirmation of result?.confirmations ?? []) {
      expect(assertionDraftSchema.parse(confirmation)).toEqual(confirmation);
    }
  });

  it.each([
    ['lines that do not add up', receipt({ total_cents: 1 }), []],
    ['a future date', receipt({ occurred_on: '2026-11-01' }), []],
    ['a duplicate', receipt(), [existing()]],
  ])('corroborates nothing for %s', (_label, proposed, existingExpenses) => {
    const consistency = checkConsistency(proposed, { ...context, existingExpenses });

    expect(corroborate(consistency, inferences, at)).toBeNull();
  });
});
