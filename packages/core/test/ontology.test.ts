import { describe, expect, it } from 'vitest';
import { type AssertionDraft, assertionDraftSchema } from '../src/index.ts';

const inference: AssertionDraft = {
  subject_type: 'expense',
  subject_id: 5,
  predicate: 'total',
  value_json: 2340,
  mode: 'inferred',
  actor: 'processor',
  source: 'telegram:42',
  basis_json: { read_from: 'receipt photo' },
  confidence: 0.92,
  valid_at: '2026-10-29T12:00:00Z',
  expires_at: null,
  status: 'current',
  supersedes_id: null,
  confirms_id: null,
};

const parses = (draft: unknown) => assertionDraftSchema.safeParse(draft).success;

describe('§7.2 assertion provenance', () => {
  it('accepts an inference carrying every provenance field', () => {
    expect(parses(inference)).toBe(true);
  });

  it('rejects a draft missing a provenance field', () => {
    const { source: _source, ...withoutSource } = inference;

    expect(parses(withoutSource)).toBe(false);
  });

  it('rejects an inference without basis or confidence', () => {
    expect(parses({ ...inference, basis_json: null })).toBe(false);
    expect(parses({ ...inference, confidence: null })).toBe(false);
  });

  it('requires confirms_id on a confirmed assertion and forbids it otherwise', () => {
    const confirmation = { ...inference, mode: 'confirmed', actor: 'principal', confidence: null };

    expect(parses({ ...confirmation, confirms_id: 11 })).toBe(true);
    expect(parses({ ...confirmation, confirms_id: null })).toBe(false);
    expect(parses({ ...inference, confirms_id: 11 })).toBe(false);
  });

  it('rejects unknown modes, actors and statuses', () => {
    expect(parses({ ...inference, mode: 'corroborated' })).toBe(false);
    expect(parses({ ...inference, actor: 'model' })).toBe(false);
    expect(parses({ ...inference, status: 'pending' })).toBe(false);
  });
});
