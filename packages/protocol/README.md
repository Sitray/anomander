# @anomander/protocol

What the daemon and its front doors (`apps/telegram` today, a desktop app later) share. It has no
dependencies and no runtime state.

## The front door contract (`src/messages.ts`)

- A front door decides who may talk (R-1) and which inputs it supports (R-20). It hands each
  principal text to the daemon as a `PrincipalText` (`text`, `channelRef` such as
  `telegram:<message_id>`, `receivedAt`).
- A photo, an image file or an album is a `PrincipalReceipt` (R-3, R-20): `images` (each a
  `ReceiptImage` with its `mimeType` and a `load()` that fetches the bytes when the daemon asks),
  `caption` (the principal's declaration, R-3 AC5, or `null`), `channelRef`
  (`telegram:<message_id>`, or `telegram:album:<media_group_id>` for an album) and `receivedAt`.
  The front door hands it to a `ReceiptHandler`, which may answer `null` to send nothing (a
  receipt queued after the day's S-10, R-12 AC2).
- The daemon decides what the text or receipt means and answers with a `Reply`. After sending
  it, the front door calls `reply.onDelivered` with the sent message's `channelRef`, so the daemon
  can record the delivery as an observation (R-9 AC2) or remember which message shows a pending
  decision (R-17 AC2).
- A reply that asks a pending decision carries `buttons` (R-6 AC3), shown in one row. Build them
  with `decisionButtons(decisionId, options)`: option `i` sends the callback data
  `decision:<id>:<i>` (R-17 AC1). The labels come from `buttons` in `src/strings.ts`.

## User-facing strings (`src/strings.ts`)

Every string of PRD §12 lives here, verbatim, with the button labels (`Apuntar`, `Corregir`,
`Descartar`, `Sí`, `No`) in `buttons`. S-27 (`remembered`) and S-29 (`confirmForget`) are a
header followed by one line per memory, joined with `\n`; with no memories, `confirmForget` is the
header alone. Beside them are `formatAmount` (`23,40 €`, written by `Intl` with a no-break
space before `€`) and `formatDate` (`29 de octubre`). No other module may write
bot text. S-1, S-2, S-16 and S-21 are also the reference and the fallback when the assistant
words a reply in its own voice (R-21, see `packages/daemon/README.md`); every other string is sent
exactly as written.

To change a string, change PRD §12 first, then this file; tests assert the PRD text literally.
