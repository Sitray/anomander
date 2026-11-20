// DK-6 AC4: field logs. Everything the app and the daemon print goes, scrubbed of every secret
// this run has known (DK-5 AC2), to a rotating file in `~/Library/Logs/dev.anomander.desktop`, and
// "Copiar diagnóstico" in the menu bar copies a short report with the end of it.
//
// The app prints with `eprintln!` and forwards the daemon's lines on stdout and stderr
// (`daemon/supervisor.rs`), so the log is fed from those two descriptors (`capture`): every line,
// whoever printed it, passes the same `daemon::output::scrub` before it reaches the file
// (`log_file`). What reaches the terminal is unchanged.
pub mod capture;
pub mod log_file;
pub mod report;

use std::collections::BTreeSet;
use std::sync::{Mutex, OnceLock, PoisonError};

/// Every secret this run has known: the launch token, and each launch's `LaunchSpec.secrets`
/// (the list `shell.rs` builds). Kept for the whole run, so a line about an older launch is
/// scrubbed too.
fn known() -> &'static Mutex<BTreeSet<String>> {
    static SECRETS: OnceLock<Mutex<BTreeSet<String>>> = OnceLock::new();
    SECRETS.get_or_init(Mutex::default)
}

/// Adds `secrets` to those taken out of every line of the log; empty ones are ignored.
pub fn remember<'a>(secrets: impl IntoIterator<Item = &'a String>) {
    let mut known = known().lock().unwrap_or_else(PoisonError::into_inner);
    known.extend(secrets.into_iter().filter(|s| !s.is_empty()).cloned());
}

/// The secrets known now.
pub fn secrets() -> Vec<String> {
    known()
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .iter()
        .cloned()
        .collect()
}
