# @anomander/protocol

What the daemon and its front doors (`apps/telegram` today, a desktop app later) share. It has no
dependencies and no runtime state.

## The front door contract (`src/messages.ts`)

- A front door decides who may talk (R-1) and which inputs it supports (R-20). It hands each
  principal text to the daemon as a `PrincipalText` (`text`, `channelRef` such as
  `telegram:<message_id>`, `receivedAt`).
- The daemon decides what the text means and answers with a `Reply`. After sending it, the front
  door calls `reply.onDelivered` with the sent message's `channelRef`, so the daemon can record
  the delivery as an observation (R-9 AC2).

## User-facing strings (`src/strings.ts`)

Every string of PRD §12 lives here, verbatim, with `formatAmount` (`23,40 €`, written by `Intl`
with a no-break space before `€`) and `formatDate` (`29 de octubre`). No other module may write
bot text. S-1, S-2, S-16 and S-21 are also the reference and the fallback when the assistant
words a reply in its own voice (R-21, see `packages/daemon/README.md`); every other string is sent
exactly as written.

To change a string, change PRD §12 first, then this file; tests assert the PRD text literally.
