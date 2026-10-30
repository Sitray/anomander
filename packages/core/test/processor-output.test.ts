import { describe, expect, it } from 'vitest';
import { validateProcessorOutput } from '../src/index.ts';

const inference = {
  subject_type: 'expense',
  subject_id: null,
  predicate: 'total',
  value_json: 2340,
  mode: 'inferred',
  basis_json: { read_from: 'receipt photo' },
  confidence: 0.92,
};

describe('R-14 processor isolation', () => {
  it('AC2: accepts inferences with basis and confidence', () => {
    expect(validateProcessorOutput([inference])).toEqual({ accepted: [inference], rejected: [] });
  });

  it.each(['observed', 'declared', 'confirmed'])(
    'AC2: rejects output claiming mode %s, with a reason to log',
    (mode) => {
      const claim = { ...inference, mode };

      expect(validateProcessorOutput([inference, claim])).toEqual({
        accepted: [inference],
        rejected: [{ item: claim, reason: `claimed_mode:${mode}` }],
      });
    },
  );

  it.each([
    ['no basis', { ...inference, basis_json: undefined }],
    ['a null basis', { ...inference, basis_json: null }],
    ['no confidence', { ...inference, confidence: undefined }],
    ['a confidence above 1', { ...inference, confidence: 1.5 }],
    ['an actor it may not claim', { ...inference, actor: 'principal' }],
    ['a confirmation target', { ...inference, confirms_id: 3 }],
    ['not an object', 'total is 23,40'],
  ])('rejects an item with %s as invalid', (_label, item) => {
    const { accepted, rejected } = validateProcessorOutput([item]);

    expect(accepted).toEqual([]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.item).toBe(item);
    expect(rejected[0]?.reason).toMatch(/^invalid:/);
  });
});
