// The text evaluation (PRD §15): how well a model interprets the principal's messages, the
// counterpart of the receipt evaluation. The e2e tests answer with a fake processor, so they
// prove what code does with an answer, never whether a real model gives it. It is a measurement,
// not a pass/fail test, so it exits 0 once it has run. It calls the real models named on the
// command line and costs one processor call per case, run and model.
//
//   pnpm eval:text [--model provider/id ...] [--runs 3] [--file evals/text/cases.json]
//
// Without `--model`, it interprets with `ANOMANDER_MODEL`. See `evals/text/README.md`.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { z } from 'zod';
import { parseModelId } from '../src/config.ts';
import { createPiAiTextInterpreter } from '../src/processor/text-interpreter.ts';

/** What the envelope must hold: `kind`, plus any field to compare; others are not compared. */
const expectSchema = z.looseObject({ kind: z.string().min(1) });
type Expect = z.infer<typeof expectSchema>;

const caseSchema = z.object({
  name: z.string().min(1),
  message: z.string().min(1),
  /** The local date and time in `TZ` when the message arrives, `YYYY-MM-DDTHH:mm`. */
  now: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
  categories: z.array(z.string()).default(['supermercado', 'restaurantes']),
  memories: z.array(z.object({ id: z.int(), text: z.string(), mode: z.string() })).default([]),
  /** The pending reminders and tasks, as the reminders capability lists them (R-25 AC1). */
  pending: z
    .array(z.object({ id: z.int(), text: z.string(), when: z.string().nullable() }))
    .default([]),
  /** One expectation, or several when more than one answer is right. */
  expect: z.union([expectSchema, z.array(expectSchema).min(1)]),
  note: z.string().optional(),
});
type Case = z.infer<typeof caseSchema>;

/** Case, accents and punctuation do not count: "Mercadona, S.A." equals "mercadona sa". */
const normalized = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');

const sorted = (values: unknown[]) => [...values].map((v) => JSON.stringify(v)).sort();

/** Strings ignore case and accents, arrays ignore order, objects compare the expected keys. */
const matches = (want: unknown, got: unknown): boolean => {
  if (typeof want === 'string')
    return typeof got === 'string' && normalized(want) === normalized(got);
  if (Array.isArray(want)) {
    if (!Array.isArray(got) || want.length !== got.length) return false;
    const [a, b] = [sorted(want), sorted(got)];
    return a.every((value, i) => value === b[i]);
  }
  if (want !== null && typeof want === 'object') {
    if (got === null || typeof got !== 'object') return false;
    return Object.entries(want).every(([key, value]) =>
      matches(value, (got as Record<string, unknown>)[key]),
    );
  }
  return want === got;
};

/**
 * The fields an expectation can name. An expense is compared by predicate (`total`, `merchant`,
 * `occurred_on`, `category`, `declared_category`); `memories: true` asks for at least one fact.
 */
const fieldsOf = (envelope: Record<string, unknown>): Record<string, unknown> => {
  const fields: Record<string, unknown> = { ...envelope };
  if (Array.isArray(envelope.inferences)) {
    for (const inference of envelope.inferences as { predicate?: string; value_json?: unknown }[]) {
      if (typeof inference.predicate === 'string')
        fields[inference.predicate] = inference.value_json;
    }
  }
  fields.memories = Array.isArray(envelope.memories) && envelope.memories.length > 0;
  return fields;
};

/** The names of the expected fields the envelope gets wrong; empty when it matches. */
const missesOf = (want: Expect, envelope: Record<string, unknown> | null): string[] => {
  if (envelope === null) return ['json'];
  const got = fieldsOf(envelope);
  return Object.entries(want)
    .filter(([key, value]) => !matches(value, got[key]))
    .map(([key]) => key);
};

const textOf = (message: AssistantMessage) =>
  message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');

const envelopeOf = (text: string): Record<string, unknown> | null => {
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const { values } = parseArgs({
  options: {
    model: { type: 'string', multiple: true },
    runs: { type: 'string', default: '3' },
    file: {
      type: 'string',
      default: resolve(import.meta.dirname, '../../../evals/text/cases.json'),
    },
  },
});
const modelIds = values.model ?? [process.env.ANOMANDER_MODEL ?? ''];
const runs = Number.parseInt(values.runs, 10);
// pnpm runs the script in this package; a relative `--file` means where the command was typed.
const file = resolve(process.env.INIT_CWD ?? process.cwd(), values.file);
const cases: Case[] = existsSync(file)
  ? z.array(caseSchema).parse(JSON.parse(readFileSync(file, 'utf8')))
  : [];
if (cases.length === 0 || !(runs > 0)) {
  console.error(`no cases in ${file} or a bad --runs; see evals/text/README.md`);
  process.exit(1);
}

const models = builtinModels();
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

for (const modelId of modelIds) {
  const { provider, id } = parseModelId(modelId);
  const model = models.getModel(provider, id);
  if (model === undefined) {
    console.error(`unknown model ${modelId}`);
    process.exit(1);
  }
  // The raw answer is kept so the envelope can be scored even when code would reject it.
  let raw = '';
  const interpret = createPiAiTextInterpreter({
    complete: async (target, context) => {
      const message = await models.complete(target, context);
      raw = textOf(message);
      return message;
    },
    model,
    logger: quiet,
  });

  console.info(`\n${modelId} (${runs} runs per case; a case passes only if every run does)`);
  const byKind = new Map<string, { right: number; total: number }>();
  for (const item of cases) {
    const wants = Array.isArray(item.expect) ? item.expect : [item.expect];
    const today = item.now.slice(0, 10);
    const weekday = WEEKDAYS[new Date(`${today}T12:00:00Z`).getUTCDay()];
    const outcomes: string[] = [];
    for (let run = 0; run < runs; run++) {
      raw = '';
      const interpretation = await interpret({
        text: item.message,
        today,
        categories: item.categories,
        recent: [],
        memories: item.memories.map((memory) => ({ ...memory, mode: memory.mode as 'declared' })),
        capabilities: { reminders: { now: item.now, weekday, pending: item.pending } },
      });
      const envelope = envelopeOf(raw);
      const misses = wants.map((want) => missesOf(want, envelope));
      const best = misses.reduce((a, b) => (b.length < a.length ? b : a));
      // Code may still reject a right envelope (a quote not in the message, a bad schema).
      const rejected = ['invalid', 'failed'].includes(interpretation.kind);
      outcomes.push(
        best.length === 0 && !rejected
          ? 'ok'
          : rejected && best.length === 0
            ? `rejected by code (${interpretation.kind})`
            : `got ${String(envelope?.kind ?? 'no json')}, wrong ${best.join(', ')}`,
      );
    }
    const passed = outcomes.every((outcome) => outcome === 'ok');
    const kind = wants.map((want) => want.kind).join('|');
    const tally = byKind.get(kind) ?? { right: 0, total: 0 };
    byKind.set(kind, { right: tally.right + (passed ? 1 : 0), total: tally.total + 1 });
    const failures = [...new Set(outcomes.filter((outcome) => outcome !== 'ok'))];
    const okRuns = outcomes.filter((outcome) => outcome === 'ok').length;
    console.info(
      `  ${item.name}: ${passed ? 'ok' : `${okRuns}/${runs} ok; ${failures.join('; ')}`}`,
    );
  }
  let right = 0;
  for (const [kind, tally] of [...byKind].sort(([a], [b]) => a.localeCompare(b))) {
    right += tally.right;
    console.info(`  ${kind.padEnd(28)} ${tally.right}/${tally.total}`);
  }
  console.info(`  ${'all'.padEnd(28)} ${right}/${cases.length}`);
}
