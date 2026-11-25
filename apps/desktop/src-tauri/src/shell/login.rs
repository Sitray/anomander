// DK-5 AC1: the model login, kept in the Keychain in the shape of `auth.json`, and what the daemon
// hands back to be stored.
use std::sync::Arc;

use super::Core;
use crate::daemon::supervisor::{Credentials, Handed};
use crate::oauth_connect;

/// DK-5 AC1: the Keychain item that holds the model login, in the shape of `auth.json`.
pub const MODEL_LOGIN: &str = "model-login";

/// A model login as stored: a JSON object by provider.
type Login = serde_json::Map<String, serde_json::Value>;

fn login_of(text: &str) -> Option<Login> {
    match serde_json::from_str(text) {
        Ok(serde_json::Value::Object(login)) => Some(login),
        _ => None,
    }
}

/// The tokens and keys of a login, to hide in the daemon's output: every text in it but a
/// credential's `type`, from 8 characters.
pub(super) fn tokens_of(login: &Login) -> Vec<String> {
    fn walk(value: &serde_json::Value, found: &mut Vec<String>) {
        match value {
            serde_json::Value::String(text) if text.chars().count() >= 8 => {
                found.push(text.clone());
            }
            serde_json::Value::Array(items) => items.iter().for_each(|item| walk(item, found)),
            serde_json::Value::Object(fields) => fields
                .iter()
                .filter(|(name, _)| name.as_str() != "type")
                .for_each(|(_, field)| walk(field, found)),
            _ => {}
        }
    }
    let mut found = Vec::new();
    login
        .values()
        .for_each(|credential| walk(credential, &mut found));
    found
}
impl Core {
    /// DK-5 AC1: the model login kept in the Keychain. An `auth.json` in the data folder (an older
    /// app's, or one `pnpm run login` wrote) is merged into it, provider by provider, and removed
    /// once the merged login reads back from the store; while it does not, the file is kept.
    pub(super) fn model_login(&self) -> Result<Login, String> {
        let stored = match self
            .store
            .get(MODEL_LOGIN)
            .map_err(|error| error.to_string())?
        {
            Some(text) => login_of(&text).unwrap_or_else(|| {
                eprintln!("the stored model login is not a JSON object: it is not used");
                Login::new()
            }),
            None => Login::new(),
        };
        let file = self.data.daemon_paths().auth;
        let Ok(found) = std::fs::symlink_metadata(&file) else {
            return Ok(stored);
        };
        let read = found
            .is_file()
            .then(|| std::fs::read_to_string(&file).ok())
            .flatten()
            .and_then(|text| login_of(&text));
        let Some(read) = read else {
            eprintln!("auth.json is not a file with a JSON object: it is left as it is");
            return Ok(stored);
        };
        let mut merged = stored;
        merged.extend(read);
        let text = serde_json::Value::Object(merged.clone()).to_string();
        match self.store.set(MODEL_LOGIN, &text) {
            Err(error) => eprintln!("{error}; auth.json is kept"),
            Ok(()) if self.store.get(MODEL_LOGIN).ok().flatten().as_deref() == Some(&text) => {
                if let Err(error) = std::fs::remove_file(&file) {
                    eprintln!("could not remove auth.json: {error}");
                }
            }
            Ok(()) => eprintln!("the model login did not read back as stored; auth.json is kept"),
        }
        Ok(merged)
    }

    /// Stores what the daemon hands over: the model login (DK-5 AC1) or the OAuth tokens of its
    /// servers (DK-11), whole. What is not a JSON object is not stored.
    pub(super) fn login_handler(&self) -> Credentials {
        let store = Arc::clone(&self.store);
        Arc::new(move |handed: Handed, json: &str| {
            let (item, what) = match handed {
                Handed::ModelLogin => (MODEL_LOGIN, "model login"),
                Handed::McpOAuth => (oauth_connect::ITEM, "set of OAuth tokens"),
            };
            if login_of(json).is_none() {
                eprintln!("the daemon handed over a {what} that is not a JSON object");
                return;
            }
            if let Err(error) = store.set(item, json) {
                eprintln!("could not store the {what}: {error}");
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shell::test_support::*;

    const LOGIN: &str = r#"{"openai":{"type":"api_key","key":"sk-login-1"}}"#;
    #[test]
    fn a_launch_hands_over_the_login_kept_in_the_store_and_hides_its_tokens() {
        let (store, settings) = configured();
        let _ = store.set(MODEL_LOGIN, LOGIN);
        let f = fixture(store, settings);
        let spec = ready(&f.core);
        assert_eq!(login_env(&spec).as_deref(), Some(LOGIN));
        assert!(spec.secrets.iter().any(|secret| secret == "sk-login-1"));
        assert!(!spec.secrets.iter().any(|secret| secret == "api_key"));
    }
    #[test]
    fn without_a_stored_login_the_daemon_gets_an_empty_one() {
        let (store, settings) = configured();
        let f = fixture(store, settings);
        assert_eq!(login_env(&ready(&f.core)).as_deref(), Some("{}"));
    }

    #[test]
    fn an_auth_json_left_in_the_data_folder_moves_to_the_store() -> Result<(), String> {
        let (store, settings) = configured();
        let _ = store.set(
            MODEL_LOGIN,
            r#"{"openai":{"type":"api_key","key":"sk-old-key"},"anthropic":{"type":"oauth","access":"a-1","refresh":"r-1","expires":1}}"#,
        );
        let f = fixture(store, settings);
        let file = f.root.join("auth.json");
        std::fs::write(&file, LOGIN).map_err(|e| e.to_string())?;

        let spec = ready(&f.core);

        let merged = r#"{"openai":{"type":"api_key","key":"sk-login-1"},"anthropic":{"type":"oauth","access":"a-1","refresh":"r-1","expires":1}}"#;
        let handed: serde_json::Value = serde_json::from_str(&login_env(&spec).unwrap_or_default())
            .map_err(|e| e.to_string())?;
        let expected: serde_json::Value =
            serde_json::from_str(merged).map_err(|e| e.to_string())?;
        assert_eq!(handed, expected);
        assert!(!file.exists(), "auth.json is still in the data folder");
        // Stored: the next start hands the same over without the file.
        assert_eq!(login_env(&ready(&f.core)), login_env(&spec));
        Ok(())
    }

    #[test]
    fn an_auth_json_that_is_not_an_object_is_left_as_it_is() -> Result<(), String> {
        let (store, settings) = configured();
        let f = fixture(store, settings);
        let file = f.root.join("auth.json");
        std::fs::write(&file, "not json").map_err(|e| e.to_string())?;
        assert_eq!(login_env(&ready(&f.core)).as_deref(), Some("{}"));
        assert_eq!(
            std::fs::read_to_string(&file).map_err(|e| e.to_string())?,
            "not json"
        );
        Ok(())
    }

    #[test]
    fn an_auth_json_is_kept_when_the_store_refuses_it() -> Result<(), String> {
        let (mut store, settings) = configured();
        store.fail_writes = true;
        let f = fixture(store, settings);
        let file = f.root.join("auth.json");
        std::fs::write(&file, LOGIN).map_err(|e| e.to_string())?;
        let _ = f.core.prepare();
        assert_eq!(
            std::fs::read_to_string(&file).map_err(|e| e.to_string())?,
            LOGIN
        );
        Ok(())
    }
    #[test]
    fn a_login_the_daemon_hands_back_is_stored_for_the_next_start() {
        let (store, settings) = configured();
        let f = fixture(store, settings);
        let spec = ready(&f.core);
        let handed = spec
            .on_credentials
            .clone()
            .unwrap_or_else(|| panic!("no credentials handler"));

        handed(Handed::ModelLogin, LOGIN);
        assert_eq!(login_env(&ready(&f.core)).as_deref(), Some(LOGIN));
        // What is not a set of credentials is never stored.
        handed(Handed::ModelLogin, "[1]");
        handed(Handed::ModelLogin, "not json");
        assert_eq!(login_env(&ready(&f.core)).as_deref(), Some(LOGIN));
    }
}
