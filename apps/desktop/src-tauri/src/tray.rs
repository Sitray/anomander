// DK-6: the menu bar icon shows whether ANOMANDER is running, stopped or failing (AC1), and its
// menu opens the chat, starts or stops ANOMANDER, and quits (AC2). The labels are read by the
// principal, so they are Spanish (es-ES); the icons are drawn here, as template images.
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
    /// The first, disabled item and the tooltip.
    pub status: &'static str,
    pub toggle: &'static str,
}

pub fn labels(status: &DaemonStatus) -> Labels {
    let stop = "Detener ANOMANDER";
    let (status, toggle) = match (status.state, status.reason) {
        (DaemonState::Running, _) => ("ANOMANDER está en marcha", stop),
        (DaemonState::Starting, _) => ("ANOMANDER está arrancando", stop),
        (DaemonState::Failing, _) => ("ANOMANDER ha fallado; reintentando", stop),
        (DaemonState::Stopped, reason) => (
            match reason {
                Some(StopReason::NotConfigured) => "ANOMANDER está detenido: falta configurarlo",
                Some(StopReason::AlreadyRunning) => {
                    "ANOMANDER está detenido: ya hay otro en marcha"
                }
                Some(StopReason::BotInUse) => "ANOMANDER está detenido: otro ANOMANDER usa el bot",
                Some(StopReason::GaveUp) => "ANOMANDER está detenido: ha fallado 3 veces",
                Some(StopReason::StoppedByPrincipal) | None => "ANOMANDER está detenido",
            },
            "Iniciar ANOMANDER",
        ),
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
    let status = MenuItem::with_id(app, "status", texts.status, false, None::<&str>)?;
    let toggle = MenuItem::with_id(app, TOGGLE, texts.toggle, true, None::<&str>)?;
    let open = MenuItem::with_id(app, OPEN_CHAT, "Abrir chat", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, QUIT, "Salir", true, None::<&str>)?;
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

/// A template image: black, with the shape in the alpha channel, so macOS tints it for the
/// light and dark menu bars. A filled disc runs, a ring is stopped, a ring with a dot starts, and
/// a disc with an exclamation mark fails.
pub fn icon(state: DaemonState) -> Image<'static> {
    Image::new_owned(icon_rgba(state), SIZE, SIZE)
}

fn icon_rgba(state: DaemonState) -> Vec<u8> {
    let mut rgba = Vec::with_capacity((SIZE * SIZE * 4) as usize);
    for y in 0..SIZE {
        for x in 0..SIZE {
            let mut covered = 0;
            for sy in 0..SAMPLES {
                for sx in 0..SAMPLES {
                    let px = x as f32 + (sx as f32 + 0.5) / SAMPLES as f32;
                    let py = y as f32 + (sy as f32 + 0.5) / SAMPLES as f32;
                    if inside(state, px, py) {
                        covered += 1;
                    }
                }
            }
            let alpha = (covered * 255 / (SAMPLES * SAMPLES)) as u8;
            rgba.extend_from_slice(&[0, 0, 0, alpha]);
        }
    }
    rgba
}

fn inside(state: DaemonState, x: f32, y: f32) -> bool {
    let center = SIZE as f32 / 2.0;
    let (dx, dy) = (x - center, y - center);
    let distance = (dx * dx + dy * dy).sqrt();
    let outer = 14.0;
    let ring = distance <= outer && distance >= outer - 3.5;
    match state {
        DaemonState::Running => distance <= outer,
        DaemonState::Stopped => ring,
        DaemonState::Starting => ring || distance <= 5.0,
        DaemonState::Failing => {
            let bar = dx.abs() <= 2.0 && (-9.0..=2.5).contains(&dy);
            let dot = dx.abs() <= 2.0 && (5.5..=9.0).contains(&dy);
            distance <= outer && !bar && !dot
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
    fn the_toggle_starts_a_stopped_daemon_and_stops_any_other() {
        assert_eq!(
            labels(&status(DaemonState::Stopped, None)).toggle,
            "Iniciar ANOMANDER"
        );
        for state in [
            DaemonState::Running,
            DaemonState::Starting,
            DaemonState::Failing,
        ] {
            assert_eq!(labels(&status(state, None)).toggle, "Detener ANOMANDER");
        }
    }

    #[test]
    fn a_stopped_daemon_says_why() {
        let why = |reason| labels(&status(DaemonState::Stopped, Some(reason))).status;
        assert_eq!(
            why(StopReason::NotConfigured),
            "ANOMANDER está detenido: falta configurarlo"
        );
        assert_eq!(
            why(StopReason::AlreadyRunning),
            "ANOMANDER está detenido: ya hay otro en marcha"
        );
        assert_eq!(
            why(StopReason::BotInUse),
            "ANOMANDER está detenido: otro ANOMANDER usa el bot"
        );
        assert_eq!(
            why(StopReason::GaveUp),
            "ANOMANDER está detenido: ha fallado 3 veces"
        );
        assert_eq!(
            why(StopReason::StoppedByPrincipal),
            "ANOMANDER está detenido"
        );
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
            assert!(rgba.chunks(4).any(|pixel| pixel[3] == 255));
            for other in &icons[index + 1..] {
                assert_ne!(rgba, other);
            }
        }
    }
}
