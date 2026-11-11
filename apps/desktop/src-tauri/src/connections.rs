// DK-11: what the connections screen reads and writes. `mcp.json` stays the source of truth, in
// the format the daemon reads (`packages/daemon/src/connections/config.ts`): the screen changes
// one server at a time and leaves the rest as the principal wrote it. A value typed in the screen
// goes to the Keychain and the file gets its marker, as after a sweep (`connection_secrets`); the
// window is told the names and whether a value is stored, never a value.
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::connection_secrets::{account, is_server_name, FILE_NAME, MARKER};
use crate::data_dir::DataDir;
use crate::secure_store::{SecretStore, StoreError};

const SERVERS: &str = "mcpServers";
/// Where plain HTTP may go: this machine only, as the daemon's `LOOPBACK`.
const LOOPBACK: [&str; 3] = ["127.0.0.1", "localhost", "[::1]"];

/// How a server is reached. `kind` and its fields in `ConnectionServer` of `shell.ts`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Target {
    Process {
        command: String,
        #[serde(default)]
        args: Vec<String>,
    },
    Http {
        url: String,
    },
}

impl Target {
    /// The field of the file that holds this server's values.
    fn field(&self) -> &'static str {
        match self {
            Self::Process { .. } => "env",
            Self::Http { .. } => "headers",
        }
    }
}

/// `ConnectionValue` of `shell.ts`: a name, and whether a value is kept for it.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct ValueView {
    pub name: String,
    pub stored: bool,
}

/// `ConnectionServer` of `shell.ts`.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerView {
    pub name: String,
    #[serde(flatten)]
    pub target: Target,
    pub values: Vec<ValueView>,
    pub read_only: Vec<String>,
}

/// `ConnectionsView` of `shell.ts`.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct ConnectionsView {
    pub servers: Vec<ServerView>,
    /// Why the file cannot be changed from the screen: where it is not as the daemon reads it,
    /// never what it says. Then no server is listed.
    pub invalid: Option<String>,
}

/// One value of a `ServerInput`. Holds a secret: no `Debug`.
#[derive(Deserialize)]
pub struct ValueInput {
    pub name: String,
    /// Omitted (or empty) keeps the value the server already has under that name.
    #[serde(default)]
    pub value: Option<String>,
}

/// `ConnectionInput` of `shell.ts`. Holds secrets: no `Debug`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInput {
    /// The name the server has in the file; omitted adds one.
    #[serde(default)]
    pub original: Option<String>,
    pub name: String,
    #[serde(flatten)]
    pub target: Target,
    #[serde(default)]
    pub values: Vec<ValueInput>,
    #[serde(default)]
    pub read_only: Vec<String>,
}

/// A server as the file holds it.
struct Server {
    target: Target,
    /// By name: the value as written, or `MARKER`.
    values: Vec<(String, String)>,
    read_only: Vec<String>,
}

/// HTTPS, or plain HTTP to this machine: the daemon's `reachable`.
fn reachable(text: &str) -> bool {
    tauri::Url::parse(text).is_ok_and(|url| {
        url.scheme() == "https"
            || (url.scheme() == "http"
                && url.host_str().is_some_and(|host| LOOPBACK.contains(&host)))
    })
}

/// The texts of an optional list; `None` when it is anything else.
fn texts(value: Option<&Value>, may_be_empty: bool) -> Option<Vec<String>> {
    let Some(value) = value else {
        return Some(Vec::new());
    };
    value
        .as_array()?
        .iter()
        .map(|item| {
            item.as_str()
                .filter(|text| may_be_empty || !text.is_empty())
                .map(str::to_owned)
        })
        .collect()
}

/// One server, read as the daemon's schema does: strict, a command or a URL. Otherwise the key
/// that is wrong, empty when it is the entry itself.
fn server_of(entry: &Value) -> Result<Server, String> {
    let entry = entry.as_object().ok_or_else(String::new)?;
    let text = |key: &str| entry.get(key).and_then(Value::as_str);
    let (target, keys): (Target, &[&str]) =
        match (entry.contains_key("command"), entry.contains_key("url")) {
            (true, false) => {
                let command = text("command")
                    .filter(|command| !command.is_empty())
                    .ok_or("command")?;
                let args = texts(entry.get("args"), true).ok_or("args")?;
                (
                    Target::Process {
                        command: command.to_owned(),
                        args,
                    },
                    &["command", "args", "env", "readOnly"],
                )
            }
            (false, true) => {
                let url = text("url").filter(|url| reachable(url)).ok_or("url")?;
                (
                    Target::Http {
                        url: url.to_owned(),
                    },
                    &["url", "headers", "readOnly"],
                )
            }
            (true, true) => return Err("url".into()),
            (false, false) => return Err("command".into()),
        };
    if let Some(key) = entry.keys().find(|key| !keys.contains(&key.as_str())) {
        return Err(key.clone());
    }
    let field = target.field();
    let values = match entry.get(field) {
        None => Vec::new(),
        Some(Value::Object(values)) => values
            .iter()
            .map(|(name, value)| match value.as_str() {
                Some(value) if !name.is_empty() => Ok((name.clone(), value.to_owned())),
                _ => Err(format!("{field}.{name}")),
            })
            .collect::<Result<_, _>>()?,
        Some(_) => return Err(field.into()),
    };
    let read_only = texts(entry.get("readOnly"), false).ok_or("readOnly")?;
    Ok(Server {
        target,
        values,
        read_only,
    })
}

/// The servers of the file, in its order; otherwise where it is not as the daemon reads it.
fn servers_of(file: &Value) -> Result<Vec<(String, Server)>, String> {
    let top = file.as_object().ok_or("its top level")?;
    if let Some(key) = top.keys().find(|key| *key != SERVERS) {
        return Err(key.clone());
    }
    let servers = top.get(SERVERS).and_then(Value::as_object).ok_or(SERVERS)?;
    servers
        .iter()
        .map(|(name, entry)| {
            let at = format!("{SERVERS}.{name}");
            if !is_server_name(name) {
                return Err(at);
            }
            match server_of(entry) {
                Ok(server) => Ok((name.clone(), server)),
                Err(key) if key.is_empty() => Err(at),
                Err(key) => Err(format!("{at}.{key}")),
            }
        })
        .collect()
}

/// The file as it is now.
struct Document {
    /// `None` when there is no file yet.
    bytes: Option<Vec<u8>>,
    file: Value,
    servers: Vec<(String, Server)>,
}

/// Reads the file, whole or not at all: a file the daemon would refuse is not the screen's to
/// rewrite, and neither is a link, which a write would replace (as the sweep leaves it).
fn read(data: &DataDir) -> Result<Document, String> {
    let path = data.root().join(FILE_NAME);
    let unreadable = |error: std::io::Error| format!("could not read {FILE_NAME}: {error}");
    let bytes = match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(unreadable(error)),
        Ok(meta) if !meta.is_file() => return Err(format!("{FILE_NAME} is not a plain file")),
        Ok(_) => Some(std::fs::read(&path).map_err(unreadable)?),
    };
    let file = match &bytes {
        None => json!({ "mcpServers": {} }),
        Some(bytes) => {
            serde_json::from_slice(bytes).map_err(|_| format!("{FILE_NAME} is not JSON"))?
        }
    };
    let servers = servers_of(&file)
        .map_err(|at| format!("{FILE_NAME} is not as the daemon reads it: {at}"))?;
    Ok(Document {
        bytes,
        file,
        servers,
    })
}

/// A change to the file, checked and not yet made. Holds secrets: no `Debug`.
pub struct Change {
    /// The file as it was read: it must still be so when it is written.
    read: Option<Vec<u8>>,
    file: Value,
    writes: Vec<Write>,
}

/// What a change does to the store before the file is written.
enum Write {
    /// A value typed in the screen.
    Typed { account: String, value: String },
    /// A kept value whose server, or its kind, changed: copied, and the sweep removes the old one
    /// once the file no longer names it.
    Moved { from: String, to: String },
}

impl Change {
    /// The accounts this change may store.
    pub fn accounts(&self) -> Vec<String> {
        self.writes
            .iter()
            .map(|write| match write {
                Write::Typed { account, .. } | Write::Moved { to: account, .. } => account.clone(),
            })
            .collect()
    }

    /// Stores the values, then writes the file with mode `600`.
    pub fn apply(self, data: &DataDir, store: &dyn SecretStore) -> Result<(), String> {
        // The principal may have saved the file since it was read: theirs stays.
        if std::fs::read(data.root().join(FILE_NAME)).ok() != self.read {
            return Err(format!("{FILE_NAME} changed meanwhile: nothing was saved"));
        }
        let failed = |error: StoreError| error.0;
        for write in &self.writes {
            match write {
                Write::Typed { account, value } => store.set(account, value).map_err(failed)?,
                Write::Moved { from, to } => {
                    // Nothing stored is a marker that already waited for its value.
                    if let Some(value) = store.get(from).map_err(failed)? {
                        store.set(to, &value).map_err(failed)?;
                    }
                }
            }
        }
        let unwritten = |error: std::io::Error| format!("could not write {FILE_NAME}: {error}");
        let mut json = serde_json::to_vec_pretty(&self.file)
            .map_err(std::io::Error::other)
            .map_err(unwritten)?;
        json.push(b'\n');
        data.write_private(FILE_NAME, &json).map_err(unwritten)
    }
}

/// The servers with `original` replaced where it stands by `with`, or taken out; a new one goes
/// last. The others keep their order and everything they hold.
fn replace(file: &mut Value, original: Option<&str>, mut with: Option<(String, Value)>) {
    let Some(servers) = file.get_mut(SERVERS).and_then(Value::as_object_mut) else {
        return;
    };
    let mut next = Map::new();
    for (name, entry) in std::mem::take(servers) {
        if Some(name.as_str()) != original {
            next.insert(name, entry);
        } else if let Some((name, entry)) = with.take() {
            next.insert(name, entry);
        }
    }
    if let Some((name, entry)) = with {
        next.insert(name, entry);
    }
    *servers = next;
}

/// Whether `account` holds a value. A store that cannot be read counts as none.
fn kept(store: &dyn SecretStore, account: &str) -> bool {
    match store.get(account) {
        Ok(value) => value.is_some(),
        Err(error) => {
            eprintln!("{error}");
            false
        }
    }
}

/// The servers of `mcp.json` for the screen. A missing file has none.
pub fn view(data: &DataDir, store: &dyn SecretStore) -> ConnectionsView {
    let document = match read(data) {
        Ok(document) => document,
        Err(invalid) => {
            return ConnectionsView {
                servers: Vec::new(),
                invalid: Some(invalid),
            }
        }
    };
    let servers = document
        .servers
        .into_iter()
        .map(|(name, server)| {
            let field = server.target.field();
            let values = server
                .values
                .into_iter()
                .map(|(value_name, value)| ValueView {
                    // A value still in the file is moved at the next start; an empty one is none.
                    stored: !value.is_empty()
                        && (value != MARKER || kept(store, &account(&name, field, &value_name))),
                    name: value_name,
                })
                .collect();
            ServerView {
                name,
                target: server.target,
                values,
                read_only: server.read_only,
            }
        })
        .collect();
    ConnectionsView {
        servers,
        invalid: None,
    }
}

/// Checks `input` whole against what the daemon accepts and returns the change that adds the
/// server or replaces `input.original`. Nothing is stored or written here.
pub fn save(data: &DataDir, input: &ServerInput) -> Result<Change, String> {
    let Document {
        bytes,
        mut file,
        servers,
    } = read(data)?;
    let name = &input.name;
    if !is_server_name(name) {
        return Err(format!(
            "{name} is not a server name: a letter or a digit, then up to 39 letters, digits, \
             spaces, '.', '_' or '-'"
        ));
    }
    let find = |name: &str| servers.iter().find(|(known, _)| known == name);
    let original = match &input.original {
        None => None,
        Some(original) => {
            Some(find(original).ok_or_else(|| format!("there is no server named {original}"))?)
        }
    };
    if input.original.as_ref() != Some(name) && find(name).is_some() {
        return Err(format!("there is already a server named {name}"));
    }

    let field = input.target.field();
    let mut values = Map::new();
    let mut writes = Vec::new();
    for value in &input.values {
        if values.contains_key(&value.name) {
            return Err(format!("{} is there twice", value.name));
        }
        let to = account(name, field, &value.name);
        let typed = value
            .value
            .as_deref()
            .map(str::trim)
            .filter(|typed| !typed.is_empty());
        let held = original.and_then(|(_, server)| {
            let held = server.values.iter().find(|(held, _)| *held == value.name);
            held.map(|(_, value)| value.as_str())
        });
        let in_file = match (typed, held, original) {
            (Some(typed), _, _) => {
                writes.push(Write::Typed {
                    account: to,
                    value: typed.to_owned(),
                });
                MARKER
            }
            (None, Some(MARKER), Some((was, server))) => {
                let from = account(was, server.target.field(), &value.name);
                if from != to {
                    writes.push(Write::Moved { from, to });
                }
                MARKER
            }
            // Not swept yet: it stays as the principal wrote it, for the next start to move.
            (None, Some(held), _) => held,
            (None, None, _) => "",
        };
        values.insert(value.name.clone(), Value::String(in_file.to_owned()));
    }

    let mut entry = Map::new();
    match &input.target {
        Target::Process { command, args } => {
            entry.insert("command".into(), json!(command));
            if !args.is_empty() {
                entry.insert("args".into(), json!(args));
            }
        }
        Target::Http { url } => {
            entry.insert("url".into(), json!(url));
        }
    }
    if !values.is_empty() {
        entry.insert(field.into(), Value::Object(values));
    }
    if !input.read_only.is_empty() {
        entry.insert("readOnly".into(), json!(input.read_only));
    }
    let entry = Value::Object(entry);
    // Read back as the daemon will: one check for a file written by hand and one written here.
    server_of(&entry)
        .map_err(|key| format!("the daemon would not read this server: its {key} is not valid"))?;
    replace(
        &mut file,
        input.original.as_deref(),
        Some((name.clone(), entry)),
    );
    Ok(Change {
        read: bytes,
        file,
        writes,
    })
}

/// The change that takes the server `name` out of the file. Its values leave the Keychain at the
/// next sweep, which knows whether another server still needs them.
pub fn remove(data: &DataDir, name: &str) -> Result<Change, String> {
    let Document {
        bytes,
        mut file,
        servers,
    } = read(data)?;
    if !servers.iter().any(|(known, _)| known == name) {
        return Err(format!("there is no server named {name}"));
    }
    replace(&mut file, Some(name), None);
    Ok(Change {
        read: bytes,
        file,
        writes: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection_secrets::sweep;
    use crate::secure_store::MemoryStore;
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

        /// With the file the principal wrote by hand, not swept yet.
        fn written() -> Result<Self, String> {
            let f = Self::new()?;
            f.write(&written().to_string())?;
            Ok(f)
        }

        fn path(&self) -> std::path::PathBuf {
            self.data.root().join(FILE_NAME)
        }

        fn write(&self, text: &str) -> Outcome {
            std::fs::write(self.path(), text).map_err(|e| e.to_string())
        }

        fn text(&self) -> Result<String, String> {
            std::fs::read_to_string(self.path()).map_err(|e| e.to_string())
        }

        fn file(&self) -> Result<Value, String> {
            serde_json::from_str(&self.text()?).map_err(|e| e.to_string())
        }

        fn save(&self, store: &dyn SecretStore, input: Value) -> Outcome {
            let input: ServerInput = serde_json::from_value(input).map_err(|e| e.to_string())?;
            save(&self.data, &input)?.apply(&self.data, store)
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

    const TYPED: &str = "typed-secret-9";
    const ZETA_TOKEN: &str = "mcp/zeta/env/TOKEN";
    const ALPHA_HEADER: &str = "mcp/alpha/headers/Authorization";

    fn notes() -> Value {
        json!({
            "name": "notes",
            "kind": "process",
            "command": "npx",
            "args": ["-y", "notes-mcp"],
            "values": [{ "name": "API_KEY", "value": TYPED }],
            "readOnly": ["list"]
        })
    }

    #[test]
    fn the_view_lists_the_servers_in_their_order_and_no_value() -> Outcome {
        let f = Fixture::new()?;
        let mut file = written();
        file["mcpServers"]["alpha"]["headers"]["Authorization"] = json!(MARKER);
        file["mcpServers"]["beta"] = json!({ "command": "beta", "env": { "LOST": MARKER } });
        f.write(&file.to_string())?;
        let store = MemoryStore::default();
        store.set(ALPHA_HEADER, "Bearer b-2").map_err(|e| e.0)?;

        let view = serde_json::to_value(view(&f.data, &store)).map_err(|e| e.to_string())?;

        // The shape `shell.ts` declares. A value still in the file counts as stored: the next
        // start moves it; a marker with nothing in the store does not.
        assert_eq!(
            view,
            json!({
                "servers": [
                    {
                        "name": "zeta",
                        "kind": "process",
                        "command": "npx",
                        "args": ["-y", "zeta-mcp"],
                        "values": [
                            { "name": "TOKEN", "stored": true },
                            { "name": "EMPTY", "stored": false }
                        ],
                        "readOnly": ["search"]
                    },
                    {
                        "name": "alpha",
                        "kind": "http",
                        "url": "https://example.com/mcp",
                        "values": [{ "name": "Authorization", "stored": true }],
                        "readOnly": []
                    },
                    {
                        "name": "beta",
                        "kind": "process",
                        "command": "beta",
                        "args": [],
                        "values": [{ "name": "LOST", "stored": false }],
                        "readOnly": []
                    }
                ],
                "invalid": null
            })
        );
        let sent = view.to_string();
        assert!(!sent.contains("tok-1") && !sent.contains("b-2"), "{sent}");
        Ok(())
    }

    #[test]
    fn a_missing_file_has_no_server_and_the_first_one_creates_it() -> Outcome {
        let f = Fixture::new()?;
        let store = MemoryStore::default();
        assert_eq!(
            view(&f.data, &store),
            ConnectionsView {
                servers: Vec::new(),
                invalid: None
            }
        );

        f.save(&store, notes())?;

        assert_eq!(
            f.file()?,
            json!({
                "mcpServers": {
                    "notes": {
                        "command": "npx",
                        "args": ["-y", "notes-mcp"],
                        "env": { "API_KEY": MARKER },
                        "readOnly": ["list"]
                    }
                }
            })
        );
        Ok(())
    }

    #[test]
    fn a_new_server_goes_last_with_its_value_in_the_store_and_a_marker_in_the_file() -> Outcome {
        let f = Fixture::written()?;
        let store = MemoryStore::default();

        f.save(&store, notes())?;

        assert_eq!(
            store.get("mcp/notes/env/API_KEY"),
            Ok(Some(TYPED.to_owned()))
        );
        assert_eq!(store.names().len(), 1);
        // What the principal wrote is as they wrote it, values included, in their order.
        let mut expected = written();
        expected["mcpServers"]["notes"] = json!({
            "command": "npx",
            "args": ["-y", "notes-mcp"],
            "env": { "API_KEY": MARKER },
            "readOnly": ["list"]
        });
        assert_eq!(f.file()?, expected);
        let text = f.text()?;
        assert!(!text.contains(TYPED), "{text}");
        assert!(text.find("zeta") < text.find("alpha") && text.find("alpha") < text.find("notes"));
        let mode = std::fs::metadata(f.path())
            .map_err(|e| e.to_string())?
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
        Ok(())
    }

    #[test]
    fn an_edit_keeps_what_was_not_typed_replaces_what_was_and_drops_what_is_gone() -> Outcome {
        let f = Fixture::written()?;
        let store = MemoryStore::default();
        let first = sweep(&f.data, &store, &[]);

        f.save(
            &store,
            json!({
                "original": "zeta",
                "name": "zeta",
                "kind": "process",
                "command": "node",
                "args": ["zeta.js"],
                "values": [
                    { "name": "TOKEN" },
                    { "name": "REGION", "value": " eu-west-1 \n" }
                ],
                "readOnly": ["search", "read"]
            }),
        )?;

        let mut expected = written();
        expected["mcpServers"]["zeta"] = json!({
            "command": "node",
            "args": ["zeta.js"],
            "env": { "TOKEN": MARKER, "REGION": MARKER },
            "readOnly": ["search", "read"]
        });
        expected["mcpServers"]["alpha"]["headers"]["Authorization"] = json!(MARKER);
        assert_eq!(f.file()?, expected);
        assert_eq!(store.get(ZETA_TOKEN), Ok(Some("tok-1".into())));
        assert_eq!(
            store.get("mcp/zeta/env/REGION"),
            Ok(Some("eu-west-1".into()))
        );

        // Typed over a kept value, it replaces it.
        f.save(
            &store,
            json!({
                "original": "zeta", "name": "zeta", "kind": "process", "command": "node",
                "values": [{ "name": "TOKEN", "value": TYPED }]
            }),
        )?;
        assert_eq!(store.get(ZETA_TOKEN), Ok(Some(TYPED.into())));
        assert_eq!(
            f.file()?["mcpServers"]["zeta"],
            json!({ "command": "node", "env": { "TOKEN": MARKER } })
        );
        // The sweep, not the save, removes what the file no longer names.
        let mut known = first.accounts;
        known.push("mcp/zeta/env/REGION".into());
        sweep(&f.data, &store, &known);
        assert_eq!(
            store.names(),
            vec![ALPHA_HEADER.to_owned(), ZETA_TOKEN.to_owned()]
        );
        Ok(())
    }

    #[test]
    fn a_value_not_swept_yet_stays_in_the_file_as_written_through_an_edit() -> Outcome {
        let f = Fixture::written()?;
        let store = MemoryStore::default();

        f.save(
            &store,
            json!({
                "original": "zeta", "name": "zeta", "kind": "process", "command": "npx",
                "values": [{ "name": "TOKEN" }, { "name": "EMPTY" }, { "name": "NEW" }]
            }),
        )?;

        assert_eq!(
            f.file()?["mcpServers"]["zeta"]["env"],
            json!({ "TOKEN": "tok-1", "EMPTY": "", "NEW": "" })
        );
        assert!(store.names().is_empty());
        Ok(())
    }

    #[test]
    fn a_renamed_server_keeps_its_place_and_its_values() -> Outcome {
        let f = Fixture::written()?;
        let store = MemoryStore::default();
        let first = sweep(&f.data, &store, &[]);
        let input: ServerInput = serde_json::from_value(json!({
            "original": "zeta", "name": "omega", "kind": "process", "command": "npx",
            "values": [{ "name": "TOKEN" }]
        }))
        .map_err(|e| e.to_string())?;

        let change = save(&f.data, &input)?;
        assert_eq!(change.accounts(), vec!["mcp/omega/env/TOKEN".to_owned()]);
        change.apply(&f.data, &store)?;

        let text = f.text()?;
        assert!(!text.contains("zeta") && text.find("omega") < text.find("alpha"));
        assert_eq!(
            f.file()?["mcpServers"]["omega"]["env"],
            json!({ "TOKEN": MARKER })
        );
        // Copied, not moved: the old account is the sweep's to remove, and it does.
        assert_eq!(store.get(ZETA_TOKEN), Ok(Some("tok-1".into())));
        let mut known = first.accounts;
        known.push("mcp/omega/env/TOKEN".into());
        let second = sweep(&f.data, &store, &known);
        assert_eq!(store.get(ZETA_TOKEN), Ok(None));
        assert!(second
            .secrets
            .contains(&("mcp/omega/env/TOKEN".to_owned(), "tok-1".to_owned())));
        Ok(())
    }

    #[test]
    fn a_removed_server_leaves_the_file_and_the_sweep_removes_its_values() -> Outcome {
        let f = Fixture::written()?;
        let store = MemoryStore::default();
        let first = sweep(&f.data, &store, &[]);

        remove(&f.data, "zeta")?.apply(&f.data, &store)?;

        let mut expected = written();
        expected["mcpServers"]
            .as_object_mut()
            .ok_or("no servers")?
            .remove("zeta");
        expected["mcpServers"]["alpha"]["headers"]["Authorization"] = json!(MARKER);
        assert_eq!(f.file()?, expected);
        assert_eq!(store.names().len(), 2);
        sweep(&f.data, &store, &first.accounts);
        assert_eq!(store.names(), vec![ALPHA_HEADER.to_owned()]);

        assert!(remove(&f.data, "zeta").is_err());
        Ok(())
    }

    #[test]
    fn what_the_daemon_would_refuse_is_refused_and_changes_nothing() -> Outcome {
        let with = |key: &str, value: Value| {
            let mut input = notes();
            input[key] = value;
            input
        };
        let http = |url: &str| {
            json!({
                "name": "remote", "kind": "http", "url": url,
                "values": [{ "name": "Authorization", "value": TYPED }]
            })
        };
        let refused = [
            with("name", json!("_notes")),
            with("name", json!("a/b")),
            with("name", json!("")),
            with("name", json!("n".repeat(41))),
            // Taken by another server, and an edit of one that is not there.
            with("name", json!("alpha")),
            with("original", json!("gone")),
            with("command", json!("")),
            with("readOnly", json!(["list", ""])),
            with("values", json!([{ "name": "", "value": TYPED }])),
            with(
                "values",
                json!([{ "name": "A", "value": TYPED }, { "name": "A", "value": "other" }]),
            ),
            http("http://example.com/mcp"),
            http("ftp://example.com/mcp"),
            http("example.com/mcp"),
            http(""),
        ];
        for input in refused {
            let f = Fixture::written()?;
            let before = f.text()?;
            let store = MemoryStore::default();

            let Err(error) = f.save(&store, input.clone()) else {
                return Err(format!("accepted: {input}"));
            };

            assert!(!error.contains(TYPED), "{error}");
            assert_eq!(f.text()?, before, "{input}");
            assert!(store.names().is_empty(), "{input}");
        }
        Ok(())
    }

    #[test]
    fn a_url_is_https_or_plain_http_to_this_machine() {
        for url in [
            "https://example.com/mcp",
            "http://127.0.0.1:8080/mcp",
            "http://localhost/mcp",
            "http://LOCALHOST:3000",
            "http://[::1]:9000/mcp",
        ] {
            assert!(reachable(url), "{url}");
        }
        for url in [
            "http://example.com/mcp",
            "http://127.0.0.2/mcp",
            "http://localhost.example.com/",
            "ws://localhost/mcp",
            "localhost:3000",
            "https://",
            "",
        ] {
            assert!(!reachable(url), "{url}");
        }
    }

    #[test]
    fn a_file_the_daemon_would_refuse_is_said_to_be_so_and_is_not_rewritten() -> Outcome {
        let edit = |change: fn(&mut Value)| {
            let mut file = written();
            change(&mut file);
            file.to_string()
        };
        let refused = [
            "{ \"mcpServers\": { \"zeta\": { \"env\": { \"TOKEN\": \"tok-1\" ".to_owned(),
            json!({ "servers": {} }).to_string(),
            json!({ "mcpServers": [] }).to_string(),
            edit(|file| file["version"] = json!(1)),
            // As other MCP clients write it, which the daemon's strict schema refuses.
            edit(|file| file["mcpServers"]["zeta"]["type"] = json!("stdio")),
            edit(|file| file["mcpServers"]["zeta"]["url"] = json!("https://example.com")),
            edit(|file| file["mcpServers"]["zeta"]["env"]["PORT"] = json!(8080)),
            edit(|file| file["mcpServers"]["alpha"]["url"] = json!("http://example.com")),
            edit(|file| file["mcpServers"]["a/b"] = json!({ "command": "x" })),
            edit(|file| file["mcpServers"]["off"] = json!("disabled for now")),
        ];
        for text in refused {
            let f = Fixture::new()?;
            f.write(&text)?;
            let store = MemoryStore::default();

            let shown = view(&f.data, &store);
            let said = shown.invalid.ok_or(format!("read: {text}"))?;
            assert!(shown.servers.is_empty(), "{text}");
            // Where it is wrong, never what it says.
            assert!(!said.contains("tok-1") && !said.contains("b-2"), "{said}");

            assert!(f.save(&store, notes()).is_err(), "{text}");
            assert!(remove(&f.data, "alpha").is_err(), "{text}");
            assert_eq!(f.text()?, text);
            assert!(store.names().is_empty(), "{text}");
        }
        Ok(())
    }

    #[test]
    fn a_file_that_is_a_link_is_left_as_it_is() -> Outcome {
        let f = Fixture::new()?;
        let target = f.data.root().join("elsewhere.json");
        std::fs::write(&target, written().to_string()).map_err(|e| e.to_string())?;
        std::os::unix::fs::symlink(&target, f.path()).map_err(|e| e.to_string())?;
        let store = MemoryStore::default();

        assert!(view(&f.data, &store).invalid.is_some());
        assert!(f.save(&store, notes()).is_err());

        let link = std::fs::symlink_metadata(f.path()).map_err(|e| e.to_string())?;
        assert!(link.file_type().is_symlink());
        assert_eq!(f.text()?, written().to_string());
        assert!(store.names().is_empty());
        Ok(())
    }

    #[test]
    fn a_file_saved_since_it_was_read_is_not_written_over() -> Outcome {
        let f = Fixture::written()?;
        let store = MemoryStore::default();
        let input: ServerInput = serde_json::from_value(notes()).map_err(|e| e.to_string())?;
        let change = save(&f.data, &input)?;
        let theirs = json!({ "mcpServers": {} }).to_string();
        f.write(&theirs)?;

        assert!(change.apply(&f.data, &store).is_err());

        assert_eq!(f.text()?, theirs);
        assert!(store.names().is_empty());
        Ok(())
    }

    #[test]
    fn a_value_the_store_refuses_leaves_the_file_as_it_was() -> Outcome {
        let f = Fixture::written()?;
        let before = f.text()?;

        let Err(error) = f.save(&MemoryStore::failing(), notes()) else {
            return Err("saved without its value".into());
        };

        assert!(!error.contains(TYPED), "{error}");
        assert_eq!(f.text()?, before);
        Ok(())
    }

    #[test]
    fn the_sweep_reads_a_file_the_screen_wrote_without_writing_it_again() -> Outcome {
        let f = Fixture::new()?;
        let store = MemoryStore::default();
        f.save(&store, notes())?;
        let saved = f.text()?;

        let swept = sweep(&f.data, &store, &[]);

        let account = "mcp/notes/env/API_KEY".to_owned();
        assert_eq!(swept.secrets, vec![(account.clone(), TYPED.to_owned())]);
        assert_eq!(swept.accounts, vec![account]);
        assert_eq!(f.text()?, saved);
        Ok(())
    }
}
