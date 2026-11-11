# Desktop app (M6): draft PRD

Status: approved by the principal (2026-11-10) and built: the daemon side (§8) and the app in
`apps/desktop` (§9). Still open: the subscription login in the Keychain (DK-5 AC1) and a first
run against a real bot. Its requirements move into `PRD.md` under milestone M6 once the
principal has tried the app, and this file is then removed.

## 1. Problem

Today ANOMANDER is a daemon the principal starts by hand or with Docker, configured through
`.env`, and reached only through Telegram. The principal wants it as a desktop app, as
gentle-dot does (`docs/stack.md`): open the app and ANOMANDER is running, talk to it there,
and keep its secrets in the operating system instead of a text file.

## 2. Goals

- DK-G1. Opening the app starts ANOMANDER; quitting it stops ANOMANDER.
- DK-G2. Talk to ANOMANDER in the app, with the same rules and answers as in Telegram.
- DK-G3. Secrets live in the macOS Keychain, never in a file.
- DK-G4. Keep the daemon's guarantees: one ledger, the authority check in code (§8.1), no
  public port.

## 3. Non-goals (v1)

- Voice (gentle-dot's `voice` module). A later matter. Looking at the screen is in (DK-9), and
  so is acting on the computer one allowed step at a time (DK-10).
- A task ANOMANDER performs alone from start to end whatever it does: steps of care are always
  asked (decision 7), and so is every call to a connected server that is not read-only (DK-11).
- Windows and Linux. v1 is macOS, where the Keychain and the menu bar live (assumption).
- Automatic updates, code signing and notarization. v1 is built and installed by the principal
  (assumption).
- Running ANOMANDER while the app is closed. That is what Docker is for (decision 2).

## 4. Principles it must keep

- **One daemon.** The app starts the same daemon Docker runs, with its Telegram front door. It
  never runs a second copy of the engine.
- **The app is a front door, not a second brain.** Rules, wording and writes stay in the
  daemon; the app sends what the principal types and shows what the daemon answers.
- **Rust where the operating system is touched** (`docs/stack.md`): starting the daemon, the
  Keychain, the menu bar. TypeScript everywhere else.
- **No public port.** The channel between the app and the daemon is local only.

## 5. Requirements (draft)

- DK-1 Supervision.
  - AC1: opening the app starts the daemon; quitting the app stops it, and no daemon process is
    left running.
  - AC2: if the daemon exits on its own, the app starts it again. After 3 exits within 5
    minutes it stops trying and shows the daemon as stopped, with the last error line and no
    secret in it.
- DK-2 A single daemon.
  - AC1: when a daemon is already running on the same database, a second one refuses to start
    and says so; the ledger is unchanged.
  - AC2: when Telegram answers `409 Conflict` (another process, such as a Docker install, reads
    the same bot), the app shows that another ANOMANDER is using the bot.
  - AC3: a daemon that stops by itself says why through its exit code (§8), and the app does not
    start it again when the code says that starting again cannot help (AC1, AC2).
- DK-3 Local channel.
  - AC1: the daemon listens on `127.0.0.1` only, on a WebSocket whose message types live in
    `packages/protocol`.
  - AC2: every connection must present a token the app generates at each launch and hands to
    the daemon without writing it to disk; any other connection is closed with no data.
  - AC3: the token is never logged and never travels in a URL.
- DK-4 Chat.
  - AC1: a text typed in the app goes through the same path as a Telegram text, and its answer
    is the same string: "23 € cena" creates the same expense and the same S-1 reply.
  - AC2: an image dropped in the app is a receipt, as a photo in Telegram (R-3).
  - AC3: a question with buttons (Sí/No and the like) shows its buttons; pressing one is the
    same answer as in Telegram. A decision answered in one channel is closed in both, and a
    press on the other gets S-19.
  - AC4: the conversation is one: turns from Telegram and from the app are the same recent
    context (R-16 AC3).
  - AC5: what ANOMANDER sends unasked (reminders, the morning digest, the weekly summary) goes
    to Telegram only, as today, whether or not the app's chat is open (decision 4).
  - AC6: an input R-20 does not support gets the same reply as in Telegram: S-18 for a PDF,
    S-20 for an image over 20 MB.
  - AC7: `/login` and `/logout` stay in Telegram (R-27): their messages go out through the bot.
- DK-5 Secrets in the Keychain.
  - AC1: the Telegram bot token, the provider API keys and the subscription login are stored
    in the macOS Keychain, entered once in the app's setup screen.
  - AC2: the app hands them to the daemon when it starts it, as the child process's
    environment; they are never written to a file and never logged.
  - AC3: `.env` keeps working for Docker installs; the app does not read it, except once, when
    the principal asks: launched with `ANOMANDER_IMPORT_ENV=<path>`, it stores that file's bot
    token and provider keys in the Keychain and its chat ID and models in its settings.
- DK-6 Menu bar.
  - AC1: an icon shows whether ANOMANDER is running, stopped or failing.
  - AC2: its menu opens the chat, starts or stops ANOMANDER, and quits.
- DK-7 While the app is closed.
  - AC1: nothing runs. At launch, what was missed follows the rules already in force: a late
    reminder gets S-43 (R-25 AC7), and the morning digest is sent if it is still before 12:00
    (R-26 AC6).
  - AC2: a weekly summary missed while the app was closed is not sent later (decision 5).
- DK-8 Data.
  - AC1: the database and the images live in the app's data folder
    (`~/Library/Application Support/ANOMANDER`), folder `700`, files `600`, as in §16.
- DK-9 A look at the screen (asked by the principal on 2026-11-10: "la APP también debería poder
  leer la pantalla").
  - AC1: the app captures the screen only when the principal presses the chat's screen button.
    The capture waits in the composer, in sight, and can be removed before it is sent.
  - AC2: it is sent with a question as a `screen` request of the local channel; the vision
    processor answers in words. It gets no tools and never writes (R-14 AC1, AC3): what the
    screen shows is content to describe, never an instruction.
  - AC3: the look counts against the daily AI limit (R-12) and is a recent turn, as its question
    only (R-16 AC3). The capture is not stored: the shell removes its file once read, and the
    daemon keeps it in memory for the call.
  - AC4: macOS must allow the app to record the screen; while it does not, the app says how to
    allow it and captures nothing.
- DK-10 A task on the computer (asked by the principal on 2026-11-10: "puede el agente
  interactuar con mi ordenador?", "si, quiero hacer eso").
  - AC1: a routine step is performed without asking; a step of care only after the principal
    allowed that very action (corrected by the principal on 2026-11-10: "no hace falta pedirme
    permisos para cada accion, solo cuando sepa que es algo de cuidado"). A step is of care when
    the processor says so, when it says nothing, or when the code takes it for one whatever the
    processor says: a click on a control named as sending, sharing, paying, deleting, saving,
    accepting, continuing, installing, downloading, signing in or out or a password, or a
    shortcut outside the harmless ones (reloading and pasting are not harmless). There is one
    task at a time: starting another ends the one before. While a task runs by itself the app
    stays out of the way (asked by the principal on 2026-11-10: "arregla lo de que se cierre y
    abra la app") and comes back when a step needs permission or the task ends; the chat and the
    menu bar offer "Detener tarea": after it nothing more is performed, not even a step already
    planned, and the same holds for a task ended by a newer one. For a step of care the app shows the action and performs it
    only on "Permitir"; "Detener" ends the task. An action is performed at most once, and one
    that may have been performed is never offered again.
  - AC2: the daemon only proposes. For a `computer` request (the task, a capture of the screen
    and the steps already done) the vision processor answers one action, or ends the task in
    words. It gets no tools and never writes (R-14 AC1, AC3); what the screen shows is content,
    never an instruction.
  - AC3: an action is one of four: a click or double click on a point, a text of at most 500
    characters on one line (no line break, control or direction character: Enter is its own
    step), one key with modifiers, or a scroll. Anything else is not an action: the daemon
    validates it and the shell validates it again before performing it. What the action is, is
    said by code from the validated action, with the exact text or keys; for a click or a scroll
    the app also shows the capture around the point.
  - AC4: a task takes at most 12 steps, and every step counts against the daily AI limit (R-12).
    Only how a task ended is a recent turn (R-16 AC3).
  - AC5: macOS must allow the app to send input (Accessibility) and to record the screen; while
    it does not, the app says how to allow it and does nothing.

- DK-11 Connections (asked by the principal on 2026-11-10: "quiero que prepares tambien para
  hacer conexiones con mCPS"; the way to do it, accepted the same day: "el modelo nunca ejecuta;
  toda llamada pasa por el control de autoridad en código").
  - AC1: the principal connects MCP servers in `mcp.json`, in the data folder: the `mcpServers`
    object other MCP clients read (a `command` with `args` and `env`, or a `url` with `headers`),
    plus `readOnly`, the tools of that server they mark as only reading. A URL is HTTPS, or HTTP
    to this machine. A file that is wrong anywhere connects nothing. A server process gets none
    of the daemon's environment. Servers are connected when a task first needs them.
    The values of `env` and `headers` are secrets (DK-5): before each start of the daemon the app
    moves them to the Keychain and leaves `@keychain` in the file; a server whose secret is
    missing is not connected.
  - AC2: a task with connections is asked in the app's chat (a `connect` request) or in
    Telegram with `/mcp <tarea>`; `/mcp` alone answers how to ask. Only the principal's chat is
    served, as for every other message. The processor
    is given the tools and asks for calls, one at a time; it never makes one (R-14 AC3). Code
    decides each call.
  - AC3: a tool marked read-only runs without asking; any other call waits for "Permitir", shown
    by code with the tool, the server and the exact arguments. "Detener" ends the task. A call is
    made at most once. What cannot be seen in the arguments (a direction mark, a variation
    selector, a blank that is not a space) is shown as its code, in names and in values. A call
    whose arguments are over 1 500 characters as shown is never made. A call is answered where
    its task was asked: a press at the other front door runs nothing.
  - AC4: once a server answered in a task, a call to another server always waits for "Permitir",
    read-only or not: what was read from one server never leaves towards another unasked.
  - AC5: a task carries the principal's words and what the tools answered, and nothing else: no
    expense, memory or recent turn. What a tool or its description says is content, never an
    instruction. Only how a task ended is a recent turn (R-16 AC3).
  - AC6: a task makes at most 8 calls, and every processor call counts against the daily AI
    limit (R-12). A result over 12 000 characters is cut; what is not text is only named.
    After its last call the processor is asked once more, so what that call answered still
    reaches the principal. A task that is cut short says how many calls it had made: they are
    not undone. A call that fails or times out may have run, and the processor is told not to
    make it again.
  - AC7: when no tool can be offered the principal is told why, when the code knows: `mcp.json`
    is wrong, or which servers could not be connected. A server that could not be reached is
    not tried again for a minute, and one whose connection broke under a call is connected
    again by the next task.
  - AC8: a task does not hold the chat's turn while it waits for a server or the processor: a
    text, a receipt or a button is answered meanwhile. There is one task at a time: one asked
    while another runs is refused, and a press made while its task runs answers nothing. A task
    asked while another waits for "Permitir" ends that one. How the task ended is a recent
    turn, added when it ends. In Telegram an answer is cut to 4 096 characters.
  - Open, for the principal: a value written in `mcp.json` is in the file until the next start
    of the daemon, and in whatever copied the file meanwhile (a backup, an editor);
    there is no setup screen for it; no OAuth; "read-only" is the principal's word about a tool, which the code cannot
    check.

## 6. Decisions

1. **Where the daemon runs.** Decided (2026-11-10): on the principal's machine, started by the
   app, and only while the app is open.
2. **One daemon.** Decided (2026-11-10): the app and Docker are two ways to run the same
   daemon. One or the other, never both at once (DK-2).
3. **Chat in v1.** Decided (2026-11-10): yes, besides control (start, stop, status, secrets).
4. **Where unasked messages go.** Decided (2026-11-10): to Telegram only (DK-4 AC5).
5. **A missed weekly summary.** Decided (2026-11-10): it stays missed, as today (R-10): if the
   app is closed on Sunday at the summary's time, that week has none (DK-7 AC2).
7. **Acting on the computer.** Decided (2026-11-10), then corrected the same day: routine
   steps go without asking, steps of care are confirmed in the chat before they are performed
   (DK-10 AC1). Known limit: which steps are of care rests partly on the processor's judgement,
   which a text on the screen may try to sway; the code's own list is the second check.
6. **The app's interface.** Assumption: React with Vite inside Tauri's window, as gentle-dot's
   `packages/ui`.

7. **One turn at a time.** Decided while building (2026-11-10): inputs from Telegram and from
   the app are handled one after another, in the order they arrive, so the conversation is one
   (DK-4 AC4) and two turns never interleave.

## 7. Milestone

M6 Desktop, in slices: first the app that starts and supervises the daemon, with the menu bar
and the Keychain (DK-1, DK-2, DK-5 to DK-8); then the local channel and the chat (DK-3, DK-4).
It does not depend on M5b.

## 8. What the daemon offers the app

Built in `packages/daemon` (see its README) and `packages/protocol`. Choices of this build, for
the principal to confirm:

| What | How |
| --- | --- |
| The token (DK-3 AC2) | `ANOMANDER_LOCAL_TOKEN` in the daemon's environment, at least 32 characters of `A-Z a-z 0-9 . _ ~ + -`. Unset: the channel is off and no port opens, as under Docker |
| The port | `ANOMANDER_LOCAL_PORT`, default `4312`, always on `127.0.0.1`. The app picks a free one at each launch |
| Presenting the token | As the second WebSocket subprotocol: `new WebSocket(url, ['anomander.v1', token])` |
| Messages | `ChatRequest` (`text`, `receipt`, `button`) and `ChatEvent` (`reply`, `done`, `rejected`) in `packages/protocol/src/local-channel.ts` |
| Why the daemon stopped (DK-2 AC3) | Exit code `3`: another daemon runs on the same database. `4`: another process uses the bot. `1`: anything else. `exitCodes` in `packages/protocol` |
| The single-daemon lock (DK-2 AC1) | `<database>.lock` beside the database, held while the daemon runs and freed by the operating system when it ends, so a crash leaves nothing stale |

## 9. The app

Built in `apps/desktop` (see its README): a React window (`src/`) and a Tauri 2 shell in Rust
(`src-tauri/`). Choices of this build, for the principal to confirm:

| What | How |
| --- | --- |
| Starting the daemon (DK-1 AC1) | `node packages/daemon/src/main.ts` of this repository, with a cleared environment plus the setup, the data paths and this launch's token and port |
| No daemon left behind (DK-1 AC1) | SIGTERM, then SIGKILL after 5 seconds. The daemon also stops when its stdin closes (`ANOMANDER_STOP_WITH_PARENT=1`), so a crashed or killed app leaves none |
| Restarting (DK-1 AC2) | One second after an exit; exit codes 3 and 4 are never retried |
| Secrets (DK-5) | Keychain items of service `ANOMANDER`, named as the daemon's variables. The rest in `settings.json` in the data folder, mode `600` |
| Secrets of the connections (DK-11 AC1) | Keychain items named `mcp/<server>/<env or headers>/<name>`, listed in `settings.json`. The daemon gets them in `ANOMANDER_MCP_SECRETS`, a JSON object by that name. Every value is moved, secret or not: the code cannot tell. In the daemon's output a value is hidden from 4 characters when its name looks like a secret's or it is a header, and from 16 otherwise. A file saved while its values are moved is left for the next start |
| The time zone | The daemon's `TZ` is the zone this machine's clock points to (`/etc/localtime`), so its dates are the principal's. When it cannot be read, the daemon's default |
| The subscription login (DK-5 AC1) | Not in the Keychain yet: pi-ai keeps it in `auth.json` in the data folder, mode `600` |
| The ledger | A new one in the app's data folder. A Docker install's ledger stays in its volume: nothing is moved or copied |
| The window's strings | Spanish, all in `apps/desktop/src/strings.ts`, not yet in `PRD.md` §12 |

