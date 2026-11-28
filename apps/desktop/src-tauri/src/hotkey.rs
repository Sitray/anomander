// DK-20: a hotkey that opens the chat from any app, Cmd+Shift+Space on macOS and Ctrl+Shift+Space
// on Windows. Pressed again while the chat is in front, it hides it. The shell registers it; no
// window may register one (the plugin's commands are granted to no window). When the system
// refuses it (another app holds it), the app works as before and the log says so, with nothing of
// the principal's.

use tauri::{AppHandle, Manager, Runtime, WebviewWindow};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::{show_chat, MAIN_WINDOW};

/// The hotkey: Cmd on macOS, Ctrl elsewhere, with Shift and Space.
pub fn chat_hotkey() -> Shortcut {
    #[cfg(target_os = "macos")]
    let command = Modifiers::SUPER;
    #[cfg(not(target_os = "macos"))]
    let command = Modifiers::CONTROL;
    Shortcut::new(Some(command | Modifiers::SHIFT), Code::Space)
}

/// What a press does to the chat window, by what the window is now.
#[derive(Debug, PartialEq, Eq)]
pub enum Toggle {
    Show,
    Hide,
}

/// Hides the chat only when it is on screen and in front; otherwise brings it.
pub fn toggle(visible: bool, focused: bool) -> Toggle {
    if visible && focused {
        Toggle::Hide
    } else {
        Toggle::Show
    }
}

/// The line of the log when the hotkey cannot be had: fixed, with nothing of the principal's.
pub const NOT_REGISTERED: &str =
    "the chat hotkey could not be registered; the app works without it";

/// Registers the hotkey. Never fails: without it the app works as before.
pub fn install<R: Runtime>(app: &AppHandle<R>) {
    if let Err(error) = app.plugin(tauri_plugin_global_shortcut::Builder::new().build()) {
        eprintln!("{NOT_REGISTERED}: {error}");
        return;
    }
    let registered = app
        .global_shortcut()
        .on_shortcut(chat_hotkey(), |app, _, event| on_event(app, event.state()));
    if let Err(error) = registered {
        eprintln!("{NOT_REGISTERED}: {error}");
    }
}

/// The hotkey going down or coming up: only going down is a press.
fn on_event<R: Runtime>(app: &AppHandle<R>, state: ShortcutState) {
    if state == ShortcutState::Pressed {
        press(app);
    }
}

/// One press of the hotkey.
fn press<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        press_on(&window, || show_chat(app));
    }
}

/// What a press reads of the chat window and does to it.
trait ChatWindow {
    fn on_screen(&self) -> bool;
    fn in_front(&self) -> bool;
    fn hide_chat(&self) -> tauri::Result<()>;
}

impl<R: Runtime> ChatWindow for WebviewWindow<R> {
    /// A window the system cannot answer about is taken as not shown, so a press brings it.
    fn on_screen(&self) -> bool {
        self.is_visible().unwrap_or(false)
    }
    fn in_front(&self) -> bool {
        self.is_focused().unwrap_or(false)
    }
    fn hide_chat(&self) -> tauri::Result<()> {
        self.hide()
    }
}

/// A press on `window`: `show` brings the chat, as every other way of showing it does.
fn press_on(window: &impl ChatWindow, show: impl FnOnce()) {
    match toggle(window.on_screen(), window.in_front()) {
        Toggle::Show => show(),
        Toggle::Hide => {
            if let Err(error) = window.hide_chat() {
                eprintln!("could not hide the window: {error}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_hotkey_is_cmd_shift_space_on_macos_and_ctrl_shift_space_on_windows() {
        let command = if cfg!(target_os = "macos") {
            Modifiers::SUPER
        } else {
            Modifiers::CONTROL
        };
        assert_eq!(
            chat_hotkey(),
            Shortcut::new(Some(command | Modifiers::SHIFT), Code::Space)
        );
    }

    use std::cell::Cell;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tauri::test::{mock_builder, MockRuntime};
    use tauri::{App, Listener, WebviewWindowBuilder};

    /// The app under the crate's real configuration, with its chat window.
    fn app_with_chat() -> App<MockRuntime> {
        let app = mock_builder()
            .build(tauri::generate_context!(test = true))
            .expect("the mock app builds");
        WebviewWindowBuilder::new(&app, MAIN_WINDOW, Default::default())
            .build()
            .expect("the window builds");
        app
    }

    /// How many times the window was told it was shown again (`show_chat`).
    fn count_shown(app: &App<MockRuntime>) -> Arc<AtomicUsize> {
        let heard = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&heard);
        app.listen_any(crate::CHAT_SHOWN_EVENT, move |_| {
            counter.fetch_add(1, Ordering::SeqCst);
        });
        heard
    }

    /// B66: the key going down brings the chat through `show_chat`; the key coming up does not.
    #[test]
    fn a_press_of_the_key_shows_the_chat_and_its_release_does_nothing() {
        let app = app_with_chat();
        let shown = count_shown(&app);

        on_event(app.handle(), ShortcutState::Released);
        assert_eq!(shown.load(Ordering::SeqCst), 0);

        // The mock window is on screen but not in front, as behind another app.
        on_event(app.handle(), ShortcutState::Pressed);
        assert_eq!(shown.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_press_without_the_chat_window_does_nothing() {
        let app = mock_builder()
            .build(tauri::generate_context!(test = true))
            .expect("the mock app builds");
        assert!(app.get_webview_window(MAIN_WINDOW).is_none());
        let shown = count_shown(&app);

        on_event(app.handle(), ShortcutState::Pressed);

        assert_eq!(shown.load(Ordering::SeqCst), 0);
    }

    /// A stand-in for the chat window, which the mock runtime always reports as not in front.
    struct Window {
        visible: bool,
        focused: bool,
        hidden: Cell<usize>,
    }

    impl ChatWindow for Window {
        fn on_screen(&self) -> bool {
            self.visible
        }
        fn in_front(&self) -> bool {
            self.focused
        }
        fn hide_chat(&self) -> tauri::Result<()> {
            self.hidden.set(self.hidden.get() + 1);
            Ok(())
        }
    }

    #[test]
    fn a_press_hides_the_chat_in_front_and_shows_it_otherwise() {
        for (visible, focused, hides) in [
            (true, true, true),
            (true, false, false),
            (false, false, false),
        ] {
            let window = Window {
                visible,
                focused,
                hidden: Cell::new(0),
            };
            let shown = Cell::new(0);
            press_on(&window, || shown.set(shown.get() + 1));
            assert_eq!(
                window.hidden.get(),
                usize::from(hides),
                "{visible} {focused}"
            );
            assert_eq!(shown.get(), usize::from(!hides), "{visible} {focused}");
        }
    }

    #[test]
    fn a_press_brings_the_chat_unless_it_is_already_in_front() {
        assert_eq!(toggle(false, false), Toggle::Show);
        // Shown behind another app: brought to the front, not hidden.
        assert_eq!(toggle(true, false), Toggle::Show);
        assert_eq!(toggle(true, true), Toggle::Hide);
    }
}
