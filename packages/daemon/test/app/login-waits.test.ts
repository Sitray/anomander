import { describe, expect, it, vi } from 'vitest';
import { watchingPastes } from '../../src/app/login-waits.ts';
import type { ModelLogin } from '../../src/auth/telegram-login.ts';

// B81 (desktop PRD DK-4 AC7): the app's windows are told while a login waits for a pasted text.

type Prompt = Parameters<Parameters<ModelLogin['login']>[2]['prompt']>[0];

/** A login whose provider asks `prompt` once, answered by `answer`. */
const asking = (prompt: Prompt, answer: () => Promise<string>) => {
  const waits: boolean[] = [];
  const logout = vi.fn(async () => {});
  const models = watchingPastes(
    {
      login: async (_providerId, _type, interaction) => interaction.prompt(prompt),
      logout,
    },
    (waiting) => waits.push(waiting),
  );
  const run = () =>
    models.login('openai', 'oauth', {
      prompt: () => {
        // While the prompt is answered, the login waits.
        expect(waits).toEqual(prompt.type === 'select' ? [] : [true]);
        return answer();
      },
      notify: () => {},
    });
  return { waits, run, models, logout };
};

describe('watchingPastes (B81)', () => {
  it('says it waits while a pasted code is asked for, and stops once it is answered', async () => {
    const { waits, run } = asking({ type: 'manual_code', message: 'Paste' }, async () => 'code');

    await expect(run()).resolves.toBe('code');

    expect(waits).toEqual([true, false]);
  });

  it('stops waiting when the prompt ends without a text', async () => {
    const { waits, run } = asking({ type: 'text', message: 'Code' }, async () => {
      throw new Error('Login prompt cancelled');
    });

    await expect(run()).rejects.toThrow('Login prompt cancelled');

    expect(waits).toEqual([true, false]);
  });

  it('says nothing for a prompt that is not answered by a pasted text', async () => {
    const { waits, run } = asking(
      { type: 'select', message: 'Pick', options: [{ id: 'a', label: 'A' }] },
      async () => 'a',
    );

    await run();

    expect(waits).toEqual([]);
  });

  it('logs out as the models do', async () => {
    const { models, logout } = asking({ type: 'manual_code', message: 'Paste' }, async () => '');

    await models.logout('openai');

    expect(logout).toHaveBeenCalledWith('openai');
  });

  it('stops waiting when the login ends while a paste prompt is still pending', async () => {
    const waits: boolean[] = [];
    const models = watchingPastes(
      {
        login: async (_providerId, _type, interaction) => {
          // The provider asks for a code, then gives up without waiting for it.
          void interaction.prompt({ type: 'manual_code', message: 'Paste' }).catch(() => {});
          throw new Error('provider failed');
        },
        logout: async () => {},
      },
      (waiting) => waits.push(waiting),
    );
    const never = new Promise<string>(() => {});

    await expect(
      models.login('openai', 'oauth', { prompt: () => never, notify: () => {} }),
    ).rejects.toThrow('provider failed');

    expect(waits).toEqual([true, false]);
  });

  it('a login that ends with its prompt pending leaves the next one counted from zero', async () => {
    const waits: boolean[] = [];
    let settle: (code: string) => void = () => {};
    const models = watchingPastes(
      {
        login: async (_providerId, _type, interaction) => {
          void interaction.prompt({ type: 'manual_code', message: 'Paste' });
        },
        logout: async () => {},
      },
      (waiting) => waits.push(waiting),
    );
    const pending = () =>
      new Promise<string>((resolve) => {
        settle = resolve;
      });

    await models.login('openai', 'oauth', { prompt: pending, notify: () => {} });
    const stale = settle;
    await models.login('openai', 'oauth', { prompt: pending, notify: () => {} });
    // The first login's prompt settling late changes nothing.
    stale('late');
    await new Promise((resolve) => setImmediate(resolve));

    expect(waits).toEqual([true, false, true, false]);
  });
});
