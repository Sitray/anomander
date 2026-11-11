// DK-11 with DK-5: the secrets of `mcp.json` live in the Keychain. The principal writes a value in
// a server's `env` or `headers`; before each start of the daemon the shell moves it to the Keychain
// and leaves `@keychain` in its place, so the file holds a token only until that start. The daemon
// gets the values in its environment, by account, and fills each marker.
use serde_json::Value;

use crate::data_dir::DataDir;
use crate::secure_store::SecretStore;

pub const FILE_NAME: &str = "mcp.json";
/// What stands in the file for a value kept in the Keychain; `KEPT_SECRET` of the daemon.
pub const MARKER: &str = "@keychain";
/// The fields of a server whose values are kept.
const FIELDS: [&str; 2] = ["env", "headers"];

/// What one sweep leaves. Holds secrets: no `Debug`.
pub struct Swept {
    /// By Keychain account: what the daemon fills the markers with.
    pub secrets: Vec<(String, String)>,
    /// The accounts in use, sorted, so they are removed once the file no longer names them.
    pub accounts: Vec<String>,
}

/// The Keychain account of one value: `mcp/<server>/<env|headers>/<name>`. No server name holds a
/// `/`, so two values never share an account, and none is named as a daemon variable.
pub fn account(server: &str, field: &str, name: &str) -> String {
    format!("mcp/{server}/{field}/{name}")
}

/// A server name as the daemon accepts it: a letter or digit, then up to 39 of those, spaces,
/// `.`, `_` and `-`. A file with any other name connects nothing, so it is left as written.
fn is_server_name(name: &str) -> bool {
    let mut chars = name.chars();
    name.len() <= 40
        && chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '_' | '-'))
}

/// Removes the accounts of `known` that `used` lacks; the ones that could not be removed stay
/// listed, to try again at the next start.
fn forget(store: &dyn SecretStore, known: &[String], used: &[String]) -> Vec<String> {
    let mut left = Vec::new();
    for account in known.iter().filter(|account| !used.contains(account)) {
        if let Err(error) = store.delete(account) {
            eprintln!("{error}");
            left.push(account.clone());
        }
    }
    left
}

/// Moves every value of `mcp.json` to `store` and returns the secrets the file refers to. `known`
/// is the accounts the last sweep left. A file that cannot be read as the daemon would is left as
/// it is, with what is stored: the principal may be halfway through writing it.
pub fn sweep(data: &DataDir, store: &dyn SecretStore, known: &[String]) -> Swept {
    let untouched = || Swept {
        secrets: Vec::new(),
        accounts: known.to_vec(),
    };
    let bytes = match std::fs::read(data.root().join(FILE_NAME)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Swept {
                secrets: Vec::new(),
                accounts: forget(store, known, &[]),
            };
        }
        Err(error) => {
            eprintln!("could not read {FILE_NAME}: {error}");
            return untouched();
        }
    };
    let Ok(mut file) = serde_json::from_slice::<Value>(&bytes) else {
        return untouched();
    };
    let Some(servers) = file.get_mut("mcpServers").and_then(Value::as_object_mut) else {
        return untouched();
    };

    let mut used = Vec::new();
    let mut moved = false;
    for (server, entry) in servers.iter_mut() {
        if !is_server_name(server) {
            continue;
        }
        for field in FIELDS {
            let Some(values) = entry.get_mut(field).and_then(Value::as_object_mut) else {
                continue;
            };
            for (name, value) in values.iter_mut() {
                // An empty value is no secret, and anything but a text the daemon refuses.
                let Some(text) = value.as_str().filter(|text| !text.is_empty()) else {
                    continue;
                };
                let account = account(server, field, name);
                if text != MARKER {
                    // The value stays in the file while the Keychain does not have it.
                    if let Err(error) = store.set(&account, text) {
                        eprintln!("{error}");
                        continue;
                    }
                    *value = Value::String(MARKER.to_owned());
                    moved = true;
                }
                used.push(account);
            }
        }
    }
    if moved {
        // After the Keychain has every value: a failure here leaves them in both places.
        let written = serde_json::to_vec_pretty(&file)
            .map_err(std::io::Error::other)
            .and_then(|mut json| {
                json.push(b'\n');
                data.write_private(FILE_NAME, &json)
            });
        if let Err(error) = written {
            eprintln!("could not rewrite {FILE_NAME} without its secrets: {error}");
        }
    }

    used.sort();
    let mut secrets = Vec::new();
    let mut accounts = forget(store, known, &used);
    for account in used {
        match store.get(&account) {
            Ok(Some(secret)) => {
                secrets.push((account.clone(), secret));
                accounts.push(account);
            }
            // The daemon leaves that server out and says which value is missing.
            Ok(None) => {}
            Err(error) => eprintln!("{error}"),
        }
    }
    accounts.sort();
    Swept { secrets, accounts }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secure_store::MemoryStore;
    use serde_json::json;
    use std::os::unix::fs::PermissionsExt;

    type Outcome = Result<(), String>;

    struct Fixture {
        _parent: tempfile::TempDir,
        data: DataDir,
    }

    impl Fixture {
        fn new() -> Result<Self, String> {
            let parent = tempfile::tempdir().map_err(|e| e.to_string())?;
            let data = DataDir::open(parent.path().join("ANOMANDER")).map_err(|e| e.to_string())?;
            Ok(Self {
                _parent: parent,
                data,
            })
        }

        fn path(&self) -> std::path::PathBuf {
            self.data.root().join(FILE_NAME)
        }

        fn write(&self, file: &Value) -> Outcome {
            std::fs::write(self.path(), file.to_string()).map_err(|e| e.to_string())
        }

        fn text(&self) -> Result<String, String> {
            std::fs::read_to_string(self.path()).map_err(|e| e.to_string())
        }

        fn file(&self) -> Result<Value, String> {
            serde_json::from_str(&self.text()?).map_err(|e| e.to_string())
        }
    }

    fn written() -> Value {
        json!({
            "mcpServers": {
                "zeta": {
                    "command": "npx",
                    "args": ["-y", "zeta-mcp"],
                    "env": { "TOKEN": "tok-1", "EMPTY": "" },
                    "readOnly": ["search"]
                },
                "alpha": {
                    "url": "https://example.com/mcp",
                    "headers": { "Authorization": "Bearer b-2" }
                }
            }
        })
    }

    const TOKEN: &str = "mcp/zeta/env/TOKEN";
    const HEADER: &str = "mcp/alpha/headers/Authorization";

    fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
            .collect()
    }

    #[test]
    fn values_move_to_the_store_and_the_file_keeps_a_marker_for_each() -> Outcome {
        let f = Fixture::new()?;
        f.write(&written())?;
        let store = MemoryStore::default();

        let swept = sweep(&f.data, &store, &[]);

        assert_eq!(
            swept.secrets,
            pairs(&[(HEADER, "Bearer b-2"), (TOKEN, "tok-1")])
        );
        assert_eq!(swept.accounts, vec![HEADER.to_owned(), TOKEN.to_owned()]);
        assert_eq!(store.get(TOKEN), Ok(Some("tok-1".into())));
        assert_eq!(store.get(HEADER), Ok(Some("Bearer b-2".into())));
        // Everything but the values is as the principal wrote it, in their order.
        let mut expected = written();
        expected["mcpServers"]["zeta"]["env"]["TOKEN"] = json!(MARKER);
        expected["mcpServers"]["alpha"]["headers"]["Authorization"] = json!(MARKER);
        assert_eq!(f.file()?, expected);
        let text = f.text()?;
        assert!(!text.contains("tok-1") && !text.contains("b-2"), "{text}");
        assert!(text.find("zeta") < text.find("alpha"), "{text}");
        let mode = std::fs::metadata(f.path())
            .map_err(|e| e.to_string())?
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
        Ok(())
    }

    #[test]
    fn a_swept_file_is_not_written_again_and_gives_the_same_secrets() -> Outcome {
        let f = Fixture::new()?;
        f.write(&written())?;
        let store = MemoryStore::default();
        let first = sweep(&f.data, &store, &[]);
        let before = f.text()?;

        let second = sweep(&f.data, &store, &first.accounts);

        assert_eq!(f.text()?, before);
        assert_eq!(second.secrets, first.secrets);
        assert_eq!(second.accounts, first.accounts);
        Ok(())
    }

    #[test]
    fn a_value_written_over_a_marker_replaces_the_stored_one() -> Outcome {
        let f = Fixture::new()?;
        f.write(&written())?;
        let store = MemoryStore::default();
        let first = sweep(&f.data, &store, &[]);
        let mut file = f.file()?;
        file["mcpServers"]["zeta"]["env"]["TOKEN"] = json!("tok-9");
        f.write(&file)?;

        let second = sweep(&f.data, &store, &first.accounts);

        assert_eq!(store.get(TOKEN), Ok(Some("tok-9".into())));
        assert!(second
            .secrets
            .contains(&(TOKEN.to_owned(), "tok-9".to_owned())));
        assert!(!f.text()?.contains("tok-9"));
        Ok(())
    }

    #[test]
    fn what_the_file_no_longer_names_leaves_the_store() -> Outcome {
        let f = Fixture::new()?;
        f.write(&written())?;
        let store = MemoryStore::default();
        let first = sweep(&f.data, &store, &[]);
        let mut file = f.file()?;
        file["mcpServers"]
            .as_object_mut()
            .ok_or("no servers")?
            .remove("alpha");
        f.write(&file)?;

        let second = sweep(&f.data, &store, &first.accounts);
        assert_eq!(second.accounts, vec![TOKEN.to_owned()]);
        assert_eq!(store.names(), vec![TOKEN.to_owned()]);

        // Without the file nothing is kept.
        std::fs::remove_file(f.path()).map_err(|e| e.to_string())?;
        let third = sweep(&f.data, &store, &second.accounts);
        assert!(third.secrets.is_empty() && third.accounts.is_empty());
        assert!(store.names().is_empty());
        Ok(())
    }

    #[test]
    fn a_value_the_store_refuses_stays_in_the_file() -> Outcome {
        let f = Fixture::new()?;
        f.write(&written())?;
        let before = f.text()?;

        let swept = sweep(&f.data, &MemoryStore::failing(), &[]);

        assert_eq!(f.text()?, before);
        assert!(swept.secrets.is_empty() && swept.accounts.is_empty());
        Ok(())
    }

    #[test]
    fn a_file_the_daemon_would_refuse_is_left_as_written_with_what_is_stored() -> Outcome {
        let store = MemoryStore::default();
        store.set(TOKEN, "tok-1").map_err(|e| e.0)?;
        let known = vec![TOKEN.to_owned()];
        let unreadable = [
            "{ \"mcpServers\": { \"zeta\": { \"env\": { \"TOKEN\": \"tok-7\" ".to_owned(),
            json!({ "servers": {} }).to_string(),
            json!({ "mcpServers": [] }).to_string(),
        ];
        for text in unreadable {
            let f = Fixture::new()?;
            std::fs::write(f.path(), &text).map_err(|e| e.to_string())?;
            let swept = sweep(&f.data, &store, &known);
            assert_eq!(f.text()?, text);
            assert!(swept.secrets.is_empty(), "{text}");
            assert_eq!(swept.accounts, known, "{text}");
            assert_eq!(store.get(TOKEN), Ok(Some("tok-1".into())), "{text}");
        }
        Ok(())
    }

    #[test]
    fn a_server_with_a_name_the_daemon_refuses_and_a_value_that_is_no_text_are_not_moved() -> Outcome
    {
        let f = Fixture::new()?;
        let file = json!({
            "mcpServers": {
                "a/b": { "command": "x", "env": { "TOKEN": "tok-1" } },
                "ok": { "command": "x", "env": { "PORT": 8080 } }
            }
        });
        f.write(&file)?;
        let before = f.text()?;
        let store = MemoryStore::default();

        let swept = sweep(&f.data, &store, &[]);

        assert_eq!(f.text()?, before);
        assert!(swept.secrets.is_empty() && store.names().is_empty());
        Ok(())
    }

    #[test]
    fn a_marker_with_nothing_stored_gives_no_secret() -> Outcome {
        let f = Fixture::new()?;
        f.write(&json!({
            "mcpServers": { "zeta": { "command": "x", "env": { "TOKEN": MARKER } } }
        }))?;

        let swept = sweep(&f.data, &MemoryStore::default(), &[]);

        assert!(swept.secrets.is_empty() && swept.accounts.is_empty());
        Ok(())
    }

    #[test]
    fn server_names_follow_the_daemons_rule() {
        for name in ["notes", "My notes 2", "a.b_c-d", "9"] {
            assert!(is_server_name(name), "{name}");
        }
        for name in ["", " notes", "a/b", "a»b", "_a", &"a".repeat(41)] {
            assert!(!is_server_name(name), "{name}");
        }
    }
}
