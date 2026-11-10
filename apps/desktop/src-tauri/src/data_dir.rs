// DK-8 AC1: the app's data folder, `~/Library/Application Support/ANOMANDER`: folder `700`,
// files `600` (PRD §16). The daemon writes the database and the images; the shell, the settings.
use std::fs;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use crate::daemon::launch::DaemonPaths;

pub const FOLDER_NAME: &str = "ANOMANDER";
const SETTINGS_FILE: &str = "settings.json";

#[derive(Clone, Debug)]
pub struct DataDir {
    root: PathBuf,
}

impl DataDir {
    /// Creates `root` if needed and narrows it to `700`, even when it already existed wider.
    pub fn open(root: PathBuf) -> std::io::Result<Self> {
        fs::create_dir_all(&root)?;
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn settings_path(&self) -> PathBuf {
        self.root.join(SETTINGS_FILE)
    }

    pub fn daemon_paths(&self) -> DaemonPaths {
        DaemonPaths {
            db: self.root.join("anomander.db"),
            inbox: self.root.join("inbox"),
            auth: self.root.join("auth.json"),
        }
    }

    /// Writes `name` with mode `600`, through a temporary file and a rename, so a crash never
    /// leaves half a file.
    pub fn write_private(&self, name: &str, contents: &[u8]) -> std::io::Result<()> {
        let target = self.root.join(name);
        let partial = self.root.join(format!(".{name}.partial"));
        // A leftover from a crash would make `create_new` fail.
        let _ = fs::remove_file(&partial);
        let written = (|| {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&partial)?;
            file.write_all(contents)?;
            file.sync_all()?;
            fs::rename(&partial, &target)
        })();
        if written.is_err() {
            let _ = fs::remove_file(&partial);
        }
        written
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mode(path: &Path) -> std::io::Result<u32> {
        Ok(fs::metadata(path)?.permissions().mode() & 0o777)
    }

    #[test]
    fn the_folder_is_created_with_mode_700() -> std::io::Result<()> {
        let parent = tempfile::tempdir()?;
        let dir = DataDir::open(parent.path().join("Application Support").join(FOLDER_NAME))?;
        assert!(dir.root().is_dir());
        assert_eq!(mode(dir.root())?, 0o700);
        Ok(())
    }

    #[test]
    fn a_wider_existing_folder_is_narrowed_to_700() -> std::io::Result<()> {
        let parent = tempfile::tempdir()?;
        let root = parent.path().join(FOLDER_NAME);
        fs::create_dir(&root)?;
        fs::set_permissions(&root, fs::Permissions::from_mode(0o755))?;
        DataDir::open(root.clone())?;
        assert_eq!(mode(&root)?, 0o700);
        Ok(())
    }

    #[test]
    fn written_files_have_mode_600_and_replace_the_old_contents() -> std::io::Result<()> {
        let parent = tempfile::tempdir()?;
        let dir = DataDir::open(parent.path().join(FOLDER_NAME))?;
        dir.write_private("settings.json", b"{\"a\":1}")?;
        dir.write_private("settings.json", b"{}")?;
        assert_eq!(fs::read(dir.settings_path())?, b"{}");
        assert_eq!(mode(&dir.settings_path())?, 0o600);
        // No temporary file is left behind.
        assert_eq!(fs::read_dir(dir.root())?.count(), 1);
        Ok(())
    }

    #[test]
    fn the_daemon_data_lives_in_the_folder() -> std::io::Result<()> {
        let parent = tempfile::tempdir()?;
        let root = parent.path().join(FOLDER_NAME);
        let paths = DataDir::open(root.clone())?.daemon_paths();
        assert_eq!(paths.db, root.join("anomander.db"));
        assert_eq!(paths.inbox, root.join("inbox"));
        assert_eq!(paths.auth, root.join("auth.json"));
        Ok(())
    }
}
