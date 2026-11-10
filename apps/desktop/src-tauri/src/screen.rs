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

/// Lets `take` write the capture to a file in `dir`, reads it and removes it.
fn capture_with(
    dir: &Path,
    take: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<Vec<u8>, String> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    let scratch = Scratch(dir.join(format!("screen-{}-{nanos}.jpg", std::process::id())));
    take(&scratch.0)?;
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
