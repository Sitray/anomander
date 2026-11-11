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
    /// The accounts to remember, sorted, so they are removed once the file no longer names them.
    pub accounts: Vec<String>,
}

/// The Keychain account of one value: `mcp/<server>/<env|headers>/<name>`. No server name holds a
/// `/`, so two values never share an account, and none is named as a daemon variable.
pub fn account(server: &str, field: &str, name: &str) -> String {
    format!("mcp/{server}/{field}/{name}")
}

/// A server name as the daemon accepts it: a letter or digit, then up to 39 of those, spaces,
/// `.`, `_` and `-`. The daemon refuses a file with any other name, so that server is skipped.
fn is_server_name(name: &str) -> bool {
    let mut chars = name.chars();
    name.len() <= 40
        && chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '_' | '-'))
}

/// Removes the accounts of `known` that `used` lacks; the ones that could not be removed stay
/// listed, to try again at the next start. `known` comes from `settings.json`: a name there that
/// is not an account of the connections is never removed.
fn forget(store: &dyn SecretStore, known: &[String], used: &[String]) -> Vec<String> {
    let mut left = Vec::new();
    let ours = known.iter().filter(|account| account.starts_with("mcp/"));
    for account in ours.filter(|account| !used.contains(account)) {
        if let Err(error) = store.delete(account) {
            eprintln!("{error}");
            left.push(account.clone());
        }
    }
    left
}

/// Moves every value of `mcp.json` to `store` and returns the secrets the file refers to. `known`
/// is the accounts the last sweep left. A file that is missing, a link, or not JSON with its
/// servers is left as it is, with what is stored: the principal may be halfway through writing it.
pub fn sweep(data: &DataDir, store: &dyn SecretStore, known: &[String]) -> Swept {
    let untouched = || Swept {
        secrets: Vec::new(),
        accounts: known.to_vec(),
    };
    let path = data.root().join(FILE_NAME);
    match std::fs::symlink_metadata(&path) {
        Ok(meta) if meta.is_file() => {}
        // Rewriting would replace the link and leave the values in the file it points to.
        Ok(_) => {
            eprintln!("{FILE_NAME} is not a plain file: its values stay in it");
            return untouched();
        }
        Err(_) => return untouched(),
    }
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
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
    let mut found = Vec::new();
    let mut waiting = false;
    for account in &used {
        match store.get(account) {
            Ok(Some(secret)) => {
                secrets.push((account.clone(), secret));
                found.push(account.clone());
            }
            // The daemon leaves that server out and says which value is missing.
            Ok(None) => waiting = true,
            Err(error) => {
                eprintln!("{error}");
                waiting = true;
            }
        }
    }
    // A marker without its value is most likely a renamed server or variable, whose value is
    // still stored under the old name: nothing is removed until every marker has one.
    let mut accounts = if waiting {
        known.to_vec()
    } else {
        forget(store, known, &used)
    };
    accounts.extend(found);
    accounts.sort();
    accounts.dedup();
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

        // A file that names no server keeps nothing.
        f.write(&json!({ "mcpServers": {} }))?;
        let third = sweep(&f.data, &store, &second.accounts);
        assert!(third.secrets.is_empty() && third.accounts.is_empty());
        assert!(store.names().is_empty());
        Ok(())
    }

    #[test]
    fn a_renamed_server_or_value_does_not_lose_its_secret() -> Outcome {
        for (from, to) in [("\"zeta\"", "\"omega\""), ("\"TOKEN\"", "\"API_TOKEN\"")] {
            let f = Fixture::new()?;
            f.write(&written())?;
            let store = MemoryStore::default();
            let first = sweep(&f.data, &store, &[]);
            std::fs::write(f.path(), f.text()?.replace(from, to)).map_err(|e| e.to_string())?;

            // A marker waits for a value nobody stored: nothing is removed meanwhile.
            let second = sweep(&f.data, &store, &first.accounts);
            assert_eq!(store.get(TOKEN), Ok(Some("tok-1".into())), "{from}");
            assert_eq!(second.accounts, first.accounts, "{from}");
            assert_eq!(second.secrets, pairs(&[(HEADER, "Bearer b-2")]), "{from}");

            // Once the principal writes the value under the new name, the old one goes.
            let mut file = f.file()?;
            for server in ["zeta", "omega"] {
                for name in ["TOKEN", "API_TOKEN"] {
                    if file["mcpServers"][server]["env"][name] == json!(MARKER) {
                        file["mcpServers"][server]["env"][name] = json!("tok-2");
                    }
                }
            }
            f.write(&file)?;
            let third = sweep(&f.data, &store, &second.accounts);
            assert_eq!(store.get(TOKEN), Ok(None), "{from}");
            assert_eq!(store.names().len(), 2, "{from}");
            assert_eq!(third.secrets.len(), 2, "{from}");
        }
        Ok(())
    }

    #[test]
    fn a_missing_file_keeps_what_is_stored() -> Outcome {
        let f = Fixture::new()?;
        f.write(&written())?;
        let store = MemoryStore::default();
        let first = sweep(&f.data, &store, &[]);
        let swept_file = f.text()?;
        std::fs::remove_file(f.path()).map_err(|e| e.to_string())?;

        let second = sweep(&f.data, &store, &first.accounts);
        assert!(second.secrets.is_empty());
        assert_eq!(second.accounts, first.accounts);

        // Put back, it works again.
        std::fs::write(f.path(), swept_file).map_err(|e| e.to_string())?;
        assert_eq!(
            sweep(&f.data, &store, &second.accounts).secrets,
            first.secrets
        );
        Ok(())
    }

    #[test]
    fn a_file_that_is_a_link_is_left_as_it_is() -> Outcome {
        let f = Fixture::new()?;
        let target = f.data.root().join("elsewhere.json");
        std::fs::write(&target, written().to_string()).map_err(|e| e.to_string())?;
        std::os::unix::fs::symlink(&target, f.path()).map_err(|e| e.to_string())?;
        let store = MemoryStore::default();

        let swept = sweep(&f.data, &store, &[]);

        // Rewriting would replace the link and leave the values in the file it points to.
        let link = std::fs::symlink_metadata(f.path()).map_err(|e| e.to_string())?;
        assert!(link.file_type().is_symlink());
        assert_eq!(f.text()?, written().to_string());
        assert!(swept.secrets.is_empty() && store.names().is_empty());
        Ok(())
    }

    #[test]
    fn only_accounts_of_the_connections_are_ever_removed() -> Outcome {
        let f = Fixture::new()?;
        f.write(&json!({ "mcpServers": {} }))?;
        let store = MemoryStore::default();
        store.set("TELEGRAM_BOT_TOKEN", "bot:1").map_err(|e| e.0)?;
        store.set(TOKEN, "tok-1").map_err(|e| e.0)?;

        // As a `settings.json` edited by hand could list.
        let swept = sweep(
            &f.data,
            &store,
            &["TELEGRAM_BOT_TOKEN".to_owned(), TOKEN.to_owned()],
        );

        assert_eq!(store.names(), vec!["TELEGRAM_BOT_TOKEN".to_owned()]);
        assert!(swept.accounts.is_empty());
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
