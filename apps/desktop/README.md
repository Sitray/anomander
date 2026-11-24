# ANOMANDER desktop

The desktop app of milestone M6 (`docs/desktop-prd.md`): a Tauri 2 shell in Rust (`src-tauri/`)
that starts and supervises the daemon, keeps its secrets in the macOS Keychain and lives in the
menu bar, and a React window (`src/`) with a chat, a setup screen, a connections screen and the
daemon's status. While ANOMANDER works the menu bar icon shows a wave (`tray.rs`); when the work
ends a pill drops from the notch saying "Ha terminado", holds and retracts (`src-tauri/src/notch.rs`
and the page in `src/notch/`). It drops after every task on the computer, and after an answer only
when the chat is not in front.

On Windows the same shell keeps the secrets in the Credential Manager and lives in the
notification area: the icon is drawn light with a dark rim (no template images there), a left
click opens the chat and the right button the menu. With no notch or menu bar, the pill floats at
the top centre of the main screen's work area (`data-floating` in `src/notch/`). Build and run it
as the root README's "Run the app on Windows" says.

This file covers the window. The two halves meet in `src/shell.ts`: every command and event they
exchange, mirrored by the Rust side. Change both together.

Each window may call only the commands granted to it. A new command goes in `generate_handler!`
(`src-tauri/src/lib.rs`), in `COMMANDS` (`src-tauri/build.rs`) and, as `allow-<name>` with
dashes, in the capability of the window that calls it (`src-tauri/capabilities/`): the chat
(`default.json`) or the notch (`notch.json`, which only opens the chat with `reveal`).
`test/capabilities.test.ts` and `src-tauri/tests/capabilities.rs` fail when they disagree.

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
| `fail` | `start`, `stop`, `save`, `oauth`, `login`: the shell refuses that command |
| `connections` | `none`, `invalid` (an `mcp.json` the daemon would not read); by default two servers |
| `subscriptions` | `connected`: ChatGPT and Claude are connected; by default none |
| `history` | `none`: nothing is kept of the conversation; by default four messages, two from Telegram (DK-16) |
| `expenses` | `none`: no expense in any month; `fail`: the daemon cannot read them; by default four expenses a month, one of each mode, and two pending (DK-17) |
| `memory` | `none`: nothing remembered or done; `failing`: the daemon cannot read or forget them; by default three memories and three actions (DK-18) |

The scripted daemon answers by what is typed: `mercadona` asks a Sí/No question, `rechaza` is
rejected, `corta` loses the connection, `lento` never answers, `largo` answers at length and
`/login` answers with a link button, `pantalla` is routed to a look (the capture is a plain
image) and `ordenador` to a task on the computer that ends at its first step. A PDF gets the
daemon's PDF reply; images are read as a receipt. It keeps the conversation as the daemon does,
for as long as the page is open, and erases it on "Borrar conversación" (DK-16).

## How the window is built

```
src/
  shell.ts            the contract with the Rust shell
  locale.ts           the window's language: the system's, as the shell hands it, Spanish for a
                      Spanish system and English for any other (the browser's with no shell)
  strings.ts          every string the principal reads, in Spanish and English, in one place
  App.tsx             the container: status on top; chat, setup, connections or subscriptions under it
  styles.css          the one stylesheet: tokens, then each part
  chat/
    chat-client.ts    the local channel: socket, request ids, in-flight requests, reconnection
    conversation.ts   the conversation as a pure reducer
    attachments.ts    files waiting in the composer
    computer-task-session.ts   a task on the computer, step by step, without React
    use-chat.ts       binds the client to React        use-draft.ts   the composer's draft
    ChatScreen.tsx    container                        MessageList.tsx, Composer.tsx   presentational
  status/
    describe.ts       what to say and offer for each state and reason
    use-shell.ts      the latest snapshot and the commands
    StatusBar.tsx     presentational
  setup/
    validation.ts     the shell's checks, made before saving
    SetupScreen.tsx   presentational
  connections/
    validation.ts     the shell's checks, made before saving
    ConnectionsScreen.tsx   presentational: the ready-made cards, the list of servers, and the form of one
  login/
    accounts.ts       the names of the accounts a subscription login is made with
    SubscriptionsScreen.tsx   presentational: one row per account, Conectar or Desconectar
```

Presentational components take props and call back; hooks own the side effects; `chat-client.ts`
is framework-free, so it is tested against a fake `WebSocket` (`test/fake-web-socket.ts`).

## What it guarantees

- **The token** of the local channel (DK-3 AC3) goes from the snapshot to the chat client and to
  the socket's second subprotocol. It is never in a URL, the DOM, a log or storage.
- **The conversation** is kept by the daemon, never by the window (DK-16): the window holds it in
  memory only, never in storage. When its chat is empty and the connection opens, it asks for the
  stored conversation (`history`) and shows it, Telegram included; a daemon that restarts while
  the chat shows messages adds nothing. "Borrar conversación" asks first, sends `clear_history`
  and empties the chat on `done`; otherwise the messages stay and the chat says why. Opening the
  setup hides the chat without unmounting it.
- **The expenses** are read, never written (DK-17): the Gastos screen opens its own connection to
  the local channel, asks for a month (`expenses`) and shows what the daemon read from its views,
  with each expense's mode. It keeps nothing once closed.
- **Memoria** (DK-18) opens its own connection to the channel and asks for `memories` and
  `actions` each time it opens. "Olvidar" asks first and sends `forget_memory` or
  `forget_action`; the daemon also erases the turns of the stored conversation that say it, so
  the chat then asks for it again. Nothing of either list is kept by the window.
- **A reply is plain text** (DK-4 AC1): shown exactly as received, line breaks kept, never HTML
  or Markdown.
- **Delivery honesty.** A `rejected` request did nothing: the window says it was not sent and
  offers to send it again. A connection lost while a request was in flight may have reached the
  daemon: the window says it does not know, and offers no one-click resend that could register
  an expense twice. A button press can always be pressed again: a closed question answers S-19.
- **Files** dropped, pasted or picked wait in the composer and go as one `receipt`, at most 10
  and at most 45 MB together (the daemon closes a connection whose frame is over 64 MB). A file
  that is not an image is sent as it is, so the daemon answers as it would in Telegram (DK-4 AC6).
- **The chat decides the way** (DK-13). The composer has no modes: every message goes as it is,
  and the daemon may answer a plain text with a `route` to a look at the screen or a task on the
  computer, in its own words ("Miro tu pantalla.", "Me pongo con ello en tu ordenador."). The
  window starts it at once (`launch` in `use-chat.ts`); a route in the answer to anything but a
  plain text is ignored, and the client keeps one only as `{ to: 'screen' | 'computer', task }`.
  What was started is shown under the reply that announced it; one that did not leave says so
  and starts again as what it is, never as a plain text. Where the window cannot capture or act,
  it says so. A task with connections asked in words is run by the daemon itself.
- **The model** (`ANOMANDER_MODEL` of the setup) is named under the composer in small type, as
  the setup holds it; nothing is shown when none is set.
- **The screen** (DK-9) is captured when the daemon routes the principal's words to a look, with
  the window hidden for that moment. The capture is shown in the conversation and sent at once
  as a `screen` request with the principal's words. The shell keeps its file only while reading
  it. It needs macOS's Screen Recording permission, which belongs to the signed app.
- **A task on the computer** (DK-10) starts when the daemon routes the words to one. Each step is a
  `computer` request with a fresh capture; the daemon answers one proposed action and whether
  it is routine (`confirm: false`). A routine step is performed at once and shown as done.
  There is one task at a time (`run` in `computer-task-session.ts`): a new task or "Detener tarea" ends the
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
- **The shell reads the screen before it acts** (T1b, after gentle-dot's `computer/risk.rs` and
  `blocklist.rs`). Right before the input it reads, through the Accessibility API
  (`computer/ax.rs`), the element under the point and its ancestors for a click, and the focused
  element with its window's default button for keys and text. `perform_action` takes
  `permitted`, which the window sets only after "Permitir". A step nobody permitted is performed
  only when the screen shows a routine one (`computer/risk.rs`): a click on a control whose name
  is of care (or says nothing), Enter or Space anywhere but in a search or address field (its
  subrole `AXSearchField`, or a name or hint with search, buscar, búsqueda, dirección, address or
  URL, and not a mail address), text typed anywhere but into a field, and anything whose element
  or app cannot be read answer `computer_careful:<role>:<name>` (or just `computer_careful`).
  The chat then shows the step with "Permitir", as if the daemon had asked, and says what the
  screen showed: a click is said again with the control's own name, other steps get a note
  ("En pantalla: campo «Escribe un mensaje»."). Before reading, the shell asks the app with the
  focus to expose its page (`AXManualAccessibility`, for Electron apps); it reads at most 512
  characters of an attribute and never a field's typed value. The words of care are one list,
  `packages/protocol/src/careful-words.json`, read by the daemon and embedded in the shell; both
  compare them in lower case after NFKD, without marks or invisible characters, and test the
  same examples. No action reaches an app of the blocklist (`computer/blocklist.rs`), permitted
  or not: ANOMANDER itself, System Settings, SecurityAgent, loginwindow, the system's permission
  and authentication prompts, Keychain Access, Passwords, 1Password, Bitwarden, Dashlane,
  LastPass, KeePassXC, Enpass, Proton Pass, NordPass and Keeper; the shell answers
  `computer_blocked:<app>` and the chat ends the task with "No actúo sobre <app>: es una app
  protegida. He detenido la tarea."
- **A task with connections** (DK-11) is asked in words, as a plain text the daemon routes
  (DK-13). The daemon runs it; a call that needs permission arrives as a reply with
  "Permitir" and "Detener" buttons, pressed like any other. The servers are the ones of
  `mcp.json` in the data folder, which the principal writes by hand or from the connections
  screen:

  ```json
  {
    "mcpServers": {
      "notes": { "command": "npx", "args": ["-y", "some-notes-mcp@1.4.2"], "readOnly": ["search"] },
      "remote": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer …" } }
    }
  }
  ```

  Name an exact version (`some-notes-mcp@1.4.2`): `npx -y` with a bare name runs whatever the
  registry serves that day, without asking.

  **Connect only servers you trust.** A server started by `command` runs as a child of the
  daemon, which is a child of the app, and macOS charges a child's privacy permissions to the app
  that started it (its "responsible process"): such a server can expect to record the screen and
  type or click (Screen Recording, Accessibility) without a prompt, counted as ANOMANDER. This
  follows from how macOS works; it has not been tried with a real server. `readOnly` and "Permitir"
  decide which tool calls the daemon makes, not what the server's process does on its own. A
  `url` server runs elsewhere and gets none of this.

  Only the tools listed in `readOnly` run without asking. The daemon reads the file when it
  starts. Just before, the shell moves every value of `env` and `headers` to the Keychain
  (`src-tauri/src/connection_secrets.rs`) and rewrites the file with `@keychain` in their place,
  so a token is in the file only until the next start. To change a value, write the new one over
  its `@keychain` and restart the app; a value whose server or name leaves the file leaves the
  Keychain too, and `"mcpServers": {}` removes them all. A renamed server or variable needs its
  value written again: until then, and while any server is not as the daemon reads it, nothing
  is removed. A missing file, or one that is a link, is
  left alone with what is stored. The rewrite keeps the order of the servers and normalises the
  spacing; a file saved while it is being swept is left for the next start.
- **The connections screen** (DK-11, the plug button of the status bar) lists the servers of
  `mcp.json` and adds, edits or removes one at a time: its name, a command with its arguments or
  a URL, its `env` or `headers`, and its `readOnly` tools. The file stays the source of truth
  and its format does not change: the shell (`src-tauri/src/connections.rs`) reads it as the
  daemon does, rewrites only the server that was changed, in its place, and leaves the others as
  written. A file the daemon would refuse (another key, as the `"type"` other clients write; a
  URL that is not `https` or `http` to this machine), or one that is a link, is shown as such
  with where it is wrong, and is never rewritten: it is fixed by hand. A value typed in the
  screen goes to the Keychain under `mcp/<server>/<env|headers>/<name>` and the file gets
  `@keychain`; the window is told the names and whether each has a value, never a value. A value
  left untouched is kept, also through a rename of its server, whose stored values are copied
  to the new name; what the file no longer names leaves the Keychain at the next sweep, as
  above. A save starts the daemon again, which reads the file at its start, and so ends a task
  that was running; a daemon that is stopped stays stopped and reads the file when it is next
  started.
- **Ready-made connections** (DK-11 AC12): the screen opens on "Conectores", one card with one
  "Conectar" each: Notion (`https://mcp.notion.com/mcp`), Linear (`https://mcp.linear.app/mcp`),
  Atlassian (`https://mcp.atlassian.com/v2/mcp`) and web search (below). A remote one
  (`OAUTH_CONNECTIONS` in `packages/protocol`) is saved by its address through `save_connection`,
  with no tool read-only, and then connected with `connect_oauth`, as its row's "Conectar con
  OAuth" would: each server's authorization server takes dynamic client registration (checked
  on 2026-11-21). A server already in the file at that address is only authorized; one
  authorized shows "Conectado". The form for any other server is behind "Avanzado", unchanged.
- **Web search** (DK-11 AC11, DK-13 AC5): while no server is named `Internet`, the connections
  screen offers the "Búsqueda web" card. One press saves, through the same `save_connection` as
  the form, `WEB_SEARCH_CONNECTION` from `packages/protocol`:

  ```json
  {
    "mcpServers": {
      "Internet": {
        "command": "npx",
        "args": ["-y", "pi-web-access@0.48.0"],
        "env": { "npm_config_ignore_scripts": "true" },
        "readOnly": ["web_search", "get_search_content"]
      }
    }
  }
  ```

  The version is pinned; `-y` only lets `npx` fetch that version without a prompt nobody would
  see. Its own dependencies are version ranges, not pinned, so `npm_config_ignore_scripts` keeps
  npm from running their install scripts (the value moves to the Keychain like any other). A
  search runs without "Permitir". Reading a page (`fetch_content`) always asks, with its exact
  address, and so does a search with `provider`, `proxy` or `includeContent`: the daemon applies
  these rules to any program that runs `pi-web-access`, whatever `readOnly` says. GitHub cloning
  and the provider can only be set in the package's `web-search.json`, so the preset leaves
  them. What leaves the Mac, as the screen says: the package from npm the first time; with no
  key and no `~/.pi/agent/web-search.json`, what is searched goes only to Exa's hosted MCP
  (`mcp.exa.ai`); pages are read from this Mac after "Permitir"; that file, when present,
  applies its keys, providers and proxy. It needs Node 22.19 or later on the daemon's `PATH`.
  The chat's interpreter is told the connected tools with a one-line purpose, so "búscame dónde
  comprar…" goes to this connection and never to the computer; with no search connection the
  reply says how to add it.
- **OAuth** (DK-11 AC10): a server reached by its URL has "Conectar con OAuth". The shell
  (`src-tauri/src/oauth_connect.rs`) runs `packages/daemon/scripts/mcp-oauth.ts` with Node,
  opens the authorization address it prints with `/usr/bin/open` only when it is `https` (or
  `http` on this machine), and keeps the client and tokens it prints in the Keychain item
  `mcp-oauth`, with the server's URL, never sending them to the window. That store, and
  "Olvidar OAuth", run under `Supervisor::while_stopped`, so a token the daemon refreshes
  meanwhile cannot overwrite them; the daemon starts again after if it ran. At each start the
  tokens of a server no longer in `mcp.json` at that URL are dropped, the rest go in
  `ANOMANDER_MCP_OAUTH` on the daemon's stdin (none while `mcp.json` is a link or cannot be read, or while the
  Keychain cannot give them: the daemon starts without them), only their tokens
  and client secrets are hidden from the daemon's output, and each `anomander mcp-oauth` line
  the daemon prints is stored and never forwarded. One connection runs at a time
  (`Core::oauth_turn`); the screen can be closed while the browser waits.
- **Link buttons** (`{label, url}`) are named, not offered: this WebView cannot open links, and
  `/login` stays in Telegram (DK-4 AC7); the app's own way to log in is the subscriptions
  screen below.
- **The subscriptions screen** (DK-15, the key button of the status bar, also linked from the
  models section of the setup) lists the accounts a subscription login is made with (ChatGPT,
  Kimi Code; Claude and GitHub Copilot only while a login of them is stored) with "Conectar" or
  "Desconectar". The shell (`src-tauri/src/login.rs`) runs
  `packages/daemon/scripts/login.ts --shell <account>` with Node and a cleared environment,
  opens the login page it prints with `/usr/bin/open` only when it is `https` (or `http` on
  this machine), tells the window each step on `shell://login` (the browser opened, a device
  code to show, the flow waits for the address the browser ended on) and keeps the credential
  the script prints once at the end in the Keychain item `model-login` under
  `Supervisor::while_stopped`, so the daemon's next start gets it. The pasted address goes from
  an uncontrolled field to the shell and to the script's stdin as one line, then the field is
  emptied. One login runs at a time (`login::Session`); the screen can be closed while the
  browser waits. The window never sees a token: only which accounts are connected.
- **Telegram is optional** (DK-5 AC4). `Core::prepare` (`src-tauri/src/shell.rs`) hands the
  daemon the bot token and `ANOMANDER_PRINCIPAL_CHAT_ID` only when both are stored; otherwise the
  local channel is its only front door. Without Telegram and without a model it is
  `not_configured`. `apply_setup` (`src-tauri/src/setup.rs`) and the setup screen refuse half of
  Telegram; a token stored before counts as typed, and an empty chat ID leaves it unused.
- **Secrets** typed in the setup screen, or as a value in the connections screen, stay in
  uncontrolled fields and a ref, never in React state or a DOM attribute, and are dropped once
  saved. Stored secrets are never sent to the window: it only knows whether each one is stored.
- **Snapshots** carry no sequence number, so an event that arrived while a command was on its
  way wins over that command's answer.

- **The secrets reach the daemon on its stdin** (DK-5 AC2), never in its environment, which
  `ps eww` shows to every process of the principal. `child_env` (`src-tauri/src/daemon/launch.rs`)
  gives the daemon the plain setup and `ANOMANDER_SECRETS_ON_STDIN=1`; `handover_line` puts the
  bot token (only with Telegram), the provider keys, `ANOMANDER_AUTH_JSON`, `ANOMANDER_MCP_SECRETS`,
  `ANOMANDER_MCP_OAUTH` and `ANOMANDER_LOCAL_TOKEN` in one JSON line, which the supervisor writes
  once to the daemon's stdin right after it starts, from its own thread. The pipe then stays open
  only so the daemon stops when it closes (DK-1 AC1).
- **The model login** (DK-5 AC1) lives in the Keychain item `model-login`. The shell hands it to
  the daemon as `ANOMANDER_AUTH_JSON` on its stdin, and the supervisor takes each line the daemon starts with
  `anomander credentials ` out of its output and stores it (`Core::login_handler`); that line is
  never forwarded. An `auth.json` left in the data folder is merged in at a start and removed
  once stored. A login made from the subscriptions screen (DK-15) joins the same item.
- **Field logs** (DK-6 AC4) are in `~/Library/Logs/dev.anomander.desktop/anomander.log`
  (folder `700`, files `600`), set aside at 1 MB with 5 files kept (`anomander.1.log` the newest
  older one). Everything the shell prints and the daemon's lines it forwards go there
  (`src-tauri/src/diagnostics/`): the shell's stdout and stderr become pipes whose lines go on to
  the terminal unchanged and to the file scrubbed by `daemon::output::scrub` of every secret the
  run has known (the launch token, and each start's `LaunchSpec.secrets`). The lines that hand
  over a login or OAuth tokens are never forwarded, so they never reach it. "Copiar diagnóstico"
  in the menu bar copies a plain-text report: the app's version, the macOS version, the daemon's
  state in the menu's words and the last 200 lines of the log, scrubbed again; nothing else. The
  daemon logs references, reasons and amounts, never what the principal wrote (§16); an error
  from a provider or a connected server is logged as it came.
- **A ledger from Docker** (DK-12) is imported from the setup screen's link: the principal
  pastes the full path of a file they copied out of the volume. The shell runs
  `packages/daemon/scripts/import-ledger.ts` with the daemon stopped (`Supervisor::while_stopped`:
  no start runs meanwhile) and shows the one word it printed. Only an empty ledger is replaced,
  and it is moved aside, never deleted; the source is only read. There is no file dialog: it
  would be a new plugin and capability.

## Design

The window borrows the app icon's three colours and nothing else: bone paper in light, ink in
dark, and one ember accent, kept for what the principal can do next and for the status light
(the icon's ring and dot, lit while the daemon runs). The daemon's words sit on the surface as
plain text; only what the principal sent is boxed. System font, a 13-point utility scale, a
4-point spacing scale, both themes checked for WCAG AA, motion only for a message arriving and
for work in progress, and none under `prefers-reduced-motion`. The tokens are at the top of
`src/styles.css`.
