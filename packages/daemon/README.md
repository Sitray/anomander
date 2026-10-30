# @anomander/daemon

The runtime of ANOMANDER (PRD §14.3). It opens the SQLite ledger, applies the migrations, runs
the matter cycles and calls the processor. It is the only package that writes rows; the rules
it applies come from `@anomander/core`, and front doors such as `apps/telegram` reach it
through the types of `@anomander/protocol`.

## The text expense cycle

`createTextExpenseHandler` (`src/expenses/text-expense.ts`) is the `TextHandler` for a text the
principal sent, such as `23 € cena`. Each step enforces a PRD rule:

1. **Interpret.** The processor classifies the text as an expense or conversation (R-17 AC5) and
   returns inferences only. A1: policies and new categories (R-13, R-18) arrive in M4.
2. **Conversation.** It gets the processor's reply and nothing is stored (R-16).
3. **Unusable response.** It is logged and answered with S-16; nothing is stored (A3).
4. **Amount.** The inferred `total` is accepted only if the principal wrote it literally, in one
   of the forms `23`, `23,40`, `23.40`, `23€`, `23 €`, `€23` (`isLiteralAmount`, R-2 AC5 and
   AC6). Otherwise the reply is S-16 and nothing is stored.
5. **Date.** Today in `TZ`, unless the processor inferred a named date. A value that is not a
   calendar date is logged and replaced by today; a date after today gets S-21 and nothing is
   stored (R-2 AC7).
6. **Category.** `categorize` (R-5): a category the principal wrote in the text is `declared`,
   then an active policy, then an existing inferred category, else none (R-2 AC3). A declared
   category that does not exist is logged and left out; asking S-15 is M4 (R-18 AC3).
7. **Authority.** `checkAuthority` decides; a text expense is authorized by the principal's own
   message, with no permission lookup (R-2 AC2, §8).
8. **Act.** One transaction stores the merchant entity (found case-insensitively), the proposal,
   the action, the expense (`mode 'declared'`, `document_id NULL`) and its assertions: the
   declared total by the principal, the declared category when stated, and the processor
   inferences the expense rests on; unused ones die with the execution (§7, §10, §13).
9. **Verify.** The expense is read back and the reply S-1 or S-2 is built from that row
   (R-9 AC1), then worded by the phraser (R-21, below). When the front door delivers it, `onDelivered` stores an `observed` assertion
   about the action and links it as `verification_assertion_id`; the action becomes
   `verified` (R-9 AC2).

## The processor port

`TextInterpreter` (`src/processor/text-interpreter.ts`) is the port the cycle depends on.
`createPiAiTextInterpreter` implements it with `@earendil-works/pi-ai`: one system prompt and
one user turn, never a `tools` key (R-14 AC3). It parses a single JSON object from the text
blocks (code fences allowed), validates its envelope with Zod, and passes each inference
through `validateProcessorOutput`, so anything claiming `observed`, `declared` or `confirmed`
is rejected and logged (R-14 AC2).

Contract tests run on recorded responses in `test/fixtures/text-interpreter/`, one pi-ai
`AssistantMessage` per JSON file. The current fixtures are hand-authored, not recorded from a
live model. To add one, save the `AssistantMessage` that `models.complete` returned for a real
message (or author one in the same shape), then add a case to
`test/processor/text-interpreter.test.ts` that loads it by name.

## Phrased replies (R-21)

ANOMANDER is an AI assistant, so it words its confirmations in its own voice, but the facts in
them come from code. `ReplyPhraser` (`src/processor/reply-phraser.ts`) receives the §12 string
(S-1, S-2, S-16 or S-21) and the facts read from the database (amount, merchant, category or
date, formatted as in §12). `createPiAiReplyPhraser` asks the processor to reword it, with no
tools, and sends the result only if:

- it contains every fact (spacing and case aside: `Intl` writes a no-break space before `€`);
- it contains no amount that is not among the facts or in the §12 string;
- it is at most 280 characters.

Otherwise, or if the call fails, the §12 string is sent unchanged. Every other string (S-17,
S-18, S-20...) is sent verbatim and never reaches the processor. The delivery observation
stores the text that was actually sent. `verbatimReplies` skips the processor, for tests.

## Running the daemon

`src/main.ts` reads the configuration, resolves `ANOMANDER_MODEL` through pi-ai's
`builtinModels()` and calls `startAnomander` (`src/app.ts`), the composition root that opens the
store, builds the cycle and starts the Telegram bot with long polling. Model credentials come
from the provider's usual environment variable (for example `OPENAI_API_KEY`), as pi-ai
resolves them.

## Configuration

`loadConfig(process.env)` (`src/config.ts`) reads PRD §14.4. An empty value counts as unset.
The error names every missing required variable.

| Variable | Default |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | required |
| `ANOMANDER_PRINCIPAL_CHAT_ID` | required, an integer |
| `ANOMANDER_MODEL` | required, provider-qualified (R-15 AC1) |
| `ANOMANDER_VISION_MODEL` | required, provider-qualified |
| `ANOMANDER_DB_PATH` | `./data/anomander.db` |
| `ANOMANDER_DAILY_AI_CALL_LIMIT` | `200` |
| `ANOMANDER_WEEKLY_SUMMARY_CRON` | `0 20 * * 0` |
| `ANOMANDER_RETENTION_CRON` | `0 3 * * *` |
| `ANOMANDER_INBOX_DIR` | `./data/inbox` |
| `TZ` | `Europe/Madrid` |

`parseModelId` splits a model ID at its first `/`: `openrouter/anthropic/x` is provider
`openrouter` and model `anthropic/x`.

## Tests

```sh
pnpm vitest run packages/daemon
pnpm -F @anomander/daemon typecheck
```

`test/e2e/` runs the whole path: the fake Telegram API (`@anomander/telegram/fake-telegram-api`),
the real bot, `startAnomander`, a SQLite file and recorded processor responses.

Store and cycle tests use a real SQLite file in a `mkdtemp` folder under the system temp
directory, removed after each test. The processor is a fake in cycle tests and a recorded
response in contract tests; no test calls a live model.

## Invariants

- The processor never writes. It returns inferences; only this package persists rows
  (R-14 AC1).
- Every assertion goes through `assertionDraftSchema` before it is inserted (§7.2), and the
  ledger is append-only except `status` (R-7 AC3, enforced by triggers).
- The reply is built from the stored row, never from the proposal (R-9 AC1).
- Bot text comes from `strings` in `@anomander/protocol`, except the processor's
  conversational reply (R-16) and the phrased replies that passed the R-21 guard.
