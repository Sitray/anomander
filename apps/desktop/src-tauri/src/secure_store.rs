// DK-5: the bot token and the provider API keys live in the macOS Keychain, never in a file.
// Each secret is a generic password of service `ANOMANDER`, its account the daemon's variable name.

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

#[cfg(target_os = "macos")]
pub use keychain::Keychain;

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

/// An in-memory store for tests.
#[cfg(test)]
#[derive(Default)]
pub struct MemoryStore {
    secrets: std::sync::Mutex<std::collections::BTreeMap<String, String>>,
    /// When set, every write fails, to test that nothing else changes.
    pub fail_writes: bool,
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
