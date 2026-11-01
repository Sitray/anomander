# Text evaluation

How well a model interprets the principal's messages (PRD §15): whether "ya compré las pilas"
becomes a done task, "23 € cena" an expense and "¿qué tengo pendiente?" a list. The e2e tests
answer with a fake processor, so they prove what code does with an answer, never whether a real
model gives it. This is a measurement, not a pass/fail test: run it when a prompt, a capability
or the model changes, and compare the result with the previous run.

```sh
pnpm eval:text                                       # ANOMANDER_MODEL from .env, 3 runs per case
pnpm eval:text --model openai/gpt-4o-mini --model ollama/qwen3
pnpm eval:text --runs 1 --file ~/my-cases.json       # another cases file
```

Each case runs `--runs` times (default 3), with the real provider, so a run costs one processor
call per case, run and model. A case passes only if every run passes, so an unstable answer
shows up as a failure. Provider credentials come from the environment, as for the daemon.

## Cases

Real messages carry personal data, so the cases never enter the repository:
`evals/text/cases.json` is ignored by git. It is a JSON array; each case is:

```json
{
  "name": "done-task",
  "message": "ya compré las pilas",
  "now": "2026-11-02T10:00",
  "pending": [{ "id": 3, "text": "comprar pilas", "when": null }],
  "expect": { "kind": "reminder_done", "ids": [3] }
}
```

- `now` is the local date and time in `TZ` when the message arrives; `today` and the weekday
  come from it.
- `categories` (default `supermercado`, `restaurantes`), `memories` (each `id`, `text`, `mode`)
  and `pending` (each `id`, `text`, `when`, `null` for a task) are what the interpreter is given.
- `expect` names the envelope `kind` and any field to compare; fields left out are not compared.
  For an expense, name the predicates: `total` (cents), `merchant`, `occurred_on`, `category`,
  `declared_category`. `"memories": true` asks for at least one remembered fact.
- When more than one answer is right, `expect` is an array; any of them passes.
- `note` is free text for you.

Strings are compared ignoring case, accents and punctuation; arrays ignore order.

## Report

For each model, every case is `ok` or shows how many runs passed and what was wrong: the kind it
got and the fields that differ, or `rejected by code` when the envelope was right but code
refused it (a quote not in the message, a call that does not match its schema). Then the cases
passed per expected kind and overall. Message texts are never printed.
