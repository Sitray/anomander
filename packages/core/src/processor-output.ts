import { z } from 'zod';

// R-14 AC2 and §7.1 rule 1: a processor only infers. Strict, so it cannot claim an actor,
// a status or a confirmation target either; the daemon adds actor, source and status.
export const processorInferenceSchema = z.strictObject({
  subject_type: z.string().min(1),
  subject_id: z.int().positive().nullable(),
  predicate: z.string().min(1),
  value_json: z.json(),
  mode: z.literal('inferred'),
  basis_json: z.json(),
  confidence: z.number().min(0).max(1),
});

export type ProcessorInference = z.infer<typeof processorInferenceSchema>;

export interface RejectedProcessorItem {
  item: unknown;
  /** `claimed_mode:<mode>` or `invalid:<first issue>`, for the log. */
  reason: string;
}

export interface ProcessorOutputValidation {
  accepted: ProcessorInference[];
  rejected: RejectedProcessorItem[];
}

const claimedModes = new Set(['observed', 'declared', 'confirmed']);

const rejectionReason = (item: unknown, error: z.ZodError): string => {
  const mode = typeof item === 'object' && item !== null ? Reflect.get(item, 'mode') : undefined;
  if (typeof mode === 'string' && claimedModes.has(mode)) return `claimed_mode:${mode}`;
  const issue = error.issues[0];
  return `invalid:${issue ? `${issue.path.join('.') || '(root)'} ${issue.message}` : 'unknown'}`;
};

export const validateProcessorOutput = (items: readonly unknown[]): ProcessorOutputValidation => {
  const result: ProcessorOutputValidation = { accepted: [], rejected: [] };
  for (const item of items) {
    const parsed = processorInferenceSchema.safeParse(item);
    if (parsed.success) result.accepted.push(parsed.data);
    else result.rejected.push({ item, reason: rejectionReason(item, parsed.error) });
  }
  return result;
};
