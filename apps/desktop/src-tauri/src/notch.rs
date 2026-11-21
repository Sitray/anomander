// The notice that drops from the notch when ANOMANDER's work ends: a second window, borderless and
// transparent, over the top centre of the main screen, drawn by `notch.html` (`src/notch/`). It
// follows the signals the menu bar icon takes (DK-6, DK-10): the chat waiting for an answer, and a
// task on the computer going by itself. While the work goes on only the menu bar's wave shows it;
// when it ends the pill drops to say so, holds, and retracts. On a screen without a notch the pill
// hangs from under the menu bar instead. Where there is no menu bar (Windows) the window sits at
// the top centre of the main screen's work area, and the pill floats just below its edge.
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use serde::Serialize;
use tauri::{App, AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const WINDOW: &str = "notch";
/// `STATE_EVENT` of `src/notch/main.ts`.
pub const STATE_EVENT: &str = "notch://state";

/// The pill's width, in points: inside the notch of every MacBook that has one, so it never
/// covers a menu bar item beside the notch.
pub const PILL_WIDTH: f64 = 176.0;
/// The narrowest notch is about 180 points wide: the pill must fit inside it.
const _: () = assert!(PILL_WIDTH < 180.0);
/// Room around the pill, so its edge is never cut by the window's.
const MARGIN: f64 = 8.0;
/// How far the pill hangs below the menu bar.
pub const DROP: f64 = 44.0;
/// The window's width.
pub const WIDTH: f64 = PILL_WIDTH + 2.0 * MARGIN;
/// A menu bar at least this tall belongs to a screen with a notch: 37 points, against 24 without.
const NOTCHED_BAR: f64 = 30.0;
/// How long the page takes to retract the pill, before the window hides.
const RETRACT: Duration = Duration::from_millis(400);
/// How long the pill stays down saying the work has ended.
const HOLD: Duration = Duration::from_millis(2400);
/// Where there is no menu bar to hang from, how far below the work area's top edge the pill
/// floats: `--gap` of `notch.css`.
pub const GAP: f64 = 12.0;
/// Whether this build has no menu bar or notch to hang the pill from, so it floats.
const FLOATS: bool = !cfg!(target_os = "macos");

/// What ANOMANDER is doing: nothing, an answer owed, or a task going by itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Work {
    Idle,
    Thinking,
    Task,
}

/// What the notice says: nothing, or that the work has ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Say {
    Nothing,
    Done,
}

/// What the page is told at each change.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct State {
    pub say: Say,
    /// The menu bar's height, in points, when the pill covers it from the notch down; 0 when the
    /// pill hangs from under the bar.
    pub bar: f64,
    /// The pill floats, rounded all round, `GAP` below the window's top edge: there is no notch
    /// or menu bar to hang from.
    pub floating: bool,
}

/// The two signals the notice follows.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct Signals {
    thinking: bool,
    task: bool,
}

impl Signals {
    /// A task is the more telling of the two: the chat may be waiting for it as well.
    fn work(self) -> Work {
        if self.task {
            Work::Task
        } else if self.thinking {
            Work::Thinking
        } else {
            Work::Idle
        }
    }
}

/// What a change of the signals does to the notice.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Turn {
    /// The work goes on, or nothing was going on.
    Nothing,
    /// Work starts: a pill still down from the last end goes back up.
    Starts,
    /// The work ended: the pill drops when `announce`.
    Ends { announce: bool },
}

/// One spell of work, from the first signal to the last.
#[derive(Debug, Default)]
struct Spell {
    signals: Signals,
    /// A task on the computer ran in this spell.
    task_seen: bool,
}

impl Spell {
    /// Applies `update`. The end is announced after a task on the computer, which the principal
    /// left to run by itself, and after an answer only when the chat is not in front: there the
    /// principal is already looking (as `notify_reply` decides).
    fn change(&mut self, update: impl FnOnce(&mut Signals), chat_in_front: bool) -> Turn {
        let before = self.signals.work();
        update(&mut self.signals);
        let after = self.signals.work();
        if after == Work::Task {
            self.task_seen = true;
        }
        match (before, after) {
            (Work::Idle, Work::Idle) => Turn::Nothing,
            (Work::Idle, _) => Turn::Starts,
            (_, Work::Idle) => {
                let announce = self.task_seen || !chat_in_front;
                self.task_seen = false;
                Turn::Ends { announce }
            }
            _ => Turn::Nothing,
        }
    }
}

struct Notice {
    spell: Mutex<Spell>,
    bar: f64,
    floating: bool,
    /// Counts the changes, so a hide ordered at one change does not take down later work.
    changes: AtomicU64,
}

/// Where the window goes, in points: centred on the main screen's top edge, over the notch when
/// there is one and under the menu bar otherwise.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Place {
    pub x: f64,
    pub y: f64,
    pub height: f64,
    /// `State::bar`.
    pub bar: f64,
}

/// `screen_*` is the screen's frame; `bar` is its menu bar's height, all in points.
pub fn place(screen_x: f64, screen_y: f64, screen_width: f64, bar: f64) -> Place {
    let notched = bar >= NOTCHED_BAR;
    let covered = if notched { bar } else { 0.0 };
    Place {
        x: screen_x + (screen_width - WIDTH) / 2.0,
        y: if notched { screen_y } else { screen_y + bar },
        height: covered + DROP + MARGIN,
        bar: covered,
    }
}

/// Where the window goes where the pill floats, in points: centred at the top of the main screen's
/// work area, which leaves out the taskbar wherever it is docked.
pub fn place_floating(area_x: f64, area_y: f64, area_width: f64) -> Place {
    Place {
        x: area_x + (area_width - WIDTH) / 2.0,
        y: area_y,
        height: GAP + DROP + MARGIN,
        bar: 0.0,
    }
}

/// Creates the window, hidden, over the main screen's notch. Without a main screen there is no
/// notice, and the app goes on without it.
pub fn build(app: &App) -> tauri::Result<()> {
    let Some(screen) = app.primary_monitor()? else {
        eprintln!("no main screen: the notice from the notch is off");
        return Ok(());
    };
    let scale = screen.scale_factor();
    let (position, size, work_area) = (screen.position(), screen.size(), screen.work_area());
    let place = if FLOATS {
        place_floating(
            f64::from(work_area.position.x) / scale,
            f64::from(work_area.position.y) / scale,
            f64::from(work_area.size.width) / scale,
        )
    } else {
        // The work area starts under the menu bar.
        let bar = f64::from(work_area.position.y - position.y) / scale;
        place(
            f64::from(position.x) / scale,
            f64::from(position.y) / scale,
            f64::from(size.width) / scale,
            bar,
        )
    };
    let builder = WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App("notch.html".into()))
        .title("ANOMANDER")
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        // It never takes the keyboard: showing it leaves the principal's app in front.
        .focusable(false)
        .focused(false)
        // A click opens the chat without first activating the app.
        .accept_first_mouse(true)
        // Kept out of other processes' screen captures, so the app's own capture of the screen
        // (`screen.rs`, through `screencapture`) does not show it. On Windows this is
        // `WDA_EXCLUDEFROMCAPTURE`.
        .content_protected(true)
        .visible(false)
        .position(place.x, place.y)
        .inner_size(WIDTH, place.height);
    // Not an app window of its own on the taskbar.
    #[cfg(not(target_os = "macos"))]
    let builder = builder.skip_taskbar(true);
    let window = builder.build()?;
    raise_over_the_menu_bar(&window);
    app.manage(Notice {
        spell: Mutex::new(Spell::default()),
        bar: place.bar,
        floating: FLOATS,
        changes: AtomicU64::new(0),
    });
    Ok(())
}

/// Puts the window at the menu bar's own level, `NSStatusWindowLevel`: macOS keeps a window at
/// any lower level under the menu bar, and the notch is in it. Sent straight to the `NSWindow`,
/// as AppKit's `-[NSWindow setLevel:]`, which takes an `NSInteger`.
#[cfg(target_os = "macos")]
fn raise_over_the_menu_bar(window: &WebviewWindow) {
    use std::ffi::{c_char, c_void};

    const NS_STATUS_WINDOW_LEVEL: isize = 25;

    #[link(name = "objc")]
    unsafe extern "C" {
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn objc_msgSend(receiver: *mut c_void, selector: *mut c_void, level: isize);
    }

    let Ok(ns_window) = window.ns_window() else {
        return;
    };
    // SAFETY: `ns_window` is the live `NSWindow` of a window just built on this, the main,
    // thread; `setLevel:` takes one `NSInteger`, which is what is passed.
    unsafe {
        let selector = sel_registerName(c"setLevel:".as_ptr());
        objc_msgSend(ns_window, selector, NS_STATUS_WINDOW_LEVEL);
    }
}

#[cfg(not(target_os = "macos"))]
fn raise_over_the_menu_bar(_window: &WebviewWindow) {}

/// Follows whether the chat waits for an answer; `chat_in_front` is whether the chat window has
/// the focus. Runs on the main thread.
pub fn show_thinking(app: &AppHandle, thinking: bool, chat_in_front: bool) {
    change(app, |signals| signals.thinking = thinking, chat_in_front);
}

/// Follows whether a task on the computer goes by itself. Runs on the main thread.
pub fn show_task(app: &AppHandle, running: bool, chat_in_front: bool) {
    change(app, |signals| signals.task = running, chat_in_front);
}

fn change(app: &AppHandle, update: impl FnOnce(&mut Signals), chat_in_front: bool) {
    let Some(notice) = app.try_state::<Notice>() else {
        return;
    };
    let turn = notice
        .spell
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .change(update, chat_in_front);
    let change = match turn {
        Turn::Nothing | Turn::Ends { announce: false } => return,
        Turn::Starts | Turn::Ends { announce: true } => {
            notice.changes.fetch_add(1, Ordering::Relaxed) + 1
        }
    };
    if turn == Turn::Starts {
        // New work: a pill still down from the last end goes back up; the wave in the menu bar
        // takes over. When none is down this hides a hidden window.
        say(app, &notice, Say::Nothing);
        hide_after_retract(app.clone(), change);
        return;
    }
    // The window shows first, so the page plays its drop on screen.
    if let Some(window) = app.get_webview_window(WINDOW) {
        if let Err(error) = window.show() {
            eprintln!("could not show the notice from the notch: {error}");
        }
    }
    say(app, &notice, Say::Done);
    retract_after_hold(app.clone(), change);
}

fn say(app: &AppHandle, notice: &Notice, say: Say) {
    let state = State {
        say,
        bar: notice.bar,
        floating: notice.floating,
    };
    if let Err(error) = app.emit_to(WINDOW, STATE_EVENT, state) {
        eprintln!("could not tell the notice from the notch: {error}");
    }
}

/// Retracts the pill once it has said its words, unless something changed in the meantime.
fn retract_after_hold(app: AppHandle, change: u64) {
    std::thread::spawn(move || {
        std::thread::sleep(HOLD);
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            let Some(notice) = handle.try_state::<Notice>() else {
                return;
            };
            if notice.changes.load(Ordering::Relaxed) != change {
                return;
            }
            say(&handle, &notice, Say::Nothing);
            hide_after_retract(handle.clone(), change);
        });
    });
}

/// Hides the window once the pill has retracted, unless work came back in the meantime.
fn hide_after_retract(app: AppHandle, change: u64) {
    std::thread::spawn(move || {
        std::thread::sleep(RETRACT);
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            let Some(notice) = handle.try_state::<Notice>() else {
                return;
            };
            if notice.changes.load(Ordering::Relaxed) != change {
                return;
            }
            if let Some(window) = handle.get_webview_window(WINDOW) {
                if let Err(error) = window.hide() {
                    eprintln!("could not hide the notice from the notch: {error}");
                }
            }
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_task_is_the_more_telling_signal_and_nothing_is_idle() {
        let both = Signals {
            thinking: true,
            task: true,
        };
        assert_eq!(both.work(), Work::Task);
        assert_eq!(
            Signals {
                thinking: true,
                task: false
            }
            .work(),
            Work::Thinking
        );
        assert_eq!(Signals::default().work(), Work::Idle);
    }

    fn think(on: bool) -> impl FnOnce(&mut Signals) {
        move |signals| signals.thinking = on
    }

    fn task(on: bool) -> impl FnOnce(&mut Signals) {
        move |signals| signals.task = on
    }

    #[test]
    fn an_answer_is_announced_only_when_the_chat_is_not_in_front() {
        let mut spell = Spell::default();
        assert_eq!(spell.change(think(true), true), Turn::Starts);
        assert_eq!(
            spell.change(think(false), true),
            Turn::Ends { announce: false }
        );
        assert_eq!(spell.change(think(true), false), Turn::Starts);
        assert_eq!(
            spell.change(think(false), false),
            Turn::Ends { announce: true }
        );
    }

    #[test]
    fn the_end_of_a_task_is_always_announced_and_only_once_the_work_is_over() {
        let mut spell = Spell::default();
        assert_eq!(spell.change(task(true), false), Turn::Starts);
        // The chat waits for each step while the task runs: still work, nothing to say.
        assert_eq!(spell.change(think(true), false), Turn::Nothing);
        assert_eq!(spell.change(task(false), true), Turn::Nothing);
        // The app came back to the front when the task ended: announced all the same.
        assert_eq!(
            spell.change(think(false), true),
            Turn::Ends { announce: true }
        );
        // The next spell starts afresh.
        assert_eq!(spell.change(think(true), true), Turn::Starts);
        assert_eq!(
            spell.change(think(false), true),
            Turn::Ends { announce: false }
        );
    }

    #[test]
    fn a_signal_that_changes_nothing_does_nothing() {
        let mut spell = Spell::default();
        assert_eq!(spell.change(think(false), false), Turn::Nothing);
        assert_eq!(spell.change(task(false), false), Turn::Nothing);
    }

    #[test]
    fn on_a_notched_screen_the_window_covers_the_notch_and_hangs_below_the_bar() {
        // A 14-inch MacBook Pro: 1512 points wide, a 37-point menu bar.
        let place = place(0.0, 0.0, 1512.0, 37.0);
        assert_eq!(place.x, (1512.0 - WIDTH) / 2.0);
        assert_eq!(place.y, 0.0);
        assert_eq!(place.bar, 37.0);
        assert_eq!(place.height, 37.0 + DROP + MARGIN);
    }

    #[test]
    fn without_a_notch_the_window_hangs_from_under_the_menu_bar() {
        let place = place(-1920.0, 200.0, 1920.0, 24.0);
        assert_eq!(place.x, -1920.0 + (1920.0 - WIDTH) / 2.0);
        assert_eq!(place.y, 224.0);
        assert_eq!(place.bar, 0.0);
        assert_eq!(place.height, DROP + MARGIN);
    }

    #[test]
    fn without_a_menu_bar_the_window_sits_at_the_top_centre_of_the_work_area() {
        // A 1920-pixel screen at 125%, its taskbar docked at the top: the work area starts
        // under it.
        let place = place_floating(0.0, 38.4, 1536.0);
        assert_eq!(place.x, (1536.0 - WIDTH) / 2.0);
        assert_eq!(place.y, 38.4);
        assert_eq!(place.bar, 0.0);
        assert_eq!(place.height, GAP + DROP + MARGIN);
        // On a second screen to the left, with the taskbar at the bottom.
        let place = place_floating(-1280.0, 0.0, 1280.0);
        assert_eq!(place.x, -1280.0 + (1280.0 - WIDTH) / 2.0);
        assert_eq!(place.y, 0.0);
    }

    #[test]
    fn the_page_is_told_what_to_say_in_snake_case() {
        let json = serde_json::to_string(&State {
            say: Say::Done,
            bar: 37.0,
            floating: false,
        })
        .unwrap();
        assert_eq!(json, r#"{"say":"done","bar":37.0,"floating":false}"#);
        assert_eq!(
            serde_json::to_string(&Say::Nothing).unwrap(),
            r#""nothing""#
        );
    }
}
