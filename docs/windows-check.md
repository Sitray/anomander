# Checking the app on Windows

A manual check of the Windows app (phase P1 of Windows support), on a real Windows 10 or 11 PC.
CI builds it and runs its tests on `windows-latest`, but nothing there opens a window, clicks the
tray or logs in. Build it first as the README's
[Run the app on Windows](../README.md#run-the-app-on-windows) says, and stop any Docker install.

Note what fails, with the step's number, and attach "Copiar diagnóstico" (step 12) to the report.

## 1. First run

- [ ] The installer (`ANOMANDER_0.1.0_x64-setup.exe`) runs after SmartScreen's "More info" ›
      "Run anyway", and puts ANOMANDER in the Start menu.
- [ ] Opening ANOMANDER shows the chat window and, in the notification area (perhaps under the
      "^" arrow), the "A" icon. No console window opens, then or later.
- [ ] With the setup empty, the window shows the setup screen and the icon's tooltip says
      "ANOMANDER está detenido: falta configurarlo".

## 2. Setup

- [ ] Fill in a model and its key (or skip to step 9 for a subscription) and save. The icon goes
      from dimmed, through the ring of "arrancando", to the solid mark; the tooltip says
      "ANOMANDER está en marcha".
- [ ] The key is not in any file: Windows "Administrador de credenciales" › "Credenciales de
      Windows" lists `ANOMANDER` entries, and `%APPDATA%\ANOMANDER` has no key in plain text.

## 3. Chat

- [ ] Write "hola" in the chat: it answers in Spanish.
- [ ] Write an expense ("He gastado 12,50 € en Mercadona"): it asks or records it as on the Mac.

## 4. Telegram (optional)

- [ ] Add the bot token and your Telegram ID in the setup and save. `/start` to the bot answers
      "¡Hola!", and a message there gets the same answer as in the app.

## 5. The tray icon and its wave

- [ ] The icon reads on a dark taskbar and on a light one (Settings › Personalization › Colors ›
      "Choose your mode"): a white "A" with a dark rim.
- [ ] While the chat waits for an answer, three dots wave in the icon's top-right corner, and the
      tooltip says "ANOMANDER está pensando…". They stop when the answer arrives.
- [ ] With Settings › Accessibility › Visual effects › "Animation effects" off, the dots stay
      still while it thinks (the setting is read when a spell of work starts).

## 6. The drop

- [ ] Send a message that takes a while ("cuéntame algo largo") and click another app's window
      before it answers. When it answers, a black pill with "Ha terminado" drops at the top centre
      of the main screen, a little below the edge, holds about two and a half seconds and
      retracts.
- [ ] The pill takes no focus: what you were typing in the other app keeps the keyboard.
- [ ] The pill has no taskbar button of its own and is not in Alt+Tab.
- [ ] A click on the pill opens the chat.
- [ ] With the chat in front when the answer arrives, no pill drops.
- [ ] With the taskbar docked at the top of the screen, the pill drops below it, not over it.
- [ ] A screenshot (Win+Shift+S) taken while the pill is down does not show it.

## 7. Reopening from the tray

- [ ] Close the chat window with its X: the app stays in the notification area and the daemon
      keeps running (the tooltip still says "en marcha").
- [ ] A left click on the icon opens the chat again, in front.
- [ ] The right button opens the menu: "Abrir chat", "Detener ANOMANDER" / "Iniciar ANOMANDER",
      "Copiar diagnóstico" and "Salir de ANOMANDER" each do what they say.

## 8. A connection with OAuth

- [ ] In Conexiones, "Conectar" Notion (or Linear, or Atlassian): the browser opens the
      provider's page; after allowing it, the connection shows as connected.
- [ ] Ask something only that connection knows ("¿qué páginas tengo en Notion?"): it answers from
      it, and asks "Permitir" before any call that is not read-only.

## 9. Subscription login

- [ ] In Suscripciones, connect ChatGPT (or Kimi Code): the browser opens the login; paste the
      answer if asked. It shows as connected, and a chat message is answered with it.
- [ ] "Desconectar" removes it.

## 10. Quitting leaves nothing behind

- [ ] With a connection to a local MCP server (one run with a command, under "Avanzado"), choose
      "Salir de ANOMANDER". Within a few seconds, Task Manager › Details lists no `node.exe` of
      ANOMANDER and no process of that MCP server.
- [ ] The same after "Detener ANOMANDER" from the menu, with the app still open.
- [ ] Opening ANOMANDER again starts cleanly: no "ya hay otro en marcha con estos datos".

## 11. Logs

- [ ] `%LOCALAPPDATA%\dev.anomander.desktop\logs\anomander.log` exists, has the start line
      ("ANOMANDER 0.1.0 started") and the daemon's lines, and no key or token from the setup.

## 12. "Copiar diagnóstico"

- [ ] The menu's "Copiar diagnóstico" puts a report on the clipboard: paste it in Notepad. It
      names the Windows version, the daemon's status and the last lines of the log, with no
      secret in it.

## 13. Private folders

- [ ] In a terminal, `icacls "%APPDATA%\dev.anomander.desktop"` and
      `icacls "%LOCALAPPDATA%\dev.anomander.desktop\logs"` list only your user and `SYSTEM`, with no
      `(I)` (inherited) entry.

## Not on Windows yet

A look at the screen and tasks on the computer (DK-9, DK-10) are macOS-only: asked for one, the
app answers with its macOS permission message. That is expected in this phase.
