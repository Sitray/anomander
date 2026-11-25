// DK-6: the menu bar icon shows whether ANOMANDER is running, stopped or failing (AC1), and its
// menu opens the chat, starts or stops ANOMANDER, and quits (AC2), and copies a diagnostic report
// (AC4). While the chat waits for an answer, or a task on the computer goes by itself (DK-10),
// the icon also shows that ANOMANDER is working. The texts are read by the principal, so they are
// in the system's language (`locale`): Spanish (es-ES) or English; the icon is drawn here: a template image in macOS's menu bar, and a light mark
// with a dark rim in Windows's notification area.
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

use tauri::{App, AppHandle, Manager, Wry};

use crate::locale::Locale;
use crate::snapshot::{DaemonState, DaemonStatus, StopReason};

mod icon;

use icon::working_frames;

pub use icon::{icon, FRAMES};

pub const TRAY_ID: &str = "anomander";
pub const OPEN_CHAT: &str = "open-chat";
pub const TOGGLE: &str = "toggle-daemon";
pub const STOP_TASK: &str = "stop-task";
/// DK-6 AC4: copies the diagnostic report to the clipboard.
pub const COPY_DIAGNOSTICS: &str = "copy-diagnostics";
pub const QUIT: &str = "quit";

/// Where the icon sits. macOS's menu bar takes a template image, which it tints for a light or a
/// dark bar, and opens the menu on a click. Windows's notification area takes a square icon in
/// colour over a taskbar that may be light or dark; a click there opens the app, and the menu is
/// on the right button.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tray {
    MenuBar,
    Taskbar,
}

/// The tray of this build.
pub const HERE: Tray = if cfg!(target_os = "macos") {
    Tray::MenuBar
} else {
    Tray::Taskbar
};

/// Whether a click on the icon opens the chat: on the taskbar a left click does, as Windows apps
/// do; in the menu bar a click opens the menu instead.
pub fn opens_the_chat(tray: Tray, event: &TrayIconEvent) -> bool {
    tray == Tray::Taskbar
        && matches!(
            event,
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            }
        )
}

/// The texts of the menu for one status.
#[derive(Debug, PartialEq, Eq)]
pub struct Labels {
    /// The first, disabled item and the tooltip: what is happening and, when stopped, why.
    pub status: &'static str,
    /// The action that makes sense now: stop, start, or set up when that is what is missing.
    pub toggle: &'static str,
}

/// The items whose text never changes, in one language.
#[derive(Debug, PartialEq, Eq)]
pub struct Items {
    pub open_chat: &'static str,
    /// Enabled while a task on the computer goes by itself (DK-10).
    pub stop_task: &'static str,
    pub copy_diagnostics: &'static str,
    pub quit: &'static str,
}

pub fn items(locale: Locale) -> Items {
    match locale {
        Locale::Es => Items {
            open_chat: "Abrir chat",
            stop_task: "Detener tarea",
            copy_diagnostics: "Copiar diagnóstico",
            quit: "Salir de ANOMANDER",
        },
        Locale::En => Items {
            open_chat: "Open chat",
            stop_task: "Stop task",
            copy_diagnostics: "Copy diagnostics",
            quit: "Quit ANOMANDER",
        },
    }
}

/// What the menu bar shows: the daemon's status, and the work ANOMANDER has in hand.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct View {
    pub status: DaemonStatus,
    /// The chat waits for an answer.
    pub thinking: bool,
    /// A task on the computer goes by itself (DK-10).
    pub task: bool,
}

/// How the icon is drawn. Work only shows on a running daemon: one that is not running owes
/// nothing, whatever the window last said.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Look {
    Running,
    Working,
    Stopped,
    Starting,
    Failing,
}

impl View {
    /// Whether ANOMANDER has work in hand: an answer owed, or a task going by itself.
    pub fn working(&self) -> bool {
        self.thinking || self.task
    }

    pub fn look(&self) -> Look {
        match self.status.state {
            DaemonState::Running if self.working() => Look::Working,
            DaemonState::Running => Look::Running,
            DaemonState::Stopped => Look::Stopped,
            DaemonState::Starting => Look::Starting,
            DaemonState::Failing => Look::Failing,
        }
    }
}

pub fn labels(view: &View, locale: Locale) -> Labels {
    let say = |es, en| locale.pick(es, en);
    let start = say("Iniciar ANOMANDER", "Start ANOMANDER");
    let stop = say("Detener ANOMANDER", "Stop ANOMANDER");
    // Starting cannot help while the setup is incomplete; choosing it opens the window, which
    // shows the setup screen by itself.
    let set_up = say("Configurar ANOMANDER…", "Set up ANOMANDER…");
    let status = &view.status;
    let (status, toggle) = match (status.state, status.reason) {
        // A task is the more telling of the two: the chat may be waiting for it as well.
        (DaemonState::Running, _) if view.task => (
            say(
                "ANOMANDER está haciendo una tarea…",
                "ANOMANDER is doing a task…",
            ),
            stop,
        ),
        (DaemonState::Running, _) if view.thinking => (
            say("ANOMANDER está pensando…", "ANOMANDER is thinking…"),
            stop,
        ),
        (DaemonState::Running, _) => (
            say("ANOMANDER está en marcha", "ANOMANDER is running"),
            stop,
        ),
        (DaemonState::Starting, _) => (
            say("ANOMANDER está arrancando…", "ANOMANDER is starting…"),
            stop,
        ),
        (DaemonState::Failing, _) => (
            say(
                "ANOMANDER se ha caído; reiniciando…",
                "ANOMANDER crashed; restarting…",
            ),
            stop,
        ),
        (DaemonState::Stopped, Some(StopReason::NotConfigured)) => (
            say(
                "ANOMANDER está detenido: falta configurarlo",
                "ANOMANDER is stopped: it is not set up yet",
            ),
            set_up,
        ),
        (DaemonState::Stopped, Some(StopReason::AlreadyRunning)) => (
            say(
                "ANOMANDER está detenido: ya hay otro en marcha con estos datos",
                "ANOMANDER is stopped: another one is already running with this data",
            ),
            start,
        ),
        (DaemonState::Stopped, Some(StopReason::BotInUse)) => (
            say(
                "ANOMANDER está detenido: otro ANOMANDER usa el bot de Telegram",
                "ANOMANDER is stopped: another ANOMANDER is using the Telegram bot",
            ),
            start,
        ),
        (DaemonState::Stopped, Some(StopReason::GaveUp)) => (
            say(
                "ANOMANDER está detenido: ha fallado 3 veces en 5 minutos",
                "ANOMANDER is stopped: it failed 3 times in 5 minutes",
            ),
            start,
        ),
        (DaemonState::Stopped, Some(StopReason::StoppedByPrincipal)) => (
            say("ANOMANDER está detenido", "ANOMANDER is stopped"),
            start,
        ),
        // No reason and an error: it never got to run, for example Node was not found.
        (DaemonState::Stopped, None) if status.last_error.is_some() => (
            say(
                "ANOMANDER no ha podido arrancar",
                "ANOMANDER could not start",
            ),
            start,
        ),
        (DaemonState::Stopped, None) => (
            say("ANOMANDER está detenido", "ANOMANDER is stopped"),
            start,
        ),
    };
    Labels { status, toggle }
}

/// The menu items whose text follows the status, and what they show now.
pub struct TrayMenu {
    status: MenuItem<Wry>,
    toggle: MenuItem<Wry>,
    /// "Detener tarea": enabled while a task on the computer goes by itself (DK-10).
    stop_task: MenuItem<Wry>,
    /// The language of every text of the menu.
    locale: Locale,
    view: Mutex<View>,
    /// Wakes the animation thread when the view changes, so it sleeps through an idle app.
    woken: Condvar,
    /// Which frame of the working wave is on screen.
    frame: AtomicU8,
}

/// How long each frame of the working wave stays: `FRAMES` of them make one turn of 1.44 s, a
/// calm pace at 25 frames a second.
const FRAME: Duration = Duration::from_millis(40);

/// Builds the icon and its menu, in `locale`; `on_menu` gets the ID of the chosen item.
pub fn build(
    app: &App,
    initial: &DaemonStatus,
    locale: Locale,
    on_menu: impl Fn(&AppHandle, &str) + Send + Sync + 'static,
) -> tauri::Result<()> {
    let view = View {
        status: initial.clone(),
        thinking: false,
        task: false,
    };
    let texts = labels(&view, locale);
    let fixed = items(locale);
    // The status reads as a heading: it cannot be chosen.
    let status = MenuItem::with_id(app, "status", texts.status, false, None::<&str>)?;
    let open = MenuItem::with_id(app, OPEN_CHAT, fixed.open_chat, true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, TOGGLE, texts.toggle, true, None::<&str>)?;
    // The app is out of the way while a task goes by itself: this is how to stop it then.
    let stop_task = MenuItem::with_id(app, STOP_TASK, fixed.stop_task, false, None::<&str>)?;
    let diagnostics = MenuItem::with_id(
        app,
        COPY_DIAGNOSTICS,
        fixed.copy_diagnostics,
        true,
        None::<&str>,
    )?;
    // Cmd-Q quits a Mac app; a menu of the notification area has no shortcut of its own.
    let shortcut = (HERE == Tray::MenuBar).then_some("Cmd+Q");
    let quit = MenuItem::with_id(app, QUIT, fixed.quit, true, shortcut)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[
            &status,
            &separator,
            &open,
            &stop_task,
            &toggle,
            &separator,
            &diagnostics,
            &quit,
        ],
    )?;
    let on_menu = Arc::new(on_menu);
    let on_click = Arc::clone(&on_menu);
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon(view.look(), 0))
        .icon_as_template(HERE == Tray::MenuBar)
        .tooltip(texts.status)
        .menu(&menu)
        .show_menu_on_left_click(HERE == Tray::MenuBar)
        .on_menu_event(move |app, event| on_menu(app, event.id().as_ref()))
        .on_tray_icon_event(move |tray, event| {
            if opens_the_chat(HERE, &event) {
                on_click(tray.app_handle(), OPEN_CHAT);
            }
        })
        .build(app)?;
    app.manage(TrayMenu {
        status,
        toggle,
        stop_task,
        locale,
        view: Mutex::new(view),
        woken: Condvar::new(),
        frame: AtomicU8::new(0),
    });
    animate(app.handle().clone());
    Ok(())
}

/// Moves the working wave for as long as the app lives. While nothing is working the thread
/// sleeps until a change wakes it, so an idle app draws nothing and wakes for nothing.
fn animate(app: AppHandle) {
    std::thread::spawn(move || {
        // The frames are drawn once, here, so the main thread never waits for them.
        working_frames();
        loop {
            let Some(menu) = app.try_state::<TrayMenu>() else {
                std::thread::sleep(FRAME);
                continue;
            };
            wait_until(&menu, |view| view.look() == Look::Working);
            if reduce_motion() {
                // A still icon says the same: the mark with its dots at rest, already drawn.
                wait_until(&menu, |view| view.look() != Look::Working);
                continue;
            }
            while step(&app, &menu) {
                std::thread::sleep(FRAME);
            }
        }
    });
}

/// Blocks until `holds` is true of the view, waking only when the view changes.
fn wait_until(menu: &TrayMenu, holds: impl Fn(&View) -> bool) {
    let view = menu.view.lock().unwrap_or_else(PoisonError::into_inner);
    let _held = menu
        .woken
        .wait_while(view, |view| !holds(view))
        .unwrap_or_else(PoisonError::into_inner);
}

/// Draws the next frame of the wave; false once the work is over.
fn step(app: &AppHandle, menu: &TrayMenu) -> bool {
    let working = menu
        .view
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .look()
        == Look::Working;
    if !working {
        return false;
    }
    let handle = app.clone();
    // Menu bar changes run on the main thread.
    let _ = app.run_on_main_thread(move || {
        let Some(menu) = handle.try_state::<TrayMenu>() else {
            return;
        };
        // The answer may have arrived in between: then the icon is no longer ours to draw.
        let view = menu
            .view
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        if view.look() != Look::Working {
            return;
        }
        let frame = (menu.frame.load(Ordering::Relaxed) + 1) % FRAMES;
        menu.frame.store(frame, Ordering::Relaxed);
        draw(&handle, Look::Working, frame);
    });
    true
}

/// Whether the principal asked the system to reduce motion: on macOS, System Settings ›
/// Accessibility › Display; on Windows, Settings › Accessibility › Visual effects › Animation
/// effects off. Read once per spell of work, off the main thread; a sandboxed build, or another
/// system, reads nothing and moves.
fn reduce_motion() -> bool {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/bin/defaults")
            .args(["read", "com.apple.universalaccess", "reduceMotion"])
            .output()
            .is_ok_and(|output| {
                output.status.success() && String::from_utf8_lossy(&output.stdout).trim() == "1"
            })
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SystemParametersInfoW, SPI_GETCLIENTAREAANIMATION,
        };
        let mut animate: i32 = 1;
        // SAFETY: SPI_GETCLIENTAREAANIMATION writes one BOOL through the pointer, which points at
        // a live i32 (a BOOL) for the length of the call.
        let read = unsafe {
            SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION, 0, (&raw mut animate).cast(), 0)
        };
        read != 0 && animate == 0
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        false
    }
}

fn draw(app: &AppHandle, look: Look, frame: u8) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    if let Err(error) =
        tray.set_icon_with_as_template(Some(icon(look, frame)), HERE == Tray::MenuBar)
    {
        eprintln!("could not update the menu bar icon: {error}");
    }
}

/// Shows the daemon's `status` in the menu bar. Runs on the main thread.
pub fn show_status(app: &AppHandle, status: &DaemonStatus) {
    change(app, |view| view.status = status.clone());
}

/// Shows whether the chat waits for an answer. Runs on the main thread.
pub fn show_thinking(app: &AppHandle, thinking: bool) {
    change(app, |view| view.thinking = thinking);
}

/// Offers "Detener tarea" while a task on the computer goes by itself, and shows the work in the
/// icon. Runs on the main thread.
pub fn show_task(app: &AppHandle, running: bool) {
    let Some(menu) = app.try_state::<TrayMenu>() else {
        return;
    };
    if let Err(error) = menu.stop_task.set_enabled(running) {
        eprintln!("could not update the menu: {error}");
    }
    change(app, |view| view.task = running);
}

fn change(app: &AppHandle, update: impl FnOnce(&mut View)) {
    let Some(menu) = app.try_state::<TrayMenu>() else {
        return;
    };
    let view = {
        let mut view = menu.view.lock().unwrap_or_else(PoisonError::into_inner);
        let before = view.clone();
        update(&mut view);
        if *view == before {
            return;
        }
        view.clone()
    };
    menu.woken.notify_all();
    show(app, &menu, &view);
}

fn show(app: &AppHandle, menu: &TrayMenu, view: &View) {
    let texts = labels(view, menu.locale);
    menu.frame.store(0, Ordering::Relaxed);
    draw(app, view.look(), 0);
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if let Err(error) = tray.set_tooltip(Some(texts.status)) {
            eprintln!("could not update the menu bar icon: {error}");
        }
    }
    let shown = menu
        .status
        .set_text(texts.status)
        .and_then(|()| menu.toggle.set_text(texts.toggle));
    if let Err(error) = shown {
        eprintln!("could not update the menu bar menu: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The Spanish menu: the cases below read as the principal of a Spanish system does.
    fn labels(view: &View) -> Labels {
        super::labels(view, Locale::Es)
    }

    fn status(state: DaemonState, reason: Option<StopReason>) -> View {
        View {
            status: DaemonStatus {
                state,
                reason,
                last_error: None,
            },
            thinking: false,
            task: false,
        }
    }

    fn thinking(state: DaemonState) -> View {
        View {
            thinking: true,
            ..status(state, None)
        }
    }

    fn on_a_task(state: DaemonState) -> View {
        View {
            task: true,
            ..status(state, None)
        }
    }

    #[test]
    fn a_running_daemon_that_owes_an_answer_says_it_is_thinking() {
        let texts = labels(&thinking(DaemonState::Running));
        assert_eq!(texts.status, "ANOMANDER está pensando…");
        assert_eq!(texts.toggle, "Detener ANOMANDER");
        assert_eq!(thinking(DaemonState::Running).look(), Look::Working);
    }

    #[test]
    fn a_running_daemon_on_a_task_says_so_and_works_in_the_icon() {
        let texts = labels(&on_a_task(DaemonState::Running));
        assert_eq!(texts.status, "ANOMANDER está haciendo una tarea…");
        assert_eq!(texts.toggle, "Detener ANOMANDER");
        assert_eq!(on_a_task(DaemonState::Running).look(), Look::Working);
        // The chat waiting for the task's answer does not change what the task says.
        let both = View {
            thinking: true,
            ..on_a_task(DaemonState::Running)
        };
        assert_eq!(labels(&both), texts);
        assert_eq!(both.look(), Look::Working);
    }

    #[test]
    fn work_never_hides_a_daemon_that_is_not_running() {
        for (state, look) in [
            (DaemonState::Stopped, Look::Stopped),
            (DaemonState::Starting, Look::Starting),
            (DaemonState::Failing, Look::Failing),
        ] {
            assert_eq!(thinking(state).look(), look);
            assert_eq!(labels(&thinking(state)), labels(&status(state, None)));
            assert_eq!(on_a_task(state).look(), look);
            assert_eq!(labels(&on_a_task(state)), labels(&status(state, None)));
        }
    }

    #[test]
    fn the_action_stops_a_daemon_that_is_up_and_starts_a_stopped_one() {
        for state in [
            DaemonState::Running,
            DaemonState::Starting,
            DaemonState::Failing,
        ] {
            assert_eq!(labels(&status(state, None)).toggle, "Detener ANOMANDER");
        }
        for reason in [
            None,
            Some(StopReason::AlreadyRunning),
            Some(StopReason::BotInUse),
            Some(StopReason::GaveUp),
            Some(StopReason::StoppedByPrincipal),
        ] {
            assert_eq!(
                labels(&status(DaemonState::Stopped, reason)).toggle,
                "Iniciar ANOMANDER"
            );
        }
    }

    #[test]
    fn an_incomplete_setup_offers_to_set_it_up_instead_of_a_start_that_cannot_help() {
        let texts = labels(&status(
            DaemonState::Stopped,
            Some(StopReason::NotConfigured),
        ));
        assert_eq!(texts.toggle, "Configurar ANOMANDER…");
        assert_eq!(texts.status, "ANOMANDER está detenido: falta configurarlo");
    }

    #[test]
    fn the_status_says_what_is_happening() {
        let says = |state| labels(&status(state, None)).status;
        assert_eq!(says(DaemonState::Running), "ANOMANDER está en marcha");
        assert_eq!(says(DaemonState::Starting), "ANOMANDER está arrancando…");
        assert_eq!(
            says(DaemonState::Failing),
            "ANOMANDER se ha caído; reiniciando…"
        );
    }

    #[test]
    fn a_stopped_daemon_says_why() {
        let why = |reason| labels(&status(DaemonState::Stopped, Some(reason))).status;
        assert_eq!(
            why(StopReason::AlreadyRunning),
            "ANOMANDER está detenido: ya hay otro en marcha con estos datos"
        );
        assert_eq!(
            why(StopReason::BotInUse),
            "ANOMANDER está detenido: otro ANOMANDER usa el bot de Telegram"
        );
        assert_eq!(
            why(StopReason::GaveUp),
            "ANOMANDER está detenido: ha fallado 3 veces en 5 minutos"
        );
        assert_eq!(
            why(StopReason::StoppedByPrincipal),
            "ANOMANDER está detenido"
        );
    }

    #[test]
    fn a_daemon_that_never_ran_is_not_shown_as_merely_stopped() {
        let never_ran = View {
            status: DaemonStatus {
                state: DaemonState::Stopped,
                reason: None,
                last_error: Some("node was not found".into()),
            },
            thinking: false,
            task: false,
        };
        assert_eq!(labels(&never_ran).status, "ANOMANDER no ha podido arrancar");
        assert_eq!(
            labels(&status(DaemonState::Stopped, None)).status,
            "ANOMANDER está detenido"
        );
    }

    #[test]
    fn the_menu_reads_in_english_on_any_other_system() {
        let english = |view: &View| super::labels(view, Locale::En);
        let says = |state, reason| english(&status(state, reason));
        let cases = [
            (
                english(&on_a_task(DaemonState::Running)),
                "ANOMANDER is doing a task…",
                "Stop ANOMANDER",
            ),
            (
                english(&thinking(DaemonState::Running)),
                "ANOMANDER is thinking…",
                "Stop ANOMANDER",
            ),
            (
                says(DaemonState::Running, None),
                "ANOMANDER is running",
                "Stop ANOMANDER",
            ),
            (
                says(DaemonState::Starting, None),
                "ANOMANDER is starting…",
                "Stop ANOMANDER",
            ),
            (
                says(DaemonState::Failing, None),
                "ANOMANDER crashed; restarting…",
                "Stop ANOMANDER",
            ),
            (
                says(DaemonState::Stopped, Some(StopReason::NotConfigured)),
                "ANOMANDER is stopped: it is not set up yet",
                "Set up ANOMANDER…",
            ),
            (
                says(DaemonState::Stopped, Some(StopReason::AlreadyRunning)),
                "ANOMANDER is stopped: another one is already running with this data",
                "Start ANOMANDER",
            ),
            (
                says(DaemonState::Stopped, Some(StopReason::BotInUse)),
                "ANOMANDER is stopped: another ANOMANDER is using the Telegram bot",
                "Start ANOMANDER",
            ),
            (
                says(DaemonState::Stopped, Some(StopReason::GaveUp)),
                "ANOMANDER is stopped: it failed 3 times in 5 minutes",
                "Start ANOMANDER",
            ),
            (
                says(DaemonState::Stopped, Some(StopReason::StoppedByPrincipal)),
                "ANOMANDER is stopped",
                "Start ANOMANDER",
            ),
            (
                says(DaemonState::Stopped, None),
                "ANOMANDER is stopped",
                "Start ANOMANDER",
            ),
        ];
        for (texts, status, toggle) in cases {
            assert_eq!(texts, Labels { status, toggle });
        }
        let never_ran = View {
            status: DaemonStatus {
                state: DaemonState::Stopped,
                reason: None,
                last_error: Some("node was not found".into()),
            },
            thinking: false,
            task: false,
        };
        assert_eq!(english(&never_ran).status, "ANOMANDER could not start");
    }

    #[test]
    fn the_fixed_items_follow_the_language() {
        assert_eq!(
            items(Locale::Es),
            Items {
                open_chat: "Abrir chat",
                stop_task: "Detener tarea",
                copy_diagnostics: "Copiar diagnóstico",
                quit: "Salir de ANOMANDER",
            }
        );
        assert_eq!(
            items(Locale::En),
            Items {
                open_chat: "Open chat",
                stop_task: "Stop task",
                copy_diagnostics: "Copy diagnostics",
                quit: "Quit ANOMANDER",
            }
        );
    }
    fn click(button: MouseButton, button_state: MouseButtonState) -> TrayIconEvent {
        TrayIconEvent::Click {
            id: TRAY_ID.into(),
            position: tauri::PhysicalPosition::new(0.0, 0.0),
            rect: tauri::Rect::default(),
            button,
            button_state,
        }
    }

    #[test]
    fn a_left_click_on_the_taskbar_icon_opens_the_chat_and_the_menu_bar_keeps_its_menu() {
        let left = click(MouseButton::Left, MouseButtonState::Up);
        assert!(opens_the_chat(Tray::Taskbar, &left));
        assert!(!opens_the_chat(Tray::MenuBar, &left));
        // The press is not the click, and the right button is the menu's.
        assert!(!opens_the_chat(
            Tray::Taskbar,
            &click(MouseButton::Left, MouseButtonState::Down)
        ));
        assert!(!opens_the_chat(
            Tray::Taskbar,
            &click(MouseButton::Right, MouseButtonState::Up)
        ));
    }
}
