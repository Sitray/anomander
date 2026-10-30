// The receipt evaluation (PRD §15): how well a vision model reads real receipts. It is a
// measurement, not a pass/fail test, so it always exits 0 once it has run. It calls the real
// models named on the command line and costs one processor call per receipt and model.
//
//   pnpm eval:receipts [--model provider/id ...] [--dir evals/receipts/cases]
//
// Without `--model`, it reads with `ANOMANDER_VISION_MODEL`. See `evals/receipts/README.md`.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { todayIn } from '@anomander/core';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { z } from 'zod';
import { parseModelId } from '../src/config.ts';
import { createPiAiReceiptReader, type ReceiptReading } from '../src/processor/receipt-reader.ts';

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

const expectedSchema = z.object({
  total_cents: z.int().positive(),
  merchant: z.string().min(1).optional(),
  occurred_on: z.iso.date().optional(),
  /** Compared as a multiset of amounts; line names are not compared. */
  lines: z.array(z.object({ amount_cents: z.int() })).optional(),
});
type Expected = z.infer<typeof expectedSchema>;

interface Case {
  name: string;
  expected: Expected;
  images: { mimeType: string; data: Uint8Array }[];
}

/** A case is a folder with `expected.json` and its images, read in file name order. */
const loadCases = (dir: string): Case[] =>
  readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .sort()
    .map((name) => {
      const folder = join(dir, name);
      const files = readdirSync(folder).sort();
      if (!existsSync(join(folder, 'expected.json'))) throw new Error(`${name}: no expected.json`);
      const images = files
        .filter((file) => MIME_TYPES[extname(file).toLowerCase()] !== undefined)
        .map((file) => ({
          mimeType: MIME_TYPES[extname(file).toLowerCase()] as string,
          data: new Uint8Array(readFileSync(join(folder, file))),
        }));
      const expected = expectedSchema.parse(
        JSON.parse(readFileSync(join(folder, 'expected.json'), 'utf8')),
      );
      if (images.length === 0) throw new Error(`${name}: no .jpg, .jpeg, .png or .webp image`);
      return { name, expected, images };
    });

/** Case, accents and punctuation do not count: "MERCADONA, S.A." equals "Mercadona SA". */
const normalized = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');

const sameAmounts = (expected: number[], read: number[]) =>
  expected.length === read.length &&
  [...expected]
    .sort((a, b) => a - b)
    .every((amount, i) => amount === [...read].sort((a, b) => a - b)[i]);

type Field = 'read' | 'total' | 'merchant' | 'occurred_on' | 'lines' | 'all';
/** `null` when the case does not state the field, so it does not count either way. */
type Score = Record<Field, boolean | null>;

const score = (expected: Expected, reading: ReceiptReading): Score => {
  const read = reading.kind === 'read' ? reading : null;
  const check = <T>(want: T | undefined, matches: (want: T) => boolean) =>
    want === undefined ? null : read !== null && matches(want);
  const fields = {
    read: read !== null,
    total: check(expected.total_cents, (want) => read?.total.value === want),
    merchant: check(
      expected.merchant,
      (want) => normalized(read?.merchant.value ?? '') === normalized(want),
    ),
    occurred_on: check(expected.occurred_on, (want) => read?.occurredOn.value === want),
    lines: check(expected.lines, (want) =>
      sameAmounts(
        want.map((line) => line.amount_cents),
        read?.lines.map((line) => line.value.amount_cents) ?? [],
      ),
    ),
  };
  return { ...fields, all: Object.values(fields).every((value) => value !== false) };
};

const percent = (scores: Score[], field: Field) => {
  const counted = scores.flatMap((s) => (s[field] === null ? [] : [s[field]]));
  if (counted.length === 0) return '-';
  const right = counted.filter(Boolean).length;
  return `${Math.round((right / counted.length) * 100)}% (${right}/${counted.length})`;
};

const { values } = parseArgs({
  options: {
    model: { type: 'string', multiple: true },
    dir: { type: 'string', default: resolve(import.meta.dirname, '../../../evals/receipts/cases') },
  },
});
const modelIds = values.model ?? [process.env.ANOMANDER_VISION_MODEL ?? ''];
// pnpm runs the script in this package; a relative `--dir` means where the command was typed.
const dir = resolve(process.env.INIT_CWD ?? process.cwd(), values.dir);
const cases = loadCases(dir);
if (cases.length === 0) {
  console.error(`no cases in ${dir}; see evals/receipts/README.md`);
  process.exit(1);
}

const models = builtinModels();
const today = todayIn(process.env.TZ ?? 'Europe/Madrid', new Date());
const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const FIELDS: Field[] = ['read', 'total', 'merchant', 'occurred_on', 'lines', 'all'];

for (const modelId of modelIds) {
  const { provider, id } = parseModelId(modelId);
  const model = models.getModel(provider, id);
  if (model === undefined) {
    console.error(`unknown model ${modelId}`);
    process.exit(1);
  }
  const reader = createPiAiReceiptReader({
    complete: (target, context) => models.complete(target, context),
    model,
    logger: quiet,
  });

  console.info(`\n${modelId}`);
  const scores: Score[] = [];
  for (const { name, expected, images } of cases) {
    const reading = await reader({ images, caption: null, today, categories: [] });
    const result = score(expected, reading);
    scores.push(result);
    const misses = FIELDS.filter((field) => field !== 'all' && result[field] === false);
    const why = reading.kind === 'unreadable' ? ` (${reading.reason})` : '';
    console.info(`  ${name}: ${misses.length === 0 ? 'ok' : `wrong ${misses.join(', ')}${why}`}`);
  }
  for (const field of FIELDS) console.info(`  ${field.padEnd(12)} ${percent(scores, field)}`);
}
