// DK-8: the data and log folders are `700` and their files `600` (PRD §16). Modes are a unix
// idea; on Windows the same narrowing is an access list of the principal and SYSTEM alone, not
// inherited from the profile above. A folder's list is inherited by what is created in it later, so
// a file made there (`create_with`) is already narrowed.
use std::fs::OpenOptions;
use std::io;
use std::path::Path;

/// Sets `path` to `mode` (`0o700`, `0o600`); on Windows, to the principal and SYSTEM alone.
pub fn restrict(path: &Path, mode: u32) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
    }
    #[cfg(windows)]
    {
        let _ = mode;
        owner_only::restrict(path)
    }
}

/// `options`, so a new file is created with `mode`; unchanged on Windows, where a new file takes
/// its folder's list.
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

/// Windows: whether `path`'s access list is the principal and SYSTEM alone, as `restrict` leaves
/// it, or inherited from a folder `restrict` left so.
#[cfg(all(windows, test))]
pub fn is_owner_only(path: &Path) -> io::Result<bool> {
    owner_only::is_owner_only(path)
}

#[cfg(windows)]
mod owner_only {
    use std::io;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::ptr::{null, null_mut};

    use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, ERROR_SUCCESS, HANDLE};
    use windows_sys::Win32::Security::Authorization::{
        SetEntriesInAclW, SetNamedSecurityInfoW, EXPLICIT_ACCESS_W, NO_MULTIPLE_TRUSTEE,
        SET_ACCESS, SE_FILE_OBJECT, TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN, TRUSTEE_W,
    };
    use windows_sys::Win32::Security::{
        CreateWellKnownSid, GetTokenInformation, TokenUser, WinLocalSystemSid, ACL,
        CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION, NO_INHERITANCE, OBJECT_INHERIT_ACE,
        PROTECTED_DACL_SECURITY_INFORMATION, PSID, SECURITY_MAX_SID_SIZE, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::Storage::FileSystem::FILE_ALL_ACCESS;
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    fn checked(error: u32) -> io::Result<()> {
        if error == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(io::Error::from_raw_os_error(error as i32))
        }
    }

    /// The principal's SID, inside the `TOKEN_USER` the buffer holds; `u64`s keep it aligned.
    struct User(Vec<u64>);

    impl User {
        fn current() -> io::Result<User> {
            let mut token: HANDLE = null_mut();
            // SAFETY: the process's own pseudo-handle; the token is closed below.
            if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
                return Err(io::Error::last_os_error());
            }
            let mut needed = 0u32;
            // SAFETY: a first call with no buffer only reports the size.
            unsafe { GetTokenInformation(token, TokenUser, null_mut(), 0, &mut needed) };
            let mut buffer = vec![0u64; (needed as usize).div_ceil(8).max(1)];
            // SAFETY: `buffer` holds `needed` bytes.
            let read = unsafe {
                GetTokenInformation(
                    token,
                    TokenUser,
                    buffer.as_mut_ptr().cast(),
                    needed,
                    &mut needed,
                )
            };
            let error = io::Error::last_os_error();
            // SAFETY: opened above.
            unsafe { CloseHandle(token) };
            if read == 0 {
                return Err(error);
            }
            Ok(User(buffer))
        }

        fn sid(&self) -> PSID {
            // SAFETY: the buffer starts with the `TOKEN_USER` the system wrote.
            unsafe { (*self.0.as_ptr().cast::<TOKEN_USER>()).User.Sid }
        }
    }

    fn system() -> io::Result<[u8; SECURITY_MAX_SID_SIZE as usize]> {
        let mut sid = [0u8; SECURITY_MAX_SID_SIZE as usize];
        let mut size = SECURITY_MAX_SID_SIZE;
        // SAFETY: `sid` holds `size` bytes, the largest a SID takes.
        let made = unsafe {
            CreateWellKnownSid(
                WinLocalSystemSid,
                null_mut(),
                sid.as_mut_ptr().cast(),
                &mut size,
            )
        };
        if made == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(sid)
    }

    /// Replaces `path`'s access list with full access for the principal and SYSTEM, protected
    /// from what the folders above grant. A folder's two entries pass to what it holds.
    pub fn restrict(path: &Path) -> io::Result<()> {
        let user = User::current()?;
        let mut system = system()?;
        let inheritance = if path.is_dir() {
            OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE
        } else {
            NO_INHERITANCE
        };
        let entry = |sid: PSID| EXPLICIT_ACCESS_W {
            grfAccessPermissions: FILE_ALL_ACCESS,
            grfAccessMode: SET_ACCESS,
            grfInheritance: inheritance,
            Trustee: TRUSTEE_W {
                pMultipleTrustee: null_mut(),
                MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_UNKNOWN,
                ptstrName: sid.cast(),
            },
        };
        let entries = [entry(user.sid()), entry(system.as_mut_ptr().cast())];
        let mut acl: *mut ACL = null_mut();
        // SAFETY: two entries whose SIDs live until the end of this function; the new list is
        // allocated by the system and freed below.
        checked(unsafe { SetEntriesInAclW(2, entries.as_ptr(), null(), &mut acl) })?;
        let name = wide(path);
        // SAFETY: `name` is zero-terminated and `acl` a valid list; only the DACL changes.
        let set = checked(unsafe {
            SetNamedSecurityInfoW(
                name.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                acl,
                null(),
            )
        });
        // SAFETY: allocated by `SetEntriesInAclW`, not used after this.
        unsafe { LocalFree(acl.cast()) };
        set
    }

    #[cfg(test)]
    pub fn is_owner_only(path: &Path) -> io::Result<bool> {
        use windows_sys::Win32::Security::Authorization::GetNamedSecurityInfoW;
        use windows_sys::Win32::Security::{
            EqualSid, GetAce, ACCESS_ALLOWED_ACE, PSECURITY_DESCRIPTOR,
        };

        let user = User::current()?;
        let mut system = system()?;
        let name = wide(path);
        let mut dacl: *mut ACL = null_mut();
        let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
        // SAFETY: `name` is zero-terminated; `descriptor` is freed below and `dacl` points in it.
        checked(unsafe {
            GetNamedSecurityInfoW(
                name.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                &mut dacl,
                null_mut(),
                &mut descriptor,
            )
        })?;
        // SAFETY: `dacl` is the descriptor's list, alive until `LocalFree`; each entry of an
        // owner-only list is an access-allowed one, checked by type before it is read as one.
        let owner_only = unsafe {
            !dacl.is_null()
                && (*dacl).AceCount == 2
                && (0..2).all(|index| {
                    let mut ace = null_mut();
                    if GetAce(dacl, index, &mut ace) == 0 {
                        return false;
                    }
                    let ace = &*ace.cast::<ACCESS_ALLOWED_ACE>();
                    // ACCESS_ALLOWED_ACE_TYPE.
                    if ace.Header.AceType != 0 || ace.Mask != FILE_ALL_ACCESS {
                        return false;
                    }
                    let sid: PSID = std::ptr::from_ref(&ace.SidStart).cast_mut().cast();
                    EqualSid(sid, user.sid()) != 0 || EqualSid(sid, system.as_mut_ptr().cast()) != 0
                })
        };
        // SAFETY: allocated by `GetNamedSecurityInfoW`.
        unsafe { LocalFree(descriptor) };
        Ok(owner_only)
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn a_folder_and_what_is_made_in_it_are_the_principals_and_systems_alone() -> io::Result<()> {
        let parent = tempfile::tempdir()?;
        let folder = parent.path().join("ANOMANDER");
        std::fs::create_dir(&folder)?;
        let before = folder.join("before.json");
        std::fs::write(&before, "{}")?;
        // The temporary folder grants more, inherited: the control.
        assert!(!is_owner_only(&folder)?);
        restrict(&folder, 0o700)?;
        assert!(is_owner_only(&folder)?);
        // Inherited by what it already held and by what is made in it later.
        assert!(is_owner_only(&before)?);
        let after = folder.join("after.json");
        std::fs::write(&after, "{}")?;
        assert!(is_owner_only(&after)?);
        // Still readable and writable by the principal.
        assert_eq!(std::fs::read_to_string(&after)?, "{}");
        Ok(())
    }

    #[test]
    fn a_file_is_the_principals_and_systems_alone() -> io::Result<()> {
        let parent = tempfile::tempdir()?;
        let file = parent.path().join("capture.png");
        std::fs::write(&file, "x")?;
        restrict(&file, 0o600)?;
        assert!(is_owner_only(&file)?);
        std::fs::write(&file, "y")?;
        assert_eq!(std::fs::read_to_string(&file)?, "y");
        Ok(())
    }
}
