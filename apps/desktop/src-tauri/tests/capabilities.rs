// Security L1, end to end through Tauri's own check: with the app's commands declared in
// `build.rs`, a window may call only what its capability grants (`capabilities/*.json`). The app is
// the mock runtime with this crate's real configuration and capabilities; the commands are stand-ins
// with the real names, since the check looks at the name and the calling window, not the body.
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{WebviewUrl, WebviewWindow, WebviewWindowBuilder};

#[tauri::command]
fn reveal() -> &'static str {
    "ran"
}

#[tauri::command]
fn perform_action() -> &'static str {
    "ran"
}

#[tauri::command]
fn capture_screen() -> &'static str {
    "ran"
}

#[tauri::command]
fn answer_login() -> &'static str {
    "ran"
}

/// A window with `label`, in an app that handles the stand-ins under the real configuration.
fn window(label: &str) -> WebviewWindow<tauri::test::MockRuntime> {
    let app = mock_builder()
        .invoke_handler(tauri::generate_handler![
            reveal,
            perform_action,
            capture_screen,
            answer_login
        ])
        .build(tauri::generate_context!(test = true))
        .expect("the mock app builds");
    match tauri::Manager::get_webview_window(&app, label) {
        Some(window) => window,
        None => WebviewWindowBuilder::new(&app, label, WebviewUrl::default())
            .build()
            .expect("the window builds"),
    }
}

/// Whether `window` may run `command`: Tauri answers "ran" or rejects it before the body runs.
fn runs(window: &WebviewWindow<tauri::test::MockRuntime>, command: &str) -> bool {
    let request = InvokeRequest {
        cmd: command.into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: "tauri://localhost".parse().expect("a URL"),
        body: InvokeBody::default(),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.to_string(),
    };
    get_ipc_response(window, request).is_ok()
}

#[test]
fn the_notch_window_opens_the_chat_and_cannot_act_on_the_computer() {
    let notch = window("notch");
    assert!(runs(&notch, "reveal"));
    for command in ["perform_action", "capture_screen", "answer_login"] {
        assert!(!runs(&notch, command), "the notch window ran {command}");
    }
}

#[test]
fn the_chat_window_runs_the_commands_it_uses() {
    let main = window("main");
    for command in ["reveal", "perform_action", "capture_screen", "answer_login"] {
        assert!(
            runs(&main, command),
            "the chat window could not run {command}"
        );
    }
}

#[test]
fn a_window_without_a_capability_runs_no_app_command() {
    let other = window("other");
    for command in ["reveal", "perform_action"] {
        assert!(
            !runs(&other, command),
            "a window with no capability ran {command}"
        );
    }
}
