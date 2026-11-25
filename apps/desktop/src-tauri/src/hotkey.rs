// DK-20: a hotkey that opens the chat from any app, Cmd+Shift+Space on macOS and Ctrl+Shift+Space
// on Windows. Pressed again while the chat is in front, it hides it. The shell registers it; no
// window may register one (the plugin's commands are granted to no window). When the system
// refuses it (another app holds it), the app works as before and the log says so, with nothing of
// the principal's.

use tauri::{AppHandle, Manager, Runtime};
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
pub const NOT_REGISTERED: &str = "the chat hotkey could not be registered; the app works without it";

/// Registers the hotkey. Never fails: without it the app works as before.
pub fn install<R: Runtime>(app: &AppHandle<R>) {
    if let Err(error) = app.plugin(tauri_plugin_global_shortcut::Builder::new().build()) {
        eprintln!("{NOT_REGISTERED}: {error}");
        return;
    }
    let registered = app
        .global_shortcut()
        .on_shortcut(chat_hotkey(), |app, _, event| {
            if event.state() == ShortcutState::Pressed {
                press(app);
            }
        });
    if let Err(error) = registered {
        eprintln!("{NOT_REGISTERED}: {error}");
    }
}

/// One press of the hotkey.
fn press<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    let visible = window.is_visible().unwrap_or(false);
    let focused = window.is_focused().unwrap_or(false);
    match toggle(visible, focused) {
        Toggle::Show => show_chat(app),
        Toggle::Hide => {
            if let Err(error) = window.hide() {
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

    #[test]
    fn a_press_brings_the_chat_unless_it_is_already_in_front() {
        assert_eq!(toggle(false, false), Toggle::Show);
        // Shown behind another app: brought to the front, not hidden.
        assert_eq!(toggle(true, false), Toggle::Show);
        assert_eq!(toggle(true, true), Toggle::Hide);
    }
}
