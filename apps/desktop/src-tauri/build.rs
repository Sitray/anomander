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
    "set_notifications",
    "open_link",
];

/// Test binaries get no app manifest, so on Windows the Tauri app in `tests/capabilities.rs` could
/// not load (comctl32 v6, STATUS_ENTRYPOINT_NOT_FOUND): the MSVC linker embeds this one in them.
const TEST_MANIFEST: &str = "windows-test.manifest";

fn main() {
    let target = |name: &str| std::env::var(name).unwrap_or_default();
    if target("CARGO_CFG_TARGET_OS") == "windows" && target("CARGO_CFG_TARGET_ENV") == "msvc" {
        let manifest = std::path::Path::new(&target("CARGO_MANIFEST_DIR")).join(TEST_MANIFEST);
        println!("cargo:rerun-if-changed={TEST_MANIFEST}");
        println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg-tests=/MANIFESTINPUT:{}",
            manifest.display()
        );
    }
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
