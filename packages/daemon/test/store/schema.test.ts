import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../../src/store/database.ts';

// PRD §13: the schema is the SQL block of the data model, applied unchanged.
const REPO_ROOT = resolve(import.meta.dirname, '../../../..');

const prdSchemaBlock = (): string => {
  const prd = readFileSync(resolve(REPO_ROOT, 'PRD.md'), 'utf8');
  const section = prd.split('## 13. Data model')[1]?.split('\n## ')[0] ?? '';
  return section.split('```sql\n')[1]?.split('```')[0] ?? '';
};

describe('0001_initial.sql', () => {
  it('equals the SQL block of PRD §13', () => {
    const block = prdSchemaBlock();
    expect(block).toContain('CREATE TABLE assertions');
    expect(readFileSync(resolve(MIGRATIONS_DIR, '0001_initial.sql'), 'utf8')).toBe(block);
  });
});
