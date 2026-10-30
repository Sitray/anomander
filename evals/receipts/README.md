# Receipt evaluation

How well a vision model reads real receipts (PRD §15). It is a measurement, not a pass/fail
test: use it to decide with data whether a new or local model, or a prompt change, reads as
well as the current one. Run it when the receipt reader or its prompt changes.

```sh
pnpm eval:receipts                                   # ANOMANDER_VISION_MODEL from .env
pnpm eval:receipts --model openai/gpt-4o --model ollama/llava
pnpm eval:receipts --dir ~/receipts                  # another cases folder
```

Each model reads each receipt once, with the real provider, so a run costs one processor call
per receipt and model. Provider credentials come from the environment, as for the daemon.

## Cases

Receipts carry personal data, so the cases never enter the repository: `evals/receipts/cases/`
is ignored by git. Each case is a folder there with the receipt's images (`.jpg`, `.jpeg`,
`.png` or `.webp`, read in file name order as one receipt, like an album) and an
`expected.json`:

```json
{
  "total_cents": 4520,
  "merchant": "Mercadona",
  "occurred_on": "2026-10-29",
  "lines": [{ "amount_cents": 120 }, { "amount_cents": 4400 }]
}
```

Only `total_cents` is required; a field left out is not counted. The merchant is compared
ignoring case, accents and punctuation; lines are compared as a set of amounts, not by name.

## Report

For each model, every case is `ok` or lists the fields it got wrong, then the percentage right
for `read` (not unreadable), `total`, `merchant`, `occurred_on`, `lines` and `all` (every stated
field right).
