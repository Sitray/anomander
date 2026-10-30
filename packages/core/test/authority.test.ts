import { describe, expect, it } from 'vitest';
import {
  type AuthorityPermission,
  type AuthorityRequest,
  type CategoryBasis,
  type ConsistencyCheckName,
  checkAuthority,
} from '../src/index.ts';

const now = new Date('2026-10-30T10:00:00Z');

// Shared invariant with the daemon seed (S9).
const startingPermission: AuthorityPermission = {
  id: 1,
  operation: 'register_expense',
  conditions: { lines_sum_to_total: true, category_basis: 'policy' },
  expires_at: null,
  revoked_at: null,
};

const allPassed: Record<ConsistencyCheckName, boolean> = {
  lines_sum_to_total: true,
  valid_date: true,
  no_duplicate: true,
};

const receipt = (
  checks: Partial<Record<ConsistencyCheckName, boolean>> = {},
  category_basis: CategoryBasis | null = 'policy',
): AuthorityRequest => ({
  operation: 'register_expense',
  expense: { kind: 'receipt', checks: { ...allPassed, ...checks }, category_basis },
});

const check = (request: AuthorityRequest, permissions = [startingPermission]) =>
  checkAuthority(request, { permissions, now });

describe('§8.1 level: free', () => {
  it.each(['read', 'observe', 'infer', 'propose'])('%s executes without any permission', (op) => {
    expect(check({ operation: op }, [])).toEqual({ decision: 'execute', level: 'free' });
  });
});

describe('§8.1 level: with permission (R-6 AC1)', () => {
  it('a receipt that passed R-4 with a policy category executes under the permission', () => {
    expect(check(receipt())).toEqual({
      decision: 'execute',
      level: 'with_permission',
      authorized_by: 'permission:1',
    });
  });

  it('send_summary executes under an active send_summary permission', () => {
    const summary = { ...startingPermission, id: 7, operation: 'send_summary', conditions: {} };

    expect(check({ operation: 'send_summary' }, [summary])).toEqual({
      decision: 'execute',
      level: 'with_permission',
      authorized_by: 'permission:7',
    });
  });

  it('an expired permission does not cover', () => {
    const expired = { ...startingPermission, expires_at: '2026-10-30T09:59:59Z' };

    expect(check(receipt(), [expired])).toEqual({
      decision: 'ask',
      level: 'with_confirmation',
      reason: 'needs_confirmation',
    });
  });

  it('a revoked permission does not cover', () => {
    const revoked = { ...startingPermission, revoked_at: '2026-10-29T10:00:00Z' };

    expect(check(receipt(), [revoked]).decision).toBe('ask');
  });

  it('a permission that expires later still covers', () => {
    const later = { ...startingPermission, expires_at: '2026-10-30T10:00:01Z' };

    expect(check(receipt(), [later]).decision).toBe('execute');
  });

  it('a permission for another operation, or with unknown conditions, does not cover', () => {
    const other = { ...startingPermission, operation: 'send_summary' };
    const unknownCondition = {
      ...startingPermission,
      conditions: { lines_sum_to_total: true, category_basis: 'policy', if_confident: true },
    };

    expect(check(receipt(), [other]).decision).toBe('ask');
    expect(check(receipt(), [unknownCondition]).decision).toBe('ask');
    expect(check({ operation: 'send_summary' }, [startingPermission]).decision).toBe('ask');
  });
});

describe('§8.1 level: with confirmation (R-6 AC2)', () => {
  it.each([
    ['lines that do not add up use S-3', receipt({ lines_sum_to_total: false }), 'lines_mismatch'],
    ['an invalid date', receipt({ valid_date: false }), 'invalid_date'],
    ['a duplicate uses S-4', receipt({ no_duplicate: false }), 'duplicate'],
    ['an inferred category uses S-6', receipt({}, 'inferred'), 'needs_confirmation'],
    ['no category (new merchant) uses S-6', receipt({}, null), 'needs_confirmation'],
    ['a declared category asks too', receipt({}, 'declared'), 'needs_confirmation'],
  ])('%s', (_label, request, reason) => {
    expect(check(request)).toEqual({ decision: 'ask', level: 'with_confirmation', reason });
  });

  it('applies the precedence lines_mismatch, invalid_date, duplicate, needs_confirmation', () => {
    const allFailed = { lines_sum_to_total: false, valid_date: false, no_duplicate: false };

    expect(check(receipt(allFailed, 'inferred'))).toMatchObject({ reason: 'lines_mismatch' });
    expect(check(receipt({ valid_date: false, no_duplicate: false }, null))).toMatchObject({
      reason: 'invalid_date',
    });
    expect(check(receipt({ no_duplicate: false }, 'inferred'))).toMatchObject({
      reason: 'duplicate',
    });
  });

  it.each(['correct_expense', 'delete_expense'])('%s always asks, even with permissions', (op) => {
    const broad = { ...startingPermission, operation: op };

    expect(check({ operation: op }, [broad])).toEqual({
      decision: 'ask',
      level: 'with_confirmation',
      reason: 'needs_confirmation',
    });
  });

  it('register_expense without an expense asks', () => {
    expect(check({ operation: 'register_expense' }).decision).toBe('ask');
  });

  it("R-2 AC2: a text expense declared by the principal executes on the principal's word", () => {
    const text: AuthorityRequest = {
      operation: 'register_expense',
      expense: { kind: 'text', declared_by: 'principal' },
    };

    expect(check(text, [])).toEqual({
      decision: 'execute',
      level: 'with_confirmation',
      authorized_by: 'principal',
    });
  });
});

describe('§8.1 level: forbidden', () => {
  it.each(['transfer_money', 'pay', 'grant_permission', 'complain_to_merchant', 'toString', ''])(
    '%j does not exist and nothing authorizes it',
    (op) => {
      const matching = { ...startingPermission, operation: op, conditions: {} };

      expect(check({ operation: op }, [matching])).toEqual({
        decision: 'reject',
        level: 'forbidden',
        reason: 'operation_does_not_exist',
      });
    },
  );
});

describe('§8.1 confidence is not permission', () => {
  it('a confidence value on the request changes nothing', () => {
    const confident = { ...receipt({}, 'inferred'), confidence: 0.99 };
    const doubtful = { ...receipt(), confidence: 0.01 };

    expect(check(confident).decision).toBe('ask');
    expect(check(doubtful).decision).toBe('execute');
  });
});
