import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// PRD §14.4: `.env.example` lists every variable of the configuration table.
const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const read = (name: string): string => readFileSync(resolve(REPO_ROOT, name), 'utf8');

const prdVariables = (): string[] => {
  const section = read('PRD.md').split('### 14.4 Configuration')[1]?.split('\n## ')[0] ?? '';
  return [...section.matchAll(/^\| `([A-Z][A-Z0-9_]*)` \|/gm)].map((match) => match[1] ?? '');
};

const exampleVariables = (): string[] =>
  [...read('.env.example').matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1] ?? '');

describe('.env.example', () => {
  it('reads the configuration table from the PRD', () => {
    expect(prdVariables()).toContain('TELEGRAM_BOT_TOKEN');
  });

  it('lists every variable of PRD §14.4', () => {
    expect(exampleVariables().sort()).toEqual(prdVariables().sort());
  });
});
