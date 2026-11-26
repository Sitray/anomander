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
   it: `{ ...createDecisionAnswers(deps), keep_receipt: ... }`). `src/app/handlers.ts` adds `keep_receipt`
   (R-8), `forget_memory` (R-23 AC6), `create_category` (R-18), `create_policy` (R-13),
   `cancel_reminder` (R-25 AC9), `grant_morning_digest` (R-26 AC2) and `forget_history`
   (DK-14 AC4).
2. **A text** goes through `createTextRouter` (`src/decisions/router.ts`), in this order:
   - a Telegram reply to the message of an `open` or `awaiting_text` decision corrects that
     decision, or the one of them that takes text when the message shows two (AC2);
   - otherwise, the decision `awaiting_text` takes it as its correction (AC3);
   - otherwise, the text expense cycle (AC5).

   Only operations listed in `corrections` take text; a reply to any other decision's message
   is an ordinary text.
3. **A photo or an image file** always starts a new receipt and never answers a decision
   (AC4); it does not pass through the router.

A decision `awaiting_text` for 15 minutes is `open` again (AC6). The button handler and the
router move stale decisions back to `open` before routing, and the retention job does too, so a
forgotten decision can still expire (R-19 AC2). A row of "Gastos" applies it before choosing the
question it presses (`rowButton`). The `amend_expense` question a row asks of its own
(`basis_json.rule` `DK-17 AC6`, no `channel_ref`) is shown in no message, so instead of going back
to `open` it is closed, `expired` with its proposal `rejected`, and the row's next press asks a new
one (`reopenStaleAwaiting`, backlog B63).

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
- **Corregir (R-7 AC1).** The reply is S-7, verbatim, with `awaitsText` (the desktop app goes
  back to its chat on it), and the decision becomes `awaiting_text` with `awaiting_since`; any
  other decision awaiting text goes back to `open` first, so the unique index `one_awaiting_text`
  holds (R-17 AC3).

A correction (`createExpenseCorrection`, `src/decisions/correction.ts`, R-7 AC2) sends the text
and the stored expense to the `CorrectionInterpreter`. A new total is accepted only if it is
written literally (`isLiteralAmount`); a merchant or category only if the principal wrote it
(`writtenIn`), and the category only if it exists. A date, resolved by the processor against
today in `TZ`, only if its quote is in the text (`quotedFrom`) and it is not after today. Each
accepted value is a `declared` assertion by the principal whose `supersedes_id` points at the
assertion it corrects, which becomes `refuted`; the expense takes the new value (a corrected category gets `category_basis
'declared'`). The corrected expense is then registered as on "Apuntar", with the first
declaration as `answer_assertion_id`, and the reply is S-8 (S-102 without a merchant), verbatim, from the row read back
(R-21 AC3). If nothing usable was written, the reply is S-7 again (S-22 if the processor
failed or gave an answer code cannot use, S-26 past the budget) and the decision is left as it was: one `awaiting_text` keeps
waiting, and one answered by a Telegram reply (such as `vale`) stays `open`, so the next
unrelated text is not taken as its correction. Only "Corregir" makes a decision wait (R-17 AC2).

`amend_expense` (`src/decisions/amend-expense-decision.ts`, rows in `src/store/amend-expense.ts`)
answers the "Deshacer" and "Corregir" that the text expense cycle puts under S-1 or S-2 (R-7 AC4),
with the S-15 buttons first when S-15 is asked with it:

- **Deshacer (R-7 AC5).** One transaction: the proposal becomes `executed` by an action
  `authorized_by 'principal'`, the expense `refuted` (it leaves `gastos`; nothing is deleted) and
  the decision `answered`. The reply is S-100, or S-101 without a merchant, verbatim, and its
  delivery verifies the action.
- **Corregir (R-7 AC6).** S-7 with `awaitsText` and `awaiting_text`, as for a receipt. The text goes to
  `createAmendExpenseCorrection`, which shares the checks of `createExpenseCorrection`
  (`acceptCorrection`) and writes them with `amendExpense`: the principal's `declared` assertion
  is the one superseded and the inference it stood with is refuted too. The reply is S-8, or
  S-102 without a merchant.
- **Closed (R-7 AC8).** A press or a text for a decision whose expense is no longer current gets
  S-19 and closes it. An answered decision, or one expired by retention (R-19 AC2), gets S-19 as
  any other.
- **Deshacer under a correction (R-7 AC9).** Every correction of a registered expense (after
  "Corregir", typed, from a row of "Gastos", or a Telegram reply to an earlier "Corregido…", also
  one whose "Deshacer" was used while its expense is current: `findUsedCorrectionUndoShownIn`,
  B79) closes
  the expense's open questions and opens a new `amend_expense` question with "Deshacer" alone under
  S-8 or S-102. Its proposal's `payload_json` keeps `restore` beside `expense_id`: the columns the
  correction changed as they were before it, the declarations it wrote, and the assertions it
  refuted with their status (`amendExpense` returns it; no schema change). A `corroborated`
  expense becomes `confirmed` when corrected, and `restore.columns.mode` keeps `corroborated`
  for "Deshacer"; a payload stored before B63 has no `mode` and leaves the mode as it is.
  `restore.after` keeps the values the correction left in those same columns (B79):
  `correctionStands` refuses (S-19) when a declaration no longer stands or one of those columns,
  `mode` included, changed since; a payload stored before B79 has no `after` and is checked by its
  declarations only. "Deshacer" runs
  `undoCorrection` in one transaction: the columns take their old values, the declarations are
  `refuted`, the refuted assertions take back their status, and the proposal is `executed` by the
  principal. The expense stays current; the reply is S-105, or S-106 without a merchant. A newer
  correction closes the older one's question, so only the newest is undone (S-19 otherwise).
  "Deshacer" also withdraws the S-12 the correction led to (`withdrawPatternOffersLedBy`, B79):
  `thenOfferPattern` after a correction records the "Deshacer" proposal in the offer's
  `basis_json` as `led_by_proposal_id`, and only the open offer naming it becomes `expired`, its
  proposal `rejected`. An offer without it is never withdrawn. A
  row's "Deshacer" never presses this question (`openAmendDecisionOf` skips it): it takes the
  expense out, as before.

A correction typed without the button (R-7 AC7) is the interpreter's `expense_correct` kind. The
text expense cycle gives the interpreter `expenses`: the current expenses registered in the last
30 minutes, at most 5, newest first (`recentExpenses`). The interpreter keeps an `expense_id` only
if it was given and each value only if its quote is in the message; the cycle then applies
`acceptCorrection` and `amendExpense` with a new `amend_expense` proposal `executed`, and closes the
expense's open decision (`closeAmendDecisions`, `expired`), so its buttons get S-19. No expense
given gets S-104, no clear id S-103, no usable value S-7.

## The daily AI budget, the queue and retention

**Budget (R-12).** `createAiBudget` (`src/budget/ai-budget.ts`) counts processor calls per day in
`TZ` in the `ai_usage` table (PRD §13), so a restart does not reset it. `ANOMANDER_DAILY_AI_CALL_LIMIT`
is the cap (AC1). `budgeted(complete, budget)` wraps the processor call of the text interpreter,
the correction interpreter and the phraser: past the cap it throws without calling the processor,
and the phraser then sends the §12 string (R-21 AC2, AC4). The interpreters report it as
`budget_exhausted`, and a text or a correction gets S-26 with nothing stored (AC4). A receipt reserves its reader call in
`mayReadNow` instead, so `src/app/handlers.ts` gives the reader the raw call and a refusal can never make a
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
finds them; later runs find none. When S-5 or S-14 cannot be sent (no Telegram, or a failed
send) the receipt stays as it is and the failure is logged once per receipt, not every minute.
It erases the `action_history` rows that ended more than 30 days ago with
`forgetActionsEndedBefore`, as long as an inference is kept (AC6, security audit L3), and the
messages of the stored conversation sent more than 90 days ago with `forgetConversationBefore`
(desktop PRD DK-16). Apart from those erases it only changes `status` columns and deletes temporary images; a second run changes
nothing (AC4).

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
and the receipt watch once at startup. After that, it runs retention at `ANOMANDER_RETENTION_CRON`,
followed by the daily backup (see "Migrations and backups" below), and the weekly summary at `ANOMANDER_WEEKLY_SUMMARY_CRON`, both in `TZ`, and the queue and the
receipt watch every minute, so S-13's "lo borro en una hora" holds. The weekly summary never runs
at startup. The jobs share one serial queue and never overlap. `stop()` waits for the job in
progress; `halt()` only keeps every queued job from starting. When the desktop app connects, the
morning digest, the due reminders and the queue also run, through the same chain
(`src/app/jobs.ts`); a job that already waits for its turn is not queued again, so a burst of
reconnections queues each one once (B69).

**Stopping.** `Anomander.stop` first refuses every new turn (a turn that waited gets the error
`ANOMANDER is stopping`; only the turn that tells how a running task with connections ended
still runs), stops the doors and the jobs (a job still queued, scheduled or asked for by the
app's connection, never starts), and waits for the turns and task steps in progress, up to
`SHUTDOWN_DEADLINE_MS` (5 s; `shutdownDeadlineMs` in tests), with `Promise.allSettled`. Past the
deadline it logs a warning. The job in progress is waited for however long it takes, so it never
runs on a closed store (B69); when it is still running past the deadline the stop says so once,
naming only its kind (`anomander is still waiting for a job before it stops`, `{ job:
'drainQueue' }`), and keeps waiting (B82). Only then does it close the connections, the read API and the
store; a step that failed is thrown after everything closed. `Anomander.halt` is that first,
synchronous part alone: `main.ts` calls it when it fails or crashes, so no new event is handled
while the last log line drains (B51). Once closed, the turns refuse at once every turn that
waits, with `TurnNotStartedError` (its `code` is `TURN_NOT_STARTED` of `@anomander/telegram`).
`halt` stops the bot with `haltTelegramBot` rather than `bot.stop()`: every update the bot began
to handle stays acknowledged, the one still running included, so nothing that ran comes again;
only a text or a receipt refused with `TURN_NOT_STARTED`, and what was read after the halt, get
no reply and are not acknowledged, so Telegram hands them over again once the daemon is back
(B82). A failed turn, an album and a button press are answered with S-22 as before. `stop`
keeps `bot.stop()`, which answers a refused text with S-22 and acknowledges it.

## Failures (R-22)

The principal always gets an answer. `withTimeout` (`src/processor/timeout.ts`) gives every
processor call `ANOMANDER_PROCESSOR_TIMEOUT_SECONDS`: it aborts the call through its `signal` and
rejects even if the provider ignores the signal, so a hung model never blocks later messages
(AC2). `withRetry` (`src/processor/retry.ts`) retries a call that fails with an error pi-ai's
`isRetryableAssistantError` calls transient, such as a 503 or 429, twice, after 1 s and 2 s;
each retry consumes one more call of the daily budget, and none is made past it (AC3). In
`src/app/handlers.ts` the timeout wraps the raw call first, so each attempt has its own, then the retry,
then the budget. An interpreter that gets a
thrown or failed call returns `failed` (not `invalid`), and the handler replies S-22 verbatim
without storing anything; a failed correction leaves the decision as it was, so one waiting
for the text keeps waiting (AC1).
The front door replies S-22 too when a handler throws. A receipt is stored before it is read,
so a failed reading is S-5, as before.

## Recent turns (R-16 AC3)

So the interpreter understands "ese" or "lo de antes", the text interpreter gets the last 10
exchanges with the principal, none older than 30 minutes, as `recent`. `src/app/chat.ts` records them at the
front door, with the door they went through: `recordingTurns` wraps the text, receipt and button
handlers (a receipt is `[foto de ticket]` and its caption, a press `[botón: Apuntar]`), and
`recordingNotices` wraps `notify`, so a message sent unasked, once delivered, is a turn with no
principal part; a send that fails or delivers nothing stores nothing. A text the interpreter routes
to a task with connections is stored once, with its announcement; the task's answer follows with
no `[conexiones]` line (`connectionSession.run(task, door, true)`). A login's messages (R-17 AC7)
go around both, so a pasted code is never a turn, from either door: the app's chat hands its text
to `login.takePasted` first.

`src/conversation/recent-turns.ts` keeps them in the local database (desktop PRD DK-16, table
`conversation`, `src/store/conversation.ts`): one row per message, the principal's and the reply,
with the reply's buttons and, once delivered, its `channelRef`, so a press on a stored button still
resolves. The turns therefore survive a restart, and the local channel answers the app's `history`
request with the latest messages (at most `HISTORY_LIMIT`, 500). Nothing here is logged; a failure
to store a turn is logged without its words and never changes the reply. They give context only: an
expense's amount must still be written in the current message (R-2 AC6), so a recent turn never
becomes an expense fact.

`clear()` erases the stored conversation for real (`secure_delete`, then a truncating WAL
checkpoint): the app's `clear_history` ("Borrar conversación"), run in the chat's turn so a turn
that runs is stored before the erase and never after it, the `forget_memory` answer on `Sí`
(R-23 AC6) and the `forget_history` answer on `Sí` (DK-14 AC4) call it, so the forgotten fact and
the S-29 question that showed it leave the context and the database. The press itself
(`[botón: Sí]` and S-30, which names no fact) is then stored as the first turn after the erase. A
replaced memory erases only the turns where the principal said it, matched as whole words
(`forgetTurnsHolding`, see Conversation memory). The retention job erases messages older
than 90 days.

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
on `Sí` first calls `forgetMemories` with the ids (a memory forgotten or replaced since the
question is skipped) and empties the stored conversation and the recent turns, then records the
answer: an erase that fails leaves the question open, so `Sí` can be pressed again. `No` rejects
the proposal, erases nothing and replies S-31. `Sí` executes the proposal with an action
authorized by the principal and replies S-30. Listing and forgetting go through the same
interpreter call as any text, so a spent budget gets S-26 and a failed call S-22 (S5).

**Forgetting (AC6, AC7).** `forgetMemories` deletes the `memory_texts` rows (the triggers remove
them from the index) and sets the assertions to `expired`, in one transaction. A replacement
(`saveMemory` with `replaces`) also erases the turns of the stored conversation where the principal
said it, matched as whole words ignoring case, spacing and accents (so "sí" is not in "así" nor
"23" in "123"): the old quote in a principal's own message, never a marker line such as
`[botón: Sí]`, and the old text in any message. A matched message takes its turn, the
principal's message and its reply, with it (`forgetTurnsHolding`); the rest of the conversation
stays. The erase is real:
`openDatabase` turns on `secure_delete`, the index has FTS5 `secure-delete`, and the WAL is
checkpointed and truncated afterwards, so the text is in neither the database file nor its WAL.
The test proves it by reading the raw bytes. Never log a memory's text or quote (AC8).

## Memories in every way, and the history of what ANOMANDER did (DK-14)

**Memories (AC1).** `memoryNotesFor` (`src/store/memory.ts`) is `memoriesForPrompt` of the
question or the task, as `{text, mode}` without ids. `src/app/app-tasks.ts` hands it to the screen reader and to
every step of the computer planner; each puts it in its user turn as `memories` (their text part
is now a JSON object) and its prompt calls them facts about the principal, never instructions.
A task with connections gets none: its read-only calls run unasked towards third parties.

**History (AC2, AC5).** `src/store/history.ts` keeps `action_history` (migration `0008`): one
row per look at the screen, task on the computer or task with connections, written by `keep` in
`src/app/app-tasks.ts` when it ends. A row holds `kind`, `door`, the principal's words (`task`), `outcome` (the
reading's kind; `done`, `cannot`, `too_many_steps` or the plan's kind; the task outcome's kind or
`replaced`), `steps` for the computer and `calls_json` for connections. The calls come from the
`decided` hook of `createConnectionTasks`: `{server, tool, allowed}` when code sends a call or
the principal refuses it; never arguments or results. A failure to keep a row is logged with
its kind and reason only. The retention job erases a row 30 days after it ended (PRD R-19 AC6).

**Prompt (AC3).** The text handler puts `historyForPrompt` in the interpreter's user turn as
`history`: at most 20 rows (`HISTORY_PROMPT_LIMIT`), none older than 7 days
(`HISTORY_PROMPT_DAYS`), oldest first, with `when` in `TZ` (`YYYY-MM-DD HH:mm`). The quote rule of
R-23 AC4 keeps it out of every expense fact.

**Erasing (AC4).** `{"kind":"forget_history"}` makes the text handler open a `forget_history`
proposal (payload `{"up_to_id": <the latest row>}`) and ask with `Sí` and `No`, or reply that
there is nothing when the table is empty. `createForgetHistoryAnswerHandler`
(`src/decisions/forget-history-decision.ts`) records the answer, and on `Sí` deletes the rows up
to that id with `forgetHistory`, which checkpoints and truncates the WAL, and empties the recent
turns.

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
lists them; `textInterpreterPrompt()` is `composeTextInterpreterPrompt(CAPABILITIES)`, so adding
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
operating system frees the lock when the process ends, so a crash leaves nothing stale. An
in-memory store (`ANOMANDER_DB_PATH=:memory:`) takes no lock: it belongs to its process alone, and
no `:memory:.lock` lands in the current folder (B80). When the store cannot be opened, `main.ts`
says why (`could not open the store: EACCES: permission denied`) without its path (B80).

`Anomander.polling` settles when Telegram polling ends: it resolves after `stop` and rejects
when Telegram ends it, for example with the `409 Conflict` of another process reading the same
bot (`isBotInUse`, AC2). `main.ts` then exits instead of staying up deaf. Its exit code tells
whoever started it why (`exitCodes` in `packages/protocol`). It exits once the line that says
why is written, up to 5 s (`exitOnceWritten` in `src/crash.ts`), as a crash does, so a pipe on
macOS keeps it (B51):

| Code | Meaning |
| --- | --- |
| `1` | Any other failure: configuration, the store, lost polling |
| `3` | Another daemon runs on the same database |
| `4` | Another process uses the Telegram bot |

## Importing a ledger (DK-12)

`importLedger` (`src/store/import-ledger.ts`), run by the desktop app as
`node scripts/import-ledger.ts <source> <own>`, makes a ledger brought from a Docker install the
app's own. It prints one word and ends with 0: `imported`, or why nothing changed (`missing`,
`same_file`, `daemon_running`, `own_has_expenses`, `not_a_ledger`, `newer_ledger`, `damaged`). An
error ends with 1 and prints only its code.

- The source is never opened by SQLite: its bytes, and its `-wal`, are copied beside `<own>` and
  only the copy is checked (`schema_migrations` with versions all known to this build,
  `integrity_check`) and has its journal folded in.
- It takes the daemon's lock (DK-2) on `<own>` for the whole import, and refuses while a daemon
  holds it.
- `<own>` is replaced only while it holds no expense. It is moved aside, with its journal files,
  as `<own>.before-import-<yyyymmdd-hhmmss>` (UTC), never deleted, and the copy (mode 600) takes
  its place. The daemon migrates it at its next start.

## The local channel (DK-3, DK-4)

The desktop app talks to the daemon over a WebSocket (`src/local-channel/`). It starts only
while `ANOMANDER_LOCAL_TOKEN` is set (the app hands it over on stdin, see "Configuration");
unset, no port is opened. It always binds to `127.0.0.1`
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
| `text` | `reply` with the same string Telegram would get (DK-4 AC1); `done` with `taken: 'login'` when a login waiting for a pasted code or address took it (DK-4 AC7, B81) |
| `receipt`: one or several images in base64 | `reply`; a PDF, another file type or an image over 20 MB gets R-20's reply, as in Telegram |
| `button`: the `data` of a reply's button | `reply`; S-19 when the decision is no longer open, whichever door closed it (DK-4 AC3) |
| `screen`: a question and one capture of the screen in base64 (DK-9) | `reply` with what the vision processor sees (`src/processor/screen-reader.ts`): no tools, nothing stored but its question in the history (DK-14), one call against the daily AI limit; an image over 20 MB gets R-20's reply |
| `connect`: a task for the connected MCP servers (DK-11) | `reply` in words that ends the task, or a `reply` that describes one call and carries "Permitir" and "Detener" buttons (`connection:<id>:allow`, `connection:<id>:refuse`), and "Permitir siempre" between them when it can be granted (`connection:<id>:always`, DK-24). Its text says the call in one plain line above the exact JSON of its arguments. `src/connections/task.ts` decides every call the processor asks for; `mcp-client.ts` makes it. The servers come from `ANOMANDER_MCP_CONFIG` (`config.ts`). At most 8 calls, each processor call against the daily AI limit |
| `computer`: a task, one capture and the steps already done (DK-10) | `reply` whose `computer` is the one action the vision processor proposes (`src/processor/computer-planner.ts`), described by code; or a `reply` in words that ends the task. The daemon never performs anything. At most 12 steps, each one call against the daily AI limit |
| `history`, with an optional `limit` (DK-16) | `history` with the stored conversation of both doors, oldest first: the latest `limit` messages, at most 500 (`HISTORY_LIMIT`). Each has its id, `from`, `door`, text, buttons and the reply's `channelRef`; a `reply` with S-22 when it cannot be read |
| `clear_history` (DK-16) | `done` once the stored conversation and the recent turns are erased for real; a `reply` with S-22 when they cannot be |
| `cancel`: the `target` id of a `text`, `screen` or `connect` request still owed (DK-19) | `done` at once, outside the chat's turn. That turn's processor call is aborted (`src/processor/cancel.ts`), none starts after it, and a task with connections stops before its next step; what was written stays. The target's own answer then says S-130 when a call was stopped |
| `connection_grants` (DK-24) | `connection_grants` with the "Permitir siempre" in force, by server and then tool: each with its id, `server`, `tool` and `at`. Never a call's arguments |
| `revoke_connection_grant`, with its `grantId` (DK-24) | `done` once it is revoked ("Quitar"); one not in force changes nothing |
| A frame that is none of these | `rejected`, and nothing is done with it |

While a task with connections calls a tool for a request still owed, the daemon may send
`progress` (`of`: that request's id; `phase`: `web_search` or `connection`), never an answer
itself (DK-19).

While a login started in Telegram waits for a pasted code or address, the daemon tells every
open connection, and one that opens meanwhile, with `login_waiting` (`waiting: true`), and again
with `waiting: false` once it no longer waits (`src/app/login-waits.ts` watches the login's
prompts, never what is pasted). The window masks a text it sent meanwhile whose answer never came
(B81, desktop PRD DK-4 AC7).

A `reply` carries its own `channelRef`, `desktop:<uuid>`, which is recorded as the delivery
(R-9 AC2) once the frame left through the socket. The channel only answers: what ANOMANDER
sends unasked goes to Telegram (DK-4 AC5), and the app sees it in the stored conversation. `/login`, `/logout` and `/exportar` are Telegram's alone (`/exportar` replies S-81 in the app).

Both doors call the same handlers, `chat` in `src/app/chat.ts`, wrapped by `oneTurnAtATime` (`src/app/turns.ts`): inputs
are handled one after another in the order they arrive, so Telegram and the app share the
recent turns (DK-4 AC4) and two turns never interleave. While no model is usable, the channel
answers everything with the setup guide (R-28).

### A task with connections, from either door (DK-11)

A task is asked with `connect` in the app, or with `/mcp <tarea>` in Telegram (`/mcp` alone
answers how to ask). A call that needs permission is asked at the door the task came from, with
"Permitir" and "Detener", and only a press at that door answers it: the same press at the other
door answers "Esa petición ya no está pendiente." and runs nothing.

"Permitir siempre" (DK-24) makes that call and stores a `call_connection_tool` permission for
that tool of that server (`src/store/permissions.ts`), once the call is found waiting: its name
and `serverIdentity`, a digest of its command, arguments and `env` as written in `mcp.json` (a
Keychain value only as `@keychain`), or of its URL (`src/connections/config.ts`). `task.ts` checks it before
skipping the question, as for a read-only tool, so DK-11 AC4 and T17's argument rules still ask.
At its start the daemon revokes the grants of a server removed, renamed or changed in `mcp.json`.

A task does not hold the chat's turn while it waits for a server or the processor
(`createConnectionSession` in `src/connections/session.ts`, given the chat's turn lock by
`src/app/chat.ts`): each step, its start or one answered call, begins in a turn, runs outside it, and
what it came to is said in a turn again, where its end becomes a recent turn. A text, a receipt or a button is answered meanwhile. There is one task at a time: while a
step runs, another task is refused with "Todavía estoy con la tarea anterior. Pídeme otra cuando
termine." and a press answers nothing; a task asked while one waits for the principal ends that
one, as before. In the app the `reply` to `connect` (or to the press) arrives when the step is
over. In Telegram the handler returns at once and the reply is sent when the step is over, cut
to 4 096 characters, the most one Telegram message holds.

The text interpreter is told the connected tools in `connected` (`known()` of
`src/connections/mcp-client.ts`, which never connects a server: one not connected yet gives only
its `readOnly` tools, without a purpose). Each purpose is the server's own first sentence, without
what cannot be seen, cut to 120 characters, at most 40 tools, in the user turn as data. A lookup
on the internet goes to `connect` when a tool can search and is never routed to the computer;
with none the interpreter answers `no_web_search` and code says how to add the web search
connection (`WEB_SEARCH_CONNECTION` of `packages/protocol`, DK-11 AC11, DK-13 AC5).

A connection may name, by tool, arguments that make a read-only call ask (`asksWith` of
`Connection`). `argumentsThatAsk` in `mcp-client.ts` gives any program running `pi-web-access`
the preset's: `fetch_content` always asks, and `web_search` asks with `provider`, `proxy` or
`includeContent`. `mcp.json` has no key for them: the app checks its keys as the daemon reads them.

### Servers connected with OAuth (DK-11 AC10)

`scripts/mcp-oauth.ts <url>` (run by the desktop app, never by the daemon) connects the app to a
server that asks for OAuth: `src/connections/oauth-login.ts` has the SDK find its authorization
server, register the app (a public client, `token_endpoint_auth_method: none`) and run the code
flow with PKCE. It listens on a free port of `127.0.0.1` for the redirect, takes it only with the
`state` it sent, and gives up after 5 minutes. It prints `anomander oauth-open <address>`, then
`anomander oauth-done <json>` with the client and tokens, then `connected`, `denied` or
`timed_out`; an error prints only its code.

The daemon gets the set in `ANOMANDER_MCP_OAUTH`, on its stdin from the app (`src/connections/oauth.ts`) and connects such a
server through the SDK's `authProvider`. A token refresh prints the whole set on one line,
`anomander mcp-oauth <json>`, for the app to store; a refused refresh drops the server's tokens,
and the server is left out. Tokens go to a server only at the URL the app kept with them. The daemon never opens a browser or registers a client. A server's
configured headers are sent only to its own origin (`originScopedFetch`): the SDK sends its OAuth
requests through the same fetch.

## The read API (RA-2)

Other applications, first the dashboard of the app of apps, read the ledger over HTTP
(`src/read-api/`, specified in `docs/read-access-prd.md`). `startAnomander` starts it only while
`ANOMANDER_API_TOKEN` is set; unset or empty, no port is opened at all (AC1). The setup guide
never starts it. It binds to `ANOMANDER_API_HOST` (default `127.0.0.1`, AC3) and
`ANOMANDER_API_PORT` (default `4311`); the port variable and its default are a choice of this
build, still to be confirmed in the PRD. `Anomander.readApi` resolves with the address once it
listens; `main.ts` logs it and stops the daemon when the port cannot be opened. `loadConfig`
refuses a token under 32 characters, and, while the token is set, a host outside `127.0.0.0/8`
and `::1` unless `ANOMANDER_API_ALLOW_PLAIN_HTTP=1`: the API speaks plain HTTP only, so the
token would travel readable (security audit M4).

Every request is checked in this order:

1. An address that sent `AUTH_FAILURES_ALLOWED` (10) wrong tokens within
   `AUTH_FAILURE_WINDOW_MS` (60 s) of its first one gets `429` `{"error":"too many failed
   attempts"}` with `Retry-After` in seconds, even with the right token, until that window has
   passed (`src/read-api/auth-backoff.ts`, security audit M4). Its address is logged once, when
   it is refused; at most 1024 addresses are remembered.
2. `Authorization` must be exactly `Bearer <ANOMANDER_API_TOKEN>`, compared through SHA-256
   digests with `timingSafeEqual`, so in constant time whatever its length. Otherwise `401`
   `{"error":"unauthorized"}`, whatever the method or path (AC2), and one more failure for the
   address. A right token clears its failures.
3. Any method but `GET` gets `405` `{"error":"method not allowed"}` with `Allow: GET` (AC4).
4. The route:

| Request | Answer |
| --- | --- |
| `GET /v1/gastos?desde=YYYY-MM-DD&hasta=YYYY-MM-DD` | array of `gastos` rows, by `fecha` then `id` |
| `GET /v1/lineas?desde=…&hasta=…[&producto=…]` | array of `lineas_de_compra` rows, by `fecha`, `gasto_id`, `producto` |
| `GET /v1/pendientes` | the one `pendientes_de_confirmar` row as an object: `cantidad`, `total_cents`, `moneda` and `por_moneda` as an array |

Each object's keys are the view's columns (`docs/data-model.md`). Every `gastos` and
`lineas_de_compra` row says its currency in `moneda`; with pending expenses in several
currencies, `total_cents` and `moneda` of `/v1/pendientes` are `null` and `por_moneda` has each
currency's count and total, never a sum across currencies (B71). `desde` and `hasta` are both
required and both inclusive, calendar days in `TZ`; a missing, malformed or impossible day gets
`400` `{"error":"desde and hasta must both be days as YYYY-MM-DD"}`. `producto` keeps only the
lines whose product equals it exactly, as printed on the receipt (case and accents included);
nothing else is searched. Any other path gets `404`; a failing query gets `500` and logs the
path only. Every answer is JSON with `Cache-Control: no-store`. There is no pagination, CORS or
rate limiting beyond the back-off above: the API is for the principal's own machines.

The queries live in `src/read-api/queries.ts` (`readGastos`, `readLineas`, `readPendientes`),
the one place a later MCP server reuses (AC6). They read only the views of RA-1, never a table,
through their own connection opened with `readonly: true`, so no reader can write even by
mistake. A new endpoint adds its query there, over a view.

## The processor ports

`CorrectionInterpreter` (`src/processor/correction-interpreter.ts`) reads a correction text.
`createPiAiCorrectionInterpreter` follows the text interpreter: one system prompt, one user turn
(`expense`, `categories`, `today`, `weekday`, `message`), no tools, and inferences `total`, `merchant`,
`category` and `occurred_on`
through `validateProcessorOutput`. Its recorded responses live in
`test/fixtures/correction-interpreter/`.

`TextInterpreter` (`src/processor/text-interpreter.ts`) is the port the cycle depends on.
`createPiAiTextInterpreter` implements it with `@earendil-works/pi-ai`: one system prompt and
one user turn, never a `tools` key (R-14 AC3). It parses a single JSON object from the text
blocks (code fences allowed), validates its envelope with Zod, and passes each inference
through `validateProcessorOutput`, so anything claiming `observed`, `declared` or `confirmed`
is rejected and logged (R-14 AC2). Its user turn starts with `today` (`YYYY-MM-DD` in `TZ`) and
`weekday`, today's English weekday (`weekdayOf` in `@anomander/core`), so "el lunes" or "la
semana pasada" never depend on the model working out the weekday (B59). Amounts are asked for
as hundredths of the principal's currency, `euro cents` with `EUR` (`src/processor/currency.ts`,
B73), in this prompt as in the receipt reader's and the correction interpreter's.

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
  `app.ts` before every other route, so they work when no model is reachable (R-17 AC7). While a
  login waits, a text sent in the desktop app's chat goes to it too (`takePasted`), answered
  `done` with `taken: 'login'`, the only answer that carries it, so the window masks it (B81);
  the app never takes `/login` or `/logout` (desktop PRD DK-4 AC7).
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

Under the desktop app (DK-5 AC1) there is no such file: the app hands the login over as
`ANOMANDER_AUTH_JSON` (the same shape) on the daemon's stdin (DK-5 AC2), and `src/auth/shell-credential-store.ts` keeps it in
memory. After every change it prints the whole set on one line,
`anomander credentials <json>`, before the change answers; the app stores it in the Keychain and
never forwards that line. `credentialStoreFor` picks the store: the app's when the variable is
set, the file otherwise. The device ID file stays where it was.

Each provider sets its own terms for using a subscription outside its own apps. Check them before
connecting an account.

## Setup guide (R-28)

The daemon starts as long as it has a front door: Telegram (`TELEGRAM_BOT_TOKEN` with
`ANOMANDER_PRINCIPAL_CHAT_ID`), the desktop app's local channel (`ANOMANDER_LOCAL_TOKEN`), or
both. Without either it exits, and the log names both and where to get the Telegram ones; half of
Telegram is an error that names the missing variable. Everything else that blocks a processor
call is a gap (`src/setup/setup-guide.ts`), sent as S-70 with one line per gap:

- **Model gaps**, found once in `main.ts` by `resolveModels`: a model variable unset (S-71) or
  naming a model pi-ai does not know (S-72). Only a restart rereads `.env`, so `main.ts` starts
  `startSetupGuide` instead of the daemon: a bot with no store, processor or scheduler that
  answers everything with the guide except `/login` and `/logout`.
- **Connection gaps**, found on every message by `createConnectionGaps` with pi-ai's `checkAuth`:
  a provider of either model with no login and no API key (S-73). The full daemon replies the
  guide instead of calling the processor, so a `/login` completes setup without a restart.
  `startAnomander` wraps the check in `cachedSetupGaps`: it runs before the message's turn, so a
  slow provider never holds the chat; messages that arrive meanwhile share one check and keep
  their order; a check that takes over 5 s is given up and counts as complete (logged); and a
  complete setup is kept 30 s. A gap is checked again on every message.

Either way the guide is logged in English and sent once when the bot starts; without Telegram it
is only logged, and the app's chat answers every message with it. `/start` replies
S-69 once setup is complete, or the guide; like the login routes, it never reaches the processor
and is never a recent turn (R-17 AC8).

## Running the daemon

`src/main.ts` reads the configuration, resolves `ANOMANDER_MODEL` through pi-ai's
`builtinModels({ credentials })` and calls `startAnomander` (`src/app.ts`), the composition root
that opens the store, builds the text and receipt cycles (its parts live under `src/app/`) and starts the Telegram bot with long
polling, while Telegram is configured.

**Without Telegram** (`src/telegram-door.ts`) `@anomander/telegram` is never imported: nothing
polls Telegram or is sent there, `started` resolves once the store is ready and `polling` only at
`stop`. What only Telegram serves is absent: `/login` and `/logout` (the app logs in from its
Suscripciones screen), `/mcp`, `/exportar`, and the setup guide sent at start. The local channel only answers
(DK-4 AC5), so the messages sent unasked have no door: the due reminders, the morning digest and
the weekly summary are not run (a reminder then goes out late once Telegram is set up), nor is
the budget queue: a queued receipt stays queued, unread, since its reply could not be told
(R-8 AC5 still holds: it is never deleted unread without telling). The rest (S-12, S-13, S-14)
fail as a failed send does and are logged, S-14 once per receipt. `startAnomander` takes the resolved `ANOMANDER_VISION_MODEL` as `visionModel`; without
it, receipts are read with `model`. Model credentials come from a stored login (see "Model login"
above) or from the provider's usual environment variable (for example `OPENAI_API_KEY`), as pi-ai
resolves them; under the desktop app that variable is the one handed over on stdin, which
`handedAuthContext` (`src/supervised.ts`) gives pi-ai before the environment.

**Migrations and backups.** At start `applyMigrations` (`src/store/database.ts`) applies the
`migrations/*.sql` files not yet recorded in `schema_migrations`, each in its own transaction. A
database that records a version this build does not know is refused, with both version numbers in
the error, and left untouched. When migrations are pending on a database that already holds some, it
is first copied with `VACUUM INTO` beside its file as `<db>.backup-v<from>-<yyyymmddThhmmssZ>` (UTC,
mode 600; `src/store/backup.ts`); the three newest such files are kept and older ones deleted.
Copies stamped after the current time, by a clock that was once ahead or one that is now behind, are
the first deleted, oldest-stamped first, but no new copy deletes more than the usual number, daily
ones included (B52): a clock that stays behind loses one copy of the history per copy taken, as a
right clock would. Limitation: a copy stamped ahead stays while the kept number is not exceeded or
while it waits behind other copies stamped ahead, and, once its day arrives, can stand for that
day's daily copy although it holds older data (for example when a daily run is missed). A fresh database gets no copy, and a copy that cannot be written stops the start with nothing
applied. To go back, stop the daemon and put a backup in place of the database file, removing its
`-wal` and `-shm`.

The daily backup (B5, `src/backup/daily-backup.ts`) runs right after each retention run, so at
startup and at `ANOMANDER_RETENTION_CRON`: it copies the database the same way as
`<db>.backup-daily-<yyyymmddThhmmssZ>`, unless a copy stamped on the same UTC day, and not after
now, is already there, and keeps the seven newest daily copies; the copies taken before migrations
are pruned apart. It runs in a `finally`, so also when retention failed; after a successful
retention the copy holds nothing retention erased. What "Borrar conversación" or a confirmed forget
erases stays in the older daily copies until seven newer ones replace them: seven days when the
daemon runs every day, longer when it does not (PRD §16). A copy that cannot be written is logged by
its error code only, never its path, and is made at the next run; the daemon keeps running. The
copies sit on the same disk as the database.

**Ledger export.** `exportLedger` (B5, `src/store/export.ts`) writes the read views of RA-1
(`gastos`, `lineas_de_compra`, `pendientes_de_confirmar`) as one CSV file each (RFC 4180, CRLF,
a header row even with no rows) and all three in `ledger.json`, into a new
`<data folder>/exports/<yyyymmddThhmmssZ>/` (`-1`, `-2`, … within the same second). The views are
read in one transaction; folders get mode 700 and files 600, and a failed write leaves no partial
folder. A CSV text that starts with `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading
`'`, so a spreadsheet never runs a merchant or product name read from a receipt as a formula;
`ledger.json` keeps the text as stored. Each `gastos` and `lineas_de_compra` row has its
`moneda`; `por_moneda` of `pendientes_de_confirmar` is JSON text in its CSV file and an array in
`ledger.json` (B71). No processor is called.

`/exportar` (PRD R-29 AC3) in Telegram calls it with the folder of `ANOMANDER_DB_PATH` and replies
S-79 with the four files in `files`; `@anomander/telegram` sends the text, then each file with
`sendDocument`. A failed export replies S-80 and logs only the error's code, or its name when it has
none, never its message or a path. An in-memory store (`ANOMANDER_DB_PATH=:memory:`) has no data
folder: `exportLedger` throws `InMemoryStoreError`, writing nothing, so the export never lands in
the folder the daemon was started from (B52). It runs in the chat's turn and gets the setup guide
while setup is incomplete. In the app `/exportar` replies S-81 and writes nothing. Exports stay
under `exports/` until deleted by hand.

## Configuration

`loadConfig(process.env)` (`src/config.ts`) reads PRD §14.4. An empty value counts as unset.
The error names every missing required variable. Telegram is one front door and the local
channel the other; at least one is required (R-28 AC5).

Docker and the CLI set every variable in the environment. The desktop app keeps the secrets out
of it, where `ps eww` would show them (DK-5 AC2): it sets `ANOMANDER_SECRETS_ON_STDIN=1` and
writes one line to the daemon's stdin, a JSON object with `TELEGRAM_BOT_TOKEN`, the provider
keys, `ANOMANDER_AUTH_JSON`, `ANOMANDER_MCP_SECRETS`, `ANOMANDER_MCP_OAUTH` and
`ANOMANDER_LOCAL_TOKEN`. `main.ts` reads it with `readHandover` (`src/supervised.ts`) and calls
`loadConfig` with it laid over the environment; `process.env` never holds it. A line that is not
a JSON object of strings, or none within 10 seconds, stops the daemon with exit code `1`.

| Variable | Default |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | required, unless `ANOMANDER_LOCAL_TOKEN` is set; then optional, with `ANOMANDER_PRINCIPAL_CHAT_ID` |
| `ANOMANDER_PRINCIPAL_CHAT_ID` | required with `TELEGRAM_BOT_TOKEN`, an integer |
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
| `ANOMANDER_API_TOKEN` | unset: the read API is off (RA-2 AC1). At least 32 characters |
| `ANOMANDER_API_HOST` | `127.0.0.1`, an IP address. While the token is set, one that is not this machine needs `ANOMANDER_API_ALLOW_PLAIN_HTTP` |
| `ANOMANDER_API_ALLOW_PLAIN_HTTP` | unset. `1` lets the read API serve plain HTTP on a host that is not this machine (RA-2 AC3) |
| `ANOMANDER_API_PORT` | `4311`, from 1 to 65535 |
| `ANOMANDER_LOCAL_TOKEN` | unset: the local channel is off (DK-3). At least 32 characters. Handed over on stdin by the desktop app |
| `ANOMANDER_LOCAL_PORT` | `4312`, from 1 to 65535 |
| `ANOMANDER_MCP_CONFIG` | unset: no connections (DK-11). The path of `mcp.json` |
| `ANOMANDER_AUTH_JSON` | unset. Handed over on stdin by the desktop app: the model login it keeps in the Keychain, in the shape of `auth.json`; while set, `ANOMANDER_AUTH_PATH` is not used (DK-5 AC1) |
| `ANOMANDER_MCP_OAUTH` | unset. Handed over on stdin by the desktop app: the clients and tokens of the servers connected with OAuth, a JSON object by server name (DK-11 AC10) |
| `ANOMANDER_SECRETS_ON_STDIN` | unset: every variable comes from the environment. `1`, set only by the desktop app: the secrets come first on stdin, as above (DK-5 AC2) |
| `ANOMANDER_MCP_SECRETS` | unset. Handed over on stdin by the desktop app: a JSON object with the values it keeps in the Keychain for `mcp.json`, by `mcp/<server>/<env or headers>/<name>`; each fills an `@keychain` in the file |

The read API's variables come from `docs/read-access-prd.md` §8 until it moves into PRD §14.4;
`.env.example` lists both tables. The local channel's two variables are not in `.env.example`:
the desktop app sets the port and hands the token over on stdin when it starts the daemon (`docs/desktop-prd.md` §8). Any token of 32 characters or more turns the API on; use a
random one, for example `openssl rand -hex 32`.

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
`evals/text/README.md`. Both read amounts in `ANOMANDER_CURRENCY` (euros by default) or
`--currency`, checked as `loadConfig` checks it.

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
- Message, receipt, correction, memory, reminder and action history text is never logged; a
  rejected processor item is logged by its reason and predicate only (R-14 AC2).
- Tokens and what the principal pastes during a login are never logged, stored outside
  `ANOMANDER_AUTH_PATH` or sent to the chat (R-27 AC3, AC5).
- The local channel listens on `127.0.0.1` only and closes, without a byte, any connection
  that does not present the token; the token is never logged (DK-3).
- Readers see only views, through a read-only connection; the read API's token, query strings
  and response bodies are never logged (RA-2 AC2, AC5).
- Bot text comes from `strings` in `@anomander/protocol`, except the processor's
  conversational reply (R-16) and the phrased replies that passed the R-21 guard.
