// DK-5: the bot token and the provider API keys live in the macOS Keychain, never in a file.
// Each secret is a generic password of service `ANOMANDER`, its account the daemon's variable name.
// On Windows they live in the Credential Manager, as generic credentials `<name>.ANOMANDER`.

/// The Keychain service every secret is stored under.
pub const SERVICE: &str = "ANOMANDER";

/// A store error. It names the secret, never its value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreError(pub String);

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for StoreError {}

/// Where secrets live. Behind a trait so tests never touch the real Keychain.
pub trait SecretStore: Send + Sync {
    fn get(&self, name: &str) -> Result<Option<String>, StoreError>;
    fn set(&self, name: &str, value: &str) -> Result<(), StoreError>;
    /// Removing a secret that is not stored is not an error.
    fn delete(&self, name: &str) -> Result<(), StoreError>;
}

#[cfg(windows)]
pub use credential_manager::CredentialManager;
/// This system's store.
#[cfg(windows)]
pub use credential_manager::CredentialManager as SystemStore;
#[cfg(target_os = "macos")]
pub use keychain::Keychain;
/// This system's store.
#[cfg(target_os = "macos")]
pub use keychain::Keychain as SystemStore;

#[cfg(target_os = "macos")]
mod keychain {
    use security_framework::passwords::{
        delete_generic_password, get_generic_password, set_generic_password,
    };

    use super::{SecretStore, StoreError, SERVICE};

    /// `errSecItemNotFound`.
    const ITEM_NOT_FOUND: i32 = -25300;

    #[derive(Debug, Default)]
    pub struct Keychain;

    // The Security framework's messages describe the status code only, never the password.
    fn failed(action: &str, name: &str, error: &security_framework::base::Error) -> StoreError {
        StoreError(format!(
            "could not {action} {name} in the Keychain (status {})",
            error.code()
        ))
    }

    impl SecretStore for Keychain {
        fn get(&self, name: &str) -> Result<Option<String>, StoreError> {
            match get_generic_password(SERVICE, name) {
                Ok(bytes) => String::from_utf8(bytes)
                    .map(Some)
                    .map_err(|_| StoreError(format!("{name} in the Keychain is not valid UTF-8"))),
                Err(error) if error.code() == ITEM_NOT_FOUND => Ok(None),
                Err(error) => Err(failed("read", name, &error)),
            }
        }

        fn set(&self, name: &str, value: &str) -> Result<(), StoreError> {
            set_generic_password(SERVICE, name, value.as_bytes())
                .map_err(|error| failed("store", name, &error))
        }

        fn delete(&self, name: &str) -> Result<(), StoreError> {
            match delete_generic_password(SERVICE, name) {
                Ok(()) => Ok(()),
                Err(error) if error.code() == ITEM_NOT_FOUND => Ok(()),
                Err(error) => Err(failed("remove", name, &error)),
            }
        }
    }
}

/// A Credential Manager entry holds at most 2560 bytes (`CRED_MAX_CREDENTIAL_BLOB_SIZE`), and the
/// model login with a ChatGPT account (two JWTs) or the OAuth tokens of a server can be longer.
/// Such a value is kept in parts on a shelf of their own, `<name>#<generation>#<index>`, and its
/// own entry, the head, names the generation and how many parts it has.
#[cfg(any(windows, test))]
mod parts {
    use super::StoreError;

    /// The most bytes one entry holds.
    pub const MAX_BLOB: usize = 2560;
    /// The head of a value kept in parts: this, then `<generation>:<count>`.
    const HEAD: &str = "anomander-parts:";

    /// Where an entry lives. The parts are apart from the secrets, so no name a secret can have
    /// (header names come from `mcp.json` unchecked) reaches a part.
    #[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
    pub enum Shelf {
        Secrets,
        Parts,
    }

    /// Entries of at most `MAX_BLOB` bytes, by shelf and name.
    pub trait Blobs {
        fn read(&self, shelf: Shelf, name: &str) -> Result<Option<Vec<u8>>, StoreError>;
        fn write(&self, shelf: Shelf, name: &str, blob: &[u8]) -> Result<(), StoreError>;
        /// Removing an entry that is not there is not an error.
        fn remove(&self, shelf: Shelf, name: &str) -> Result<(), StoreError>;
    }

    #[derive(Clone, Copy)]
    struct Head {
        generation: u64,
        count: usize,
    }

    fn part(name: &str, generation: u64, index: usize) -> String {
        format!("{name}#{generation}#{index}")
    }

    /// The head `entry` is, `None` for a value kept whole, `Err` for a head that cannot be read.
    fn head(name: &str, entry: &[u8]) -> Result<Option<Head>, StoreError> {
        let Some(rest) = entry.strip_prefix(HEAD.as_bytes()) else {
            return Ok(None);
        };
        let damaged = || StoreError(format!("{name} is damaged in the store"));
        let (generation, count) = std::str::from_utf8(rest)
            .ok()
            .and_then(|rest| rest.split_once(':'))
            .ok_or_else(damaged)?;
        Ok(Some(Head {
            generation: generation.parse().map_err(|_| damaged())?,
            count: count.parse().map_err(|_| damaged())?,
        }))
    }

    /// The head of the value now stored under `name`, if it is kept in parts. One that cannot be
    /// read names no part, so a new value replaces it.
    fn current(blobs: &impl Blobs, name: &str) -> Result<Option<Head>, StoreError> {
        let entry = blobs.read(Shelf::Secrets, name)?;
        Ok(entry.and_then(|entry| head(name, &entry).ok().flatten()))
    }

    /// Removes what it can of the first `count` parts of `generation`: none of them is read again.
    fn discard(blobs: &impl Blobs, name: &str, generation: u64, count: usize) {
        for index in 0..count {
            let _ = blobs.remove(Shelf::Parts, &part(name, generation, index));
        }
    }

    pub fn get(blobs: &impl Blobs, name: &str) -> Result<Option<String>, StoreError> {
        let Some(entry) = blobs.read(Shelf::Secrets, name)? else {
            return Ok(None);
        };
        let bytes = match head(name, &entry)? {
            None => entry,
            Some(Head { generation, count }) => {
                let mut bytes = Vec::new();
                for index in 0..count {
                    let blob = blobs
                        .read(Shelf::Parts, &part(name, generation, index))?
                        .ok_or_else(|| StoreError(format!("part {index} of {name} is missing")))?;
                    bytes.extend(blob);
                }
                bytes
            }
        };
        String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| StoreError(format!("{name} is not valid UTF-8")))
    }

    /// The new value's parts are written under a new generation and the head switches last, so a
    /// failure on the way leaves the old value whole, never a mix of both.
    pub fn set(blobs: &impl Blobs, name: &str, value: &str) -> Result<(), StoreError> {
        let before = current(blobs, name)?;
        let bytes = value.as_bytes();
        // A short value that reads like a head is kept in parts too, so it is never taken for one.
        if bytes.len() <= MAX_BLOB && !bytes.starts_with(HEAD.as_bytes()) {
            blobs.write(Shelf::Secrets, name, bytes)?;
        } else {
            let generation = before.map_or(0, |head| head.generation.wrapping_add(1));
            let chunks: Vec<&[u8]> = bytes.chunks(MAX_BLOB).collect();
            for (index, chunk) in chunks.iter().enumerate() {
                if let Err(error) = blobs.write(Shelf::Parts, &part(name, generation, index), chunk)
                {
                    discard(blobs, name, generation, index);
                    return Err(error);
                }
            }
            let head = format!("{HEAD}{generation}:{}", chunks.len());
            if let Err(error) = blobs.write(Shelf::Secrets, name, head.as_bytes()) {
                discard(blobs, name, generation, chunks.len());
                return Err(error);
            }
        }
        if let Some(Head { generation, count }) = before {
            discard(blobs, name, generation, count);
        }
        Ok(())
    }

    /// The parts go first and the head last: a removal that fails leaves the head, so a retry
    /// finds the parts again.
    pub fn delete(blobs: &impl Blobs, name: &str) -> Result<(), StoreError> {
        if let Some(Head { generation, count }) = current(blobs, name)? {
            for index in 0..count {
                blobs.remove(Shelf::Parts, &part(name, generation, index))?;
            }
        }
        blobs.remove(Shelf::Secrets, name)
    }
}

#[cfg(windows)]
mod credential_manager {
    use keyring::{Entry, Error};

    use super::parts::{self, Blobs, Shelf};
    use super::{SecretStore, StoreError, SERVICE};

    /// The service of the parts of long values. Credentials are named `<name>.<service>`, so a
    /// part (`….ANOMANDER-parts`) never shares a name with a secret (`….ANOMANDER`).
    const PARTS_SERVICE: &str = "ANOMANDER-parts";

    #[derive(Debug, Default)]
    pub struct CredentialManager;

    // keyring's messages describe the platform's failure, never the secret.
    fn failed(action: &str, name: &str, error: &Error) -> StoreError {
        StoreError(format!(
            "could not {action} {name} in the Credential Manager ({error})"
        ))
    }

    fn entry(shelf: Shelf, name: &str) -> Result<Entry, StoreError> {
        let service = match shelf {
            Shelf::Secrets => SERVICE,
            Shelf::Parts => PARTS_SERVICE,
        };
        Entry::new(service, name).map_err(|error| failed("reach", name, &error))
    }

    impl Blobs for CredentialManager {
        fn read(&self, shelf: Shelf, name: &str) -> Result<Option<Vec<u8>>, StoreError> {
            match entry(shelf, name)?.get_secret() {
                Ok(blob) => Ok(Some(blob)),
                Err(Error::NoEntry) => Ok(None),
                Err(error) => Err(failed("read", name, &error)),
            }
        }

        fn write(&self, shelf: Shelf, name: &str, blob: &[u8]) -> Result<(), StoreError> {
            entry(shelf, name)?
                .set_secret(blob)
                .map_err(|error| failed("store", name, &error))
        }

        fn remove(&self, shelf: Shelf, name: &str) -> Result<(), StoreError> {
            match entry(shelf, name)?.delete_credential() {
                Ok(()) | Err(Error::NoEntry) => Ok(()),
                Err(error) => Err(failed("remove", name, &error)),
            }
        }
    }

    impl SecretStore for CredentialManager {
        fn get(&self, name: &str) -> Result<Option<String>, StoreError> {
            parts::get(self, name)
        }

        fn set(&self, name: &str, value: &str) -> Result<(), StoreError> {
            parts::set(self, name, value)
        }

        fn delete(&self, name: &str) -> Result<(), StoreError> {
            parts::delete(self, name)
        }
    }
}

/// An in-memory store for tests.
#[cfg(test)]
#[derive(Default)]
pub struct MemoryStore {
    secrets: std::sync::Mutex<std::collections::BTreeMap<String, String>>,
    /// When set, every write fails, to test that nothing else changes.
    pub fail_writes: bool,
    /// The item every read of fails, as a locked Keychain would.
    pub unreadable: Option<&'static str>,
}

#[cfg(test)]
impl MemoryStore {
    pub fn failing() -> Self {
        Self {
            fail_writes: true,
            ..Self::default()
        }
    }

    pub fn names(&self) -> Vec<String> {
        self.secrets
            .lock()
            .map(|secrets| secrets.keys().cloned().collect())
            .unwrap_or_default()
    }
}

#[cfg(test)]
impl SecretStore for MemoryStore {
    fn get(&self, name: &str) -> Result<Option<String>, StoreError> {
        if self.unreadable == Some(name) {
            return Err(StoreError(format!("could not read {name}")));
        }
        let secrets = self
            .secrets
            .lock()
            .map_err(|_| StoreError("poisoned".into()))?;
        Ok(secrets.get(name).cloned())
    }

    fn set(&self, name: &str, value: &str) -> Result<(), StoreError> {
        if self.fail_writes {
            return Err(StoreError(format!("could not store {name}")));
        }
        let mut secrets = self
            .secrets
            .lock()
            .map_err(|_| StoreError("poisoned".into()))?;
        secrets.insert(name.to_owned(), value.to_owned());
        Ok(())
    }

    fn delete(&self, name: &str) -> Result<(), StoreError> {
        if self.fail_writes {
            return Err(StoreError(format!("could not remove {name}")));
        }
        let mut secrets = self
            .secrets
            .lock()
            .map_err(|_| StoreError("poisoned".into()))?;
        secrets.remove(name);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::parts::{self, Blobs, Shelf, MAX_BLOB};
    use super::StoreError;
    use std::collections::BTreeMap;
    use std::sync::Mutex;

    /// Entries that refuse a blob longer than the Credential Manager's, and that can fail the
    /// `n`-th write or removal from now on (1 is the next one).
    #[derive(Default)]
    struct Entries {
        entries: Mutex<BTreeMap<(Shelf, String), Vec<u8>>>,
        failing: Mutex<Failing>,
    }

    #[derive(Default)]
    struct Failing {
        write: Option<usize>,
        remove: Option<usize>,
    }

    impl Entries {
        fn all(&self) -> BTreeMap<(Shelf, String), Vec<u8>> {
            self.entries.lock().map(|e| e.clone()).unwrap_or_default()
        }

        fn fail_write(&self, nth: usize) {
            if let Ok(mut failing) = self.failing.lock() {
                failing.write = Some(nth);
            }
        }

        fn fail_remove(&self, nth: usize) {
            if let Ok(mut failing) = self.failing.lock() {
                failing.remove = Some(nth);
            }
        }

        /// Counts down the call `pick` chooses; fails it when it reaches zero.
        fn call(&self, pick: fn(&mut Failing) -> &mut Option<usize>) -> Result<(), StoreError> {
            let mut failing = self
                .failing
                .lock()
                .map_err(|_| StoreError("poisoned".into()))?;
            let countdown = pick(&mut failing);
            match *countdown {
                Some(1) => {
                    *countdown = None;
                    Err(StoreError("the system refused".into()))
                }
                Some(n) => {
                    *countdown = Some(n - 1);
                    Ok(())
                }
                None => Ok(()),
            }
        }
    }

    impl Blobs for Entries {
        fn read(&self, shelf: Shelf, name: &str) -> Result<Option<Vec<u8>>, StoreError> {
            Ok(self.all().get(&(shelf, name.to_owned())).cloned())
        }
        fn write(&self, shelf: Shelf, name: &str, blob: &[u8]) -> Result<(), StoreError> {
            self.call(|failing| &mut failing.write)?;
            if blob.len() > MAX_BLOB {
                return Err(StoreError(format!("{name} is too long")));
            }
            let mut entries = self
                .entries
                .lock()
                .map_err(|_| StoreError("poisoned".into()))?;
            entries.insert((shelf, name.to_owned()), blob.to_vec());
            Ok(())
        }
        fn remove(&self, shelf: Shelf, name: &str) -> Result<(), StoreError> {
            self.call(|failing| &mut failing.remove)?;
            let mut entries = self
                .entries
                .lock()
                .map_err(|_| StoreError("poisoned".into()))?;
            entries.remove(&(shelf, name.to_owned()));
            Ok(())
        }
    }

    #[test]
    fn a_save_that_fails_partway_over_a_value_in_parts_keeps_the_old_value() {
        let entries = Entries::default();
        let (old, new) = ("a".repeat(3 * MAX_BLOB), "b".repeat(3 * MAX_BLOB));
        assert_eq!(parts::set(&entries, "model-login", &old), Ok(()));
        // The third part of the new value is refused.
        entries.fail_write(3);
        assert!(parts::set(&entries, "model-login", &new).is_err());
        assert_eq!(parts::get(&entries, "model-login"), Ok(Some(old)));
        // The parts it wrote before the failure are gone.
        assert_eq!(names(&entries).len(), 4, "{:?}", names(&entries));
    }

    #[test]
    fn a_delete_that_fails_on_a_part_and_is_retried_leaves_no_entry() {
        let entries = Entries::default();
        assert_eq!(
            parts::set(&entries, "model-login", &"a".repeat(3 * MAX_BLOB)),
            Ok(())
        );
        entries.fail_remove(2);
        assert!(parts::delete(&entries, "model-login").is_err());
        assert_eq!(parts::delete(&entries, "model-login"), Ok(()));
        assert!(names(&entries).is_empty(), "{:?}", names(&entries));
    }

    #[test]
    fn a_name_that_looks_like_a_part_never_changes_another_value() {
        let entries = Entries::default();
        let token = "t".repeat(2 * MAX_BLOB);
        assert_eq!(parts::set(&entries, "Authorization", &token), Ok(()));
        // Header names come from `mcp.json`, unchecked.
        for name in ["Authorization#0", "Authorization#1#0", "Authorization#0#0"] {
            assert_eq!(parts::set(&entries, name, "x"), Ok(()));
        }
        assert_eq!(parts::get(&entries, "Authorization"), Ok(Some(token)));
        assert_eq!(parts::delete(&entries, "Authorization#0"), Ok(()));
        assert_eq!(
            parts::get(&entries, "Authorization").map(|v| v.map(|v| v.len())),
            Ok(Some(2 * MAX_BLOB))
        );
    }

    /// Every entry, as `secrets/<name>` or `parts/<name>`.
    fn names(entries: &Entries) -> Vec<String> {
        let shelf = |shelf| match shelf {
            Shelf::Secrets => "secrets",
            Shelf::Parts => "parts",
        };
        entries
            .all()
            .into_keys()
            .map(|(on, name)| format!("{}/{name}", shelf(on)))
            .collect()
    }

    #[test]
    fn a_short_value_is_one_entry() -> Result<(), StoreError> {
        let entries = Entries::default();
        parts::set(&entries, "model-login", "{}")?;
        assert_eq!(names(&entries), ["secrets/model-login"]);
        assert_eq!(parts::get(&entries, "model-login")?.as_deref(), Some("{}"));
        assert_eq!(parts::get(&entries, "other")?, None);
        Ok(())
    }

    #[test]
    fn a_long_value_is_kept_in_parts_and_read_whole() -> Result<(), StoreError> {
        let entries = Entries::default();
        // Two-byte characters, so a part ends inside one.
        let login = format!("{{\"access\":\"{}\"}}", "ñ".repeat(3000));
        parts::set(&entries, "model-login", &login)?;
        assert_eq!(
            names(&entries),
            [
                "secrets/model-login",
                "parts/model-login#0#0",
                "parts/model-login#0#1",
                "parts/model-login#0#2"
            ]
        );
        assert_eq!(parts::get(&entries, "model-login")?, Some(login));
        Ok(())
    }

    #[test]
    fn a_shorter_value_or_a_delete_leaves_no_part_behind() -> Result<(), StoreError> {
        let entries = Entries::default();
        parts::set(&entries, "model-login", &"a".repeat(3 * MAX_BLOB))?;
        parts::set(&entries, "model-login", &"b".repeat(MAX_BLOB + 1))?;
        assert_eq!(
            names(&entries),
            [
                "secrets/model-login",
                "parts/model-login#1#0",
                "parts/model-login#1#1"
            ]
        );
        assert_eq!(
            parts::get(&entries, "model-login")?,
            Some("b".repeat(MAX_BLOB + 1))
        );
        parts::set(&entries, "model-login", "{}")?;
        assert_eq!(names(&entries), ["secrets/model-login"]);
        parts::set(&entries, "model-login", &"c".repeat(MAX_BLOB + 1))?;
        parts::delete(&entries, "model-login")?;
        assert!(names(&entries).is_empty());
        // Removing what is not there is not an error.
        parts::delete(&entries, "model-login")?;
        Ok(())
    }

    #[test]
    fn a_value_that_reads_like_a_head_is_kept_as_it_is() -> Result<(), StoreError> {
        let entries = Entries::default();
        for value in ["anomander-parts:2", "anomander-parts:0:1"] {
            parts::set(&entries, "token", value)?;
            assert_eq!(parts::get(&entries, "token")?.as_deref(), Some(value));
        }
        Ok(())
    }
}
