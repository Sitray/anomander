import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOGIN_ACCOUNTS, LOGOUT_ACCOUNTS } from '../../src/auth/telegram-login.ts';

// DK-15: the desktop shell runs `scripts/login.ts --shell <account>` and reads what it prints.
// Only what can be checked without a provider: how it refuses, and that it writes no file.
const script = resolve(import.meta.dirname, '../../scripts/login.ts');

const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', ...env },
    input: '',
    timeout: 20_000,
  });

describe('the login script in shell mode', () => {
  it('offers the accounts the shell lists (login.rs ACCOUNTS and LOGOUT_ACCOUNTS)', () => {
    expect(LOGIN_ACCOUNTS.map(({ providerId }) => providerId)).toEqual(['openai', 'kimi-coding']);
    expect(LOGOUT_ACCOUNTS.map(({ providerId }) => providerId)).toEqual([
      'openai',
      'kimi-coding',
      'anthropic',
      'github-copilot',
    ]);
  });

  it('refuses an account it does not offer with the usage and exit code 2, printing nothing else', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'anomander-login-'));
    for (const args of [['--shell'], ['--shell', 'anthropic'], ['--shell', 'nope']]) {
      const ran = run(args, { ANOMANDER_AUTH_PATH: join(scratch, 'auth.json') });
      expect(ran.status, args.join(' ')).toBe(2);
      expect(ran.stdout).toBe('');
      expect(ran.stderr).toContain('usage: login --shell <openai | kimi-coding>');
    }
    // Nothing of the data folder is touched by a refusal.
    expect(readdirSync(scratch)).toEqual([]);
  });
});
