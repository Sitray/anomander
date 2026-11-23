// "Copiar diagnóstico": what the principal can paste when something goes wrong. The app's
// version, the system's version, the daemon's state and the last lines of the log, nothing else.
// The daemon never logs what the principal writes (§16): only references, reasons and amounts.
use std::fs;
use std::io;
use std::path::Path;

use super::log_file::path_of;
use crate::daemon::output::scrub;
use crate::locale::Locale;

/// How many lines of the log the report carries.
pub const LINES: usize = 200;

/// What the report says besides the log.
pub struct Facts<'a> {
    pub app_version: &'a str,
    /// The version of the system (`OS_NAME`).
    pub os_version: &'a str,
    /// The menu bar's own words for the daemon's state (`tray::labels`).
    pub daemon: &'a str,
}

/// The last `count` lines of the log in `dir`, oldest first: the current file, and the newest
/// one set aside when the current one is shorter. No log yet gives no lines.
pub fn tail(dir: &Path, count: usize) -> io::Result<Vec<String>> {
    let mut lines = Vec::new();
    for index in [0, 1] {
        let text = match fs::read(path_of(dir, index)) {
            Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        let mut older: Vec<String> = text.lines().map(str::to_owned).collect();
        older.append(&mut lines);
        lines = older;
        if lines.len() >= count {
            break;
        }
    }
    Ok(lines.split_off(lines.len().saturating_sub(count)))
}

/// The report, plain text, in `locale`. The lines are scrubbed again with the secrets known now,
/// which covers a line written before its secret was known.
pub fn report(facts: &Facts, lines: &[String], secrets: &[&str], locale: Locale) -> String {
    let (app_version, os_version, daemon, count) = (
        facts.app_version,
        facts.os_version,
        facts.daemon,
        lines.len(),
    );
    let mut text = match locale {
        Locale::Es => format!(
            "ANOMANDER: diagnóstico\nVersión de la app: {app_version}\n{OS_NAME}: {os_version}\nEstado: {daemon}\n\nÚltimas {count} líneas del registro:\n"
        ),
        Locale::En => format!(
            "ANOMANDER: diagnostics\nApp version: {app_version}\n{OS_NAME}: {os_version}\nStatus: {daemon}\n\nLast {count} lines of the log:\n"
        ),
    };
    for line in lines {
        text.push_str(&scrub(line, secrets));
        text.push('\n');
    }
    text
}

/// The system the report names.
pub const OS_NAME: &str = if cfg!(windows) { "Windows" } else { "macOS" };

/// The version of macOS, as `sw_vers` gives it, or "desconocida" ("unknown").
#[cfg(not(windows))]
pub fn os_version(locale: Locale) -> String {
    std::process::Command::new("/usr/bin/sw_vers")
        .arg("-productVersion")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|version| version.trim().to_owned())
        .filter(|version| !version.is_empty())
        .unwrap_or_else(|| unknown(locale))
}

/// The version of Windows, such as `10.0.26100` (Windows 11 24H2). `RtlGetVersion` gives the
/// real one, where `GetVersionEx` answers what the app's manifest declares.
#[cfg(windows)]
pub fn os_version(locale: Locale) -> String {
    use windows_sys::Wdk::System::SystemServices::RtlGetVersion;
    use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;
    let mut info = OSVERSIONINFOW {
        dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
        ..Default::default()
    };
    // SAFETY: `info` is an `OSVERSIONINFOW` with its size set, which is all the call writes.
    if unsafe { RtlGetVersion(&mut info) } != 0 {
        return unknown(locale);
    }
    format!(
        "{}.{}.{}",
        info.dwMajorVersion, info.dwMinorVersion, info.dwBuildNumber
    )
}

/// A version that could not be read.
fn unknown(locale: Locale) -> String {
    locale.pick("desconocida", "unknown").to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::locale::Locale;

    const SECRET: &str = "oauth-access-0123456789";

    fn facts() -> Facts<'static> {
        Facts {
            app_version: "0.0.0",
            os_version: "26.4",
            daemon: "ANOMANDER está en marcha",
        }
    }

    #[test]
    fn the_report_has_the_versions_the_state_and_the_tail() {
        let lines = vec!["2026-11-20T01:02:03Z first".to_owned(), "second".to_owned()];
        let text = report(&facts(), &lines, &[], Locale::Es);
        let mut expected = String::from("ANOMANDER: diagnóstico\n");
        expected.push_str("Versión de la app: 0.0.0\n");
        expected.push_str(&format!("{OS_NAME}: 26.4\n"));
        expected.push_str("Estado: ANOMANDER está en marcha\n");
        expected.push_str("\nÚltimas 2 líneas del registro:\n");
        expected.push_str("2026-11-20T01:02:03Z first\nsecond\n");
        assert_eq!(text, expected);
    }

    #[test]
    fn the_report_reads_in_english_on_any_other_system() {
        let lines = vec!["first".to_owned(), "second".to_owned()];
        let facts = Facts {
            daemon: "ANOMANDER is running",
            ..facts()
        };
        let text = report(&facts, &lines, &[], Locale::En);
        let mut expected = String::from("ANOMANDER: diagnostics\n");
        expected.push_str("App version: 0.0.0\n");
        expected.push_str(&format!("{OS_NAME}: 26.4\n"));
        expected.push_str("Status: ANOMANDER is running\n");
        expected.push_str("\nLast 2 lines of the log:\n");
        expected.push_str("first\nsecond\n");
        assert_eq!(text, expected);
    }

    #[test]
    fn the_report_carries_no_secret() {
        let lines = vec![format!("Bearer {SECRET}")];
        let text = report(&facts(), &lines, &[SECRET], Locale::Es);
        assert!(!text.contains(SECRET), "{text}");
        assert!(text.contains("Bearer [secret]"));
    }

    #[test]
    fn the_tail_is_the_last_lines_across_the_newest_two_files() -> io::Result<()> {
        let dir = tempfile::tempdir()?;
        fs::write(path_of(dir.path(), 2), "too old\n")?;
        fs::write(path_of(dir.path(), 1), "a\nb\nc\n")?;
        fs::write(path_of(dir.path(), 0), "d\ne\n")?;
        assert_eq!(tail(dir.path(), 4)?, ["b", "c", "d", "e"]);
        assert_eq!(tail(dir.path(), 1)?, ["e"]);
        assert_eq!(tail(dir.path(), 50)?, ["a", "b", "c", "d", "e"]);
        Ok(())
    }

    #[test]
    fn no_log_yet_gives_no_lines() -> io::Result<()> {
        let dir = tempfile::tempdir()?;
        assert!(tail(&dir.path().join("missing"), LINES)?.is_empty());
        Ok(())
    }
}
