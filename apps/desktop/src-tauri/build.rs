// Declaring the app's commands makes Tauri check every one of them against the capabilities of
// the window that calls it (`capabilities/*.json`): a window gets only the commands granted to it,
// so the notice from the notch cannot act on the computer (security L1). Keep this list equal to
// `generate_handler!` in `src/lib.rs`; `test/capabilities.test.ts` compares them.
const COMMANDS: &[&str] = &[
    "get_snapshot",
    "save_setup",
    "get_connections",
    "save_connection",
    "remove_connection",
    "import_ledger",
    "connect_oauth",
    "forget_oauth",
    "get_subscriptions",
    "connect_subscription",
    "answer_login",
    "disconnect_subscription",
    "start_daemon",
    "stop_daemon",
    "set_thinking",
    "notify_reply",
    "capture_screen",
    "perform_action",
    "reveal",
    "set_task_running",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
