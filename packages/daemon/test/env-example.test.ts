import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// PRD §14.4: `.env.example` lists every variable of the configuration table, and those of the
// read access draft (docs/read-access-prd.md §8) until it moves into the PRD.
const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const read = (name: string): string => readFileSync(resolve(REPO_ROOT, name), 'utf8');

const tableVariables = (file: string, heading: string): string[] => {
  const section = read(file).split(heading)[1]?.split('\n## ')[0] ?? '';
  return [...section.matchAll(/^\| `([A-Z][A-Z0-9_]*)` \|/gm)].map((match) => match[1] ?? '');
};
const prdVariables = (): string[] => tableVariables('PRD.md', '### 14.4 Configuration');
const draftVariables = (): string[] =>
  tableVariables('docs/read-access-prd.md', '## 8. Configuration');

const exampleVariables = (): string[] =>
  [...read('.env.example').matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1] ?? '');

describe('.env.example', () => {
  it('reads the configuration tables from the PRD and the draft', () => {
    expect(prdVariables()).toContain('TELEGRAM_BOT_TOKEN');
    expect(draftVariables()).toContain('ANOMANDER_API_TOKEN');
  });

  it('lists every variable of PRD §14.4 and of the read access draft', () => {
    expect(exampleVariables().sort()).toEqual([...prdVariables(), ...draftVariables()].sort());
  });
});
