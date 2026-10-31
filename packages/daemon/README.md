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

## The receipt cycle

`createReceiptExpenseHandler` (`src/expenses/receipt-expense.ts`) is the `ReceiptHandler` for a
photo, an image file or an album (PRD §10). Each step enforces a PRD rule:

1. **Observe.** The images are loaded from the front door and written to
   `ANOMANDER_INBOX_DIR/<document id>/` with generated names (`1.jpg`, `2.png`...); nothing the
   sender chose reaches the file system. One transaction stores the `documents` row (`kind
   'receipt'`, `status 'queued'`, `image_count`, `source` = the message or album) and an
   `observed` assertion `images_received` about it (R-3 AC1).
2. **Budget seam.** `mayReadNow` decides whether the receipt is read now. It always says yes
   until the daily AI budget (R-12, R-8 AC2) arrives in T3, which keeps the document `queued`
   with its images instead.
3. **Read.** The images are read back from disk and sent, with the caption, in one call to the
   `ReceiptReader` (R-3 AC4, AC5). Invalid output is unreadable (R-3 AC2).
4. **Delete the images.** Whatever the outcome, the folder is deleted, the document becomes
   `read` or `unreadable` and `image_deleted_at` is set (R-8 AC1).
5. **Unreadable.** The reply is S-5, verbatim, and no expense is stored (R-3 AC3).
6. **Declarations.** A merchant or category the caption states counts as `declared` only if the
   principal actually wrote it there; then it wins over the receipt (R-3 AC5).
7. **Categorize.** `categorize` (R-5): declared, then an active policy, then an existing inferred
   category, else none. A declared category that does not exist is logged (R-18 AC3 is M4).
8. **Check consistency.** `checkConsistency` with the current expenses and today in `TZ`: the
   lines sum to the total, the date is not later than today, no duplicate (R-4).
9. **Check authority.** `checkAuthority` with the permissions that are neither revoked nor
   expired (`listActivePermissions`, `conditions_json` parsed as `conditions`) (R-6, §8.1).
10. **Act (R-6 AC1).** When a permission covers it, one transaction stores the merchant entity,
    the proposal (`executed`), the action (`authorized_by 'permission:<id>'`), the expense
    (`status 'current'`, `document_id`, `mode 'corroborated'` when R-4 passed), its
    `purchase_lines`, the processor inferences it rests on (lines as `purchase_line` subjects),
    the caption's declarations and, when R-4 passed, one `confirmed` assertion by `code` per
    extracted inference, which becomes `confirmed` (R-4 AC4). The reply S-1 is built from the
    row read back and worded by the phraser (R-9, R-21); its delivery is recorded as in the text
    cycle (R-9 AC2).
11. **Ask (R-6 AC2, AC3).** Otherwise the same rows are stored with the expense `pending`, the
    proposal `asked` and no action, plus a `pending_decisions` row (`open`, `options_json`,
    `question` = the text sent). The question follows the precedence of `checkAuthority`: lines
    that do not add up get S-3 (`Apuntar`, `Corregir`, `Descartar`), a duplicate gets S-4
    (`Apuntar`, `Descartar`), and a new merchant, an inferred or declared category, or a date
    after today get S-6 (`Apuntar`, `Corregir`, `Descartar`). These are sent verbatim with their
    buttons; on delivery the sent message is stored as the decision's `channel_ref` (R-17 AC2).
    Answering the buttons is T2.

## The processor ports

`TextInterpreter` (`src/processor/text-interpreter.ts`) is the port the cycle depends on.
`createPiAiTextInterpreter` implements it with `@earendil-works/pi-ai`: one system prompt and
one user turn, never a `tools` key (R-14 AC3). It parses a single JSON object from the text
blocks (code fences allowed), validates its envelope with Zod, and passes each inference
through `validateProcessorOutput`, so anything claiming `observed`, `declared` or `confirmed`
is rejected and logged (R-14 AC2).

`ReceiptReader` (`src/processor/receipt-reader.ts`) reads receipts. `createPiAiReceiptReader`
calls `ANOMANDER_VISION_MODEL` with one user turn: a text block (`today`, `categories`,
`caption`) followed by one image block per image, and never a `tools` key (R-14 AC3). Every item
goes through `validateProcessorOutput`, and each predicate's value through Zod: `merchant`,
`occurred_on` (a calendar date), `total` (positive cents), `line` (`{ name, quantity,
amount_cents }`), and optionally `category`, `declared_category` and `declared_merchant` (from
the caption). Any rejected item, a repeated predicate, or a missing merchant, date, total or
line makes the receipt unreadable (R-3 AC2, R-14 AC2).

Contract tests run on recorded responses in `test/fixtures/text-interpreter/` and
`test/fixtures/receipt-reader/`, one pi-ai
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
store, builds the text and receipt cycles and starts the Telegram bot with long polling.
`startAnomander` takes the resolved `ANOMANDER_VISION_MODEL` as `visionModel`; without it,
receipts are read with `model`. Model credentials come
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
the real bot, `startAnomander`, a SQLite file and recorded processor responses. Receipt tests
send generated 1×1 PNGs (`pngBytes`), never real receipts, with the inbox in the same `mkdtemp`
folder.

Store and cycle tests use a real SQLite file in a `mkdtemp` folder under the system temp
directory, removed after each test. The processor is a fake in cycle tests and a recorded
response in contract tests; no test calls a live model.

## Invariants

- The processor never writes. It returns inferences; only this package persists rows
  (R-14 AC1).
- Receipt images live on disk only until they are read (R-8 AC1), under generated names.
- Every assertion goes through `assertionDraftSchema` before it is inserted (§7.2), and the
  ledger is append-only except `status` (R-7 AC3, enforced by triggers).
- The reply is built from the stored row, never from the proposal (R-9 AC1).
- Bot text comes from `strings` in `@anomander/protocol`, except the processor's
  conversational reply (R-16) and the phrased replies that passed the R-21 guard.
