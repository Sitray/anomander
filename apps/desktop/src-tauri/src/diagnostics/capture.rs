// Feeds the log from the app's own stdout and stderr: each descriptor becomes a pipe read by a
// thread, which writes every byte on to where the descriptor went before (the terminal of
// `tauri dev`, or nowhere when opened from the Finder) and hands every line to the log.
use std::fs::File;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Mutex, PoisonError};

use super::log_file::LogFile;

/// Calls `line` with every line of `reader`, decoded leniently, after writing it on to
/// `terminal` as it came. Returns when the pipe closes or fails. A failing terminal or a
/// panicking `line` never stops it: whoever prints would block on a full pipe.
pub fn pump(reader: impl Read, mut terminal: impl Write, mut line: impl FnMut(&str)) {
    let mut reader = BufReader::new(reader);
    let mut buffer = Vec::new();
    let mut to_terminal = true;
    loop {
        buffer.clear();
        match reader.read_until(b'\n', &mut buffer) {
            Ok(0) => return,
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return,
        }
        // A terminal that went away is not written to again.
        to_terminal = to_terminal && terminal.write_all(&buffer).is_ok();
        let text = String::from_utf8_lossy(&buffer);
        let text = text.trim_end_matches(['\n', '\r']);
        let _ = std::panic::catch_unwind(AssertUnwindSafe(|| line(text)));
    }
}

/// From now on, everything this process prints on stdout and stderr also goes to `log`, each
/// line scrubbed of the secrets known at that moment (`super::secrets`).
pub fn start(log: LogFile) -> io::Result<()> {
    let log = Arc::new(Mutex::new(log));
    for fd in [libc::STDOUT_FILENO, libc::STDERR_FILENO] {
        redirect(fd, Arc::clone(&log))?;
    }
    Ok(())
}

/// What the pumps hand each line to: `log`, scrubbed of the secrets known now. A full disk loses
/// the line, never the app.
pub fn to_log(log: Arc<Mutex<LogFile>>) -> impl FnMut(&str) {
    move |line| {
        let secrets = super::secrets();
        let secrets: Vec<&str> = secrets.iter().map(String::as_str).collect();
        let mut log = log.lock().unwrap_or_else(PoisonError::into_inner);
        let _ = log.write_line(line, &secrets);
    }
}

fn redirect(fd: RawFd, log: Arc<Mutex<LogFile>>) -> io::Result<()> {
    // SAFETY: `fcntl` on the process's own descriptor; the copy is checked and owned below.
    let terminal = check(unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) })?;
    // SAFETY: `terminal` is a fresh descriptor nobody else owns.
    let terminal = unsafe { File::from_raw_fd(terminal) };
    let restore = terminal.try_clone()?;
    let (reader, writer) = pipe()?;
    // The pump starts before `fd` moves: if it cannot, nothing has changed.
    std::thread::Builder::new()
        .name(format!("anomander-log-{fd}"))
        .spawn(move || {
            pump(reader, terminal, to_log(log));
            // The pipe failed: `fd` goes back to where it went, so nobody blocks on it.
            // SAFETY: both are open descriptors of this process.
            unsafe { libc::dup2(restore.as_raw_fd(), fd) };
        })?;
    // SAFETY: both are open descriptors of this process. On failure `writer` is dropped, the
    // pump sees the pipe close, and `fd` stays as it was.
    check(unsafe { libc::dup2(writer.as_raw_fd(), fd) })?;
    Ok(())
}

/// A pipe whose two ends close on `exec`: children inherit only the descriptor it is copied to.
fn pipe() -> io::Result<(File, File)> {
    let mut ends = [0; 2];
    // SAFETY: `ends` has room for the two descriptors `pipe` writes.
    check(unsafe { libc::pipe(ends.as_mut_ptr()) })?;
    // SAFETY: both are fresh descriptors nobody else owns.
    let (read, write) = unsafe { (File::from_raw_fd(ends[0]), File::from_raw_fd(ends[1])) };
    for end in [&read, &write] {
        // SAFETY: an open descriptor of this process.
        check(unsafe { libc::fcntl(end.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) })?;
    }
    Ok((read, write))
}

fn check(result: libc::c_int) -> io::Result<libc::c_int> {
    if result < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_line_goes_on_to_the_terminal_and_to_the_log() {
        let input: &[u8] = b"one\r\ntwo\n\nlast without end";
        let mut terminal = Vec::new();
        let mut lines = Vec::new();
        pump(input, &mut terminal, |line| lines.push(line.to_owned()));
        assert_eq!(terminal, input);
        assert_eq!(lines, ["one", "two", "", "last without end"]);
    }

    #[test]
    fn a_line_that_panics_does_not_stop_the_pump() {
        let input: &[u8] = b"boom\nafter\n";
        let mut lines = Vec::new();
        pump(input, io::sink(), |line| {
            assert_ne!(line, "boom", "a panicking sink");
            lines.push(line.to_owned());
        });
        assert_eq!(lines, ["after"]);
    }

    #[test]
    fn a_line_with_a_known_secret_reaches_the_log_scrubbed() -> io::Result<()> {
        const SECRET: &str = "capture-test-secret-0123456789";
        let dir = tempfile::tempdir()?;
        super::super::remember([&SECRET.to_owned()]);
        let log = Arc::new(Mutex::new(LogFile::open(dir.path(), 1024, 2)?));
        let printed = format!("could not store the model login {SECRET}\n[daemon] ok\n");
        pump(printed.as_bytes(), io::sink(), to_log(log));
        let text = std::fs::read_to_string(super::super::log_file::path_of(dir.path(), 0))?;
        assert!(!text.contains(SECRET), "{text}");
        assert!(text.contains("could not store the model login [secret]"));
        assert!(text.contains("[daemon] ok"));
        Ok(())
    }

    struct Closed;

    impl Write for Closed {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::Error::from(io::ErrorKind::BrokenPipe))
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn a_closed_terminal_does_not_stop_the_log() {
        let mut lines = Vec::new();
        pump(&b"a\nb\n"[..], Closed, |line| lines.push(line.to_owned()));
        assert_eq!(lines, ["a", "b"]);
    }
}
