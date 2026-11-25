// The ANOMANDER desktop shell (M6, docs/desktop-prd.md): Rust where the operating system is
// touched (docs/stack.md). It starts and supervises the daemon (DK-1), keeps the secrets in the
// Keychain (DK-5), lives in the menu bar (DK-6) and owns the data folder (DK-8). The window's side
// of every command and event is `apps/desktop/src/shell.ts`.
pub mod computer;
pub mod connection_secrets;
pub mod connections;
pub mod daemon;
pub mod data_dir;
pub mod diagnostics;
pub mod file_mode;
pub mod hotkey;
pub mod ledger_import;
pub mod locale;
pub mod login;
pub mod notch;
pub mod notification;
pub mod oauth_connect;
pub mod platform;
pub mod screen;
pub mod secure_store;
pub mod setup;
pub mod shell;
pub mod snapshot;
pub mod tray;

use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, RunEvent, Runtime, WindowEvent};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_notification::NotificationExt;

use crate::connections::{ConnectionsView, ServerInput};
use crate::daemon::launch::{daemon_entry, find_node, launch_token, search_path};
use crate::daemon::supervisor::{Options, Prepared, Supervisor, Update};
use crate::data_dir::{DataDir, FOLDER_NAME};
use crate::diagnostics::log_file::{self, LogFile};
use crate::diagnostics::report::{self, Facts};
use crate::ledger_import::LedgerImport;
use crate::login::{LoginOutcome, SubscriptionsView};
use crate::oauth_connect::{open_in_browser, OAuthConnect};
use crate::secure_store::SecretStore;
use crate::setup::{load_settings, Settings, SetupInput};
use crate::shell::Core;
use crate::snapshot::{DaemonState, Snapshot};

/// `SNAPSHOT_EVENT` of `shell.ts`.
pub const SNAPSHOT_EVENT: &str = "shell://snapshot";
/// `STOP_TASK_EVENT` of `shell.ts`.
pub const STOP_TASK_EVENT: &str = "shell://stop-task";
/// `CHAT_SHOWN_EVENT` of `shell.ts`: the chat window was shown again (B48).
pub const CHAT_SHOWN_EVENT: &str = "shell://chat-shown";
/// `LOGIN_EVENT` of `shell.ts`: a `login::Step` while a subscription login runs (DK-15).
pub const LOGIN_EVENT: &str = "shell://login";
const MAIN_WINDOW: &str = "main";

/// DK-15: the subscription logins, kept in the same Keychain item the daemon gets (`model-login`).
struct Logins {
    store: Arc<dyn SecretStore>,
    /// `auth.json` of the data folder: the script places the device ID next to it, nothing else.
    auth_path: PathBuf,
    session: login::Session,
}

impl Logins {
    /// Runs the login of `provider_id` with the daemon package's script, as `Core::connect_oauth`
    /// runs its own: the daemon runs meanwhile, and nothing is stored here.
    fn run(
        &self,
        provider_id: &str,
        open: &dyn Fn(&str) -> Result<(), String>,
        notify: &dyn Fn(login::Step),
    ) -> Result<login::Ran, String> {
        let path = search_path(std::env::var("PATH").ok().as_deref());
        let node =
            find_node(std::env::var("ANOMANDER_NODE").ok().as_deref(), &path).ok_or_else(|| {
                format!("node was not found on {path}; set ANOMANDER_NODE to its path")
            })?;
        let entry = daemon_entry(std::env::var("ANOMANDER_DAEMON_ENTRY").ok().as_deref());
        let script = login::script_of(&entry)
            .filter(|script| script.is_file())
            .ok_or_else(|| format!("the login is not next to {}", entry.display()))?;
        login::run(
            &node,
            &script,
            provider_id,
            &self.auth_path,
            &path,
            &self.session,
            open,
            notify,
            login::DEADLINE,
        )
    }
}

/// The app's managed state.
struct Shell {
    core: Arc<Core>,
    supervisor: Supervisor,
    logins: Logins,
    /// DK-6 AC4: the log's folder, `~/Library/Logs/dev.anomander.desktop`.
    logs: PathBuf,
}

impl Shell {
    fn snapshot(&self) -> Snapshot {
        self.core.snapshot(self.supervisor.current())
    }

    /// The daemon reads `mcp.json` only when it starts: starts it again, as a saved setup does,
    /// unless it is stopped, which the principal may have chosen; then its next start reads the
    /// file. Answers with the servers as that start left them.
    fn reread_connections(&self) -> ConnectionsView {
        if self.supervisor.current().status.state != DaemonState::Stopped {
            self.supervisor.restart();
        }
        self.core.connections()
    }
}

/// Sends each change to the window and the menu bar, in order: a change that arrives after a newer
/// one is dropped.
struct Publisher {
    app: AppHandle,
    core: Arc<Core>,
    last: Mutex<u64>,
}

impl Publisher {
    fn publish(&self, update: Update) {
        let mut last = self.last.lock().unwrap_or_else(PoisonError::into_inner);
        if update.seq < *last {
            return;
        }
        *last = update.seq;
        let status = update.status.clone();
        let snapshot = self.core.snapshot(update);
        // Only the chat window gets the snapshot, which carries the token (DK-3 AC2).
        if let Err(error) = self.app.emit_to(MAIN_WINDOW, SNAPSHOT_EVENT, &snapshot) {
            eprintln!("could not send the snapshot to the window: {error}");
        }
        // The supervisor's notifications must not block, and menu bar changes run on the main
        // thread: hand them over.
        let app = self.app.clone();
        if let Err(error) = self
            .app
            .run_on_main_thread(move || tray::show_status(&app, &status))
        {
            eprintln!("could not update the menu bar: {error}");
        }
    }
}

/// Every way of showing the chat comes through here. Closing it only hides it, and on Windows the
/// page never learns it was hidden: the window is told, so it shows the stored conversation again
/// (B48).
fn show_chat<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let shown = window
            .unminimize()
            .and_then(|()| window.show())
            .and_then(|()| window.set_focus());
        if let Err(error) = shown {
            eprintln!("could not open the chat: {error}");
        }
        if let Err(error) = app.emit_to(MAIN_WINDOW, CHAT_SHOWN_EVENT, ()) {
            eprintln!("could not tell the window it was shown: {error}");
        }
    }
}

/// Runs `work` off the main thread: starting and stopping the daemon read the Keychain and wait
/// for the process.
fn in_background(app: &AppHandle, work: impl FnOnce(&Shell) + Send + 'static) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || work(&app.state::<Shell>()));
}

async fn blocking<T: Send + 'static>(
    app: AppHandle,
    work: impl FnOnce(&Shell) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || work(&app.state::<Shell>()))
        .await
        .map_err(|error| format!("the shell failed: {error}"))?
}

#[tauri::command]
async fn get_snapshot(app: AppHandle) -> Result<Snapshot, String> {
    blocking(app, |shell| Ok(shell.snapshot())).await
}

/// DK-5 AC1: saves the setup and starts the daemon again with it.
#[tauri::command]
async fn save_setup(app: AppHandle, setup: SetupInput) -> Result<Snapshot, String> {
    blocking(app, move |shell| {
        shell.core.save_setup(&setup)?;
        shell.supervisor.restart();
        Ok(shell.snapshot())
    })
    .await
}

/// DK-11: the servers of `mcp.json` for the connections screen, without their values.
#[tauri::command]
async fn get_connections(app: AppHandle) -> Result<ConnectionsView, String> {
    blocking(app, |shell| Ok(shell.core.connections())).await
}

/// DK-11: saves one server of `mcp.json` and has the daemon read the file again.
#[tauri::command]
async fn save_connection(app: AppHandle, server: ServerInput) -> Result<ConnectionsView, String> {
    blocking(app, move |shell| {
        shell.core.save_connection(&server)?;
        Ok(shell.reread_connections())
    })
    .await
}

/// DK-11: takes one server out of `mcp.json` and has the daemon read the file again.
#[tauri::command]
async fn remove_connection(app: AppHandle, name: String) -> Result<ConnectionsView, String> {
    blocking(app, move |shell| {
        shell.core.remove_connection(&name)?;
        Ok(shell.reread_connections())
    })
    .await
}

/// DK-11: connects the app to an HTTP server with OAuth. The principal authorizes it in the
/// browser, which can take minutes: the daemon runs meanwhile. The tokens are stored with it
/// stopped, so a refresh it hands over cannot overwrite them; it starts again if it ran.
#[tauri::command]
async fn connect_oauth(app: AppHandle, name: String) -> Result<OAuthConnect, String> {
    blocking(app, move |shell| {
        // Held until the tokens are stored.
        let _turn = shell.core.oauth_turn()?;
        let (ran, url) = shell.core.connect_oauth(&name, &open_in_browser)?;
        if let Some(entry) = ran.entry {
            shell
                .supervisor
                .while_stopped(|| shell.core.keep_oauth(&name, &url, entry))?;
        }
        Ok(ran.outcome)
    })
    .await
}

/// DK-11: forgets the OAuth tokens of a server, with the daemon stopped as `connect_oauth`.
#[tauri::command]
async fn forget_oauth(app: AppHandle, name: String) -> Result<ConnectionsView, String> {
    blocking(app, move |shell| {
        shell
            .supervisor
            .while_stopped(|| shell.core.forget_oauth(&name))?;
        Ok(shell.core.connections())
    })
    .await
}

/// DK-15: the accounts of the Suscripciones screen, and which are connected; never a token.
#[tauri::command]
async fn get_subscriptions(app: AppHandle) -> Result<SubscriptionsView, String> {
    blocking(app, |shell| login::view(shell.logins.store.as_ref())).await
}

/// DK-15: connects a subscription. The principal logs in in the browser, which can take minutes:
/// the daemon runs meanwhile, and the window is told each step on `LOGIN_EVENT`. The credential
/// is stored with the daemon stopped, so a refresh it hands over cannot overwrite it; it starts
/// again if it ran, and gets the login at that start.
#[tauri::command]
async fn connect_subscription(app: AppHandle, provider_id: String) -> Result<LoginOutcome, String> {
    let window = app.clone();
    blocking(app, move |shell| {
        // Held until the credential is stored.
        let _turn = shell.logins.session.turn()?;
        let notify = |step: login::Step| {
            // Only the chat window: a step names no secret, but it is the window's business.
            if let Err(error) = window.emit_to(MAIN_WINDOW, LOGIN_EVENT, &step) {
                eprintln!("could not tell the window about the login: {error}");
            }
        };
        let ran = shell.logins.run(&provider_id, &open_in_browser, &notify)?;
        if let Some(credential) = ran.credential {
            shell
                .supervisor
                .while_stopped(|| login::keep(shell.logins.store.as_ref(), &credential))?;
        }
        Ok(ran.outcome)
    })
    .await
}

/// DK-15: the address the browser ended on, pasted in the window for the login that waits.
#[tauri::command]
fn answer_login(app: AppHandle, text: String) -> Result<(), String> {
    app.state::<Shell>().logins.session.answer(&text)
}

/// DK-15: forgets the login of an account, with the daemon stopped as `connect_subscription`.
#[tauri::command]
async fn disconnect_subscription(
    app: AppHandle,
    provider_id: String,
) -> Result<SubscriptionsView, String> {
    blocking(app, move |shell| {
        shell
            .supervisor
            .while_stopped(|| login::forget(shell.logins.store.as_ref(), &provider_id))?;
        login::view(shell.logins.store.as_ref())
    })
    .await
}

/// DK-12: imports a ledger brought from a Docker install. The daemon is stopped meanwhile, and
/// started again after if it ran.
#[tauri::command]
async fn import_ledger(app: AppHandle, path: String) -> Result<LedgerImport, String> {
    blocking(app, move |shell| {
        shell
            .supervisor
            .while_stopped(|| shell.core.import_ledger(&path))
    })
    .await
}

#[tauri::command]
async fn start_daemon(app: AppHandle) -> Result<(), String> {
    blocking(app, |shell| {
        shell.supervisor.start();
        Ok(())
    })
    .await
}

#[tauri::command]
async fn stop_daemon(app: AppHandle) -> Result<(), String> {
    blocking(app, |shell| {
        shell.supervisor.stop();
        Ok(())
    })
    .await
}

/// Whether the principal is looking at the chat: its window has the focus.
fn chat_in_front(app: &AppHandle) -> bool {
    app.get_webview_window(MAIN_WINDOW)
        .is_some_and(|window| window.is_focused().unwrap_or(false))
}

/// The chat waits for an answer, or no longer does: the menu bar shows it, and the notch says
/// when it is over.
#[tauri::command]
fn set_thinking(app: AppHandle, thinking: bool) -> Result<(), String> {
    let handle = app.clone();
    app.run_on_main_thread(move || {
        tray::show_thinking(&handle, thinking);
        notch::show_thinking(&handle, thinking, chat_in_front(&handle));
    })
    .map_err(|error| error.to_string())
}

/// An answer arrived in the chat: notifies it, unless the principal is looking at the window.
#[tauri::command]
fn notify_reply(app: AppHandle, text: String) -> Result<(), String> {
    if chat_in_front(&app) {
        return Ok(());
    }
    app.notification()
        .builder()
        .title("ANOMANDER")
        .body(notification::body(&text))
        .show()
        .map_err(|error| error.to_string())
}

/// How long the app the principal was using takes to come back to the front once ours hides.
const APP_LEAVES: Duration = Duration::from_millis(450);

/// The whole app steps aside, so the screen shows the app the principal was using. Hiding the
/// app is macOS's; elsewhere each window hides.
fn step_aside(app: &AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return app.hide().map_err(|error| error.to_string());
    #[cfg(not(target_os = "macos"))]
    app.webview_windows()
        .values()
        .try_for_each(|window| window.hide())
        .map_err(|error| error.to_string())
}

/// Brings the app and the chat back after a capture or an action.
fn come_back(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    if let Err(error) = app.show() {
        eprintln!("could not show the app again: {error}");
    }
    show_chat(app);
}

/// The app comes back after its work on the screen, unless that work went well and the window
/// asked to stay away: a task that goes by itself hides once, not at every step (DK-10).
fn after_screen_work<T>(app: &AppHandle, keep_hidden: bool, outcome: &Result<T, String>) {
    if !(keep_hidden && outcome.is_ok()) {
        come_back(app);
    }
}

/// The window asks for the app back: its task waits for the principal, or is over.
#[tauri::command]
fn reveal(app: AppHandle) {
    come_back(&app);
}

/// A task goes by itself, or no longer does: the menu bar offers to stop it and shows the work,
/// and the notch says when it is over.
#[tauri::command]
fn set_task_running(app: AppHandle, running: bool) -> Result<(), String> {
    let handle = app.clone();
    app.run_on_main_thread(move || {
        tray::show_task(&handle, running);
        notch::show_task(&handle, running, chat_in_front(&handle));
    })
    .map_err(|error| error.to_string())
}

/// A JPEG of the screen for a question the principal is asking in the chat, taken with the chat
/// window out of the way. It runs only on their click, and nothing is kept on disk.
#[tauri::command]
async fn capture_screen(app: AppHandle, keep_hidden: bool) -> Result<tauri::ipc::Response, String> {
    if !screen::allowed() {
        return Err(screen::NO_PERMISSION.into());
    }
    // The whole app steps aside, as for an action (DK-10): the capture shows the screen the
    // principal was looking at, with that app in front, which is the screen a step acts on.
    step_aside(&app)?;
    let captured = blocking(app.clone(), |shell| {
        std::thread::sleep(APP_LEAVES);
        screen::capture(shell.core.data_root())
    })
    .await;
    after_screen_work(&app, keep_hidden, &captured);
    captured.map(tauri::ipc::Response::new)
}

/// How long the screen takes to show what an action did, before it is captured again.
const SCREEN_SETTLES: Duration = Duration::from_millis(900);

/// DK-10 AC1: performs one action of a task, and answers with a JPEG of the screen as that action
/// left it. The app hides for it, so the click or the keys go to the app the principal was using.
/// `permitted` says the principal allowed it in the chat; without it the shell performs it only
/// when the screen shows a routine step, and answers `computer_careful` otherwise (T1b). An app
/// of the blocklist is never acted on (`computer_blocked:<app>`).
#[tauri::command]
async fn perform_action(
    app: AppHandle,
    action: computer::Action,
    keep_hidden: bool,
    permitted: bool,
) -> Result<tauri::ipc::Response, String> {
    if !computer::allowed() {
        return Err(computer::NO_PERMISSION.into());
    }
    if !screen::allowed() {
        return Err(screen::NO_PERMISSION.into());
    }
    step_aside(&app)?;
    let captured = blocking(app.clone(), move |shell| {
        std::thread::sleep(APP_LEAVES);
        // Read after the app stepped aside: the screen the input goes to.
        computer::perform_guarded(
            &action,
            computer::screen_size(),
            permitted,
            &computer::SystemScreen,
            std::process::id() as i32,
            &mut computer::SystemInput,
        )?;
        std::thread::sleep(SCREEN_SETTLES);
        screen::capture(shell.core.data_root())
    })
    .await;
    after_screen_work(&app, keep_hidden, &captured);
    captured.map(tauri::ipc::Response::new)
}

fn on_menu(app: &AppHandle, id: &str) {
    match id {
        tray::OPEN_CHAT => show_chat(app),
        tray::TOGGLE => {
            let opener = app.clone();
            in_background(app, move |shell| {
                if shell.supervisor.current().status.state == DaemonState::Stopped {
                    shell.supervisor.start();
                    // Still stopped, such as without a setup: show the window, which says why.
                    if shell.supervisor.current().status.state == DaemonState::Stopped {
                        show_chat(&opener);
                    }
                } else {
                    shell.supervisor.stop();
                }
            });
        }
        // The window stops its task and asks for the app back.
        tray::STOP_TASK => {
            if let Err(error) = app.emit_to(MAIN_WINDOW, STOP_TASK_EVENT, ()) {
                eprintln!("could not stop the task: {error}");
            }
        }
        tray::COPY_DIAGNOSTICS => {
            let handle = app.clone();
            in_background(app, move |shell| copy_diagnostics(&handle, shell));
        }
        tray::QUIT => app.exit(0),
        _ => {}
    }
}

/// DK-6 AC4: the report of `diagnostics::report` to the clipboard, and a notification that says
/// whether it is there.
fn copy_diagnostics(app: &AppHandle, shell: &Shell) {
    let locale = locale::current();
    let view = tray::View {
        status: shell.supervisor.current().status,
        thinking: false,
        task: false,
    };
    let lines = report::tail(&shell.logs, report::LINES).unwrap_or_else(|error| {
        eprintln!("could not read the log: {error}");
        Vec::new()
    });
    let secrets = diagnostics::secrets();
    let secrets: Vec<&str> = secrets.iter().map(String::as_str).collect();
    let facts = Facts {
        app_version: &app.package_info().version.to_string(),
        os_version: &report::os_version(locale),
        daemon: tray::labels(&view, locale).status,
    };
    let text = report::report(&facts, &lines, &secrets, locale);
    let handle = app.clone();
    // The pasteboard belongs to the main thread.
    let copied = app.run_on_main_thread(move || {
        let said = match handle.clipboard().write_text(text) {
            Ok(()) => locale.pick(
                "Diagnóstico copiado. Pégalo donde lo necesites.",
                "Diagnostics copied. Paste them wherever you need them.",
            ),
            Err(error) => {
                eprintln!("could not copy the diagnostic report: {error}");
                locale.pick(
                    "No se ha podido copiar el diagnóstico.",
                    "The diagnostics could not be copied.",
                )
            }
        };
        let shown = handle
            .notification()
            .builder()
            .title("ANOMANDER")
            .body(said)
            .show();
        if let Err(error) = shown {
            eprintln!("could not say the diagnostic report was copied: {error}");
        }
    });
    if let Err(error) = copied {
        eprintln!("could not copy the diagnostic report: {error}");
    }
}

/// DK-6 AC4: from now on, what the app and the daemon print also goes to the log in `dir`. An app
/// without its log still runs.
fn start_log(dir: &std::path::Path) {
    let started = LogFile::open(dir, log_file::MAX_BYTES, log_file::FILES)
        .and_then(diagnostics::capture::start);
    match started {
        Ok(()) => eprintln!("ANOMANDER {} started", env!("CARGO_PKG_VERSION")),
        Err(error) => eprintln!("could not open the log in {}: {error}", dir.display()),
    }
}

fn set_up(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // First, so the log has every line after it.
    let logs = app.path().app_log_dir().unwrap_or_else(|error| {
        eprintln!("no folder for the log: {error}");
        PathBuf::new()
    });
    if !logs.as_os_str().is_empty() {
        start_log(&logs);
    }
    // DK-8 AC1: `~/Library/Application Support/ANOMANDER`, not the identifier's folder.
    let data = DataDir::open(app.path().data_dir()?.join(FOLDER_NAME))?;
    screen::remove_leftovers(data.root());
    let settings = load_settings(&data.settings_path()).unwrap_or_else(|error| {
        eprintln!("{error}; starting with an empty setup");
        Settings::default()
    });
    let token = launch_token()?;
    diagnostics::remember([&token]);
    let logins = Logins {
        store: Arc::new(secure_store::SystemStore),
        auth_path: data.daemon_paths().auth,
        session: login::Session::default(),
    };
    let environment = environment(locale::current());
    let core = Arc::new(Core::new(
        data,
        Box::new(secure_store::SystemStore),
        environment,
        settings,
        token,
    ));
    import_env_file(&core);

    let publisher = Publisher {
        app: app.handle().clone(),
        core: Arc::clone(&core),
        last: Mutex::new(0),
    };
    let preparer = Arc::clone(&core);
    let supervisor = Supervisor::new(
        Box::new(move || {
            let prepared = preparer.prepare();
            // Each launch's secrets are taken out of the log as well as out of its output.
            if let Prepared::Ready(spec) = &prepared {
                diagnostics::remember(&spec.secrets);
            }
            prepared
        }),
        Box::new(move |update| publisher.publish(update)),
        Options::default(),
    );
    tray::build(
        app,
        &supervisor.current().status,
        locale::current(),
        on_menu,
    )?;
    notch::build(app)?;
    // DK-20: after the tray, which can bring the chat too; without the hotkey the app still works.
    hotkey::install(app.handle());
    app.manage(Shell {
        core,
        supervisor,
        logins,
        logs,
    });

    // DK-1 AC1: opening the app starts the daemon.
    in_background(app.handle(), |shell| shell.supervisor.start());
    Ok(())
}

/// The app's own environment as the shell reads it. `TZ` is the zone of this machine's clock and
/// `ANOMANDER_LOCALE` the system's language, never the app's own variables: the daemon refuses a
/// zone that is not an IANA name, and speaks the language the window and the menu bar speak.
fn environment(locale: locale::Locale) -> shell::Environment {
    Box::new(move |name| match name {
        "TZ" => daemon::launch::system_time_zone(),
        "ANOMANDER_LOCALE" => Some(locale.as_str().to_owned()),
        _ => std::env::var(name).ok(),
    })
}

/// A one-time import of a Docker install's `.env`, asked for with `ANOMANDER_IMPORT_ENV=<path>` at
/// launch: its secrets go to the Keychain and the rest to the settings, as a save from the setup
/// screen would (DK-5). Without the variable the app never reads a `.env` (DK-5 AC3).
fn import_env_file(core: &Core) {
    let Some(path) = std::env::var_os("ANOMANDER_IMPORT_ENV") else {
        return;
    };
    let imported = std::fs::read_to_string(&path)
        .map_err(|error| error.to_string())
        .and_then(|text| core.save_setup(&setup::setup_from_env_file(&text)));
    match imported {
        Ok(()) => eprintln!("imported the setup from {}", path.to_string_lossy()),
        Err(error) => eprintln!("could not import the setup: {error}"),
    }
}

/// Stops the daemon and waits for it (DK-1 AC1). Safe to call more than once.
fn quit(app: &AppHandle) {
    if let Some(shell) = app.try_state::<Shell>() {
        shell.supervisor.shutdown();
    }
}

pub fn run() {
    // Read once, before any text or webview: the window, the notch, the menu bar and the daemon
    // speak the same language for the whole life of the app.
    let locale = locale::system();
    locale::choose(locale);
    let app = tauri::Builder::default()
        .plugin(locale::plugin(locale))
        .plugin(platform::plugin())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            save_setup,
            get_connections,
            save_connection,
            remove_connection,
            import_ledger,
            connect_oauth,
            forget_oauth,
            get_subscriptions,
            connect_subscription,
            answer_login,
            disconnect_subscription,
            start_daemon,
            stop_daemon,
            set_thinking,
            notify_reply,
            capture_screen,
            perform_action,
            reveal,
            set_task_running
        ])
        .setup(set_up)
        .on_window_event(|window, event| {
            // Closing the window only hides it: the app lives in the menu bar, or in Windows's
            // notification area (DK-6).
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == MAIN_WINDOW {
                    api.prevent_close();
                    if let Err(error) = window.hide() {
                        eprintln!("could not hide the window: {error}");
                    }
                }
            }
        })
        .build(tauri::generate_context!());
    let app = match app {
        Ok(app) => app,
        Err(error) => {
            eprintln!("ANOMANDER could not start: {error}");
            std::process::exit(1);
        }
    };
    app.run(|app, event| match event {
        // Every window closed: stay in the menu bar.
        RunEvent::ExitRequested {
            code: None, api, ..
        } => api.prevent_exit(),
        // A quit from the menu bar or Cmd-Q.
        RunEvent::ExitRequested { .. } | RunEvent::Exit => quit(app),
        // A click on the Dock icon brings the chat back. Windows has no Dock: there a click on
        // the icon in the notification area does it (`tray::opens_the_chat`).
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_chat(app),
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use locale::Locale;

    /// B48: every way of showing the chat tells the window, which then shows the stored
    /// conversation again: on Windows the page never learns it was hidden by itself.
    #[test]
    fn showing_the_chat_tells_the_window_it_was_shown_again() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use tauri::Listener;

        let app = tauri::test::mock_builder()
            .build(tauri::generate_context!(test = true))
            .expect("the mock app builds");
        let window = match app.get_webview_window(MAIN_WINDOW) {
            Some(window) => window,
            None => tauri::WebviewWindowBuilder::new(&app, MAIN_WINDOW, Default::default())
                .build()
                .expect("the window builds"),
        };
        let heard = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&heard);
        window.listen(CHAT_SHOWN_EVENT, move |_| {
            counter.fetch_add(1, Ordering::SeqCst);
        });

        show_chat(app.handle());

        assert_eq!(heard.load(Ordering::SeqCst), 1);
        // The name `shell.ts` listens for.
        assert!(include_str!("../../src/shell.ts")
            .contains(&format!("CHAT_SHOWN_EVENT = '{CHAT_SHOWN_EVENT}'")));
    }

    #[test]
    fn the_daemon_is_handed_the_language_the_shell_read_whatever_the_app_was_started_with() {
        for locale in [Locale::Es, Locale::En] {
            assert_eq!(
                environment(locale)("ANOMANDER_LOCALE").as_deref(),
                Some(locale.as_str())
            );
        }
    }
}
