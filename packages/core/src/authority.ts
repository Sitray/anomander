import { z } from 'zod';
import type { ConsistencyCheckName } from './consistency.ts';
import type { CategoryBasis } from './ontology.ts';

// PRD §8.1. The authority check is code, never a model step. Confidence is deliberately not an
// input: it decides whether ANOMANDER proposes, never whether it acts.

export type AuthorityLevel = 'free' | 'with_permission' | 'with_confirmation' | 'forbidden';

export type ExpenseSubject =
  | {
      kind: 'receipt';
      checks: Record<ConsistencyCheckName, boolean>;
      category_basis: CategoryBasis | null;
    }
  /** R-2 AC2: what the principal declared is authorized by the principal's own message. */
  | { kind: 'text'; declared_by: 'principal' };

export interface AuthorityRequest {
  /** Any string: an operation that does not exist below is forbidden. */
  operation: string;
  expense?: ExpenseSubject;
}

export interface AuthorityPermission {
  id: number;
  operation: string;
  /** Parsed `permissions.conditions_json`. */
  conditions: unknown;
  expires_at: string | null;
  revoked_at: string | null;
}

export interface AuthorityContext {
  permissions: readonly AuthorityPermission[];
  now: Date;
}

export type AskReason = 'lines_mismatch' | 'invalid_date' | 'duplicate' | 'needs_confirmation';

export type AuthorityDecision =
  | { decision: 'execute'; level: 'free' }
  | { decision: 'execute'; level: 'with_permission'; authorized_by: `permission:${number}` }
  | { decision: 'execute'; level: 'with_confirmation'; authorized_by: 'principal' }
  | { decision: 'ask'; level: 'with_confirmation'; reason: AskReason }
  | { decision: 'reject'; level: 'forbidden'; reason: 'operation_does_not_exist' };

// The keys of the starting permission (shared invariant with the daemon seed). Strict objects:
// a condition this code cannot check makes the permission cover nothing.
const registerExpenseConditions = z.strictObject({
  lines_sum_to_total: z.literal(true),
  category_basis: z.literal('policy'),
});
const sendSummaryConditions = z.strictObject({});

const ask = (reason: AskReason): AuthorityDecision => ({
  decision: 'ask',
  level: 'with_confirmation',
  reason,
});

const isActive = (permission: AuthorityPermission, now: Date): boolean => {
  if (permission.revoked_at !== null) return false;
  if (permission.expires_at === null) return true;
  const expiresAt = Date.parse(permission.expires_at);
  return !Number.isNaN(expiresAt) && expiresAt > now.getTime();
};

const coveringPermission = (
  operation: string,
  conditions: z.ZodType,
  context: AuthorityContext,
): AuthorityDecision | null => {
  const permission = context.permissions.find(
    (candidate) =>
      candidate.operation === operation &&
      isActive(candidate, context.now) &&
      conditions.safeParse(candidate.conditions).success,
  );
  return permission
    ? {
        decision: 'execute',
        level: 'with_permission',
        authorized_by: `permission:${permission.id}`,
      }
    : null;
};

const registerExpense = (
  expense: ExpenseSubject | undefined,
  context: AuthorityContext,
): AuthorityDecision => {
  if (expense === undefined) return ask('needs_confirmation');
  if (expense.kind === 'text') {
    return { decision: 'execute', level: 'with_confirmation', authorized_by: 'principal' };
  }
  // R-6 AC2, in the assumed precedence order.
  if (!expense.checks.lines_sum_to_total) return ask('lines_mismatch');
  if (!expense.checks.valid_date) return ask('invalid_date');
  if (!expense.checks.no_duplicate) return ask('duplicate');
  if (expense.category_basis !== 'policy') return ask('needs_confirmation');
  // R-6 AC1: every condition of the starting permission holds; it must still be active.
  return (
    coveringPermission('register_expense', registerExpenseConditions, context) ??
    ask('needs_confirmation')
  );
};

export const checkAuthority = (
  request: AuthorityRequest,
  context: AuthorityContext,
): AuthorityDecision => {
  switch (request.operation) {
    case 'read':
    case 'observe':
    case 'infer':
    case 'propose':
      return { decision: 'execute', level: 'free' };
    case 'register_expense':
      return registerExpense(request.expense, context);
    case 'correct_expense':
    case 'delete_expense':
      return ask('needs_confirmation');
    case 'send_summary':
      return (
        coveringPermission('send_summary', sendSummaryConditions, context) ??
        ask('needs_confirmation')
      );
    default:
      // Paying, transferring, granting permissions, acting towards others: they do not exist.
      return { decision: 'reject', level: 'forbidden', reason: 'operation_does_not_exist' };
  }
};
