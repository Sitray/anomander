// DK-12 (desktop next, S4): the import of a ledger brought from a Docker install. The work is the
// daemon package's (`packages/daemon/scripts/import-ledger.ts`), so SQLite stays in Node; the
// shell runs it with the daemon stopped and hands the window the one word it printed.
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;

use crate::daemon::launch::system_env;
use crate::daemon::process::WithoutConsole;

/// The script, from the daemon package's folder.
const SCRIPT: &str = "scripts/import-ledger.ts";

/// Every word the script may print: `imported`, or why it refused.
const OUTCOMES: [&str; 8] = [
    "imported",
    "missing",
    "same_file",
    "not_a_ledger",
    "newer_ledger",
    "damaged",
    "daemon_running",
    "own_has_expenses",
];

/// What the window is told. `outcome` is a word of `OUTCOMES`, or `not_a_path`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerImport {
    pub outcome: String,
}

impl LedgerImport {
    fn of(outcome: &str) -> Self {
        Self {
            outcome: outcome.into(),
        }
    }
}

/// The script next to the daemon's entry point: `<daemon>/src/main.ts` gives
/// `<daemon>/scripts/import-ledger.ts`.
pub fn script_of(entry: &Path) -> Option<PathBuf> {
    Some(entry.parent()?.parent()?.join(SCRIPT))
}

/// The path the principal typed or pasted: trimmed, `~/` read as their home folder. Only a full
/// path is taken: a relative one would be read from a folder they never chose.
pub fn source_path(typed: &str, home: Option<&str>) -> Option<PathBuf> {
    let typed = typed.trim();
    let path = match (typed.strip_prefix("~/"), home) {
        (Some(rest), Some(home)) if !home.is_empty() => Path::new(home).join(rest),
        _ => PathBuf::from(typed),
    };
    path.is_absolute().then_some(path)
}

/// Runs the import of `source` into `own` with `node`, and reads the word it printed.
pub fn run(
    node: &Path,
    script: &Path,
    source: &Path,
    own: &Path,
    path: &str,
) -> Result<LedgerImport, String> {
    let folder = own
        .parent()
        .ok_or_else(|| "the ledger has no folder".to_string())?;
    let output = Command::new(node)
        .arg(script)
        .arg(source)
        .arg(own)
        // Nothing of the app's environment: the import needs none of its secrets.
        .env_clear()
        .envs(system_env(&|name| std::env::var(name).ok()))
        .env("PATH", path)
        .current_dir(folder)
        .stdin(Stdio::null())
        .without_console()
        .output()
        .map_err(|error| format!("could not start {}: {error}", node.display()))?;
    let printed = String::from_utf8_lossy(&output.stdout);
    let word = printed.trim();
    if output.status.success() && OUTCOMES.contains(&word) {
        return Ok(LedgerImport::of(word));
    }
    // Its error output holds only an error code, never a path or a row.
    let said = String::from_utf8_lossy(&output.stderr);
    let reason = said.lines().rev().find(|line| !line.trim().is_empty());
    Err(match reason {
        Some(reason) => reason.trim().to_string(),
        None => format!("the import ended without an answer ({})", output.status),
    })
}

/// The answer when the typed text is not a full path.
pub fn not_a_path() -> LedgerImport {
    LedgerImport::of("not_a_path")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::launch::{daemon_entry, find_node, search_path};
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    #[cfg(unix)]
    /// A fake `node` that prints `stdout`, writes `stderr` and ends with `code`.
    fn fake_node(dir: &Path, stdout: &str, stderr: &str, code: i32) -> PathBuf {
        let node = dir.join("node");
        let body = format!("#!/bin/sh\nprintf '{stdout}'\nprintf '{stderr}' >&2\nexit {code}\n");
        std::fs::write(&node, body).unwrap_or_else(|e| panic!("no fake node: {e}"));
        std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755))
            .unwrap_or_else(|e| panic!("no fake node: {e}"));
        node
    }

    #[cfg(unix)]
    fn run_fake(stdout: &str, stderr: &str, code: i32) -> Result<LedgerImport, String> {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("no temp dir: {e}"));
        let node = fake_node(dir.path(), stdout, stderr, code);
        run(
            &node,
            Path::new("/x/import-ledger.ts"),
            Path::new("/x/source.db"),
            &dir.path().join("anomander.db"),
            "/usr/bin:/bin",
        )
    }

    #[cfg(unix)]
    #[test]
    fn each_word_the_script_prints_reaches_the_window() {
        for word in OUTCOMES {
            assert_eq!(
                run_fake(&format!("{word}\\n"), "", 0),
                Ok(LedgerImport::of(word))
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn an_unknown_word_or_an_error_is_an_error_with_what_the_script_said() {
        assert_eq!(
            run_fake("", "could not import the ledger: EACCES\\n", 1),
            Err("could not import the ledger: EACCES".into())
        );
        assert!(run_fake("deleted_everything\\n", "", 0).is_err());
        assert!(run_fake("imported\\n", "", 1).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn on_windows_a_full_path_has_a_drive_and_a_tilde_is_the_home_folder() {
        assert_eq!(
            source_path("  C:\\Users\\p\\anomander.db \n", None),
            Some(PathBuf::from("C:\\Users\\p\\anomander.db"))
        );
        assert_eq!(
            source_path("~/anomander.db", Some("C:\\Users\\p")),
            Some(PathBuf::from("C:\\Users\\p").join("anomander.db"))
        );
        assert_eq!(source_path("/Users/p/anomander.db", None), None);
        assert_eq!(source_path("anomander.db", Some("C:\\Users\\p")), None);
    }

    // Unix paths: on Windows a full path starts with a drive.
    #[cfg(unix)]
    #[test]
    fn only_a_full_path_is_taken_and_a_tilde_is_the_home_folder() {
        assert_eq!(
            source_path("  /Users/p/anomander.db \n", None),
            Some(PathBuf::from("/Users/p/anomander.db"))
        );
        assert_eq!(
            source_path("~/Downloads/anomander.db", Some("/Users/p")),
            Some(PathBuf::from("/Users/p/Downloads/anomander.db"))
        );
        assert_eq!(source_path("anomander.db", Some("/Users/p")), None);
        assert_eq!(source_path("~/anomander.db", None), None);
        assert_eq!(source_path("", Some("/Users/p")), None);
    }

    #[test]
    fn the_script_sits_next_to_the_daemons_entry_point() {
        let script = script_of(&daemon_entry(None))
            .unwrap_or_else(|| panic!("the entry point has no package folder"));
        assert!(script.ends_with("packages/daemon/scripts/import-ledger.ts"));
        assert!(script.is_file());
    }

    #[test]
    fn the_real_script_refuses_what_is_not_a_ledger_and_changes_nothing() {
        let path = search_path(std::env::var("PATH").ok().as_deref());
        let node = find_node(None, &path).unwrap_or_else(|| panic!("node is needed: {path}"));
        let script = script_of(&daemon_entry(None))
            .unwrap_or_else(|| panic!("the entry point has no package folder"));
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("no temp dir: {e}"));
        let own = dir.path().join("anomander.db");
        let text = dir.path().join("notes.txt");
        std::fs::write(&text, "not a ledger, only some text long enough to be read")
            .unwrap_or_else(|e| panic!("no file: {e}"));

        let answered = |source: &Path| run(&node, &script, source, &own, &path);
        assert_eq!(answered(&text), Ok(LedgerImport::of("not_a_ledger")));
        assert_eq!(
            answered(&dir.path().join("nothing.db")),
            Ok(LedgerImport::of("missing"))
        );
        let mut left: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap_or_else(|e| panic!("no listing: {e}"))
            .filter_map(|entry| entry.ok().map(|entry| entry.file_name()))
            // The daemon's lock (DK-2), which the import takes as a daemon does.
            .filter(|name| !name.to_string_lossy().contains(".lock"))
            .collect();
        left.sort();
        assert_eq!(left, vec![std::ffi::OsString::from("notes.txt")]);
    }
}
