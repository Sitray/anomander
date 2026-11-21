// The log file: `anomander.log` in its folder, and at most `FILES - 1` older ones
// (`anomander.1.log` the newest of them). Folder `700`, files `600`, as the data folder (DK-8).
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::daemon::output::scrub;
use crate::file_mode;

pub const FILE_NAME: &str = "anomander.log";
/// The size at which the file is set aside and a new one begun.
pub const MAX_BYTES: u64 = 1024 * 1024;
/// How many files are kept, the current one included: at most 5 MB of log.
pub const FILES: usize = 5;
/// A longer line is cut, after it is scrubbed, so a cut never leaves part of a secret.
pub const MAX_LINE_CHARS: usize = 4000;

pub struct LogFile {
    dir: PathBuf,
    max_bytes: u64,
    files: usize,
    file: File,
    size: u64,
}

/// The `index`-th file: 0 is the current one, 1 the newest set aside.
pub fn path_of(dir: &Path, index: usize) -> PathBuf {
    match index {
        0 => dir.join(FILE_NAME),
        n => dir.join(format!("anomander.{n}.log")),
    }
}

impl LogFile {
    /// Opens the log in `dir`, created if needed; both are narrowed to their modes even when
    /// they already existed wider.
    pub fn open(dir: &Path, max_bytes: u64, files: usize) -> io::Result<Self> {
        fs::create_dir_all(dir)?;
        file_mode::restrict(dir, 0o700)?;
        let file = open_current(dir)?;
        let size = file.metadata()?.len();
        Ok(Self {
            dir: dir.to_path_buf(),
            max_bytes,
            files: files.max(1),
            file,
            size,
        })
    }

    /// Appends `line`, scrubbed of `secrets` and stamped with the time, and sets the file
    /// aside first when the line would take it past its size.
    pub fn write_line(&mut self, line: &str, secrets: &[&str]) -> io::Result<()> {
        let text = format!("{} {}\n", timestamp(now()), entry(line, secrets));
        let bytes = text.len() as u64;
        if self.size > 0 && self.size + bytes > self.max_bytes {
            self.rotate()?;
        }
        self.file.write_all(text.as_bytes())?;
        self.size += bytes;
        Ok(())
    }

    /// The oldest file goes, each other one moves one place back, and a new current one begins.
    fn rotate(&mut self) -> io::Result<()> {
        let oldest = path_of(&self.dir, self.files - 1);
        match fs::remove_file(&oldest) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
            _ => {}
        }
        for index in (0..self.files - 1).rev() {
            let from = path_of(&self.dir, index);
            if from.exists() {
                fs::rename(&from, path_of(&self.dir, index + 1))?;
            }
        }
        self.file = open_current(&self.dir)?;
        self.size = 0;
        Ok(())
    }
}

fn open_current(dir: &Path) -> io::Result<File> {
    let path = path_of(dir, 0);
    let file =
        file_mode::create_with(OpenOptions::new().create(true).append(true), 0o600).open(&path)?;
    // `mode` applies only to a new file: one left wider is narrowed.
    file_mode::restrict(&path, 0o600)?;
    Ok(file)
}

/// `line` as the file gets it: scrubbed, then cut to `MAX_LINE_CHARS`.
pub fn entry(line: &str, secrets: &[&str]) -> String {
    let mut scrubbed = scrub(line, secrets);
    if let Some((cut, _)) = scrubbed.char_indices().nth(MAX_LINE_CHARS) {
        scrubbed.truncate(cut);
        scrubbed.push('…');
    }
    scrubbed
}

/// `seconds` since the epoch as `YYYY-MM-DDTHH:MM:SSZ`.
pub fn timestamp(seconds: u64) -> String {
    let (days, time) = (seconds / 86_400, seconds % 86_400);
    // Howard Hinnant's `civil_from_days`, for days since 1970-01-01.
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        time / 3_600,
        time % 3_600 / 60,
        time % 60
    )
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "sk-live-0123456789";

    #[cfg(unix)]
    fn mode(path: &Path) -> io::Result<u32> {
        use std::os::unix::fs::PermissionsExt;
        Ok(fs::metadata(path)?.permissions().mode() & 0o777)
    }

    fn logs(dir: &Path) -> io::Result<Vec<String>> {
        let mut names: Vec<String> = fs::read_dir(dir)?
            .map(|entry| entry.map(|entry| entry.file_name().to_string_lossy().into_owned()))
            .collect::<io::Result<_>>()?;
        names.sort();
        Ok(names)
    }

    #[test]
    fn a_secret_never_reaches_the_file() -> io::Result<()> {
        let parent = tempfile::tempdir()?;
        let dir = parent.path().join("Logs");
        let mut log = LogFile::open(&dir, MAX_BYTES, FILES)?;
        log.write_line(
            &format!("[daemon] 401 for bot123:{SECRET} and {SECRET}"),
            &[SECRET],
        )?;
        log.write_line("could not store the model login", &[SECRET])?;
        let text = fs::read_to_string(path_of(&dir, 0))?;
        assert!(!text.contains(SECRET), "{text}");
        assert!(text.contains("[daemon] 401 for bot123:[secret] and [secret]"));
        assert_eq!(text.lines().count(), 2);
        Ok(())
    }

    #[test]
    fn a_long_line_is_cut_after_it_is_scrubbed() {
        let line = format!("{}{SECRET}", "a".repeat(MAX_LINE_CHARS - 3));
        let written = entry(&line, &[SECRET]);
        assert!(!written.contains("sk-"), "{written}");
        assert_eq!(written.chars().count(), MAX_LINE_CHARS + 1);
        assert!(written.ends_with('…'));
    }

    #[test]
    fn each_line_is_stamped_with_the_time() {
        assert_eq!(timestamp(0), "1970-01-01T00:00:00Z");
        assert_eq!(timestamp(1_795_132_800 + 3_723), "2026-11-20T01:02:03Z");
        assert_eq!(timestamp(951_782_400), "2000-02-29T00:00:00Z");
    }

    #[cfg(unix)]
    #[test]
    fn the_folder_is_700_and_the_files_600() -> io::Result<()> {
        use std::os::unix::fs::PermissionsExt;
        let parent = tempfile::tempdir()?;
        let dir = parent.path().join("Logs");
        fs::create_dir(&dir)?;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755))?;
        fs::write(path_of(&dir, 0), "old\n")?;
        fs::set_permissions(path_of(&dir, 0), fs::Permissions::from_mode(0o644))?;
        let mut log = LogFile::open(&dir, 64, FILES)?;
        assert_eq!(mode(&dir)?, 0o700);
        assert_eq!(mode(&path_of(&dir, 0))?, 0o600);
        for _ in 0..4 {
            log.write_line(&"x".repeat(40), &[])?;
        }
        for name in logs(&dir)? {
            assert_eq!(mode(&dir.join(&name))?, 0o600, "{name}");
        }
        Ok(())
    }

    #[test]
    fn rotation_keeps_the_count_and_the_newest_lines() -> io::Result<()> {
        let parent = tempfile::tempdir()?;
        let dir = parent.path().join("Logs");
        let mut log = LogFile::open(&dir, 200, 3)?;
        for n in 0..100 {
            log.write_line(&format!("line {n:03} {}", "y".repeat(40)), &[])?;
        }
        assert_eq!(
            logs(&dir)?,
            ["anomander.1.log", "anomander.2.log", "anomander.log"]
        );
        for name in logs(&dir)? {
            assert!(fs::metadata(dir.join(name))?.len() <= 200);
        }
        assert!(fs::read_to_string(path_of(&dir, 0))?.contains("line 099"));
        let older = fs::read_to_string(path_of(&dir, 1))?;
        assert!(!older.contains("line 099") && older.contains("line 09"));
        Ok(())
    }

    #[test]
    fn a_reopened_log_appends_and_rotates_when_full() -> io::Result<()> {
        let parent = tempfile::tempdir()?;
        let dir = parent.path().join("Logs");
        LogFile::open(&dir, 120, 3)?.write_line("first run", &[])?;
        let mut log = LogFile::open(&dir, 120, 3)?;
        log.write_line("second run", &[])?;
        let text = fs::read_to_string(path_of(&dir, 0))?;
        assert!(text.contains("first run") && text.contains("second run"));
        log.write_line(&"z".repeat(80), &[])?;
        assert!(fs::read_to_string(path_of(&dir, 1))?.contains("second run"));
        Ok(())
    }
}
