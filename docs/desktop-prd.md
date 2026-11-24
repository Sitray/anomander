# Desktop app (M6): draft PRD

Status: approved by the principal (2026-11-10) and built: the daemon side (§8) and the app in
`apps/desktop` (§9), with the points asked on 2026-11-11 ("haz esos puntos"): the connections
screen and OAuth (DK-11 AC9, AC10), tasks with connections from Telegram (DK-11 AC2), a task that
does not hold the chat (DK-11), the ledger from Docker (DK-12) and the subscription login in the
Keychain (DK-5 AC1), the subscription login from the app (DK-15, asked on 2026-11-20), and the
conversation that survives the app and the daemon (DK-16, asked on 2026-11-24). Still
open: a first run against a real bot, against a real server that asks for OAuth, and of a
subscription login in the app. Its requirements move into `PRD.md` under
milestone M6 once the principal has tried the app, and this file is then removed.

## 1. Problem

Today ANOMANDER is a daemon the principal starts by hand or with Docker, configured through
`.env`, and reached only through Telegram. The principal wants it as a desktop app, as
gentle-dot does (`docs/stack.md`): open the app and ANOMANDER is running, talk to it there,
and keep its secrets in the operating system instead of a text file.

## 2. Goals

- DK-G1. Opening the app starts ANOMANDER; quitting it stops ANOMANDER.
- DK-G2. Talk to ANOMANDER in the app, with the same rules and answers as in Telegram.
- DK-G3. Secrets live in the macOS Keychain (on Windows, the Credential Manager), never in a file.
- DK-G4. Keep the daemon's guarantees: one ledger, the authority check in code (§8.1), no
  public port.

## 3. Non-goals (v1)

- Voice (gentle-dot's `voice` module). A later matter. Looking at the screen is in (DK-9), and
  so is acting on the computer one allowed step at a time (DK-10).
- A task ANOMANDER performs alone from start to end whatever it does: steps of care are always
  asked (decision 7), and so is every call to a connected server that is not read-only (DK-11).
- Linux. v1 is macOS, where the Keychain and the menu bar live (assumption). Windows runs the
  app from source too (README, "Run the app on Windows"): the chat, setup, connections, login,
  Telegram, the tray and the drop; a look at the screen (DK-9) and tasks on the computer (DK-10)
  are macOS-only for now.
- Automatic updates, code signing and notarization. v1 is built and installed by the principal
  (assumption).
- Running ANOMANDER while the app is closed. That is what Docker is for (decision 2).

## 4. Principles it must keep

- **One daemon.** The app starts the same daemon Docker runs, with its Telegram front door when
  Telegram is set up; Telegram is optional in the app (DK-5 AC4). It never runs a second copy of
  the engine.
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
    context (R-16 AC3) and the same stored conversation, which the daemon keeps and the app's chat
    shows again (DK-16).
  - AC5: what ANOMANDER sends unasked (reminders, the morning digest, the weekly summary) goes
    to Telegram only, as today, whether or not the app's chat is open (decision 4). Without
    Telegram (DK-5 AC4) it is not sent: a reminder waits and goes out late once Telegram is set
    up, the digest and the summary are skipped, and the other unasked messages are logged as not
    sent. What goes out is kept in the stored conversation (DK-16), so the app's chat shows it
    the next time it loads the conversation.
  - AC6: an input R-20 does not support gets the same reply as in Telegram: S-18 for a PDF,
    S-20 for an image over 20 MB.
  - AC7: `/login` and `/logout` stay in Telegram (R-27): their messages go out through the bot.
    The app has its own place for the same logins, the Suscripciones screen (DK-15); the chat
    does not offer them. While a login started in Telegram waits for a pasted code or address,
    the next text sent in the app's chat goes to it, as in Telegram (R-17 AC7): it is answered
    `done` and is never stored, logged, a recent turn or sent to the model.
- DK-5 Secrets in the Keychain.
  - AC1: the Telegram bot token (optional, AC4), the provider API keys and the subscription login are stored
    in the macOS Keychain, entered once in the app's setup screen. The login is made from
    Telegram (`/login`, DK-4 AC7) or from the app's Suscripciones screen (DK-15) and kept by
    the daemon in memory: the app hands it over at
    each start as `ANOMANDER_AUTH_JSON` on the daemon's stdin (AC2), and every change (a login, a logout, a token refresh)
    comes back on one line of the daemon's output that the app stores as the Keychain item
    `model-login` and never forwards. An `auth.json` found in the data folder at a start is
    merged into it, provider by provider, and removed once the merged login reads back.
  - AC2: the app hands them to the daemon when it starts it, on the child process's stdin, as
    one JSON object on one line named by the daemon's variables, never in its environment, which
    `ps eww` shows to every process of the principal; the environment says only
    `ANOMANDER_SECRETS_ON_STDIN=1`. They are never written to a file and never logged. Docker
    and the CLI, which never set that variable, keep reading the same variables from the
    environment (AC3).
  - AC3: `.env` keeps working for Docker installs; the app does not read it, except once, when
    the principal asks: launched with `ANOMANDER_IMPORT_ENV=<path>`, it stores that file's bot
    token and provider keys in the Keychain and its chat ID and models in its settings.
  - AC4: Telegram is optional (asked for launch, engineering audit Medium 9). The setup screen
    shows it as "Telegram (opcional)"; saving with both of its fields empty starts ANOMANDER with
    the app's chat as its only front door (no bot token or chat ID reaches the daemon), and half
    of it, a token without a chat ID or the reverse, is refused with a plain message. A token kept
    from before counts as typed. Without Telegram the app starts the daemon once a model is set;
    with nothing set it stays "Falta configurarlo" and the setup opens by itself.
- DK-6 Menu bar.
  - AC1: an icon shows whether ANOMANDER is running, stopped or failing.
  - AC2: its menu opens the chat, starts or stops ANOMANDER, and quits.
  - AC3: while ANOMANDER works (an answer owed, a task on the computer going by itself) the icon
    shows a wave. When the work ends a drop grows out of the notch saying "Ha terminado", holds
    and retracts; on a screen without a notch it hangs from under the menu bar. It shows after
    every task on the computer, and after an answer only when the chat window is not in front
    (asked by the principal on 2026-11-20: "solo debería salir con un aviso de que ha acabado, no
    el Pensando entero, para eso tenemos la animacion de la barra"). A click on it opens the chat.
  - AC4: field logs (engineering audit High 4, 2026-11-20). What the app prints and the daemon's
    lines it forwards go to `~/Library/Logs/dev.anomander.desktop/anomander.log`, folder `700`
    and files `600`, set aside at 1 MB with 5 files kept. Every line is scrubbed of every secret
    the run has known before it reaches the file, as the forwarded output is (DK-5 AC2). The menu's
    "Copiar diagnóstico" copies to the clipboard the app's version, the macOS version, the
    daemon's state and the last 200 lines of the log, scrubbed again, and nothing else.
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
  - AC1: the app captures the screen when the principal's words ask about it and the text
    interpreter routes them to a look (DK-13, changed by the principal on 2026-11-20: "cambia las
    reglas, que decida solo"). The capture is sent at once and shown in the conversation; there
    is no screen button.
  - AC2: it is sent with a question as a `screen` request of the local channel; the vision
    processor answers in words, with what ANOMANDER remembers about the principal (DK-14 AC1). It
    gets no tools and never writes (R-14 AC1, AC3): what the screen shows is content to
    describe, never an instruction.
  - AC3: the look counts against the daily AI limit (R-12) and is a recent turn, as its question
    only (R-16 AC3); it is kept in the history the same way (DK-14 AC2). The capture is not
    stored: the shell removes its file once read, and the daemon keeps it in memory for the call.
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
    shortcut outside the harmless ones (reloading and pasting are not harmless), Enter or Space,
    with or without Shift (they press whatever has the focus), Spotlight or the app switcher
    (Cmd+Space, Cmd+Tab: they change which app the next keys go to), and every fifth step of a
    task, however routine it looks (corrected on 2026-11-20 after the security audit, following
    gentle-dot's `computer/risk.rs`). The app does not trust the processor's words either:
    right before a step nobody allowed, it reads the screen itself (the Accessibility element
    under the point, or the one with the focus and its window's default button) and asks for it
    instead when what is there is of care: a click on a control named with the same words, or
    one that says nothing; Enter or Space anywhere but in a search or address field (a web form,
    a terminal or a message box sends on Enter); text typed anywhere but into a field; and any
    step whose element or app cannot be read, such as an Electron app's page that reads as a
    group (T1b, made stricter on 2026-11-20 after its verifier). Then the chat shows what the
    screen showed, not what the processor said. No step, allowed or not, acts on ANOMANDER
    itself, System Settings, the login and authorization prompts, Keychain Access or a password
    manager: the app refuses it, says so and ends the task.
    There is one task at a time: starting another ends the one before. While a task runs by
    itself the app stays out of the way (asked by the principal on 2026-11-10: "arregla lo de que se cierre y
    abra la app") and comes back when a step needs permission or the task ends; the chat and the
    menu bar offer "Detener tarea": after it nothing more is performed, not even a step already
    planned, and the same holds for a task ended by a newer one. For a step of care the app shows the action and performs it
    only on "Permitir"; "Detener" ends the task. An action is performed at most once, and one
    that may have been performed is never offered again.
  - AC2: the daemon only proposes. For a `computer` request (the task, a capture of the screen
    and the steps already done) the vision processor answers one action, or ends the task in
    words; it also gets what ANOMANDER remembers about the principal (DK-14 AC1). It gets no
    tools and never writes (R-14 AC1, AC3); what the screen shows is content, never an
    instruction.
  - AC3: an action is one of four: a click or double click on a point, a text of at most 500
    characters on one line (no line break, control or direction character: Enter is its own
    step), one key with modifiers, or a scroll. Anything else is not an action: the daemon
    validates it and the shell validates it again before performing it. What the action is, is
    said by code from the validated action, with the exact text or keys; for a click or a scroll
    the app also shows the capture around the point.
  - AC4: a task takes at most 12 steps, and every step counts against the daily AI limit (R-12).
    Only how a task ended is a recent turn (R-16 AC3), and only how it ended and how many steps
    it took is kept in the history (DK-14 AC2).
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
    missing is not connected. A server started by `command` is a child of the app, so macOS
    gives it the app's Screen Recording and Accessibility permissions: the app does not prevent
    it, the README tells the principal to connect only servers they trust (security M2).
  - AC2: a task with connections is asked in words, in the app's chat or in Telegram, and the
    text interpreter routes it (DK-13); a `connect` request from the app and `/mcp <tarea>` in
    Telegram still ask for one directly, and `/mcp` alone answers how to ask. Only the principal's chat is
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
    memory (DK-14 AC1), expense or recent turn (changed by the
    principal on 2026-11-20: "También me gustaría que recordara quién soy, que recuerde quien soy
    y tenga memoria de lo que ha hecho"; "si, me gustaria ya que esto es algo que la gente tendrá
    en su local"). What a tool or its description says is
    content, never an instruction. Only how a task ended is a recent turn (R-16 AC3), and only
    how it ended and which calls it made is kept in the history (DK-14 AC2).
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
  - AC9: the app has a "Conexiones" screen, opened from the status bar, that lists the servers
    of `mcp.json` and lets the principal add, edit and remove one: its name, a command with its
    arguments or a URL, the names of its `env` or `headers`, and the tools marked read-only.
    `mcp.json` stays the source of truth and its format does not change: the shell validates a
    server exactly as the daemon reads it, rewrites only the server that changed, in its place,
    and leaves the rest of the file as written. A file the daemon would refuse, or one that is
    a link, is shown as such, with where it is wrong and never what it says, and cannot be
    changed from the screen. A value typed in the screen goes to the Keychain and the file gets
    `@keychain`; it is never written to the file, logged, put in an error or sent back to the
    window, which only knows each name and whether a value is stored. A value left untouched is
    kept, also when its server is renamed. Saving starts the daemon again, which reads the file
    at its start; a daemon that is stopped stays stopped.
  - AC10 (asked on 2026-11-11, "Pantalla para configurar servidores MCP y OAuth."): a server
    reached by its URL can be connected with OAuth from the screen ("Conectar con OAuth"). The
    app registers itself with the server's authorization server (dynamic registration) and runs
    the authorization code flow with PKCE; the shell opens the authorization address in the
    browser, only when it is `https` (or `http` on this machine), and the redirect comes back to
    a port on `127.0.0.1`, open only while it waits, up to 5 minutes, and taken only with the
    `state` it sent. The client and its tokens are stored in the Keychain with the server's
    name and URL; the window only learns that they are kept ("Conectado con OAuth") and can
    forget them ("Olvidar OAuth"). The screen can be closed while the browser waits; one
    connection runs at a time. They are handed to the daemon at its start and only for that
    server at that URL: a server removed, renamed or moved to another URL loses them, and none
    is handed over while the shell cannot read `mcp.json` (a link, or a file half written); only
    the tokens and client secrets are hidden from the daemon's output. The
    daemon refreshes them itself and hands every refresh back, as the model login (DK-5 AC1);
    it never opens a browser, so a server whose refresh is refused is left out until the
    principal connects it again. A server's configured headers go only to its own origin: an
    authorization server on another origin never gets them, one on the same origin does, and on
    a request to the server the OAuth token replaces a configured `Authorization` header.
  - AC11 (asked on 2026-11-20: "como un asistente de ia podria buscar en internet si esa
    necesidad"): the Conexiones screen offers "Añadir búsqueda web" while no server is named
    `Internet`. One press saves, through the same path as the form, the server `Internet`:
    `npx -y pi-web-access@0.48.0` (MIT, pinned: never what npm calls latest), the variable
    `npm_config_ignore_scripts=true` (npm runs no install script), and `web_search` and
    `get_search_content` marked read-only. The preset is `WEB_SEARCH_CONNECTION` in
    `packages/protocol`. The daemon does not run that `npx` line (B9, 2026-11-24): the daemon
    depends on that exact version, so `pnpm-lock.yaml` pins it and everything it brings, and a
    server whose command and arguments are exactly the preset's starts that installed copy with
    the daemon's own `node`, in the Mac app, on Windows and in Docker alike. A file written
    before holds the same line and runs pinned too, with nothing to migrate; another version or
    another command runs as written. If the installed copy is missing or is another version, the
    server is left out, never run unpinned. A search runs without "Permitir"
    and AC4 holds for what it answered. Reading a page (`fetch_content`) always asks, showing
    its exact address, and so does a search carrying `provider`, `proxy` or `includeContent`:
    the daemon applies these argument rules (`asksWith`) to any program that runs
    `pi-web-access`, whatever its `readOnly` says, because one server that reaches any address
    could otherwise read a page (a GitHub URL is cloned with the user's own git credentials; a
    proxy can reach this machine) and carry it out in a second read-only call (verifier B1,
    2026-11-20). `source_check` asks. The package can turn GitHub cloning off and pin a provider
    only in its `web-search.json`, not by a variable or an argument, so the preset does
    neither; a page fetch asks anyway. The screen says beside the button what leaves the Mac:
    the package comes with ANOMANDER at a fixed version; with no key and no `web-search.json`
    what is searched goes only to Exa's hosted MCP (`mcp.exa.ai`), and another provider or a
    proxy asks first; pages are read from this Mac, after "Permitir"; a
    `~/.pi/agent/web-search.json`, when present, applies its keys, providers and proxy. It needs
    Node 22.19 or later. Once saved it is edited or removed like any other server. Since AC12
    it is one more card, "Búsqueda web", with the same press.
  - AC13 (asked on 2026-11-23: "la busqueda web deberia estar on por defecto", then "pues ve
    con la 2 y 3"): the web search comes on by default without leaving the principal unaware.
    The first setup (while it cannot start the daemon yet) shows "Búsqueda web" as a checkbox,
    checked, with AC11's note beside it; saving with it checked adds AC11's server through the
    same path as the card, before the setup is saved, so the daemon starts once. A server
    already named `Internet` is kept as it is; when the connection cannot be saved the setup is
    not saved either, and the screen says why. When the connection was saved and the setup is
    then refused, the screen also says the web search was added and stays on, removable in
    Conexiones (not when a server already had the name: nothing was added). Two adds at once (the
    setup, chat presses) save the file once: a later call through the same shell joins the add
    under way, and any other adds after it, with its own. Unchecked, nothing is added. A complete setup
    opened again does not show it: Conexiones does. And when the web search is missing, the
    chat offers it in one press (DK-13 AC5).
  - AC12 (asked on 2026-11-11: "Quiero algo parecido, que tenga como conectores bases que al
    darle a un botón de connect ya me conecte el MCP"; "Pero me gustaría que la parte de
    connectar a un MCP fuera más sencilla"; Google left out on 2026-11-21: "no hagas lo del oauth
    de google"): the Conexiones screen opens on "Conectores", one card per ready-made
    connection with one "Conectar": Notion (`https://mcp.notion.com/mcp`), Linear
    (`https://mcp.linear.app/mcp`), Atlassian (`https://mcp.atlassian.com/v2/mcp`, the endpoint
    that publishes its protected-resource metadata; v1 does not) and "Búsqueda web" (AC11). Each
    remote one was checked on 2026-11-21 to publish an authorization server with a
    `registration_endpoint`, so the app registers itself as AC10 does. A press saves the server
    by its address through the same path as the form, with nothing marked read-only (every call
    waits for "Permitir" until the principal marks a tool by hand), and then runs AC10's OAuth
    connection. A server already in the file at that address is only authorized, whatever its
    name; one authorized shows "Conectado" instead of "Conectar". The presets are
    `OAUTH_CONNECTIONS` in `packages/protocol`. The form of AC9 waits behind "Avanzado",
    unchanged, and its words are plain: "Claves y ajustes del programa" (`env`), "Claves de
    acceso" (`headers`) and "Herramientas que solo leen" (`readOnly`), each with a one-line hint.
  - Open, for the principal: a value written in `mcp.json` is in the file until the next start
    of the daemon, and in whatever copied the file meanwhile (a backup, an editor); a server
    whose authorization server does not take dynamic registration, or a redirect to a port of
    its choice, cannot be connected with OAuth; "read-only" is the principal's word about a
    tool, which the code cannot check.
- DK-12 A ledger from Docker (asked by the principal on 2026-11-11, "haz esos puntos", to
  "Copiar el ledger de Docker a la app").
  - AC1: the principal brings the ledger out of the Docker volume themselves (`docker compose
    stop`, then `docker compose cp daemon:/app/data/anomander.db <path>`): the app cannot reach
    the volume. In the setup screen, "¿Vienes de una instalación con Docker? Trae tu ledger"
    opens a screen where they type or paste its full path (or one from `~/`); there is no file
    dialog.
  - AC2: the import runs only into an app whose ledger holds no expense, and only a file that is
    an ANOMANDER ledger this build can migrate (every version in `schema_migrations` is known to
    it) and whose integrity check passes. Each refusal is said in its own sentence, and nothing
    changes.
  - AC3: the source is never written: its bytes, and its `-wal` when there is one, are copied
    first and only the copy is read. The copy gets mode 600. The app's own ledger, with its
    journal files (also ones left without it), is moved aside as
    `anomander.db.before-import-<UTC date and time>`, never
    deleted, and the copy takes its place. A failure leaves the app's own ledger where it was.
  - AC4: the daemon is stopped during the import, and nothing starts it meanwhile; it starts
    again after if it ran. Only the ledger comes: the setup of a Docker install is imported once
    with `ANOMANDER_IMPORT_ENV` (DK-5 AC3), and its receipts' images stay behind.
- DK-13 The chat decides the way (asked by the principal on 2026-11-20: "yo diciendoselo en el
  chat ya debería saberlo no hace falta que previamente le de a una opción para poder hacer que
  me controle el ordenador"; "cambia las reglas, que decida solo").
  - AC1: every chat text reaches the text interpreter with the ways its front door offers: the
    app offers a look at the screen, a task on the computer and a task with connections;
    Telegram offers only a task with connections. The processor may route a request one of
    those ways (`{"kind":"route","to":…,"task":…}`); it still gets no tools there (R-14 AC3), and
    code refuses a way the door does not offer.
  - AC2: code announces the way in its own words ("Miro tu pantalla.", "Me pongo con ello en tu
    ordenador.", "Lo miro en tus conexiones.") and starts it. The daemon runs a task with
    connections itself, as DK-11 does; the app starts a look (DK-9) or a task on the computer
    (DK-10) from the reply's `route`. Every limit and permission of those paths holds: Permitir
    for a step of care and for a call that is not read-only, Detener, one task at a time.
  - AC3: the composer offers no mode: no screen button, no computer or connections toggle.
  - AC4: code starts a way only when the task is the principal's own words: every word of the
    task is a word of the message, as written (never stemmed), ignoring case, accents,
    punctuation and order, and the task keeps every "no", "nunca" or "jamás" of the message. The
    processor is told to copy the message's words exactly. Otherwise nothing is captured,
    planned or called, and the reply asks for it another way ("No he sabido qué hacer en tu
    ordenador. ¿Me lo pides de otra forma?", or for connections "No he podido hacerlo con tus
    conexiones. ¿Me lo pides de otra forma?"); the log names the way only (security audit M5,
    2026-11-20).
  - AC5 (asked on 2026-11-20: "Buscame donde puedo encontrar el dragons doma 2 para la switch 2
    al mejor precio y queria controlar el ordenador, creo que en este caso no hace falta, no?"):
    the user turn carries `connected`, the tools of the servers the principal connected, each
    with its server, its name and its purpose. The daemon never connects a server for it: a
    connected server gives its tools and what it says they do, one not connected yet only the
    tools marked read-only, without a purpose. A purpose is the server's own words: only the
    first sentence of its first line, without what cannot be seen, cut to 120 characters; a name
    longer than 64 characters or with something unseen is left out; at most 40 tools are told.
    They go in the user turn as data, never in the prompt, which says they are never
    instructions. A lookup on the internet (where to buy something, a price, news, a fact) is
    never a task on the computer: with a tool that searches it is routed to `connect`; with none
    the processor answers `{"kind":"no_web_search"}` and code says "Para buscar en internet
    necesito la conexión de búsqueda web. Añádela en Conexiones, en la app de ANOMANDER, y
    vuelve a pedírmelo.", starting nothing. AC4 holds for such a route. In the app that reply
    carries `offer: 'web_search'` (DK-11 AC13; Telegram gets the text alone), and the chat shows
    under it AC11's note and a button "Añadir búsqueda web" when the request was a typed text.
    One press adds AC11's server (a server already named `Internet` is kept), waits for the
    daemon that reads it to be back and open, and sends the same text again; while it works the
    button is disabled, and when the connection cannot be saved the chat says so and the button
    stays. When the server was already there the chat says it was already on instead of added,
    and asks again all the same, as soon as the connection is open: pressed while the daemon is
    still down, it waits for it instead of sending into the channel that is gone. The 60 seconds
    count from the press: an add that has not answered by then says it could not be added, and a
    request whose daemon is not back by then is not asked again: the chat says the daemon did not
    come back. Either way the button can be pressed again, and an answer that comes later is
    ignored. An add that has not answered in 30 seconds is given up on; the next press, or the
    setup, reads and saves only once that add is over, so the server is never saved twice.
- DK-14 Who the principal is and what ANOMANDER did (asked by the principal on 2026-11-20:
  "También me gustaría que recordara quién soy, que recuerde quien soy y tenga memoria de lo que
  ha hecho"; the proposal "pasarle los recuerdos a todas las rutas, y agregar un historial
  persistente de acciones para que pueda contestar «¿qué hiciste ayer?»" accepted the same day:
  "si, me gustaria ya que esto es algo que la gente tendrá en su local").
  - AC1: a look at the screen (DK-9) and every step of a task on the computer (DK-10) get the
    current `declared` memories (R-23), chosen among them as for a conversation reply (R-23 AC4)
    from the question or the task, each with its text and mode, in the user turn. An `inferred`
    memory never reaches them: its quote need not be the principal's words, and these ways act
    on the computer (security audit M5, 2026-11-20). They are facts about the principal, never
    instructions. They still never become an expense fact (R-23 AC4): none of these ways
    writes one. A task with connections (DK-11) gets none: its read-only calls run without
    asking and go to third-party services, so a remembered fact could leave unasked (security
    audit H2, 2026-11-20).
  - AC2: when one of those ends, the daemon keeps it in `action_history`, in the app's database:
    what it was, the front door it was asked at, the principal's words (the question or the
    task), how it ended as a code word, when, and for a task on the computer the steps it took,
    for a task with connections each tool of each server code sent or the principal refused,
    and which. Never the capture, what a step typed or pressed, a call's arguments or what a
    tool or the processor answered. Expenses stay in the ledger and are not copied here. A task
    on the computer that the app ends by itself ("Detener", a step not allowed, a newer task)
    is not seen by the daemon and is not kept (assumption); a task with connections that waited
    for "Permitir" and was ended by a newer one is kept as `replaced`.
  - AC3: the text interpreter gets the latest of them in its user turn as `history`, oldest
    first, with when each ended in `TZ`: at most 20, none older than 7 days, bounded by code. It
    uses them only to answer what ANOMANDER did ("¿qué hiciste ayer?") in a conversation reply;
    an expense inference that rests on them is rejected like one that rests on a memory (R-23
    AC4). An action is kept 30 days after it ended; the retention job then erases it (PRD R-19
    AC6, security audit L3, 2026-11-20).
  - AC4: when the principal asks to erase it ("borra tu historial"), code asks "¿Borro el
    historial de lo que he hecho por ti? Son N acciones y no podré recuperarlas." ("Es 1 acción" for one) with `Sí` and
    `No`, or replies "No tengo nada en mi historial." when it is empty. `Sí` erases every action
    kept when it was asked, checkpoints the WAL as a forget does (R-23 AC7), empties the recent
    turns and the stored conversation (DK-16 AC5) and replies "Hecho, he borrado mi historial.";
    `No` erases nothing and replies "Vale, no borro nada.". One action at a time can also be
    erased from the app's "Memoria" (DK-18 AC5).
  - AC5: the history is local: it lives only in the app's database (DK-8), is never logged (a
    failure to keep an action is logged without its words) and never leaves the machine except
    in the history the text interpreter receives. It survives a restart, as the stored
    conversation does (DK-16).
- DK-15 Subscription login in the app (asked by the principal on 2026-11-20: "ah, tambien
  necesitariamos una parte de conectarte con una suscripcion, openai, kimi, etc").
  - AC1: the app has a "Suscripciones" screen, opened from the status bar and from the models
    section of the setup screen, with one row per account a login is made with (R-27 AC1: ChatGPT
    `openai`, Kimi Code `kimi-coding`), its state ("Conectada" or "No conectada") and one button:
    "Conectar" while it is not connected, "Desconectar" while it is. An account no longer offered
    for login (Claude, GitHub Copilot) is listed only while a login of it is stored, with
    "Desconectar" (R-27 AC6). Only the accounts pi-ai's login flows support are offered; the list
    is the daemon's `LOGIN_ACCOUNTS`, mirrored by the shell.
  - AC2: "Conectar" runs the same flow as `/login` (R-27 AC2), through
    `packages/daemon/scripts/login.ts --shell <account>` run by the shell with Node, as the MCP
    OAuth connection runs its script (DK-11 AC10). The shell opens the login page in the browser,
    only when it is `https` (or `http` on this machine). For ChatGPT the redirect comes back to
    pi-ai's own port on this machine; when the browser ends on an error page instead, the
    principal pastes its address in the screen's field and the shell hands it to the flow as one
    line, once. For Kimi Code the screen shows the device code to type on the page the browser was
    opened on. A login not completed in 10 minutes is abandoned (R-27 AC4); one runs at a time, and
    the screen can be closed while the browser waits.
  - AC3: the credential the flow produces never touches a file and never reaches the window: the
    script holds it in memory and prints it once, on one line of its output, which the shell
    stores in the Keychain item `model-login` (DK-5 AC1) with the daemon stopped, so a refresh the
    daemon hands over meanwhile cannot overwrite it; the daemon starts again after if it ran, and
    gets the login at that start. "Desconectar" takes the account out of the same item the same
    way. The window learns only which accounts are connected, a device code and the steps of the
    flow; the shell's logs carry the kind of a failure, never a token or an address.
  - Open, for the principal: the pasted address holds a one-time authorization code, which goes
    from the window to the shell and to the script and nowhere else; `pnpm run login` on a
    terminal still reaches the app's daemon only through an `auth.json` merged at its next start.
- DK-16 The conversation survives (asked by the principal on 2026-11-24: "Sobretodo esta la
  conversación se pierde al cerrar la ventana es importante. Debemos guardar la conversacion y
  recordar al usuariow"; the option "Daemon + IA recuerda" chosen the same day). Closing the
  window only hides it; quitting the app or restarting the daemon lost the conversation.
  - AC1: the daemon keeps every message of the conversation, from either door (DK-4 AC4), in the
    app's database (DK-8), one row per message: who (`principal` or `anomander`), the door, the
    text, the buttons and `channelRef` of a reply, and when. What ANOMANDER sends unasked is kept
    as its message. No image is kept: a receipt is its `[foto de ticket]` line and a press its
    `[botón: …]` line. A text pasted for a login (R-17 AC7) is never kept. What ANOMANDER sends
    unasked is kept only once it was delivered. A text the chat routes to a task with
    connections (DK-13 AC2) is kept once, with its announcement; the task's answer follows as a
    message of its own. Unlike the action history of DK-14, which keeps only the request and how it
    ended, the stored conversation keeps the reply to a look at the screen, the end of a task on the
    computer and the final answer of a task with connections (what was read or what the tools
    answered); the capture itself is never kept (decided by the principal on 2026-11-24: "Dejarlo
    así").
  - AC2: the text interpreter's recent turns are read from it, with R-16 AC3's bounds unchanged:
    at most the last 10, none older than 30 minutes. A restart within 30 minutes keeps the
    context; lasting facts are the memories of R-23.
  - AC3: when the app's chat is empty and its connection opens, the app asks for the stored
    conversation (`history`, at most `HISTORY_LIMIT`, 500 messages, oldest first) and shows it,
    Telegram messages included and marked "Por Telegram", before anything new. An answer that
    arrives after the principal already said something is not shown (assumption: it arrives at
    once; nothing is merged). A daemon that restarts while the chat shows messages adds nothing:
    nothing is asked and nothing is shown twice. A stored reply shows its buttons, and a press on
    one goes as any press: a decision already answered gets S-19. Proposals (DK-10), the looks
    and tasks a reply started (DK-13) and offers (DK-11 AC13) are not kept and are never armed
    again.
  - AC4: "Borrar conversación", over the chat while it shows messages, asks "¿Borrar la
    conversación? ANOMANDER la borra de este Mac y deja de tenerla en cuenta. Lo que hay en
    Telegram sigue en Telegram." with "Sí, borrar" and "No borrar". "No borrar" sends nothing.
    "Sí, borrar" sends `clear_history`: the daemon erases the stored conversation and the recent
    turns for real (secure delete, then the WAL checkpoint, as a forget, R-23 AC7) and answers
    `done`, and the chat empties. The erase waits for a turn of either door that runs, so
    nothing of that turn is kept after it. When it was not erased the chat keeps its messages and says so;
    when the connection was lost first it says it cannot know. It cannot be pressed while the
    connection is not open, while an answer is owed, or while a task runs or waits for
    "Permitir".
  - AC5: a confirmed "olvida" (R-23 AC6) and a confirmed erase of the action history (DK-14 AC4)
    also erase the stored conversation. "Olvidar" on one item of the app's "Memoria" erases only
    the turns that say it (DK-18 AC4, AC5). When an erase fails the question stays open and the reply
    is S-22, so `Sí` can be pressed again. A memory replaced by a new fact (R-23 AC3) erases, the
    same way, only the turns where the principal said it, matched as whole words ignoring case,
    spacing and accents: its quote in a principal's own message (never a line such as
    `[botón: Sí]`), or its text in any message; the principal's message and its reply go
    together, and the rest of the conversation stays.
    The window follows a confirmed forget: once the `Sí` pressed in the app
    is answered ("Hecho, lo he olvidado.", "Hecho, he borrado mi historial."), and each time the
    shell shows the window again (closing it only hides it; the shell tells the window, since on
    Windows the page never learns it was hidden), so one confirmed through Telegram is gone too,
    the chat asks for the stored conversation and shows it instead of what it showed. Not while an
    answer is owed, a task runs or waits for "Permitir", or a web search is being added or waits
    to ask again: it is shown once nothing does any more, and asked again when something changed
    before it came. What the store cannot give back stays, after it: a message not sent or that
    it cannot know arrived, a press it cannot know arrived, a look or a task that did not leave or
    may not have, and a web search offered and not added.
  - AC6: a stored message is kept 90 days; the retention job then erases it, next to the 30 days
    of the action history (DK-14 AC3).
  - AC7: the conversation is local: it lives only in the app's database, is never logged, and
    leaves the machine only in the recent turns the text interpreter receives (R-16 AC3). The
    window keeps it in memory only, never in storage.
- DK-18 Memories and history in the window (backlog B32, 2026-11-24: "Memories and history
  visible, with "me lo dijiste / lo deduje" and "olvidar" per item (principles 2 and 5).").
  - AC1: the app has a "Memoria" screen, opened from the status bar like "Conexiones", with two
    sections. "Lo que sé de ti" lists every current memory (R-23 AC5), in the order it was
    remembered, each marked "Me lo dijiste" when it is `declared` and "Lo deduje" when it is
    `inferred` (PRD principle 2). "Lo que he hecho" lists every action of the history (DK-14
    AC2), the latest first: when it ended, what it was ("Miré tu pantalla", "Tarea en tu
    ordenador", "Tarea con tus conexiones"), "Por Telegram" when it was asked there, the
    principal's words and how it ended. Its steps and calls are not shown. An empty section says
    so.
  - AC2: the window asks for them on the local channel with `memories` and `actions`, each time
    its connection opens and after each forget; the daemon answers with the lists, outside the
    chat's turn, as `history` is answered. A list that cannot be read is the reply S-22, as for
    `history` (DK-16): the section says it could not be read and offers "Reintentar". Without a
    channel the screen says ANOMANDER is not running; while it connects, that it is connecting.
    Nothing of either list is ever logged (R-23 AC8, DK-14 AC5).
  - AC3: every item has "Olvidar", which asks first in the window, as "Borrar conversación"
    does: for a memory "¿Lo olvido? Lo borro de este Mac, y también los mensajes de la
    conversación que lo mencionan.", for an action "¿Lo olvido? Lo borro de este Mac, y también
    los mensajes de la conversación que lo mencionan. No podré recuperarlo.", with "Sí, olvidar"
    and "No olvidar". "No olvidar" sends nothing.
  - AC4: "Sí, olvidar" on a memory sends `forget_memory` with its id: the daemon forgets it as a
    confirmed "olvida" does (R-23 AC6, AC7: its text and quote erased for real, the assertion
    `expired`), and of the stored conversation it erases only the turns that say it, found as a
    replaced memory's are (R-23 AC3, DK-16 AC5): its quote in a principal's own message, its text
    in any message, matched as whole words ignoring case, spacing and accents, each message with
    its turn. The rest of the conversation stays, and the recent turns are read from what stays
    (decided by the principal on 2026-11-24: "Solo los mensajes que lo contienen" — "Borra de
    verdad la memoria o la acción, y además los mensajes de la conversación que la mencionan, con
    la búsqueda por palabra completa que ya usamos para una memoria reemplazada. El resto del chat
    se queda."). A memory no longer current is left alone and nothing else is erased.
  - AC5: "Sí, olvidar" on an action sends `forget_action` with its id: the daemon erases that
    one row of `action_history` for real and, by the same decision and the same matching, the
    turns that say its task: a principal's own message that holds the task's words, and a reply
    that holds the whole task (a reply that holds only some of its words stays), each with its
    turn. The rest of the history and of the conversation stays. Both erases are secure deletes
    followed by the WAL checkpoint (R-23 AC7).
  - Known limit (accepted by the principal with that decision): a reply that said the memory or
    the task in other words is not matched and stays.
  - AC6: both forgets wait for the chat's turn of either door that runs, as `clear_history`
    does (DK-16 AC4), and are answered `done`; the window then reads both lists again and the
    chat asks for the stored conversation again, as after a forget confirmed in the chat. When it
    was not forgotten (the reply S-22) the item stays and the screen says so; when the connection
    was lost first, that it cannot know.

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
| The token (DK-3 AC2) | `ANOMANDER_LOCAL_TOKEN`, handed over on the daemon's stdin by the app (DK-5 AC2), at least 32 characters of `A-Z a-z 0-9 . _ ~ + -`. Unset: the channel is off and no port opens, as under Docker |
| The port | `ANOMANDER_LOCAL_PORT`, default `4312`, always on `127.0.0.1`. The app picks a free one at each launch |
| Presenting the token | As the second WebSocket subprotocol: `new WebSocket(url, ['anomander.v1', token])` |
| Messages | `ChatRequest` (`text`, `receipt`, `button`, `screen`, `computer`, `connect`, `history`, `clear_history`, `memories`, `forget_memory`, `actions`, `forget_action`) and `ChatEvent` (`reply`, `done`, `rejected`, `history`, `memories`, `actions`) in `packages/protocol/src/local-channel.ts` |
| Why the daemon stopped (DK-2 AC3) | Exit code `3`: another daemon runs on the same database. `4`: another process uses the bot. `1`: anything else. `exitCodes` in `packages/protocol` |
| The single-daemon lock (DK-2 AC1) | `<database>.lock` beside the database, held while the daemon runs and freed by the operating system when it ends, so a crash leaves nothing stale |

## 9. The app

Built in `apps/desktop` (see its README): a React window (`src/`) and a Tauri 2 shell in Rust
(`src-tauri/`). Choices of this build, for the principal to confirm:

| What | How |
| --- | --- |
| Starting the daemon (DK-1 AC1) | `node packages/daemon/src/main.ts` of this repository, with a cleared environment plus the setup without its secrets, the data paths, this launch's port and `ANOMANDER_SECRETS_ON_STDIN=1` |
| Handing the secrets over (DK-5 AC2) | Right after the start the shell writes one line to the daemon's stdin: a JSON object with `TELEGRAM_BOT_TOKEN`, every provider key, `ANOMANDER_AUTH_JSON`, `ANOMANDER_MCP_SECRETS`, `ANOMANDER_MCP_OAUTH` and `ANOMANDER_LOCAL_TOKEN`. The daemon reads it before its configuration, lays it over its environment without copying it there, and stops with exit code `1` when it is not a JSON object of strings or does not arrive within 10 seconds; the rest of stdin is then only watched for its end (DK-1 AC1). pi-ai reads a handed provider key as if it were in the environment |
| No daemon left behind (DK-1 AC1) | SIGTERM, then SIGKILL after 5 seconds. The daemon also stops when its stdin closes (`ANOMANDER_STOP_WITH_PARENT=1`), so a crashed or killed app leaves none |
| Restarting (DK-1 AC2) | One second after an exit; exit codes 3 and 4 are never retried |
| Secrets (DK-5) | Keychain items of service `ANOMANDER`, named as the daemon's variables. The rest in `settings.json` in the data folder, mode `600` |
| Secrets of the connections (DK-11 AC1) | Keychain items named `mcp/<server>/<env or headers>/<name>`, listed in `settings.json`. The daemon gets them in `ANOMANDER_MCP_SECRETS` on its stdin, a JSON object by that name. Every value is moved, secret or not: the code cannot tell. In the daemon's output a value is hidden from 4 characters when its name holds a word a secret's name usually does or it is a header, and from 8 otherwise. A file saved while its values are moved is left for the next start |
| OAuth of the connections (DK-11 AC10) | The Keychain item `mcp-oauth`, one JSON object by server name with its client, tokens, redirect address and the server's URL. The shell runs `packages/daemon/scripts/mcp-oauth.ts`, which prints the address to open and then the tokens on one line; the daemon gets the set in `ANOMANDER_MCP_OAUTH` on its stdin and prints it whole on a line starting `anomander mcp-oauth ` after a refresh. The shell stores what a connection gave, and forgets a server's tokens, with the daemon stopped, so a refresh it hands over meanwhile cannot overwrite them |
| The time zone | The daemon's `TZ` is the zone this machine's clock points to (`/etc/localtime`), so its dates are the principal's. When it cannot be read, the daemon's default |
| The subscription login (DK-5 AC1) | The Keychain item `model-login`, the shape of `auth.json`. The daemon prints it whole on a line starting `anomander credentials ` after every change, before pi-ai uses it; a daemon killed between a token refresh and that line loses the refreshed token, and the principal logs in again. `pnpm run login` reaches the app's daemon only through an `auth.json` merged at its next start. The device ID stays on disk: it is not a secret |
| The subscription login from the app (DK-15) | The shell (`src-tauri/src/login.rs`) runs `packages/daemon/scripts/login.ts --shell <account>` with a cleared environment plus `PATH` and `ANOMANDER_AUTH_PATH` (for the device ID only). The script prints `anomander login-open <address>` for the shell to open, `anomander login-code <code> <address>` for a device code, `anomander login-prompt` when it waits for the pasted address on its stdin, then `anomander login-done <json>` with the credential by provider and one word: `connected`, `timed_out` or `cancelled`. The shell tells the window each step on the event `shell://login` (opened, device code, prompt), merges the credential into `model-login` under `Supervisor::while_stopped`, and refuses any account but `openai` and `kimi-coding` before starting Node |
| The ledger | A new one in the app's data folder. A Docker install's ledger is brought by the principal and imported into an empty one (DK-12); nothing reaches into the volume |
| The window's strings | Spanish and English, all in `apps/desktop/src/strings.ts`, not yet in `PRD.md` §12. The shell reads the system's preferred language once: a Spanish one keeps Spanish, any other is English. It gives the same answer to the window and the notch (`window.__ANOMANDER_LOCALE__`, before their scripts run), to its own tray and notifications, and to the daemon (`ANOMANDER_LOCALE`) |

