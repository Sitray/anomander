// A look at the screen, taken only when the principal asks for one in the chat. macOS decides
// whether the app may record the screen (Privacy & Security > Screen Recording); without that
// permission a capture would show the wallpaper alone, so it is checked first and never taken.
// The capture lives in a file of the data folder only for the moment it takes to read it.
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

/// The error the window knows as "macOS does not let the app see the screen" (`shell.ts`).
pub const NO_PERMISSION: &str = "screen_permission";

/// The longest side of the capture sent, in pixels: enough to read text, light enough to send.
const LONGEST_SIDE: &str = "2000";

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

/// Whether macOS lets the app record the screen. The first time it does not, macOS shows its own
/// prompt, and the permission takes effect when the app is opened again.
#[cfg(target_os = "macos")]
pub fn allowed() -> bool {
    // SAFETY: both functions take no arguments and only read or request the app's own permission.
    unsafe { CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess() }
}

#[cfg(not(target_os = "macos"))]
pub fn allowed() -> bool {
    false
}

/// Removes the capture's file when it goes out of scope, whatever happened.
struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// A JPEG of the main display.
pub fn capture(dir: &Path) -> Result<Vec<u8>, String> {
    capture_with(dir, |path| {
        // `-x`: no shutter sound. One file: the main display.
        run(Command::new("/usr/sbin/screencapture")
            .args(["-x", "-t", "jpg"])
            .arg(path))?;
        // Smaller is only cheaper to send: a capture that could not be resized is sent as it is.
        let _ = run(Command::new("/usr/bin/sips")
            .args(["-Z", LONGEST_SIDE, "-s", "formatOptions", "75"])
            .arg(path));
        Ok(())
    })
}

fn run(command: &mut Command) -> Result<(), String> {
    let output = command
        .output()
        .map_err(|error| format!("could not run the capture: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!("the capture failed: {}", output.status))
    }
}

/// How a capture's file is named, so one left by a crash can be told apart and removed.
const PREFIX: &str = "screen-";
const SUFFIX: &str = ".jpg";

fn create_private(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map(|_| ())
        .map_err(|error| format!("the capture could not be created: {error}"))
}

fn private(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("the capture could not be made private: {error}"))
}

/// Removes the captures a crash left in `dir`: the app died between taking one and removing it.
/// Called at launch, before anything can be captured.
pub fn remove_leftovers(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let is_capture = name.starts_with(PREFIX) && name.ends_with(SUFFIX);
        if is_capture && entry.file_type().is_ok_and(|kind| kind.is_file()) {
            if let Err(error) = std::fs::remove_file(entry.path()) {
                eprintln!("could not remove a capture left behind: {error}");
            }
        }
    }
}

/// Lets `take` write the capture to a file in `dir`, reads it and removes it.
fn capture_with(
    dir: &Path,
    take: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<Vec<u8>, String> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    let scratch = Scratch(dir.join(format!("{PREFIX}{}-{nanos}{SUFFIX}", std::process::id())));
    // DK-8: private from its first byte, and again in case the tool replaced the file.
    create_private(&scratch.0)?;
    take(&scratch.0)?;
    private(&scratch.0)?;
    let bytes = std::fs::read(&scratch.0)
        .map_err(|error| format!("the capture could not be read: {error}"))?;
    if bytes.is_empty() {
        return Err("the capture is empty".into());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files_in(dir: &Path) -> usize {
        std::fs::read_dir(dir).unwrap().count()
    }

    #[test]
    fn a_capture_is_read_and_its_file_removed() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = capture_with(dir.path(), |path| {
            std::fs::write(path, b"jpeg").map_err(|error| error.to_string())
        });
        assert_eq!(bytes.unwrap(), b"jpeg");
        assert_eq!(files_in(dir.path()), 0);
    }

    #[test]
    fn the_capture_is_private_while_it_exists() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        let mut before = 0;
        capture_with(dir.path(), |path| {
            before = mode(path);
            std::fs::write(path, b"jpeg").map_err(|error| error.to_string())
        })
        .unwrap();
        assert_eq!(before, 0o600);

        // A tool that replaced the file would leave its own mode: it is made private again.
        let replaced = dir.path().join("replaced.jpg");
        std::fs::write(&replaced, b"jpeg").unwrap();
        std::fs::set_permissions(&replaced, std::fs::Permissions::from_mode(0o644)).unwrap();
        private(&replaced).unwrap();
        assert_eq!(mode(&replaced), 0o600);
    }

    #[test]
    fn captures_left_by_a_crash_are_removed_and_nothing_else() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("screen-123-456.jpg"), b"left").unwrap();
        std::fs::write(dir.path().join("anomander.db"), b"ledger").unwrap();
        std::fs::write(dir.path().join("screen-notes.txt"), b"mine").unwrap();
        std::fs::create_dir(dir.path().join("screen-dir.jpg")).unwrap();

        remove_leftovers(dir.path());

        let mut names: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(
            names,
            ["anomander.db", "screen-dir.jpg", "screen-notes.txt"]
        );
    }

    #[test]
    fn a_failed_capture_leaves_no_file_behind() {
        let dir = tempfile::tempdir().unwrap();
        let failed = capture_with(dir.path(), |path| {
            std::fs::write(path, b"half").unwrap();
            Err("the capture failed: exit status: 1".into())
        });
        assert_eq!(failed.unwrap_err(), "the capture failed: exit status: 1");
        assert_eq!(files_in(dir.path()), 0);
    }

    #[test]
    fn a_capture_that_wrote_nothing_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(capture_with(dir.path(), |_| Ok(())).is_err());
        let empty = capture_with(dir.path(), |path| {
            std::fs::write(path, b"").map_err(|error| error.to_string())
        });
        assert_eq!(empty.unwrap_err(), "the capture is empty");
        assert_eq!(files_in(dir.path()), 0);
    }
}
