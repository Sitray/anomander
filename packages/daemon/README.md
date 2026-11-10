# @anomander/daemon

The runtime of ANOMANDER (PRD §14.3). It opens the SQLite ledger, applies the migrations, runs
the matter cycles and calls the processor. It is the only package that writes rows; the rules
it applies come from `@anomander/core`, and front doors such as `apps/telegram` reach it
through the types of `@anomander/protocol`.

## The text expense cycle

`createTextExpenseHandler` (`src/expenses/text-expense.ts`) is the `TextHandler` for a text the
principal sent, such as `23 € cena`. Each step enforces a PRD rule:

1. **Interpret.** The processor classifies the text as an expense, conversation, a category
   request or a policy (R-17 AC5, see "Categories" and "Policies and patterns" below) and returns
   inferences only.
2. **Conversation.** It gets the processor's reply and nothing is stored (R-16).
3. **Unusable response.** It is logged and answered with S-22, verbatim; nothing is stored
   (R-22 AC1).
4. **Amount.** The inferred `total` is accepted only if the principal wrote it literally, in one
   of the forms `23`, `23,40`, `23.40`, `23€`, `23 €`, `€23` (`isLiteralAmount`, R-2 AC5 and
   AC6). Otherwise the reply is S-16 and nothing is stored.
5. **Date.** Today in `TZ`, unless the processor inferred a named date. A value that is not a
   calendar date is logged and replaced by today; a date after today gets S-21 and nothing is
   stored (R-2 AC7).
6. **Category.** `categorize` (R-5): a category the principal wrote in the text is `declared`,
   then an active policy, then an existing inferred category, else none (R-2 AC3). A declared
   category that does not exist is left out, and S-15 is asked with the reply (R-18 AC3, below).
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
2. **Budget seam.** `mayReadNow` decides whether the receipt is read now: it reserves one call
   of the daily AI budget (R-12). Past the cap the document stays `queued` with its images
   instead (R-8 AC2; see the queue below).
3. **Read.** The images are read back from disk and sent, with the caption, in one call to the
   `ReceiptReader` (R-3 AC4, AC5). Invalid output is unreadable (R-3 AC2).
4. **Delete the images.** Whatever the outcome, the folder is deleted, the document becomes
   `read` or `unreadable` and `image_deleted_at` is set (R-8 AC1).
5. **Unreadable.** The reply is S-5, verbatim, and no expense is stored (R-3 AC3).
6. **Declarations.** A merchant or category the caption states counts as `declared` only if the
   principal actually wrote it there; then it wins over the receipt (R-3 AC5).
7. **Categorize.** `categorize` (R-5): declared, then an active policy, then an existing inferred
   category, else none. A declared category that does not exist is logged and left out; S-15 is
   not asked, because the receipt is only proposed (R-18 AC3 covers expenses registered at once).
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
    (`Apuntar`, `Descartar`), a date after today gets S-33, and a new merchant or an inferred or
    declared category gets S-6 (both `Apuntar`, `Corregir`, `Descartar`). These are sent
    verbatim with their buttons; on delivery the sent message is stored as the decision's
    `channel_ref` (R-17 AC2). The answer arrives as described below.

## Decisions and corrections

Every incoming message has exactly one destination, decided by code (R-17):

1. **A button press** (`createButtonHandler`, `src/decisions/answer.ts`) carries
   `decision:<id>:<option index>`. A decision that is not `open` or `awaiting_text`, an unknown
   id, malformed data or an option the decision does not have gets S-19 and changes nothing
   (AC1). Otherwise the answer goes to the handler of the proposal's `operation`, from the
   dispatch table (`createDecisionAnswers`, a plain record; add another operation by spreading
   it: `{ ...createDecisionAnswers(deps), keep_receipt: ... }`). `app.ts` adds `keep_receipt`
   (R-8), `forget_memory` (R-23 AC6), `create_category` (R-18), `create_policy` (R-13),
   `cancel_reminder` (R-25 AC9) and `grant_morning_digest` (R-26 AC2).
2. **A text** goes through `createTextRouter` (`src/decisions/router.ts`), in this order:
   - a Telegram reply to the message of an `open` or `awaiting_text` decision corrects that
     decision (AC2);
   - otherwise, the decision `awaiting_text` takes it as its correction (AC3);
   - otherwise, the text expense cycle (AC5).

   Only operations listed in `corrections` take text; a reply to any other decision's message
   is an ordinary text.
3. **A photo or an image file** always starts a new receipt and never answers a decision
   (AC4); it does not pass through the router.

A decision `awaiting_text` for 15 minutes is `open` again (AC6). The button handler and the
router move stale decisions back to `open` before routing, and the retention job does too, so a
forgotten decision can still expire (R-19 AC2).

`register_expense` (`src/decisions/register-expense-decision.ts`) answers S-3, S-4, S-6 and S-33:

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
(`writtenIn`), and the category only if it exists. A date, resolved by the processor against
today in `TZ`, only if its quote is in the text (`quotedFrom`) and it is not after today. Each
accepted value is a `declared` assertion by the principal whose `supersedes_id` points at the
assertion it corrects, which becomes `refuted`; the expense takes the new value (a corrected category gets `category_basis
'declared'`). The corrected expense is then registered as on "Apuntar", with the first
declaration as `answer_assertion_id`, and the reply is S-8, verbatim, from the row read back
(R-21 AC3). If nothing usable was written, the reply is S-7 again (S-22 if the processor
failed or gave an answer code cannot use, S-26 past the budget) and the decision is left as it was: one `awaiting_text` keeps
waiting, and one answered by a Telegram reply (such as `vale`) stays `open`, so the next
unrelated text is not taken as its correction. Only "Corregir" makes a decision wait (R-17 AC2).

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
handles expired queued receipts (AC3). A receipt stays `queued` without `keep_until` only while
it is being read, so one left that way by an earlier run (the daemon stopped mid-read) is
abandoned: S-5, then its images are deleted and it becomes `unreadable` with `image_deleted_at`
(AC5). "Earlier run" means its `images_received` observation was created before
`createRetention` was called; `received_at` cannot tell, because a photo sent while the daemon
was down arrives after the restart, possibly while the startup run is going. The startup run
finds them; later runs find none. It only changes `status` columns and deletes temporary
images; a second run changes nothing (AC4).

**Weekly summary (R-10).** `createWeeklySummary().send` (`src/summary/weekly-summary.ts`) covers
the 7 days that end on the day it runs in `TZ` (today and the 6 days before; with the default
Sunday cron, Monday to Sunday). It sums, in SQL, the `current` expenses whose `occurred_on` falls in
those days, per category and without one, and counts every `pending` expense whatever its week
(AC2). `strings.weeklySummary` writes S-9 with every existing category, highest amount first and
ties by name, `0,00 €` when a category had nothing, and `Sin clasificar` always last (AC4). The text
goes out with `notify` exactly as written: no processor call, so it costs no AI budget. It is off
by default: `send` sends nothing unless a `send_weekly_summary` permission is in force (AC5),
which only the principal grants (see the weekly summary capability below).

**Scheduler.** `startScheduler` (`src/scheduler/scheduler.ts`, croner) runs retention, the queue
and the receipt watch once at startup. After that, it runs retention at `ANOMANDER_RETENTION_CRON`
and the weekly summary at `ANOMANDER_WEEKLY_SUMMARY_CRON`, both in `TZ`, and the queue and the
receipt watch every minute, so S-13's "lo borro en una hora" holds. The weekly summary never runs
at startup. The jobs share one serial queue and never overlap. `stop()` waits for the job in
progress.

## Failures (R-22)

The principal always gets an answer. `withTimeout` (`src/processor/timeout.ts`) gives every
processor call `ANOMANDER_PROCESSOR_TIMEOUT_SECONDS`: it aborts the call through its `signal` and
rejects even if the provider ignores the signal, so a hung model never blocks later messages
(AC2). `withRetry` (`src/processor/retry.ts`) retries a call that fails with an error pi-ai's
`isRetryableAssistantError` calls transient, such as a 503 or 429, twice, after 1 s and 2 s;
each retry consumes one more call of the daily budget, and none is made past it (AC3). In
`app.ts` the timeout wraps the raw call first, so each attempt has its own, then the retry,
then the budget. An interpreter that gets a
thrown or failed call returns `failed` (not `invalid`), and the handler replies S-22 verbatim
without storing anything; a failed correction leaves the decision as it was, so one waiting
for the text keeps waiting (AC1).
The front door replies S-22 too when a handler throws. A receipt is stored before it is read,
so a failed reading is S-5, as before.

## Recent turns (R-16 AC3)

So the interpreter understands "ese" or "lo de antes", `src/conversation/recent-turns.ts` keeps the
last 10 exchanges with the principal, none older than 30 minutes, and the text interpreter gets
them as `recent`. `app.ts` records them at the front door: `recordingTurns` wraps the text, receipt
and button handlers (a receipt is `[foto de ticket]` and its caption, a press `[botón: Apuntar]`),
and `recordingNotices` wraps `notify`, so a message sent unasked is a turn with no principal part.
Turns live only in this process: they are never written to the database or logged, and a restart
loses them. They give context only: an expense's amount must still be written in the current message
(R-2 AC6), so a recent turn never becomes an expense fact. `clear()` empties them: `app.ts` hands
it to the `forget_memory` answer, which calls it on `Sí` (R-23 AC6), so the forgotten fact and the
S-29 question that showed it leave the context. The press itself (`[botón: Sí]` and S-30) is then
recorded as the first turn of the emptied window.

## Conversation memory (R-23)

`src/store/memory.ts` keeps what ANOMANDER remembers about the principal. Each memory is an
assertion about the principal entity with predicate `memory`. Its text and quote live only in
`memory_texts` (migration `0004`), indexed by the FTS5 table `memory_search`, never in
`assertions`: the ledger is append-only, so text there could never be erased.

**Mode (AC2).** `saveMemory` stores `declared` by the principal only when the processor says the
principal said it and the quote is in the message, compared ignoring case and runs of spaces;
otherwise `inferred` by the processor, with its confidence. A fact that `replaces` a current
memory supersedes it, refutes it and erases its text the way a forget does (AC3), so no
outdated text is kept; an id that is not a current memory is ignored.

**Prompt (AC4).** `memoriesForPrompt` gives every current memory up to 50, and beyond that the 50
that best match the message in `memory_search`. Each word of the message is quoted, so the
principal's text is never read as FTS5 syntax.

**Capture (AC1).** The text interpreter's envelope, `expense` or `conversation`, may carry
`memories`: facts with `text`, `quote`, `said`, `confidence` and an optional `replaces` id, found
in the same processor call. Zod drops an invalid fact and the log names only its field and issue
code. The text handler saves each fact with `saveMemory` (source: the message's `channelRef`),
for expenses and conversation alike, never for a failed, budget-blocked or invalid message. A
save that fails is logged and the reply stays the same.

**Use (AC4).** The handler puts `memoriesForPrompt` (`id`, `text`, `mode`) in the interpreter's
user turn as `memories`; the prompt allows them only in conversation replies. Code enforces it:
the interpreter rejects any expense inference whose `basis_json.quote` is not in the message,
with the same `quotedFrom` rule as the mode decision, and logs only its predicate.

**Listing (AC5).** When the principal asks what ANOMANDER remembers, the interpreter answers
`{"kind":"memory_list"}` and code replies S-27 from `listMemories`, one line per current memory
with `(me lo dijiste)` for `declared` and `(lo deduje)` for `inferred`, or S-28 when there is none.
The model never words the list, so it is complete whatever the prompt held.

**Asking to forget (AC6).** When the principal asks to forget something, the interpreter answers
`{"kind":"forget","ids":[...]}` with the ids of the matching memories among the `memories` it was
given; code keeps only those ids, once each. The candidates are therefore the prompt's memories:
all of them up to 50, and beyond that the 50 that best match the request's own words, which are
the words of the fact to forget. The text handler keeps the ids that are still current
(`listMemories`) and replies S-32 when none is left; otherwise it opens a `forget_memory` proposal
(`asked`, payload `{"memory_ids":[...]}`, no matter) with a pending decision and asks S-29 with
`Sí` and `No`. The stored `question` is only the S-29 header, so a memory's text is never copied
into `pending_decisions`. A text sent as a reply to S-29 is not a correction: the router has no
correction for `forget_memory`, so it goes to the interpreter (R-17).

**Answering (AC6).** `createForgetMemoryAnswerHandler` (`src/decisions/forget-memory-decision.ts`)
records the answer first. `No` rejects the proposal, erases nothing and replies S-31. `Sí`
executes the proposal with an action authorized by the principal, then calls `forgetMemories`
with the ids (a memory forgotten or replaced since the question is skipped), empties the recent
turns and replies S-30. Listing and forgetting go through the same interpreter call as any text,
so a spent budget gets S-26 and a failed call S-22 (S5).

**Forgetting (AC6, AC7).** `forgetMemories` deletes the `memory_texts` rows (the triggers remove
them from the index) and sets the assertions to `expired`, in one transaction. The erase is real:
`openDatabase` turns on `secure_delete`, the index has FTS5 `secure-delete`, and the WAL is
checkpointed and truncated afterwards, so the text is in neither the database file nor its WAL.
The test proves it by reading the raw bytes. Never log a memory's text or quote (AC8).

## Categories (R-18)

Categories are created only by the principal, after `Sí` to S-15; the processor can never create
one (R-5 AC3).

**Asking for one (AC1).** For a text such as `crea la categoría gasolina`, the interpreter answers
`{"kind":"category","name":"gasolina","reply":"..."}`: the name as the principal wrote it, and S-36
worded in the same call. The text handler accepts the name only if the principal wrote it
(`writtenIn`); otherwise it is logged without the message and answered like any unusable response
(S-22). The name is lowercased (AC2). If the category already exists, it is not proposed again:
the reply is the interpreter's wording of S-36, checked with `checkedPhrasing` (the R-21 AC2 checks
of `src/processor/reply-phraser.ts`, with the name as the fact), or S-36 verbatim. Otherwise
`openCreateCategoryDecision` stores a `create_category` proposal (`asked`, in the "Keep my
expenses" matter, payload `{"name":"gasolina","expense_id":null}`) with a pending decision, and
the reply is S-15 with `Sí` and `No`.

**A stated category that does not exist (AC3).** For `40 € gasolina, categoría gasolina`, the
expense is registered without a category, as before; its declared `category` assertion is stored
anyway. In the same transaction a `create_category` proposal is opened with the expense's id in
`expense_id`. The principal gets one message: S-1 or S-2, then S-15 on the next line, with the S-15
buttons. Only the S-1 or S-2 part is stored as the delivery observation that verifies the expense
(R-9 AC2).

**Answering.** `createCreateCategoryAnswerHandler` (`src/decisions/create-category-decision.ts`)
answers the decision and settles the proposal. `Sí` executes it with an action authorized by the
principal, creates the category (`createCategory` in `src/store/categories.ts`; a name created
meanwhile is reused) and, when `expense_id` is set and the expense still has no category, assigns
it with `category_basis = 'declared'` (`assignDeclaredCategory`); the reply is S-37. `No` rejects
it, creates nothing and replies S-34.

A receipt caption or a correction text that names a category that does not exist does not ask
S-15: the expense is only proposed and answers its own decision first.

## Policies and patterns (R-13)

A policy (`policies`, §13) says which category a merchant always takes; `categorize` (core) uses
the active ones through `listActivePolicies` (R-5 AC1), so a receipt from that merchant that adds
up is registered without asking (R-6 AC1). Policies are declared only by the principal: the
processor and code may only propose one, and it is stored only after `Sí`.

**Stating a rule (AC1).** For `Mercadona es supermercado`, the interpreter answers
`{"kind":"policy","merchant":"Mercadona","category":"supermercado","reply":"..."}`. The text
handler accepts it only if the principal wrote both names (`writtenIn`); otherwise it is logged
without the message and answered with S-22, like any unusable response. A category that does not
exist is asked with S-15 first (R-18; the rule itself is not proposed, so the principal states it
again once the category exists). A rule already active is not asked again: the reply is the
interpreter's wording of S-39, checked with `checkedPhrasing` (merchant and category as the facts),
or S-39 verbatim. Otherwise `openCreatePolicyDecision`
(`src/store/policies.ts`) stores a `create_policy` proposal (`asked`, in the "Keep my expenses"
matter, payload `{"merchant","category","source"}` with the principal's message as `source`) with
a pending decision, and the reply is S-11 with `Sí` and `No`.

**Noticing a pattern (AC2).** Code, never the processor, looks for patterns
(`src/patterns/pattern-offers.ts`), right after a registration that can complete one: a text
expense, `Apuntar` or a correction. `thenOfferPattern` wraps that reply, so once it is delivered,
`findPattern` (`src/store/policies.ts`) checks the expense. An expense counts when it is `current`
and the principal declared its category (`category_basis = 'declared'`: written in the text, a
caption or a correction) or confirmed it (`category_basis = 'inferred'` and `mode = 'confirmed'`:
`Apuntar` on S-6). An inferred category the principal never saw a question about, and a category
from a policy, do not count. There is a pattern when the expense counts, at least 3 counting
expenses share its merchant and category, the merchant has no active policy, and no
`create_policy` decision for the same merchant and category is open or was rejected by the
principal as a pattern. A pattern decision that expired unanswered (R-19) was not rejected, so it
may be offered again. The proposal (basis `{"rule":"R-13 AC2","expense_ids":[...]}`, payload
`source: null`) and its decision are opened in one transaction, and S-12 goes out as its own
message through `notify`, with `{patron}` = `{comercio} siempre es {categoria}` and `Sí` and `No`.
If sending fails, the decision stays open until it expires, so the pattern is not offered twice.

**Answering.** `createCreatePolicyAnswerHandler` (`src/decisions/create-policy-decision.ts`)
answers S-11 and S-12 alike. `Sí` executes the proposal with an action authorized by the principal
and `declarePolicy` stores the rule: a `declared` assertion by the principal (`subject_type
'policy'`, `predicate 'rule'`, the rule as its value; `source` is the principal's message for S-11,
or the pressed button `decision:<id>:0` for S-12), then the `policies` row that points at it. The
assertion answers the decision. An active policy for the same merchant with another category is
revoked (`active = 0`, `revoked_at`) and its declaration refuted and superseded by the new one; the
same rule already active is kept as it is. The reply to `Sí` is S-38 (`policySaved`). `No` rejects the proposal, stores nothing and replies S-35.

## Capabilities (R-24) and reminders (R-25)

A capability (`src/capabilities/capability.ts`) declares its envelope `kinds`, the `prompt`
section it adds to the text interpreter, the Zod `schema` of its call, an optional `context` for
the interpreter's user turn and the `handle` that carries a call out. `src/capabilities/registry.ts`
lists them; `TEXT_INTERPRETER_PROMPT` is `composeTextInterpreterPrompt(CAPABILITIES)`, so adding
one changes no routing code. A call that fails its schema becomes `failed`, which replies S-22
(R-22 AC1). How to add one is in [docs/capabilities.md](../../docs/capabilities.md).

Reminders and tasks (`src/reminders/`) are the first. Their context is the local time in `TZ`
and every pending reminder and task (`id`, `text`, `when`). `reminder_create` stores at once,
without buttons: S-51 for a repetition it cannot keep, S-22 when the text is not quoted from the
message, S-52 for a time already past, otherwise `createReminder` (`src/store/reminders.ts`)
writes the row and its declared `reminder` assertion in one transaction and the reply is S-40, or
S-41 for a task, phrased in the same call and checked by `checkedPhrasing`. `src/reminders/when.ts`
holds the date math in `TZ`: local time to UTC, the next occurrence of a repetition (a monthly
day a month lacks falls on its last day) and `{cuando}`. Never log a reminder's text (AC12).

A `reminder_create` with an `id` gives that pending task a time (AC5): by the same rules (S-51,
S-52), `scheduleTask` sets only `due_at` and `recurrence_json` on the same row, which keeps its
text and assertion, and the reply is S-40; an id that is not a pending task gets S-49. The other
kinds carry ids the processor picked; code keeps only the pending ones (`pendingAmong`).
`reminder_list` is listed by code (AC8): S-44, reminders soonest first then tasks oldest first, as
`listPending` orders them, or S-45. `reminder_done` (AC10) sets each one `done` at once, without
buttons, and replies S-50 with the texts joined, or S-49; the rows are kept. `reminder_cancel`
(AC9) follows the forget pattern: S-49 when nothing matches, otherwise a `cancel_reminder`
proposal (`openCancelReminderDecision`, only the S-46 header stored as the question) asked with
`Sí` and `No`. Its answer (`src/decisions/cancel-reminder-decision.ts`) on `Sí` runs
`cancelReminders` in the answering transaction: each item still pending becomes `cancelled` and its
`reminder` assertion `expired`, then S-47; `No` changes nothing, S-48.

## The morning digest (R-26)

The second capability (`src/digest/capability.ts`) is off by default and has no `context`.
`digest_enable` carries only the time (`HH:mm`, or null for 8:00): code replies S-59 when it is
the time already in force, otherwise opens a `grant_morning_digest` proposal
(`openDigestDecision`, `src/store/digest.ts`) asked with S-53, `Sí` and `No`. Its answer
(`src/decisions/grant-digest-decision.ts`) on `Sí` runs `grantDigestPermission` in the answering
transaction, which revokes any earlier `send_morning_digest` permission and inserts the new one,
then S-54; `No` grants nothing, S-55. ANOMANDER never grants it on its own (§8.1).
`digest_disable` revokes at once, without buttons: S-56, or S-58 when none was in force.

Sending is a scheduler job, `src/digest/send-digest.ts`, run at startup and every minute just
before due reminders. While the permission is in force, once its time has come in `TZ`, it sends
S-57 through `notify` (a recent turn, R-16 AC3), built from the store with no processor call:
today's pending reminders still ahead, every pending task and the count of `pending` expenses.
Empty parts are left out; when all are empty nothing is sent and the day is marked all the same.
A digest more than 10 minutes late (the daemon was down) still goes out before 12:00 in `TZ`, not
after (AC6); one granted after its time today first goes out tomorrow. `digest_sends` holds the
days handled, written only after the send succeeded, so a day never gets two. Logs carry the day
and the reason, never the digest's text (AC7).

## The weekly summary capability (R-10 AC5-AC8)

The third capability (`src/summary/capability.ts`) turns the weekly summary on and off; it has no
`context` and its calls carry nothing. `weekly_summary_enable` replies S-76 when the permission is
already in force, otherwise opens a `grant_weekly_summary` proposal (`openGrantDecision`,
`src/store/permissions.ts`) asked with S-74, `Sí` and `No`; a new S-74 closes an earlier one still
unanswered. Its answer (`src/decisions/grant-weekly-summary-decision.ts`) on `Sí` grants
`send_weekly_summary` with `conditions_json` `{}`, S-75; `No` grants nothing, S-55.
`weekly_summary_disable` revokes at once: S-77, or S-78 when none was in force. The schedule stays
`ANOMANDER_WEEKLY_SUMMARY_CRON`. Its prompt tells the processor that a summary not called weekly
is the morning digest (AC8).

The permission code both capabilities use lives in `src/store/permissions.ts`:
`activePermissions`, `grantPermission` (revokes the earlier ones first), `revokePermissions` and
`openGrantDecision`. A new permission granted by the principal reuses them.

## A single daemon (DK-2)

The desktop app and Docker are two ways to run this daemon, never both at once
(`docs/desktop-prd.md`). `startAnomander` and `startSetupGuide` take the lock of the database
before anything else (`src/store/daemon-lock.ts`): an exclusive SQLite transaction on
`<ANOMANDER_DB_PATH>.lock`, held until `stop` (SQLite keeps a small `.lock-journal` beside it). A second daemon throws
`DaemonAlreadyRunningError` before the store is opened, so the ledger is unchanged (AC1). The
operating system frees the lock when the process ends, so a crash leaves nothing stale.

`Anomander.polling` settles when Telegram polling ends: it resolves after `stop` and rejects
when Telegram ends it, for example with the `409 Conflict` of another process reading the same
bot (`isBotInUse`, AC2). `main.ts` then exits instead of staying up deaf. Its exit code tells
whoever started it why (`exitCodes` in `packages/protocol`):

| Code | Meaning |
| --- | --- |
| `1` | Any other failure: configuration, the store, lost polling |
| `3` | Another daemon runs on the same database |
| `4` | Another process uses the Telegram bot |

## The local channel (DK-3, DK-4)

The desktop app talks to the daemon over a WebSocket (`src/local-channel/`). It starts only
while `ANOMANDER_LOCAL_TOKEN` is set; unset, no port is opened. It always binds to `127.0.0.1`
(DK-3 AC1), on `ANOMANDER_LOCAL_PORT`. `Anomander.localChannel` resolves with the address once
it listens.

The app presents the token as the second WebSocket subprotocol,
`new WebSocket(url, ['anomander.v1', token])`, so it never travels in a URL. It is compared
through SHA-256 digests with `timingSafeEqual`. A connection that does not present exactly the
protocol and the token, plain HTTP included, is closed without a byte (DK-3 AC2). The token is
never logged.

Each message is one JSON text frame, typed in `packages/protocol/src/local-channel.ts`:

| The app sends | The daemon answers |
| --- | --- |
| `text` | `reply` with the same string Telegram would get (DK-4 AC1) |
| `receipt`: one or several images in base64 | `reply`; a PDF, another file type or an image over 20 MB gets R-20's reply, as in Telegram |
| `button`: the `data` of a reply's button | `reply`; S-19 when the decision is no longer open, whichever door closed it (DK-4 AC3) |
| `screen`: a question and one capture of the screen in base64 (DK-9) | `reply` with what the vision processor sees (`src/processor/screen-reader.ts`): no tools, nothing stored, one call against the daily AI limit; an image over 20 MB gets R-20's reply |
| `connect`: a task for the connected MCP servers (DK-11) | `reply` in words that ends the task, or a `reply` that describes one call and carries "Permitir" and "Detener" buttons (`connection:<id>:allow`, `connection:<id>:refuse`). `src/connections/task.ts` decides every call the processor asks for; `mcp-client.ts` makes it. The servers come from `ANOMANDER_MCP_CONFIG` (`config.ts`). At most 8 calls, each processor call against the daily AI limit |
| `computer`: a task, one capture and the steps already done (DK-10) | `reply` whose `computer` is the one action the vision processor proposes (`src/processor/computer-planner.ts`), described by code; or a `reply` in words that ends the task. The daemon never performs anything. At most 12 steps, each one call against the daily AI limit |
| A frame that is none of these | `rejected`, and nothing is done with it |

A `reply` carries its own `channelRef`, `desktop:<uuid>`, which is recorded as the delivery
(R-9 AC2) once the frame left through the socket. The channel only answers: what ANOMANDER
sends unasked goes to Telegram (DK-4 AC5). `/login` and `/logout` are Telegram's alone.

Both doors call the same handlers, `chat` in `src/app.ts`, wrapped by `oneTurnAtATime`: inputs
are handled one after another in the order they arrive, so Telegram and the app share the
recent turns (DK-4 AC4) and two turns never interleave. While no model is usable, the channel
answers everything with the setup guide (R-28).

## The read API (RA-2)

Other applications, first the dashboard of the app of apps, read the ledger over HTTP
(`src/read-api/`, specified in `docs/read-access-prd.md`). `startAnomander` starts it only while
`ANOMANDER_API_TOKEN` is set; unset or empty, no port is opened at all (AC1). The setup guide
never starts it. It binds to `ANOMANDER_API_HOST` (default `127.0.0.1`, AC3) and
`ANOMANDER_API_PORT` (default `4311`); the port variable and its default are a choice of this
build, still to be confirmed in the PRD. `Anomander.readApi` resolves with the address once it
listens; `main.ts` logs it and stops the daemon when the port cannot be opened.

Every request is checked in this order:

1. `Authorization` must be exactly `Bearer <ANOMANDER_API_TOKEN>`, compared through SHA-256
   digests with `timingSafeEqual`, so in constant time whatever its length. Otherwise `401`
   `{"error":"unauthorized"}`, whatever the method or path (AC2).
2. Any method but `GET` gets `405` `{"error":"method not allowed"}` with `Allow: GET` (AC4).
3. The route:

| Request | Answer |
| --- | --- |
| `GET /v1/gastos?desde=YYYY-MM-DD&hasta=YYYY-MM-DD` | array of `gastos` rows, by `fecha` then `id` |
| `GET /v1/lineas?desde=…&hasta=…[&producto=…]` | array of `lineas_de_compra` rows, by `fecha`, `gasto_id`, `producto` |
| `GET /v1/pendientes` | the one `pendientes_de_confirmar` row as an object: `cantidad`, `total_cents` |

Each object's keys are the view's columns (`docs/data-model.md`). `desde` and `hasta` are both
required and both inclusive, calendar days in `TZ`; a missing, malformed or impossible day gets
`400` `{"error":"desde and hasta must both be days as YYYY-MM-DD"}`. `producto` keeps only the
lines whose product equals it exactly, as printed on the receipt (case and accents included);
nothing else is searched. Any other path gets `404`; a failing query gets `500` and logs the
path only. Every answer is JSON with `Cache-Control: no-store`. There is no pagination, CORS or
rate limiting: the API is for the principal's own machines.

The queries live in `src/read-api/queries.ts` (`readGastos`, `readLineas`, `readPendientes`),
the one place a later MCP server reuses (AC6). They read only the views of RA-1, never a table,
through their own connection opened with `readonly: true`, so no reader can write even by
mistake. A new endpoint adds its query there, over a view.

## The processor ports

`CorrectionInterpreter` (`src/processor/correction-interpreter.ts`) reads a correction text.
`createPiAiCorrectionInterpreter` follows the text interpreter: one system prompt, one user turn
(`expense`, `categories`, `today`, `message`), no tools, and inferences `total`, `merchant`,
`category` and `occurred_on`
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
line makes the receipt unreadable (R-3 AC2, R-14 AC2). In every interpreter a rejected item is
logged with only its reason and predicate, never the item itself, which can quote the message,
the receipt or the correction (R-14 AC2).

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

Otherwise, or if the call fails, the §12 string is sent unchanged. S-36, S-39, S-40 and S-41 are
worded by the text interpreter in the call that read the message, and go through the same checks
(`checkedPhrasing`). Every other string (S-17, S-18, S-20...) is sent verbatim and never reaches the processor. The delivery observation
stores the text that was actually sent. `verbatimReplies` skips the processor, for tests.

## Model login (R-27)

A model is reached with an API key in `.env` (for example `ANTHROPIC_API_KEY`) or with the
principal's subscription through a login: ChatGPT (pi-ai provider `openai`) or Kimi Code
(`kimi-coding`). Claude and GitHub Copilot are left out because their providers may suspend
accounts whose subscription is used outside their own apps (R-27 AC1). A stored login takes precedence over that provider's API
key (R-15 AC3).

- **From Telegram.** `/login` replies S-60 with one button per account. Pressing one runs pi-ai's
  `models.login` (`src/auth/telegram-login.ts`) and sends its link as an `Abrir` button: S-62 for
  ChatGPT (paste the address the browser fails to open), S-63 with the device code for Kimi Code.
  The next text the principal sends answers the login,
  is deleted from the chat and is never stored, logged or a recent turn. Success replies S-64;
  failure, or 10 minutes without an answer, S-65. One login runs at a time: a new `/login`
  abandons the running one, with no S-65. `/logout` replies S-66 with one button per connected
  account, or S-68; pressing one deletes it (S-67). These commands, their buttons (`login:<provider>`
  and `logout:<provider>`, apart from `decision:` data) and the awaited text are handled in
  `app.ts` before every other route, so they work when no model is reachable (R-17 AC7).
- **From a terminal on the server.** `pnpm run login [provider]` and `pnpm run logout <provider>`
  (`scripts/login.ts`, `scripts/logout.ts`) do the same and print the link or device code. Plain
  `pnpm login` is pnpm's own npm-registry login, so `run` is needed. Run them from the directory
  the daemon runs in (the repository root, or `/app` in the container:
  `docker compose exec daemon pnpm run login`), so a relative `ANOMANDER_AUTH_PATH` names the same
  file.

The credentials live in the file at `ANOMANDER_AUTH_PATH` (default `./data/auth.json`, in the
data volume in Docker), keyed by provider ID. `src/auth/file-credential-store.ts` is the pi-ai
`CredentialStore` behind `builtinModels({ credentials })`: it reads the file on every request (so a
terminal login is used without a restart), writes it to a temporary file with mode 600 and renames
it over the old one, and serializes writes inside the process. There is no lock across processes:
the rename keeps the file whole, but if the daemon refreshes a token at the very moment a terminal
login writes, one of the two writes is lost and that login has to be repeated. pi-ai refreshes
expired tokens itself. Sign in with ChatGPT also needs a stable installation ID, kept in
`<ANOMANDER_AUTH_PATH>.device-id`. Logs carry the provider ID and the outcome only, never a
token, link or pasted text.

Each provider sets its own terms for using a subscription outside its own apps. Check them before
connecting an account.

## Setup guide (R-28)

The daemon starts as long as `TELEGRAM_BOT_TOKEN` and `ANOMANDER_PRINCIPAL_CHAT_ID` are set;
without them it exits, and the log says where to get each one. Everything else that blocks a
processor call is a gap (`src/setup/setup-guide.ts`), sent as S-70 with one line per gap:

- **Model gaps**, found once in `main.ts` by `resolveModels`: a model variable unset (S-71) or
  naming a model pi-ai does not know (S-72). Only a restart rereads `.env`, so `main.ts` starts
  `startSetupGuide` instead of the daemon: a bot with no store, processor or scheduler that
  answers everything with the guide except `/login` and `/logout`.
- **Connection gaps**, found on every message by `createConnectionGaps` with pi-ai's `checkAuth`:
  a provider of either model with no login and no API key (S-73). The full daemon replies the
  guide instead of calling the processor, so a `/login` completes setup without a restart.

Either way the guide is logged in English and sent once when the bot starts. `/start` replies
S-69 once setup is complete, or the guide; like the login routes, it never reaches the processor
and is never a recent turn (R-17 AC8).

## Running the daemon

`src/main.ts` reads the configuration, resolves `ANOMANDER_MODEL` through pi-ai's
`builtinModels({ credentials })` and calls `startAnomander` (`src/app.ts`), the composition root
that opens the store, builds the text and receipt cycles and starts the Telegram bot with long
polling. `startAnomander` takes the resolved `ANOMANDER_VISION_MODEL` as `visionModel`; without
it, receipts are read with `model`. Model credentials come from a stored login (see "Model login"
above) or from the provider's usual environment variable (for example `OPENAI_API_KEY`), as pi-ai
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
| `ANOMANDER_AUTH_PATH` | `./data/auth.json` |
| `TZ` | `Europe/Madrid` |
| `ANOMANDER_API_TOKEN` | unset: the read API is off (RA-2 AC1) |
| `ANOMANDER_API_HOST` | `127.0.0.1`, an IP address |
| `ANOMANDER_API_PORT` | `4311`, from 1 to 65535 |
| `ANOMANDER_LOCAL_TOKEN` | unset: the local channel is off (DK-3). At least 32 characters |
| `ANOMANDER_LOCAL_PORT` | `4312`, from 1 to 65535 |

The read API's variables come from `docs/read-access-prd.md` §8 until it moves into PRD §14.4;
`.env.example` lists both tables. The local channel's two variables are not in `.env.example`:
the desktop app sets them when it starts the daemon (`docs/desktop-prd.md` §8). Any non-empty token turns the API on, so use a long random
one, for example `openssl rand -hex 32`.

`parseModelId` splits a model ID at its first `/`: `openrouter/anthropic/x` is provider
`openrouter` and model `anthropic/x`.

## Tests

```sh
pnpm vitest run packages/daemon
pnpm -F @anomander/daemon typecheck
```

`test/desktop/` connects a real WebSocket client to the local channel of a started daemon
(`localPort: 0`) and starts two daemons on one database. `test/read-api/` sends real HTTP requests to the read API of a started daemon, which listens
on a free port of `127.0.0.1` (`apiPort: 0`), never on `4311`. `test/e2e/` runs the whole path: the fake Telegram API (`@anomander/telegram/fake-telegram-api`),
the real bot, `startAnomander`, a SQLite file and recorded processor responses. Receipt tests
send generated 1×1 PNGs (`pngBytes`), never real receipts, with the inbox in the same `mkdtemp`
folder. `test/e2e/telegram-decisions.test.ts` wires the bot and the decision handlers itself,
presses buttons with `updates.callbackQuery` and moves its clock to test the 15 minutes.

Store and cycle tests use a real SQLite file in a `mkdtemp` folder under the system temp
directory, removed after each test. The processor is a fake in cycle tests and a recorded
response in contract tests; no test calls a live model.

The receipt evaluation (`scripts/eval-receipts.ts`, `pnpm eval:receipts`) does call live
models: it measures how well each one reads the receipts in `evals/receipts/cases/`, which stay
out of git. See `evals/receipts/README.md`. The text evaluation (`scripts/eval-text.ts`,
`pnpm eval:text`) does the same for messages: it measures whether each model returns the
expected kind and fields for the cases in `evals/text/cases.json`, also out of git. See
`evals/text/README.md`.

## Invariants

- The processor never writes. It returns inferences; only this package persists rows
  (R-14 AC1).
- Receipt images live on disk only until they are read (R-8 AC1), under generated names.
- What the daemon creates on disk is its owner's alone (PRD §16): `openDatabase` creates a
  missing data folder with mode 700 and a missing database file with mode 600 before SQLite
  opens it, and SQLite gives `-wal` and `-shm` the database file's mode; receipt folders are 700
  and images 600; the Dockerfile creates `/app/data` with mode 700. Existing folders and files
  keep their mode, so a database or a Docker volume created before this rule needs a manual
  `chmod`.
- Every assertion goes through `assertionDraftSchema` before it is inserted (§7.2), and the
  ledger is append-only except `status` (R-7 AC3, enforced by triggers).
- The reply is built from the stored row, never from the proposal (R-9 AC1).
- Message, receipt, correction, memory and reminder text is never logged; a rejected processor
  item is logged by its reason and predicate only (R-14 AC2).
- Tokens and what the principal pastes during a login are never logged, stored outside
  `ANOMANDER_AUTH_PATH` or sent to the chat (R-27 AC3, AC5).
- The local channel listens on `127.0.0.1` only and closes, without a byte, any connection
  that does not present the token; the token is never logged (DK-3).
- Readers see only views, through a read-only connection; the read API's token, query strings
  and response bodies are never logged (RA-2 AC2, AC5).
- Bot text comes from `strings` in `@anomander/protocol`, except the processor's
  conversational reply (R-16) and the phrased replies that passed the R-21 guard.
