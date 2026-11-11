# ANOMANDER desktop

The desktop app of milestone M6 (`docs/desktop-prd.md`): a Tauri 2 shell in Rust (`src-tauri/`)
that starts and supervises the daemon, keeps its secrets in the macOS Keychain and lives in the
menu bar, and a React window (`src/`) with a chat, a setup screen and the daemon's status.

This file covers the window. The two halves meet in `src/shell.ts`: every command and event they
exchange, mirrored by the Rust side. Change both together.

## Running it

| What | Command |
| --- | --- |
| The app, with the shell | `pnpm --dir apps/desktop tauri dev` |
| The window alone, in a browser | `pnpm --dir apps/desktop dev`, then open `http://localhost:1420/test/preview/index.html` |
| Tests | `pnpm vitest run apps/desktop` (from the repository root) |
| Types | `pnpm --dir apps/desktop typecheck` |
| Build the window into `dist/` | `pnpm --dir apps/desktop build` |

The dev server is always on port 1420 (`strictPort`): Tauri loads exactly that URL.

### Signing the build

macOS ties each Keychain entry to the signature of the app that stored it. An unsigned build has
a new ad-hoc signature every time, so after each rebuild macOS asks for the login keychain
password before the app can read its own secrets. Sign the build with a fixed identity (list them
with `security find-identity -v -p codesigning`) and it asks no more:

```sh
APPLE_SIGNING_IDENTITY="<identity name or hash>" pnpm --dir apps/desktop tauri build --debug
```

Entries stored by an unsigned build still ask once. To skip that, delete them
(`security delete-generic-password -s ANOMANDER`, once per entry) and enter the setup again.

### The preview

`test/preview/` runs the window without the shell or a daemon: Tauri's IPC is mocked and the
local channel is a scripted socket. It is never part of a build. The URL picks the scene:

| Parameter | Values |
| --- | --- |
| `daemon` | `running` (default), `starting`, `failing`, `not_configured`, `already_running`, `bot_in_use`, `gave_up`, `stopped_by_principal`, `failed` (stopped with no reason, only an error), `unreachable` (the shell does not answer) |
| `setup` | `empty`, `filled` |
| `error` | `long`: a 300-character last error |
| `fail` | `start`, `stop`, `save`: the shell refuses that command |

The scripted daemon answers by what is typed: `mercadona` asks a Sí/No question, `rechaza` is
rejected, `corta` loses the connection, `lento` never answers, `largo` answers at length and
`/login` answers with a link button. A PDF gets the daemon's PDF reply; images are read as a
receipt.

## How the window is built

```
src/
  shell.ts            the contract with the Rust shell
  strings.ts          every string the principal reads (es-ES), in one place
  App.tsx             the container: status on top, chat or setup under it
  styles.css          the one stylesheet: tokens, then each part
  chat/
    chat-client.ts    the local channel: socket, request ids, in-flight requests, reconnection
    conversation.ts   the conversation as a pure reducer
    attachments.ts    files waiting in the composer
    use-chat.ts       binds the client to React        use-draft.ts   the composer's draft
    ChatScreen.tsx    container                        MessageList.tsx, Composer.tsx   presentational
  status/
    describe.ts       what to say and offer for each state and reason
    use-shell.ts      the latest snapshot and the commands
    StatusBar.tsx     presentational
  setup/
    validation.ts     the shell's checks, made before saving
    SetupScreen.tsx   presentational
```

Presentational components take props and call back; hooks own the side effects; `chat-client.ts`
is framework-free, so it is tested against a fake `WebSocket` (`test/fake-web-socket.ts`).

## What it guarantees

- **The token** of the local channel (DK-3 AC3) goes from the snapshot to the chat client and to
  the socket's second subprotocol. It is never in a URL, the DOM, a log or storage.
- **The conversation** lives in memory only and is gone with the window. Opening the setup hides
  the chat without unmounting it.
- **A reply is plain text** (DK-4 AC1): shown exactly as received, line breaks kept, never HTML
  or Markdown.
- **Delivery honesty.** A `rejected` request did nothing: the window says it was not sent and
  offers to send it again. A connection lost while a request was in flight may have reached the
  daemon: the window says it does not know, and offers no one-click resend that could register
  an expense twice. A button press can always be pressed again: a closed question answers S-19.
- **Files** dropped, pasted or picked wait in the composer and go as one `receipt`, at most 10
  and at most 45 MB together (the daemon closes a connection whose frame is over 64 MB). A file
  that is not an image is sent as it is, so the daemon answers as it would in Telegram (DK-4 AC6).
- **The screen** (DK-9) is captured only on a press of the composer's screen button, with the
  window hidden for that moment. The capture is shown before it is sent, travels alone as a
  `screen` request with a question (without words: "¿Qué ves en mi pantalla?"), and is never
  mixed with receipts. The shell keeps its file only while reading it. It needs macOS's Screen
  Recording permission, which belongs to the signed app.
- **A task on the computer** (DK-10) starts from the composer's pointer button. Each step is a
  `computer` request with a fresh capture; the daemon answers one proposed action and whether
  it is routine (`confirm: false`). A routine step is performed at once and shown as done.
  There is one task at a time (`run` in `use-chat.ts`): a new task or "Detener tarea" ends the
  one before, whose late answers are shown and never performed, and the shell is asked for one
  capture or action at a time. While a task goes by itself the app stays hidden
  (`keepHidden`), with "Detener tarea" in the menu bar; it comes back (`reveal`) when a step
  needs permission, the task ends or something fails. A look at the screen (DK-9) is refused
  while a task runs and waits for an action still going. Anything else, a missing `confirm` included, is
  shown with "Permitir" and "Detener" and, for a click or a scroll, the capture around the point
  with a mark. `perform_action` is called once per action: the proposal is taken out
  before the call, an action that may have been performed is never offered again, and an action
  in the reply to anything but a step the principal asked for is ignored. The shell validates the
  action again (`src-tauri/src/computer.rs`), hides the app so the input goes to the app the
  principal was using, and answers with the next capture. It needs macOS's Accessibility
  permission besides Screen Recording.
- **A task with connections** (DK-11) starts from the composer's plug button and goes as a
  `connect` request. The daemon runs it; a call that needs permission arrives as a reply with
  "Permitir" and "Detener" buttons, pressed like any other. The servers are the ones of
  `mcp.json` in the data folder, which the principal writes:

  ```json
  {
    "mcpServers": {
      "notes": { "command": "npx", "args": ["-y", "some-notes-mcp"], "readOnly": ["search"] },
      "remote": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer …" } }
    }
  }
  ```

  Only the tools listed in `readOnly` run without asking. The daemon reads the file when it
  starts. Just before, the shell moves every value of `env` and `headers` to the Keychain
  (`src-tauri/src/connection_secrets.rs`) and rewrites the file with `@keychain` in their place,
  so a token is in the file only until the next start. To change a value, write the new one over
  its `@keychain` and restart the app; a value whose server or name leaves the file leaves the
  Keychain too. The rewrite keeps the order of the servers and normalises the spacing.
- **Link buttons** (`{label, url}`) are named, not offered: this WebView cannot open links, and
  `/login` stays in Telegram (DK-4 AC7).
- **Secrets** typed in the setup screen stay in uncontrolled fields and a ref, never in React
  state or a DOM attribute, and are dropped once saved. Stored secrets are never sent to the
  window: it only knows whether each one is stored.
- **Snapshots** carry no sequence number, so an event that arrived while a command was on its
  way wins over that command's answer.

## Design

The window borrows the app icon's three colours and nothing else: bone paper in light, ink in
dark, and one ember accent, kept for what the principal can do next and for the status light
(the icon's ring and dot, lit while the daemon runs). The daemon's words sit on the surface as
plain text; only what the principal sent is boxed. System font, a 13-point utility scale, a
4-point spacing scale, both themes checked for WCAG AA, motion only for a message arriving and
for work in progress, and none under `prefers-reduced-motion`. The tokens are at the top of
`src/styles.css`.
