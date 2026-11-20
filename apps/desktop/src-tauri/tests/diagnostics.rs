// DK-6 AC4, end to end: once the log starts, what the process prints on stdout and stderr still
// reaches them, and reaches the log file without a known secret. Redirecting stdout and stderr
// would take over this test's own, so the redirecting half runs in a child: this same test
// binary, run again with `CHILD_DIR` set.
use std::process::Command;
use std::time::Duration;

use anomander_desktop_lib::diagnostics::{self, capture, log_file};

const CHILD_DIR: &str = "ANOMANDER_TEST_LOG_DIR";
const SECRET: &str = "bot-token-for-the-capture-test";

#[test]
fn printed_lines_reach_the_log_scrubbed_and_the_terminal_unchanged() -> std::io::Result<()> {
    if let Some(dir) = std::env::var_os(CHILD_DIR) {
        diagnostics::remember([&SECRET.to_owned()]);
        let log = log_file::LogFile::open(dir.as_ref(), log_file::MAX_BYTES, log_file::FILES)?;
        capture::start(log)?;
        println!("to stdout");
        eprintln!("401 for bot{SECRET}");
        // The pumps write on their own threads.
        std::thread::sleep(Duration::from_millis(300));
        return Ok(());
    }
    let dir = tempfile::tempdir()?;
    let child = Command::new(std::env::current_exe()?)
        .args([
            "--exact",
            "printed_lines_reach_the_log_scrubbed_and_the_terminal_unchanged",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CHILD_DIR, dir.path())
        .output()?;
    assert!(child.status.success(), "{child:?}");
    // What was printed before goes on as it was.
    assert!(String::from_utf8_lossy(&child.stdout).contains("to stdout"));
    assert!(String::from_utf8_lossy(&child.stderr).contains(&format!("401 for bot{SECRET}")));
    let text = std::fs::read_to_string(log_file::path_of(dir.path(), 0))?;
    assert!(!text.contains(SECRET), "{text}");
    assert!(text.contains("401 for bot[secret]"), "{text}");
    assert!(text.contains("to stdout"), "{text}");
    Ok(())
}
