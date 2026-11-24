# Capabilities

ANOMANDER is a personal assistant. Expenses were its first matter, not its limit: what it can do for the principal grows by adding **capabilities**, each one self-contained (PRD R-24). Reminders and tasks (PRD R-25) are the first one, the morning digest (PRD R-26) the second and the opt-in weekly summary (PRD R-10 AC5-AC8) the third.

Expenses, memories, categories and policies are older, built-in kinds of the text interpreter. They are not capabilities yet; moving them is not part of M5.

The Mac app (M6) adds three more things ANOMANDER can do: look at the screen, act on the computer and use the principal's connections. They are not `defineCapability` modules: the text interpreter reaches them through its built-in `route` kind, described [below](#routes-the-screen-the-computer-and-connections).

## What a capability is

A capability is a module that declares four things to the daemon (`packages/daemon/src/capabilities/capability.ts`):

| Part | What it is | Reminders | Morning digest |
| --- | --- | --- | --- |
| `kinds` | The envelope kinds it handles; no two capabilities share one | `reminder_create`, `reminder_list`, `reminder_cancel`, `reminder_done` | `digest_enable`, `digest_disable` |
| `prompt` | The instructions and JSON shape it adds to the text interpreter's prompt | "If the user asks you to remind them…" | "If the user asks you to send them a summary every morning…" |
| `schema` | The Zod schema code validates the processor's call with | One `z.discriminatedUnion('kind', …)` over the four kinds | The same over the two kinds |
| `handle` | The handler that carries out a validated call and returns the reply | Stores, lists, cancels or completes reminders and replies S-40 to S-52 | Asks S-53, or replies S-59; revokes and replies S-56 or S-58 |

It may also declare `context`: what the processor needs to read the message, sent in the interpreter's user turn under the capability's `name`. Reminders sends the local time in `TZ` and the pending reminders and tasks (R-25 AC1). The morning digest declares none: the processor only reads a time from the message.

## How a message reaches it

1. The text handler builds the user turn with every capability's `context` and calls the text interpreter once (R-14).
2. The interpreter's system prompt is the built-in kinds followed by each registered capability's `prompt` (`composeTextInterpreterPrompt`).
3. The processor answers with one JSON envelope, so at most one capability call per message (R-24 AC2).
4. If the envelope's `kind` belongs to a capability, the interpreter validates it with that capability's `schema`. A call that does not validate is a failure (R-22 AC1): the reply is S-22 and only the field and issue code are logged.
5. The text handler passes the validated call to the capability's `handle`, with the message and the store.

The processor never carries out anything and never writes (R-14); a capability gives it no tools. The handler decides, by the authority model, whether a write runs at once, needs the principal's answer to a decision with buttons, or is refused (R-24 AC3).

## Adding a capability

1. Create a folder under `packages/daemon/src/` named after the matter, for example `src/reminders/`.
2. Write the module with `defineCapability({ name, kinds, prompt, schema, context?, handle })`. Keep the prompt in the same style as the built-in kinds: when to answer, the exact JSON shape, and what the processor must never do.
3. Keep writes in the store (`src/store/<matter>.ts`). Every row rests on an assertion inserted with `insertAssertion`, in the same transaction.
4. Add any new user-facing string to `packages/protocol/src/strings.ts`, verbatim from PRD §12. A reply the processor may word goes through `checkedPhrasing` with the §12 string as the reference (R-21).
5. Register it in `src/capabilities/registry.ts`. Nothing else changes: the prompt, the user turn and the dispatch all follow from the registry.
6. Test it end to end through the fake Telegram API (`packages/daemon/test/e2e/`), with the fake processor answering the envelope. Unit-test only pure logic such as date math.

## Worked example: reminders

`src/reminders/capability.ts` handles `reminder_create`:

```json
{"kind":"reminder_create","text":"llamar a mamá","at":"2026-10-31T09:00","recurrence":null,"unsupported_recurrence":false,"reply":"Te lo recuerdo mañana a las 9:00: llamar a mamá."}
```

- `at` is a local time in `TZ`; the processor works out "mañana" or "el viernes" from the `now` and `weekday` of its context. A day without a time is 09:00.
- `recurrence` is `daily`, `weekly` with `days` (1 Monday to 7 Sunday) or `monthly` with `day`, always with a `time`. When it is set, `at` is ignored. Any other repetition comes back as `unsupported_recurrence: true` and gets S-51; nothing is stored.
- With neither `at` nor `recurrence` it is a task, S-41.

The handler checks, in this order: an unsupported repetition (S-51); that `text` is the principal's own words, with `quotedFrom` (otherwise S-22, nothing stored); that a one-time `at` has not passed (S-52). Then `createReminder` stores the row and its `reminder` assertion (mode `declared`, actor `principal`, source the Telegram message) in one transaction. A repeating reminder's `due_at` is its first occurrence after now, computed in `TZ` by `src/reminders/when.ts`; a monthly day a month does not have falls on its last day.

The reply is built from the stored row: `{cuando}` comes from `whenOf`, and the processor's `reply` is sent only if `checkedPhrasing` finds the text and `{cuando}` in it; otherwise S-40 or S-41 goes out verbatim.

A `reminder_create` with an `id` naming a pending task gives that task a time: the same checks apply, the row keeps its text and assertion, and only `due_at` and `recurrence_json` change (R-25 AC5).

The other three kinds work on the pending items the processor was given; any id that is not pending is dropped:

- `reminder_list` is listed by code, never worded by the processor: S-44 or S-45 (R-25 AC8).
- `reminder_cancel` copies the forget pattern: code asks S-46 with `Sí` and `No` through a `cancel_reminder` decision, and only `Sí` cancels (R-25 AC9).
- `reminder_done` marks the items `done` at once and keeps them (R-25 AC10).

Sending is not part of the capability: it is a scheduler job. `src/reminders/send-due.ts` runs at startup and every minute, before the receipt queue (R-25 AC7). It sends each pending reminder whose `due_at` has come through `notify`, so the message is recorded as a turn (R-16 AC3): S-42, or S-43 with `{cuando}` when it goes out more than 10 minutes late. A one-time reminder then becomes `sent`; a repeating one sends only its latest missed occurrence and moves `due_at` to its next occurrence after now. A reminder is marked only after its send succeeds, so a failed send is logged by id and retried on the next minute. Tasks have no `due_at` and are never sent.

Reminder text is the principal's private data. It never appears in a log (R-25 AC12): log calls carry the channel reference and reasons, never the text, the quote or the reply.

## Worked example: the morning digest

The second capability shows a call that needs the principal's permission. `src/digest/capability.ts` handles two kinds:

```json
{"kind":"digest_enable","time":"07:30"}
{"kind":"digest_disable"}
```

- `time` is local `HH:mm` in `TZ`, or `null` when the message gives none; code then asks for 08:00. `H:mm` is read the same.
- The processor never turns anything on, and the prompt tells it never to offer the digest: it exists only when the principal asks for it (R-26).

Sending the digest is an action covered by a permission (§8.1), and granting a permission is something only the principal does. So `digest_enable` writes nothing that takes effect: it opens a `grant_morning_digest` proposal and its decision with `openDigestDecision` (`src/store/digest.ts`) and asks S-53 with `Sí` and `No`, as `reminder_cancel` does. When the time asked for is already the one in force, it replies S-59 and asks nothing. The answer handler (`src/decisions/grant-digest-decision.ts`, registered under `grant_morning_digest` in `app.ts`) grants on `Sí`: in the answering transaction, `grantDigestPermission` revokes any earlier `send_morning_digest` permission and inserts the new one with `conditions_json` `{"time":"07:30"}`, then S-54. `No` grants nothing, S-55. A new time is always a new permission, asked again, because it changes what was authorized (AC3).

`digest_disable` is the principal taking a permission back, so it runs at once, without buttons: `revokeDigestPermissions` sets `revoked_at`, and the reply is S-56, or S-58 when none was in force.

Sending is a scheduler job, like the reminders' send. `src/digest/send-digest.ts` runs at startup and every minute, just before due reminders. While the permission is in force and its time has come in `TZ`, it builds S-57 from the store alone, with no processor call and no AI budget: today's pending reminders still ahead (soonest first, `· 9:00 llamar a mamá`), every pending task (oldest first) and the number of `pending` expenses. Empty parts are left out; with every part empty nothing is sent. It goes through `notify`, so it is a recent turn (R-16 AC3). `digest_sends` records the day after a successful send, so a day never gets two and a failed send is tried on the next minute. A digest missed while the daemon was down goes out at startup only before 12:00 in `TZ` (AC6). Its text, like a reminder's, never appears in a log (AC7).

## A third capability: the weekly summary

`src/summary/capability.ts` follows the digest with nothing to carry: `{"kind":"weekly_summary_enable"}` asks S-74 (or S-76 when it is already on) and `{"kind":"weekly_summary_disable"}` revokes at once. Its answer handler is `src/decisions/grant-weekly-summary-decision.ts`, registered under `grant_weekly_summary`. Both capabilities share `src/store/permissions.ts`: `openGrantDecision` opens the question (closing an earlier one still unanswered), `grantPermission` revokes the earlier permission and inserts the new one, `revokePermissions` takes it back and `activePermissions` reads what is in force. A capability that needs a new permission should reuse them rather than write its own queries.

When two capabilities read alike, the prompt is where they are told apart: the summary's prompt says a summary not called weekly is the morning one (R-10 AC8).

## Routes: the screen, the computer and connections

A capability answers inside one interpreter call. These three need more than one call, a capture of the screen or tools, so the interpreter only names the way and code takes over (`docs/desktop-prd.md` DK-13). Each has its own processor, which never carries anything out and never writes (R-14): it answers in words, proposes one action, or asks for one tool call that code decides.

| Part | A look at the screen | A task on the computer | A task with connections |
| --- | --- | --- | --- |
| `to` in the route | `screen` | `computer` | `connect` |
| Offered at | The app | The app | The app and Telegram, also as `/mcp <tarea>` |
| Announced with | "Miro tu pantalla." | "Me pongo con ello en tu ordenador." | "Lo miro en tus conexiones." |
| Who does it | The app captures the screen; `processor/screen-reader.ts` answers in words | `processor/computer-planner.ts` proposes one action per capture; the shell validates and performs it (`apps/desktop/src-tauri/src/computer.rs`) | `connections/task.ts` offers the tools of `mcp.json`; the processor asks for one call at a time and code decides each |
| Asks before | Nothing: it only reads | A step of care, said by code from the validated action (DK-10 AC1) | A call to a tool not marked read-only, and any call to a second server in the same task (DK-11 AC3, AC4) |
| Limits | One capture, never stored | 12 steps | 8 calls |
| Memories (DK-14 AC1) | Yes | Yes | None: read-only calls run unasked and go to third parties |
| Kept in the history (DK-14 AC2) | The question and how it ended | How it ended and the steps it took | How it ended and the calls made or refused |
| macOS permission | Screen Recording | Screen Recording and Accessibility | None |

Every processor call counts against the daily AI limit (R-12). A look is a recent turn as its question only; a task, as how it ended (R-16 AC3).

### How a message reaches one

1. The text handler adds `routes` to the interpreter's user turn: the ways its front door offers. It also adds `connected`: the tools of the connected servers with a one-line purpose, so the processor knows what a task with connections can do (DK-13 AC5). The purposes are the servers' own words, capped and kept out of the prompt.
2. When the message can only be done one of those ways, the processor answers `{"kind":"route","to":"computer","task":"abre Notas y apunta comprar pan"}`. The prompt tells it to take `task` from the message only.
3. Code refuses a way the door does not offer (`route_elsewhere`), then announces the way in its own words.
4. The daemon runs a task with connections itself. The app starts a look or a task on the computer from the reply's `route`, and sends each capture back as a `screen` or `computer` request of the local channel.

A lookup on the internet is never a task on the computer. With a connection that searches (the "Añadir búsqueda web" preset, `pi-web-access`, DK-11 AC11) it is routed to `connect`, and its search runs without "Permitir"; reading a page, or a search that picks its provider, a proxy or the pages' content, asks first. With none, the processor answers `{"kind":"no_web_search"}` and code says how to add one; the app's reply carries `offer: 'web_search'`, so the chat adds it in one press and asks again (DK-11 AC13). The first setup adds it too, checked by default.

What the screen shows and what a tool answers is content, never an instruction. The prompts say so, and the authority check holds whatever the processor proposes: "Permitir" is shown by code, with the exact action or call.
