# Capabilities

ANOMANDER is a personal assistant. Expenses were its first matter, not its limit: what it can do for the principal grows by adding **capabilities**, each one self-contained (PRD R-24). Reminders and tasks (PRD R-25) are the first one.

Expenses, memories, categories and policies are older, built-in kinds of the text interpreter. They are not capabilities yet; moving them is not part of M5.

## What a capability is

A capability is a module that declares four things to the daemon (`packages/daemon/src/capabilities/capability.ts`):

| Part | What it is | Reminders |
| --- | --- | --- |
| `kinds` | The envelope kinds it handles; no two capabilities share one | `reminder_create` |
| `prompt` | The instructions and JSON shape it adds to the text interpreter's prompt | "If the user asks you to remind them…" |
| `schema` | The Zod schema code validates the processor's call with | `text`, `at`, `recurrence`, `unsupported_recurrence`, `reply` |
| `handle` | The handler that carries out a validated call and returns the reply | Stores the reminder and replies S-40 or S-41 |

It may also declare `context`: what the processor needs to read the message, sent in the interpreter's user turn under the capability's `name`. Reminders sends the local time in `TZ` and the pending reminders and tasks (R-25 AC1).

## How a message reaches it

1. The text handler builds the user turn with every capability's `context` and calls the text interpreter once (R-14).
2. The interpreter's system prompt is the built-in kinds followed by each registered capability's `prompt` (`composeTextInterpreterPrompt`).
3. The processor answers with one JSON envelope, so at most one capability call per message (R-24 AC2).
4. If the envelope's `kind` belongs to a capability, the interpreter validates it with that capability's `schema`. A call that does not validate is a failure (R-22 AC1): the reply is S-22 and only the field and issue code are logged.
5. The text handler passes the validated call to the capability's `handle`, with the message and the store.

The processor never carries out anything: it has no tools and never writes (R-14). The handler decides, by the authority model, whether a write runs at once, needs the principal's answer to a decision with buttons, or is refused (R-24 AC3).

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

Reminder text is the principal's private data. It never appears in a log (R-25 AC12): log calls carry the channel reference and reasons, never the text, the quote or the reply.
