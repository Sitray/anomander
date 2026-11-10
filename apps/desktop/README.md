# ANOMANDER desktop

The desktop app (M6, `docs/desktop-prd.md`): a Tauri shell in `src-tauri` that starts and
supervises the daemon, and a React window in `src` with the chat, the setup screen and the
daemon's status.

## The window

`src/shell.ts` is the seam with the shell: every Tauri command and event the two exchange. The
window never calls Tauri anywhere else.

| Folder | What it holds |
| --- | --- |
| `src/status/` | `useShell` (the shell's snapshot, kept current from its events), `useDaemonControl` (start, stop) and `StatusBar` |
| `src/chat/` | `chat-client.ts` (the local channel's WebSocket protocol, with no React), `chat-state.ts` (the conversation as a pure reducer), `useChat`, `useDraft` and the screens |
| `src/setup/` | `SetupScreen` (DK-5 AC1) |
| `src/strings.ts` | Every string the principal reads, in Spanish, in one place to review |

Hooks own the side effects; components take props and call back.

### Status (DK-6 AC1, DK-1 AC2, DK-2)

Always on top: running, starting, stopped or failing. When the daemon is not running, the window
says why, by the snapshot's `reason`. After 3 exits in 5 minutes (`gave_up`) it shows the last
error line verbatim in a monospace block. With `not_configured`, the setup screen opens by
itself.

### Chat (DK-3, DK-4)

The window connects whenever the snapshot has a `channel`, with
`new WebSocket(url, ['anomander.v1', token])`. The token is never put in a URL, the DOM, a log
or storage. A new channel (a restarted daemon) closes the old socket and opens a new one, and a
dropped socket is retried after 1 s, doubling up to 10 s.

- Enter sends a `text` (at most 4096 characters, as the daemon accepts); Shift+Enter is a new
  line.
- Files dropped on the window, pasted or picked wait in the composer and leave together as one
  `receipt`, at most 10, with the composer's text as the caption. Which files are receipts is the
  daemon's call: a PDF gets S-18 and a large image S-20, as in Telegram.
- A reply's text is shown exactly as received, as text. A `{label, data}` button sends a
  `button` request with the reply's `channelRef`; the reply's buttons then wait for the answer.
  A `{label, url}` button opens only an `https:` address.
- Each message shows "Enviando…" until its `reply` or `done`. A `rejected`, or a connection lost
  meanwhile, marks it "No se ha enviado." with a retry.
- The conversation lives in memory only. The composer is disabled, saying why, while there is no
  channel.

### Setup (DK-5 AC1)

The bot token and the provider keys are typed into password fields that are read only when a key
is added or the form is saved, and cleared as soon as they are handed to `shell.saveSetup`. The
shell never sends a secret back: a stored token shows as stored (leave it blank to keep it), and
stored keys are listed by name, with a remove action that takes effect on save.

## Commands

From the repository root:

```sh
pnpm vitest run apps/desktop     # the window's tests (jsdom, a fake WebSocket, shell.ts mocked)
pnpm --dir apps/desktop typecheck
pnpm --dir apps/desktop dev      # Vite on port 1420, which the shell's devUrl points at
pnpm --dir apps/desktop build    # into apps/desktop/dist, the shell's frontendDist
```
