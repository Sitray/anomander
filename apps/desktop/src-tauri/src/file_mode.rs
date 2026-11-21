// DK-8: the data and log folders are `700` and their files `600` (PRD §16). Modes are a unix
// idea; on Windows these folders live in the user's profile, which its access list already keeps
// to that user, so there the modes are left alone.
use std::fs::OpenOptions;
use std::io;
use std::path::Path;

/// Sets `path` to `mode` (`0o700`, `0o600`); does nothing on Windows.
pub fn restrict(path: &Path, mode: u32) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
        Ok(())
    }
}

/// `options`, so a new file is created with `mode`; unchanged on Windows.
pub fn create_with(options: &mut OpenOptions, mode: u32) -> &mut OpenOptions {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(mode)
    }
    #[cfg(not(unix))]
    {
        let _ = mode;
        options
    }
}
