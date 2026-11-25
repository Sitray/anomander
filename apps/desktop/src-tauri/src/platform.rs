// The operating system the window runs on, handed to every webview before its scripts
// (`window.__ANOMANDER_PLATFORM__`), as the language is (`locale.rs`): the window words the
// Keychain, "este Mac" and what is not on Windows yet by it (DK-20).

use tauri::plugin::TauriPlugin;
use tauri::Runtime;

/// What every webview runs before its own scripts. A fixed literal, chosen when the shell is
/// built: nothing from outside is ever put in it.
pub fn init_script() -> &'static str {
    if cfg!(windows) {
        "window.__ANOMANDER_PLATFORM__ = 'windows';"
    } else {
        "window.__ANOMANDER_PLATFORM__ = 'macos';"
    }
}

/// Hands the platform to every webview before its scripts run.
pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("platform")
        .js_init_script(init_script())
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_webviews_get_the_platform_the_shell_was_built_for() {
        let expected = if cfg!(windows) {
            "window.__ANOMANDER_PLATFORM__ = 'windows';"
        } else {
            "window.__ANOMANDER_PLATFORM__ = 'macos';"
        };
        assert_eq!(init_script(), expected);
        // The name and the values `src/platform.ts` reads.
        let page = include_str!("../../src/platform.ts");
        assert!(page.contains("__ANOMANDER_PLATFORM__"));
        assert!(page.contains("'windows'"));
    }
}
