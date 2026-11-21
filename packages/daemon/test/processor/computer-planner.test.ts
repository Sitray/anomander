import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import { AiBudgetExhaustedError } from '../../src/budget/ai-budget.ts';
import {
  COMPUTER_PLANNER_PROMPT,
  createPiAiComputerPlanner,
} from '../../src/processor/computer-planner.ts';

// DK-10: the planner on its own, with a fake `complete`. The whole task, through the local
// channel, is in `test/desktop/local-channel.test.ts`; this pins the function's own contract.
const MODEL = { provider: 'openai', id: 'gpt-4o-mini' };
const TASK = 'Envía el correo que tengo abierto';
const IMAGE = { mimeType: 'image/png', data: new Uint8Array([137, 80, 78, 71]) };

const answer = (
  text: string,
  stopReason: AssistantMessage['stopReason'] = 'stop',
  errorMessage?: string,
) =>
  ({
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'openai',
    model: 'gpt-4o-mini',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(errorMessage === undefined ? {} : { errorMessage }),
    timestamp: 0,
  }) as AssistantMessage;

const plannerAnswering = (respond: () => Promise<AssistantMessage>) => {
  const contexts: Context[] = [];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const plan = createPiAiComputerPlanner({
    complete: async (_model: typeof MODEL, context: Context) => {
      contexts.push(context);
      return respond();
    },
    model: MODEL,
    logger,
  });
  return { plan, contexts, logger };
};

/** What the planner makes of `step`, the processor's reply, after `done` steps. */
const planned = (step: unknown, done = 0) =>
  plannerAnswering(async () => answer(typeof step === 'string' ? step : JSON.stringify(step))).plan(
    { task: TASK, image: IMAGE, done: Array.from({ length: done }, (_, n) => `Paso ${n}`) },
  );

const key = (name: string, modifiers: string[] = []) => ({
  kind: 'key',
  key: name,
  modifiers,
  sensitive: false,
});
const SCROLL = { kind: 'scroll', x: 500, y: 500, direction: 'down', sensitive: false };

describe('the computer planner (DK-10)', () => {
  it('asks with one system prompt and one user turn: the task, the steps, the memories and the capture', async () => {
    const { plan, contexts } = plannerAnswering(async () => answer(JSON.stringify(SCROLL)));
    const memories = [{ text: 'Uso Gmail', mode: 'declared' as const }];

    await plan({ task: TASK, image: IMAGE, done: ['Paso 1'], memories });

    expect(contexts).toHaveLength(1);
    const [context] = contexts;
    expect(context?.systemPrompt).toBe(COMPUTER_PLANNER_PROMPT);
    expect(context).not.toHaveProperty('tools');
    expect(context?.messages).toHaveLength(1);
    expect(context?.messages[0]?.content).toEqual([
      { type: 'text', text: JSON.stringify({ task: TASK, done: ['Paso 1'], memories }) },
      { type: 'image', mimeType: 'image/png', data: Buffer.from(IMAGE.data).toString('base64') },
    ]);
  });

  it('reads one step, with or without a Markdown fence, and says in code what it is', async () => {
    const step = {
      kind: 'action',
      action: { kind: 'key', key: 'c', modifiers: ['cmd'] },
      text: 'Quiero pulsar ⌘C.',
      confirm: false,
    };

    expect(await planned(key('c', ['cmd']))).toEqual(step);
    expect(await planned(`\`\`\`json\n${JSON.stringify(key('c', ['cmd']))}\n\`\`\``)).toEqual(step);
    // The modifiers are shown in the order a Mac writes them, whatever order they came in.
    expect(await planned(key('c', ['cmd', 'shift', 'ctrl', 'alt']))).toMatchObject({
      text: 'Quiero pulsar ⌃⌥⇧⌘C.',
    });
  });

  it('ends the task with the processor words, done or not', async () => {
    expect(await planned({ kind: 'done', message: 'Correo enviado.' })).toEqual({
      kind: 'end',
      text: 'Correo enviado.',
      completed: true,
    });
    expect(await planned({ kind: 'cannot', message: 'No veo ningún correo.' })).toEqual({
      kind: 'end',
      text: 'No veo ningún correo.',
      completed: false,
    });
  });

  it('AC1: takes a step for one of care when the processor does not say otherwise', async () => {
    const { sensitive: _, ...unsaid } = SCROLL;

    expect(await planned(unsaid)).toMatchObject({ kind: 'action', confirm: true });
  });

  it.each([
    ['Enter', key('enter'), true],
    ['Space', key('space'), true],
    ['Shift+Enter', key('enter', ['shift']), true],
    ['Ctrl+Enter', key('enter', ['ctrl']), true],
    ['Alt+Space', key('space', ['alt']), true],
    ['Cmd+Space, Spotlight', key('space', ['cmd']), true],
    ['Cmd+Tab, the app switcher', key('tab', ['cmd']), true],
    ['Ctrl+Space, the input source', key('space', ['ctrl']), true],
    ['Cmd+L', key('l', ['cmd']), false],
    ['Shift+Tab', key('tab', ['shift']), false],
    ['Tab', key('tab'), false],
  ])('AC1: whether %s waits for the principal: %s', async (_label, step, careful) => {
    expect(await planned(step)).toMatchObject({ kind: 'action', confirm: careful });
  });

  it('AC1: the fifth step, and every fifth after it, waits for the principal', async () => {
    const confirms = async (done: number) => (await planned(SCROLL, done)) as { confirm: boolean };

    expect((await confirms(0)).confirm).toBe(false);
    expect((await confirms(3)).confirm).toBe(false);
    expect((await confirms(4)).confirm).toBe(true);
    expect((await confirms(5)).confirm).toBe(false);
    expect((await confirms(9)).confirm).toBe(true);
    expect((await confirms(14)).confirm).toBe(true);
  });

  it('fails, and logs the reason without the task, when the reply is not one valid step', async () => {
    const { plan, logger } = plannerAnswering(async () => answer('haz clic en enviar'));

    expect(await plan({ task: TASK, image: IMAGE, done: [] })).toEqual({ kind: 'failed' });
    expect(logger.warn).toHaveBeenCalledWith('computer planning failed', {
      reason: 'processor response is not one valid step',
    });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(TASK);
  });

  it('tells a spent budget, a spent provider quota and a failed call apart', async () => {
    const outcome = (respond: () => Promise<AssistantMessage>) =>
      plannerAnswering(respond).plan({ task: TASK, image: IMAGE, done: [] });

    expect(
      await outcome(async () => {
        throw new AiBudgetExhaustedError();
      }),
    ).toEqual({ kind: 'budget_exhausted' });
    expect(
      await outcome(async () => {
        throw new Error('429 You exceeded your current quota');
      }),
    ).toEqual({ kind: 'provider_limit' });
    expect(await outcome(async () => answer('', 'error', 'rate limit reached'))).toEqual({
      kind: 'provider_limit',
    });
    expect(
      await outcome(async () => {
        throw new Error('the provider is down');
      }),
    ).toEqual({ kind: 'failed' });
    expect(await outcome(async () => answer('', 'aborted'))).toEqual({ kind: 'failed' });
  });
});
