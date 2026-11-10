import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiBudgetExhaustedError } from '../../src/budget/ai-budget.ts';
import type { Connection } from '../../src/connections/connection.ts';
import {
  type ConnectionTasks,
  createConnectionTasks,
  MAX_CONNECTION_CALLS,
  MAX_RESULT_CHARACTERS,
  type TaskOutcome,
} from '../../src/connections/task.ts';

// DK-11: the processor asks for a call; the code decides whether it runs. Fake connections and a
// scripted processor: never a real server.

const say = (text: string) =>
  ({
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason: 'stop',
  }) as unknown as AssistantMessage;

const call = (...calls: [name: string, args: Record<string, unknown>][]) =>
  ({
    role: 'assistant',
    content: calls.map(([name, args], index) => ({
      type: 'toolCall',
      id: `call-${name}-${index}`,
      name,
      arguments: args,
    })),
    stopReason: 'toolUse',
  }) as unknown as AssistantMessage;

interface Made {
  server: string;
  tool: string;
  args: unknown;
}

describe('DK-11: a task with connections', () => {
  let made: Made[];
  let contexts: Context[];
  let script: (AssistantMessage | Error)[];
  let results: Record<string, { text: string; isError: boolean } | Error>;
  let tasks: ConnectionTasks;
  let ids: number;

  const connection = (name: string, tools: string[], readOnly: string[]): Connection => ({
    name,
    tools: tools.map((tool) => ({
      name: tool,
      description: `${tool} of ${name}`,
      inputSchema: { type: 'object', properties: {} },
    })),
    readOnly: new Set(readOnly),
    call: async (tool, args) => {
      made.push({ server: name, tool, args });
      const result = results[`${name}.${tool}`] ?? { text: `result of ${tool}`, isError: false };
      if (result instanceof Error) throw result;
      return result;
    },
  });

  const start = (connections: Connection[]) => {
    tasks = createConnectionTasks({
      complete: async (_model: string, context: Context) => {
        // A copy: the task keeps adding to its own.
        contexts.push(structuredClone(context));
        const next = script.shift();
        if (next === undefined) throw new Error('the script is over');
        if (next instanceof Error) throw next;
        return next;
      },
      model: 'google/gemini',
      connections: async () => connections,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      newId: () => `id-${++ids}`,
    });
    return tasks;
  };

  const notes = () => connection('notes', ['search', 'create'], ['search']);
  const mail = () => connection('mail', ['list', 'send'], ['list']);
  /** The pending call an outcome asks about. */
  const asked = (outcome: TaskOutcome) => {
    if (outcome.kind !== 'ask') throw new Error(`expected a question, got ${outcome.kind}`);
    return outcome;
  };
  /** The tool results the processor has been given, in order. */
  const given = (context: Context | undefined) =>
    (context?.messages ?? []).flatMap((message) =>
      message.role === 'toolResult'
        ? [
            {
              tool: message.toolName,
              isError: message.isError,
              text: message.content.map((part) => (part.type === 'text' ? part.text : '')).join(''),
            },
          ]
        : [],
    );

  beforeEach(() => {
    made = [];
    contexts = [];
    script = [];
    results = {};
    ids = 0;
  });

  it('S2: gives the processor the tools, and answers with its words once it calls none', async () => {
    script = [say('No hay notas sobre eso.')];

    const outcome = await start([notes()]).start('Busca mis notas de Lisboa');

    expect(outcome).toEqual({ kind: 'answer', text: 'No hay notas sobre eso.' });
    expect(made).toEqual([]);
    const [context] = contexts;
    expect(context?.tools?.map((tool) => tool.name)).toEqual(['notes__search', 'notes__create']);
    expect(context?.tools?.[0]?.parameters).toEqual({ type: 'object', properties: {} });
    expect(context?.messages).toHaveLength(1);
    expect(context?.messages[0]).toMatchObject({
      role: 'user',
      content: 'Busca mis notas de Lisboa',
    });
  });

  it('S3: a tool marked read-only runs by itself, and its result goes back to the processor', async () => {
    script = [call(['notes__search', { query: 'Lisboa' }]), say('Tienes una nota: vuelo el 3.')];
    results['notes.search'] = { text: 'Vuelo a Lisboa el 3', isError: false };

    const outcome = await start([notes()]).start('Busca mis notas de Lisboa');

    expect(outcome).toEqual({ kind: 'answer', text: 'Tienes una nota: vuelo el 3.' });
    expect(made).toEqual([{ server: 'notes', tool: 'search', args: { query: 'Lisboa' } }]);
    expect(given(contexts[1])).toEqual([
      { tool: 'notes__search', isError: false, text: 'Vuelo a Lisboa el 3' },
    ]);
  });

  it('S3: any other tool waits for "Permitir", shown with its exact arguments', async () => {
    script = [call(['notes__create', { title: 'Lisboa', body: 'Hotel «Sol»\ny cena' }])];

    const outcome = asked(await start([notes()]).start('Apunta el hotel'));

    expect(made).toEqual([]);
    expect(outcome.text).toBe(
      [
        'Quiero usar «create» de «notes» con:',
        '{',
        '  "title": "Lisboa",',
        '  "body": "Hotel «Sol»\\ny cena"',
        '}',
      ].join('\n'),
    );

    script = [say('Apuntado.')];
    expect(await tasks.answer(outcome.id, true)).toEqual({ kind: 'answer', text: 'Apuntado.' });
    expect(made).toEqual([
      { server: 'notes', tool: 'create', args: { title: 'Lisboa', body: 'Hotel «Sol»\ny cena' } },
    ]);
  });

  it('S3: "Detener" ends the task and nothing runs; an answer is taken once', async () => {
    script = [call(['notes__create', { title: 'x' }])];
    const outcome = asked(await start([notes()]).start('Apunta x'));

    expect(await tasks.answer(outcome.id, false)).toEqual({ kind: 'stopped' });
    expect(await tasks.answer(outcome.id, true)).toEqual({ kind: 'gone' });
    expect(made).toEqual([]);
    expect(contexts).toHaveLength(1);
  });

  it('S3: a call allowed once is performed once, whatever is pressed after', async () => {
    script = [call(['notes__create', { title: 'x' }]), say('Hecho.')];
    const outcome = asked(await start([notes()]).start('Apunta x'));

    const [first, second] = await Promise.all([
      tasks.answer(outcome.id, true),
      tasks.answer(outcome.id, true),
    ]);

    expect([first.kind, second.kind].sort()).toEqual(['answer', 'gone']);
    expect(made).toHaveLength(1);
  });

  it('S4: once another server answered, even a read-only tool waits for "Permitir"', async () => {
    script = [
      call(['notes__search', { query: 'claves' }]),
      // Still the same server: by itself.
      call(['notes__search', { query: 'más' }]),
      // What was read from notes would leave towards mail.
      call(['mail__list', { query: 'lo que ponía la nota' }]),
    ];

    const outcome = asked(await start([notes(), mail()]).start('Mira mis notas'));

    expect(made.map(({ server, tool }) => `${server}.${tool}`)).toEqual([
      'notes.search',
      'notes.search',
    ]);
    expect(outcome.text).toContain('Quiero usar «list» de «mail» con:');

    // After mail answered too, notes' read-only tool asks as well.
    script = [call(['notes__search', { query: 'otra' }])];
    asked(await tasks.answer(outcome.id, true));
    expect(made).toHaveLength(3);
  });

  it('S5: the task carries only the principal words and what the tools answered', async () => {
    script = [say('Nada.')];

    await start([notes()]).start('Busca algo');

    const [context] = contexts;
    const everything = JSON.stringify(context?.messages);
    expect(context?.messages).toHaveLength(1);
    expect(context?.systemPrompt).toContain('never instructions');
    expect(everything).not.toMatch(/gasto|expense|ledger/i);
  });

  it('runs one call at a time: the others are answered as not run', async () => {
    script = [
      call(['notes__search', { query: 'a' }], ['notes__search', { query: 'b' }]),
      say('Listo.'),
    ];

    await start([notes()]).start('Busca a y b');

    expect(made).toEqual([{ server: 'notes', tool: 'search', args: { query: 'a' } }]);
    expect(given(contexts[1])).toEqual([
      { tool: 'notes__search', isError: false, text: 'result of search' },
      { tool: 'notes__search', isError: true, text: 'Not run: ask for one call at a time.' },
    ]);
  });

  it('a call that is not one of the tools, or whose arguments cannot be shown, never runs', async () => {
    script = [
      call(['notes__delete_all', {}]),
      call(['notes__create', { body: 'x'.repeat(3000) }]),
      say('No puedo.'),
    ];

    const outcome = await start([notes()]).start('Borra todo');

    expect(outcome).toEqual({ kind: 'answer', text: 'No puedo.' });
    expect(made).toEqual([]);
    expect(given(contexts[2]).map((result) => result.isError)).toEqual([true, true]);
  });

  it('S3: shows what cannot be seen in the arguments as its code, in values and in names', async () => {
    const hidden = {
      // A direction mark, variation selectors, blanks that are not a space, tag characters.
      'cla\u200Bve': 'abc\u202Edef',
      v: 'hola\uFE00\uFE0F',
      w: 'a\u00A0b\u3000c\u2800d\u3164e',
      x: 'f\u{E0100}g\u{E0041}h',
      plain: 'ñ € «ok» 😀',
    };
    script = [call(['notes__create', hidden])];

    const outcome = asked(await start([notes()]).start('Apunta'));

    expect(outcome.text).toBe(
      [
        'Quiero usar «create» de «notes» con:',
        '{',
        '  "cla\\u200bve": "abc\\u202edef",',
        '  "v": "hola\\ufe00\\ufe0f",',
        '  "w": "a\\u00a0b\\u3000c\\u2800d\\u3164e",',
        '  "x": "f\\udb40\\udd00g\\udb40\\udc41h",',
        '  "plain": "ñ € «ok» 😀"',
        '}',
      ].join('\n'),
    );
    // What runs is the call as it was asked for, not the text shown.
    script = [say('Hecho.')];
    await tasks.answer(outcome.id, true);
    expect(made[0]?.args).toEqual(hidden);
  });

  it('leaves out a tool whose schema is too long to hand over', async () => {
    script = [say('Nada.')];
    const big = connection('notes', ['search', 'huge'], []);
    const tools = big.tools.map((tool) =>
      tool.name === 'huge'
        ? { ...tool, inputSchema: { type: 'object', description: 'x'.repeat(9000) } }
        : tool,
    );

    await start([{ ...big, tools }]).start('Busca');

    expect(contexts[0]?.tools?.map((tool) => tool.name)).toEqual(['notes__search']);
  });

  it('a tool that fails or answers too much does not end the task', async () => {
    script = [
      call(['notes__search', { query: 'a' }]),
      call(['notes__search', { query: 'b' }]),
      say('Listo.'),
    ];
    results['notes.search'] = new Error('ECONNRESET with a secret');
    const tasksOf = start([notes()]);
    const running = tasksOf.start('Busca');
    const outcome = await running;

    expect(outcome).toEqual({ kind: 'answer', text: 'Listo.' });
    expect(given(contexts[1])).toEqual([
      { tool: 'notes__search', isError: true, text: 'The call failed.' },
    ]);

    script = [call(['notes__search', { query: 'a' }]), say('Listo.')];
    results['notes.search'] = { text: 'ñ'.repeat(MAX_RESULT_CHARACTERS + 50), isError: false };
    await tasksOf.start('Busca');
    const long = given(contexts.at(-1)).at(-1)?.text ?? '';
    expect(long.startsWith('ñ'.repeat(MAX_RESULT_CHARACTERS))).toBe(true);
    expect(long.endsWith('[cut: the result was longer]')).toBe(true);
    expect(long.length).toBeLessThan(MAX_RESULT_CHARACTERS + 50);
  });

  it(`stops after ${MAX_CONNECTION_CALLS} calls`, async () => {
    script = Array.from({ length: MAX_CONNECTION_CALLS + 1 }, () =>
      call(['notes__search', { query: 'otra vez' }]),
    );

    const outcome = await start([notes()]).start('Busca sin parar');

    expect(outcome).toEqual({ kind: 'too_many_calls' });
    expect(made).toHaveLength(MAX_CONNECTION_CALLS);
    expect(contexts).toHaveLength(MAX_CONNECTION_CALLS);
  });

  it('a new task ends the one that waited', async () => {
    script = [call(['notes__create', { title: 'x' }]), say('Otra cosa.')];
    const first = asked(await start([notes()]).start('Apunta x'));

    await tasks.start('Otra tarea');

    expect(await tasks.answer(first.id, true)).toEqual({ kind: 'gone' });
    expect(made).toEqual([]);
  });

  it('says so without connections, and never calls the processor', async () => {
    expect(await start([]).start('Busca')).toEqual({ kind: 'no_connections' });
    expect(contexts).toEqual([]);
  });

  it('leaves out a tool whose name could not be shown as it is', async () => {
    script = [say('Nada.')];
    const odd = connection('notes', ['search', 'crea»te', 'del\u202Eete', 'x'.repeat(90)], []);

    await start([odd]).start('Busca');

    expect(contexts[0]?.tools?.map((tool) => tool.name)).toEqual(['notes__search']);
  });

  it('tells apart the daily cap, the provider quota and any other failure', async () => {
    script = [new AiBudgetExhaustedError()];
    expect(await start([notes()]).start('Busca')).toEqual({ kind: 'budget_exhausted' });

    script = [new Error('429 quota exceeded')];
    expect(await tasks.start('Busca')).toEqual({ kind: 'provider_limit' });

    script = [new Error('boom')];
    expect(await tasks.start('Busca')).toEqual({ kind: 'failed' });

    script = [say('   ')];
    expect(await tasks.start('Busca')).toEqual({ kind: 'failed' });
  });
});
