// The ANOMANDER desktop shell (M6, docs/desktop-prd.md): Rust where the operating system is
// touched (docs/stack.md). It starts and supervises the daemon (DK-1), keeps the secrets in the
// Keychain (DK-5), lives in the menu bar (DK-6) and owns the data folder (DK-8). The window's side
// of every command and event is `apps/desktop/src/shell.ts`.
pub mod daemon;
pub mod data_dir;
pub mod notification;
pub mod screen;
pub mod secure_store;
pub mod setup;
pub mod shell;
pub mod snapshot;
pub mod tray;

use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_notification::NotificationExt;

use crate::daemon::launch::launch_token;
use crate::daemon::supervisor::{Options, Supervisor, Update};
use crate::data_dir::{DataDir, FOLDER_NAME};
use crate::setup::{load_settings, Settings, SetupInput};
use crate::shell::Core;
use crate::snapshot::{DaemonState, Snapshot};

/// `SNAPSHOT_EVENT` of `shell.ts`.
pub const SNAPSHOT_EVENT: &str = "shell://snapshot";
const MAIN_WINDOW: &str = "main";

/// The app's managed state.
struct Shell {
    core: Arc<Core>,
    supervisor: Supervisor,
}

impl Shell {
    fn snapshot(&self) -> Snapshot {
        self.core.snapshot(self.supervisor.current())
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

fn show_chat(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let shown = window
            .unminimize()
            .and_then(|()| window.show())
            .and_then(|()| window.set_focus());
        if let Err(error) = shown {
            eprintln!("could not open the chat: {error}");
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

/// The chat waits for an answer, or no longer does: the menu bar shows it.
#[tauri::command]
fn set_thinking(app: AppHandle, thinking: bool) -> Result<(), String> {
    let handle = app.clone();
    app.run_on_main_thread(move || tray::show_thinking(&handle, thinking))
        .map_err(|error| error.to_string())
}

/// An answer arrived in the chat: notifies it, unless the principal is looking at the window.
#[tauri::command]
fn notify_reply(app: AppHandle, text: String) -> Result<(), String> {
    let in_front = app
        .get_webview_window(MAIN_WINDOW)
        .is_some_and(|window| window.is_focused().unwrap_or(false));
    if in_front {
        return Ok(());
    }
    app.notification()
        .builder()
        .title("ANOMANDER")
        .body(notification::body(&text))
        .show()
        .map_err(|error| error.to_string())
}

/// How long the window takes to leave the screen once hidden, before the capture is taken.
const WINDOW_LEAVES: Duration = Duration::from_millis(350);

/// A JPEG of the screen for a question the principal is asking in the chat, taken with the chat
/// window out of the way. It runs only on their click, and nothing is kept on disk.
#[tauri::command]
async fn capture_screen(app: AppHandle) -> Result<tauri::ipc::Response, String> {
    if !screen::allowed() {
        return Err(screen::NO_PERMISSION.into());
    }
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        window.hide().map_err(|error| error.to_string())?;
    }
    let captured = blocking(app.clone(), |shell| {
        std::thread::sleep(WINDOW_LEAVES);
        screen::capture(shell.core.data_root())
    })
    .await;
    // Whatever happened, the chat comes back.
    show_chat(&app);
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
        tray::QUIT => app.exit(0),
        _ => {}
    }
}

fn set_up(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // DK-8 AC1: `~/Library/Application Support/ANOMANDER`, not the identifier's folder.
    let data = DataDir::open(app.path().data_dir()?.join(FOLDER_NAME))?;
    let settings = load_settings(&data.settings_path()).unwrap_or_else(|error| {
        eprintln!("{error}; starting with an empty setup");
        Settings::default()
    });
    let token = launch_token()?;
    let environment: shell::Environment = Box::new(|name| std::env::var(name).ok());
    let core = Arc::new(Core::new(
        data,
        Box::new(secure_store::Keychain),
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
        Box::new(move || preparer.prepare()),
        Box::new(move |update| publisher.publish(update)),
        Options::default(),
    );
    tray::build(app, &supervisor.current().status, on_menu)?;
    app.manage(Shell { core, supervisor });

    // DK-1 AC1: opening the app starts the daemon.
    in_background(app.handle(), |shell| shell.supervisor.start());
    Ok(())
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
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            save_setup,
            start_daemon,
            stop_daemon,
            set_thinking,
            notify_reply,
            capture_screen
        ])
        .setup(set_up)
        .on_window_event(|window, event| {
            // Closing the window only hides it: the app lives in the menu bar (DK-6).
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
        // A click on the Dock icon brings the chat back.
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_chat(app),
        _ => {}
    });
}
