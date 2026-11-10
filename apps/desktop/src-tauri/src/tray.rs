// DK-6: the menu bar icon shows whether ANOMANDER is running, stopped or failing (AC1), and its
// menu opens the chat, starts or stops ANOMANDER, and quits (AC2). The texts are read by the
// principal, so they are Spanish (es-ES); the icon is drawn here, as a template image.
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{App, AppHandle, Manager, Wry};

use crate::snapshot::{DaemonState, DaemonStatus, StopReason};

pub const TRAY_ID: &str = "anomander";
pub const OPEN_CHAT: &str = "open-chat";
pub const TOGGLE: &str = "toggle-daemon";
pub const QUIT: &str = "quit";

/// The texts of the menu for one status.
#[derive(Debug, PartialEq, Eq)]
pub struct Labels {
    /// The first, disabled item and the tooltip: what is happening and, when stopped, why.
    pub status: &'static str,
    /// The action that makes sense now: stop, start, or set up when that is what is missing.
    pub toggle: &'static str,
}

const START: &str = "Iniciar ANOMANDER";
const STOP: &str = "Detener ANOMANDER";
/// Starting cannot help while the setup is incomplete; choosing it opens the window, which shows
/// the setup screen by itself.
const SET_UP: &str = "Configurar ANOMANDER…";

pub fn labels(status: &DaemonStatus) -> Labels {
    let (status, toggle) = match (status.state, status.reason) {
        (DaemonState::Running, _) => ("ANOMANDER está en marcha", STOP),
        (DaemonState::Starting, _) => ("ANOMANDER está arrancando…", STOP),
        (DaemonState::Failing, _) => ("ANOMANDER se ha caído; reiniciando…", STOP),
        (DaemonState::Stopped, Some(StopReason::NotConfigured)) => {
            ("ANOMANDER está detenido: falta configurarlo", SET_UP)
        }
        (DaemonState::Stopped, Some(StopReason::AlreadyRunning)) => (
            "ANOMANDER está detenido: ya hay otro en marcha con estos datos",
            START,
        ),
        (DaemonState::Stopped, Some(StopReason::BotInUse)) => (
            "ANOMANDER está detenido: otro ANOMANDER usa el bot de Telegram",
            START,
        ),
        (DaemonState::Stopped, Some(StopReason::GaveUp)) => (
            "ANOMANDER está detenido: ha fallado 3 veces en 5 minutos",
            START,
        ),
        (DaemonState::Stopped, Some(StopReason::StoppedByPrincipal)) => {
            ("ANOMANDER está detenido", START)
        }
        // No reason and an error: it never got to run, for example Node was not found.
        (DaemonState::Stopped, None) if status.last_error.is_some() => {
            ("ANOMANDER no ha podido arrancar", START)
        }
        (DaemonState::Stopped, None) => ("ANOMANDER está detenido", START),
    };
    Labels { status, toggle }
}

/// The menu items whose text follows the status.
pub struct TrayMenu {
    status: MenuItem<Wry>,
    toggle: MenuItem<Wry>,
}

/// Builds the icon and its menu; `on_menu` gets the ID of the chosen item.
pub fn build(
    app: &App,
    initial: &DaemonStatus,
    on_menu: impl Fn(&AppHandle, &str) + Send + Sync + 'static,
) -> tauri::Result<()> {
    let texts = labels(initial);
    // The status reads as a heading: it cannot be chosen.
    let status = MenuItem::with_id(app, "status", texts.status, false, None::<&str>)?;
    let open = MenuItem::with_id(app, OPEN_CHAT, "Abrir chat", true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, TOGGLE, texts.toggle, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, QUIT, "Salir de ANOMANDER", true, Some("Cmd+Q"))?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[&status, &separator, &open, &toggle, &separator, &quit],
    )?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon(initial.state))
        .icon_as_template(true)
        .tooltip(texts.status)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| on_menu(app, event.id().as_ref()))
        .build(app)?;
    app.manage(TrayMenu { status, toggle });
    Ok(())
}

/// Shows `status` in the menu bar. Runs on the main thread.
pub fn show(app: &AppHandle, status: &DaemonStatus) {
    let texts = labels(status);
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let shown = tray
            .set_icon(Some(icon(status.state)))
            .and_then(|()| tray.set_icon_as_template(true))
            .and_then(|()| tray.set_tooltip(Some(texts.status)));
        if let Err(error) = shown {
            eprintln!("could not update the menu bar icon: {error}");
        }
    }
    if let Some(menu) = app.try_state::<TrayMenu>() {
        let shown = menu
            .status
            .set_text(texts.status)
            .and_then(|()| menu.toggle.set_text(texts.toggle));
        if let Err(error) = shown {
            eprintln!("could not update the menu bar menu: {error}");
        }
    }
}

/// 18 points at 2x, the menu bar's height.
const SIZE: u32 = 36;
/// Supersampling per axis, for smooth edges.
const SAMPLES: u32 = 4;
/// How a mark that is not running is dimmed, as macOS dims an inactive menu bar item.
const DIMMED: f32 = 0.42;

/// A template image: black, with the shape in the alpha channel, so macOS tints it for the light
/// and dark menu bars. The mark is always ANOMANDER's "A", so the icon is recognised whatever the
/// state; the state is how it is drawn (DK-6 AC1):
/// - running: the solid mark;
/// - stopped: the mark dimmed;
/// - starting: the mark dimmed, with a small ring that says something is on its way;
/// - failing: the solid mark with an exclamation badge.
pub fn icon(state: DaemonState) -> Image<'static> {
    Image::new_owned(icon_rgba(state), SIZE, SIZE)
}

fn icon_rgba(state: DaemonState) -> Vec<u8> {
    let mut rgba = Vec::with_capacity((SIZE * SIZE * 4) as usize);
    for y in 0..SIZE {
        for x in 0..SIZE {
            let mut total = 0.0;
            for sy in 0..SAMPLES {
                for sx in 0..SAMPLES {
                    let px = x as f32 + (sx as f32 + 0.5) / SAMPLES as f32;
                    let py = y as f32 + (sy as f32 + 0.5) / SAMPLES as f32;
                    total += opacity(state, px, py);
                }
            }
            let alpha = (total / (SAMPLES * SAMPLES) as f32 * 255.0).round() as u8;
            rgba.extend_from_slice(&[0, 0, 0, alpha]);
        }
    }
    rgba
}

/// The distance from a point to the segment from `a` to `b`: a stroke with round ends is every
/// point closer than half its width.
fn distance_to_segment(point: (f32, f32), a: (f32, f32), b: (f32, f32)) -> f32 {
    let (abx, aby) = (b.0 - a.0, b.1 - a.1);
    let (apx, apy) = (point.0 - a.0, point.1 - a.1);
    let along = ((apx * abx + apy * aby) / (abx * abx + aby * aby)).clamp(0.0, 1.0);
    let (dx, dy) = (apx - abx * along, apy - aby * along);
    (dx * dx + dy * dy).sqrt()
}

/// The "A": two legs from the apex and a crossbar.
fn in_mark(point: (f32, f32)) -> bool {
    const APEX: (f32, f32) = (18.0, 5.5);
    const LEFT_FOOT: (f32, f32) = (7.5, 30.0);
    const RIGHT_FOOT: (f32, f32) = (28.5, 30.0);
    const LEG: f32 = 2.5;
    const BAR: f32 = 2.0;
    distance_to_segment(point, APEX, LEFT_FOOT) <= LEG
        || distance_to_segment(point, APEX, RIGHT_FOOT) <= LEG
        || distance_to_segment(point, (11.5, 22.5), (24.5, 22.5)) <= BAR
}

/// How opaque the icon is at a point, from 0 to 1.
fn opacity(state: DaemonState, x: f32, y: f32) -> f32 {
    // The badge sits in the corner the mark leaves empty, where a notification badge goes, with
    // a clear gap around it so it reads at 18 points and the mark stays whole.
    const BADGE: (f32, f32) = (29.0, 7.5);
    const BADGE_RADIUS: f32 = 6.0;
    const GAP: f32 = 1.5;
    let (dx, dy) = (x - BADGE.0, y - BADGE.1);
    let from_badge = (dx * dx + dy * dy).sqrt();
    let mark = |strength: f32| if in_mark((x, y)) { strength } else { 0.0 };
    let badged_mark = |strength: f32| {
        if from_badge <= BADGE_RADIUS + GAP {
            0.0
        } else {
            mark(strength)
        }
    };
    match state {
        DaemonState::Running => mark(1.0),
        DaemonState::Stopped => mark(DIMMED),
        DaemonState::Starting => {
            if (BADGE_RADIUS - 2.3..=BADGE_RADIUS).contains(&from_badge) {
                1.0
            } else {
                badged_mark(DIMMED)
            }
        }
        DaemonState::Failing => {
            let bar = dx.abs() <= 1.2 && (-3.9..=0.6).contains(&dy);
            let dot = dx.abs() <= 1.2 && (2.2..=4.2).contains(&dy);
            if from_badge <= BADGE_RADIUS {
                if bar || dot {
                    0.0
                } else {
                    1.0
                }
            } else {
                badged_mark(1.0)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(state: DaemonState, reason: Option<StopReason>) -> DaemonStatus {
        DaemonStatus {
            state,
            reason,
            last_error: None,
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
        let never_ran = DaemonStatus {
            state: DaemonState::Stopped,
            reason: None,
            last_error: Some("node was not found".into()),
        };
        assert_eq!(labels(&never_ran).status, "ANOMANDER no ha podido arrancar");
        assert_eq!(
            labels(&status(DaemonState::Stopped, None)).status,
            "ANOMANDER está detenido"
        );
    }

    fn strongest(rgba: &[u8]) -> u8 {
        rgba.chunks(4).map(|pixel| pixel[3]).max().unwrap_or(0)
    }

    #[test]
    fn each_state_has_its_own_template_icon() {
        let states = [
            DaemonState::Running,
            DaemonState::Stopped,
            DaemonState::Starting,
            DaemonState::Failing,
        ];
        let icons: Vec<Vec<u8>> = states.iter().map(|state| icon_rgba(*state)).collect();
        for (index, rgba) in icons.iter().enumerate() {
            assert_eq!(rgba.len(), (SIZE * SIZE * 4) as usize);
            // Template images: only the alpha channel carries the shape.
            assert!(rgba.chunks(4).all(|pixel| pixel[..3] == [0, 0, 0]));
            for other in &icons[index + 1..] {
                assert_ne!(rgba, other);
            }
        }
    }

    #[test]
    fn a_stopped_mark_is_dimmed_and_a_running_one_is_solid() {
        assert_eq!(strongest(&icon_rgba(DaemonState::Running)), 255);
        let dimmed = strongest(&icon_rgba(DaemonState::Stopped));
        assert!((90..=120).contains(&dimmed), "dimmed alpha was {dimmed}");
        // The badges are solid even on a dimmed mark, so they are what the eye finds.
        assert_eq!(strongest(&icon_rgba(DaemonState::Starting)), 255);
        assert_eq!(strongest(&icon_rgba(DaemonState::Failing)), 255);
    }

    #[test]
    fn the_mark_stays_inside_the_icon_with_a_clear_edge() {
        for state in [DaemonState::Running, DaemonState::Failing] {
            let rgba = icon_rgba(state);
            let alpha = |x: u32, y: u32| rgba[((y * SIZE + x) * 4 + 3) as usize];
            for i in 0..SIZE {
                assert_eq!(alpha(i, 0), 0);
                assert_eq!(alpha(i, SIZE - 1), 0);
                assert_eq!(alpha(0, i), 0);
                assert_eq!(alpha(SIZE - 1, i), 0);
            }
        }
    }
}
