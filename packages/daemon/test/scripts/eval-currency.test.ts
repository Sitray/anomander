import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// B78: the evaluations read amounts in the principal's currency, `ANOMANDER_CURRENCY` (euros by
// default) or `--currency`, checked as the daemon checks it. Only what needs no provider is
// checked here: a currency the daemon refuses stops the run before any model is called.
const scripts = {
  text: resolve(import.meta.dirname, '../../scripts/eval-text.ts'),
  receipts: resolve(import.meta.dirname, '../../scripts/eval-receipts.ts'),
};

const run = (script: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', ...env },
    timeout: 20_000,
  });

describe.each(Object.entries(scripts))('the %s evaluation', (_name, script) => {
  const empty = mkdtempSync(join(tmpdir(), 'anomander-eval-currency-'));
  const noCases = ['--file', join(empty, 'none.json'), '--dir', join(empty, 'none')];
  // Each script takes only its own option; the other one is refused by `parseArgs`.
  const where = script === scripts.text ? noCases.slice(0, 2) : noCases.slice(2);
  afterAll(() => rmSync(empty, { recursive: true, force: true }));

  it('refuses a currency the daemon refuses, from the environment or --currency', () => {
    const fromEnv = run(script, where, { ANOMANDER_CURRENCY: 'XYZ' });
    expect(fromEnv.status).toBe(1);
    expect(fromEnv.stderr).toContain(
      'invalid configuration: ANOMANDER_CURRENCY must be an ISO 4217 currency, such as EUR',
    );
    const fromFlag = run(script, [...where, '--currency', 'JPY']);
    expect(fromFlag.status).toBe(1);
    expect(fromFlag.stderr).toContain('must have two decimals, as EUR or USD do: JPY has not');
  });

  it('takes euros by default and a valid currency, then looks for its cases', () => {
    for (const args of [where, [...where, '--currency', 'gbp']]) {
      const ran = run(script, args);
      expect(ran.status).toBe(1);
      expect(ran.stderr).toMatch(/^no cases in /u);
    }
  });
});
