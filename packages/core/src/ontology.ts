import { z } from 'zod';

// Vocabulary of PRD §6, §7 and the CHECK constraints of §13. Field names mirror the §13 columns
// so the daemon can persist these shapes directly; `*_json` fields hold the parsed JSON value.

export const assertionModes = ['observed', 'declared', 'inferred', 'confirmed'] as const;
export const actors = ['principal', 'source', 'code', 'processor'] as const;
export const assertionStatuses = ['current', 'confirmed', 'refuted', 'expired'] as const;
export const expenseModes = ['declared', 'inferred', 'corroborated', 'confirmed'] as const;
export const expenseStatuses = ['pending', 'current', 'refuted'] as const;
export const categoryBases = ['declared', 'policy', 'inferred'] as const;
export const proposalStatuses = [
  'proposed',
  'authorized',
  'asked',
  'rejected',
  'executed',
] as const;
export const decisionStatuses = ['open', 'awaiting_text', 'answered', 'expired'] as const;
export const actionStatuses = ['executed', 'verified', 'failed'] as const;

export type AssertionMode = (typeof assertionModes)[number];
export type Actor = (typeof actors)[number];
export type AssertionStatus = (typeof assertionStatuses)[number];
export type ExpenseMode = (typeof expenseModes)[number];
export type ExpenseStatus = (typeof expenseStatuses)[number];
export type CategoryBasis = (typeof categoryBases)[number];
export type ProposalStatus = (typeof proposalStatuses)[number];
export type DecisionStatus = (typeof decisionStatuses)[number];
export type ActionStatus = (typeof actionStatuses)[number];

const timestamp = z.iso.datetime({ offset: true });
const assertionId = z.int().positive();

// §7.2: without these fields an assertion is not stored. `created_at` is set when persisting.
export const assertionDraftSchema = z
  .strictObject({
    subject_type: z.string().min(1),
    subject_id: assertionId.nullable(),
    predicate: z.string().min(1),
    value_json: z.json(),
    mode: z.enum(assertionModes),
    actor: z.enum(actors),
    source: z.string().min(1),
    basis_json: z.json().nullable(),
    confidence: z.number().min(0).max(1).nullable(),
    valid_at: timestamp.nullable(),
    expires_at: timestamp.nullable(),
    status: z.enum(assertionStatuses),
    supersedes_id: assertionId.nullable(),
    confirms_id: assertionId.nullable(),
  })
  .superRefine((draft, ctx) => {
    // Mirrors CHECK ((mode = 'confirmed') = (confirms_id IS NOT NULL)).
    if ((draft.mode === 'confirmed') !== (draft.confirms_id !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['confirms_id'],
        message: 'confirms_id is required for confirmed assertions and forbidden otherwise',
      });
    }
    if (draft.mode === 'inferred' && (draft.basis_json === null || draft.confidence === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['basis_json'],
        message: 'an inference needs basis_json and confidence',
      });
    }
  });

export type AssertionDraft = z.infer<typeof assertionDraftSchema>;
