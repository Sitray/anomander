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
    The answer arrives as described below.

## Decisions and corrections

Every incoming message has exactly one destination, decided by code (R-17):

1. **A button press** (`createButtonHandler`, `src/decisions/answer.ts`) carries
   `decision:<id>:<option index>`. A decision that is not `open` or `awaiting_text`, an unknown
   id, malformed data or an option the decision does not have gets S-19 and changes nothing
   (AC1). Otherwise the answer goes to the handler of the proposal's `operation`, from the
   dispatch table (`createDecisionAnswers`, a plain record; add another operation by spreading
   it: `{ ...createDecisionAnswers(deps), keep_receipt: ... }`).
2. **A text** goes through `createTextRouter` (`src/decisions/router.ts`), in this order:
   - a Telegram reply to the message of an `open` or `awaiting_text` decision corrects that
     decision (AC2);
   - otherwise, the decision `awaiting_text` takes it as its correction (AC3);
   - otherwise, the text expense cycle (AC5).

   Only operations listed in `corrections` take text; a reply to any other decision's message
   is an ordinary text.
3. **A photo or an image file** always starts a new receipt and never answers a decision
   (AC4); it does not pass through the router.

A decision `awaiting_text` for 15 minutes is `open` again (AC6). There is no scheduler: the
button handler and the router move stale decisions back to `open` before routing.

`register_expense` (`src/decisions/register-expense-decision.ts`) answers S-3, S-4 and S-6:

- **Apuntar (R-6 AC4).** One transaction: the proposal becomes `executed`, a new action
  `authorized_by 'principal'`, one `confirmed` assertion by the principal (source
  `decision:<id>:<index>`) for each processor inference the expense and its lines still rest on,
  each now `confirmed`, and the expense `current` with mode `confirmed`. The decision is
  `answered`, with the confirmation of the total as `answer_assertion_id`. The reply is S-1
  from the row read back, through the phraser, and its delivery verifies the action (R-9).
- **Descartar (R-6 AC4).** The proposal is `rejected`, the pending expense `refuted` (so no
  current expense remains) and the decision `answered`. The reply is S-23, verbatim, from the
  stored row.
- **Corregir (R-7 AC1).** The reply is S-7, verbatim, and the decision becomes `awaiting_text`
  with `awaiting_since`; any other decision awaiting text goes back to `open` first, so the
  unique index `one_awaiting_text` holds (R-17 AC3).

A correction (`createExpenseCorrection`, `src/decisions/correction.ts`, R-7 AC2) sends the text
and the stored expense to the `CorrectionInterpreter`. A new total is accepted only if it is
written literally (`isLiteralAmount`); a merchant or category only if the principal wrote it
(`writtenIn`), and the category only if it exists. Each accepted value is a `declared`
assertion by the principal whose `supersedes_id` points at the assertion it corrects, which
becomes `refuted`; the expense takes the new value (a corrected category gets `category_basis
'declared'`). The corrected expense is then registered as on "Apuntar", with the first
declaration as `answer_assertion_id`, and the reply is S-8, verbatim, from the row read back
(R-21 AC3). If nothing usable was written, the reply is S-7 again and the decision keeps
waiting.

## The daily AI budget, the queue and retention

**Budget (R-12).** `createAiBudget` (`src/budget/ai-budget.ts`) counts processor calls per day in
`TZ` in the `ai_usage` table (PRD §13), so a restart does not reset it. `ANOMANDER_DAILY_AI_CALL_LIMIT`
is the cap (AC1). `budgeted(complete, budget)` wraps the processor call of the text interpreter,
the correction interpreter and the phraser: past the cap it throws without calling the processor,
and the phraser then sends the §12 string (R-21 AC2, AC4). The interpreters report it as
`budget_exhausted`, and a text or a correction gets S-26 with nothing stored (AC4). A receipt reserves its reader call in
`mayReadNow` instead, so `app.ts` gives the reader the raw call and a refusal can never make a
receipt unreadable.

**Queue (R-8 AC2, R-12 AC2, AC3).** Past the cap a receipt stays `queued` with its images,
`keep_until` is set to 24 hours after `received_at`, and its caption is observed with it. The
principal gets S-10 once that day (`limit_notified`); later receipts that day get no reply (the
`ReceiptHandler` returns `null`). Once the day changes in `TZ`, `createReceiptQueue` reads the
queue in arrival order through the same receipt cycle, against the new day's cap, and sends each
reply with `notify`.

**Unread receipts (R-8 AC3 to AC5).** One hour before `keep_until`, an unread receipt gets S-13 with
"Sí" and "No", once, as a `keep_receipt` proposal and pending decision. "Sí" keeps it until it is
read, at most 7 days after `received_at`, and replies S-24; "No" leaves `keep_until` as it is and
replies S-25. When `keep_until` passes, S-14 is sent, the images are deleted and the document
becomes `discarded` with `image_deleted_at`.

**Retention job (R-19).** `createRetention().retain` expires `current` inferences older than 30
days that no current expense or its purchase lines rest on (AC1), and `open` decisions older than
7 days, rejecting their proposal and refuting a provisional `pending` expense (AC2). It also
handles expired queued receipts (AC3). It only changes `status` columns and deletes temporary
images; a second run changes nothing (AC4).

**Scheduler.** `startScheduler` (`src/scheduler/scheduler.ts`, croner) runs retention, the queue
and the receipt watch once at startup. After that, it runs retention at `ANOMANDER_RETENTION_CRON`
in `TZ`, and the queue and the receipt watch every minute, so S-13's "lo borro en una hora" holds.
The jobs share one serial queue and never overlap. `stop()` waits for the job in progress.

## Failures (R-22)

The principal always gets an answer. `withTimeout` (`src/processor/timeout.ts`) gives every
processor call `ANOMANDER_PROCESSOR_TIMEOUT_SECONDS`: it aborts the call through its `signal` and
rejects even if the provider ignores the signal, so a hung model never blocks later messages
(AC2). In `app.ts` it wraps the raw call first and the budget second. An interpreter that gets a
thrown or failed call returns `failed` (not `invalid`), and the handler replies S-22 verbatim
without storing anything; a failed correction keeps the decision waiting for the text (AC1).
The front door replies S-22 too when a handler throws. A receipt is stored before it is read,
so a failed reading is S-5, as before.

## Conversation memory (R-23)

`src/store/memory.ts` keeps what ANOMANDER remembers about the principal. Each memory is an
assertion about the principal entity with predicate `memory`. Its text and quote live only in
`memory_texts` (migration `0004`), indexed by the FTS5 table `memory_search`, never in
`assertions`: the ledger is append-only, so text there could never be erased.

**Mode (AC2).** `saveMemory` stores `declared` by the principal only when the processor says the
principal said it and the quote is in the message, compared ignoring case and runs of spaces;
otherwise `inferred` by the processor, with its confidence. A fact that `replaces` a current
memory supersedes it and refutes it (AC3); an id that is not a current memory is ignored.

**Prompt (AC4).** `memoriesForPrompt` gives every current memory up to 50, and beyond that the 50
that best match the message in `memory_search`. Each word of the message is quoted, so the
principal's text is never read as FTS5 syntax.

**Forgetting (AC6, AC7).** `forgetMemories` deletes the `memory_texts` rows (the triggers remove
them from the index) and sets the assertions to `expired`, in one transaction. The erase is real:
`openDatabase` turns on `secure_delete`, the index has FTS5 `secure-delete`, and the WAL is
checkpointed and truncated afterwards, so the text is in neither the database file nor its WAL.
The test proves it by reading the raw bytes. Never log a memory's text or quote (AC8).

## The processor ports

`CorrectionInterpreter` (`src/processor/correction-interpreter.ts`) reads a correction text.
`createPiAiCorrectionInterpreter` follows the text interpreter: one system prompt, one user turn
(`expense`, `categories`, `message`), no tools, and inferences `total`, `merchant` and `category`
through `validateProcessorOutput`. Its recorded responses live in
`test/fixtures/correction-interpreter/`.

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
| `ANOMANDER_PROCESSOR_TIMEOUT_SECONDS` | `60` |
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
folder. `test/e2e/telegram-decisions.test.ts` wires the bot and the decision handlers itself,
presses buttons with `updates.callbackQuery` and moves its clock to test the 15 minutes.

Store and cycle tests use a real SQLite file in a `mkdtemp` folder under the system temp
directory, removed after each test. The processor is a fake in cycle tests and a recorded
response in contract tests; no test calls a live model.

The receipt evaluation (`scripts/eval-receipts.ts`, `pnpm eval:receipts`) does call live
models: it measures how well each one reads the receipts in `evals/receipts/cases/`, which stay
out of git. See `evals/receipts/README.md`.

## Invariants

- The processor never writes. It returns inferences; only this package persists rows
  (R-14 AC1).
- Receipt images live on disk only until they are read (R-8 AC1), under generated names.
- Every assertion goes through `assertionDraftSchema` before it is inserted (§7.2), and the
  ledger is append-only except `status` (R-7 AC3, enforced by triggers).
- The reply is built from the stored row, never from the proposal (R-9 AC1).
- Bot text comes from `strings` in `@anomander/protocol`, except the processor's
  conversational reply (R-16) and the phrased replies that passed the R-21 guard.
