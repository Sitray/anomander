// DK-11: `mcp.json` read as the daemon reads it (`packages/daemon/src/connections/config.ts`):
// strict, whole or not at all, and where it is wrong when it is.
use serde_json::{json, Value};

use super::{Target, SERVERS};
use crate::connection_secrets::{is_server_name, FILE_NAME};
use crate::data_dir::DataDir;

/// Where plain HTTP may go: this machine only, as the daemon's `LOOPBACK`.
const LOOPBACK: [&str; 3] = ["127.0.0.1", "localhost", "[::1]"];
/// A server as the file holds it.
pub(super) struct Server {
    pub(super) target: Target,
    /// By name: the value as written, or `MARKER`.
    pub(super) values: Vec<(String, String)>,
    pub(super) read_only: Vec<String>,
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
pub(super) fn server_of(entry: &Value) -> Result<Server, String> {
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
pub(super) struct Document {
    /// `None` when there is no file yet.
    pub(super) bytes: Option<Vec<u8>>,
    pub(super) file: Value,
    pub(super) servers: Vec<(String, Server)>,
}

/// Reads the file, whole or not at all: a file the daemon would refuse is not the screen's to
/// rewrite, and neither is a link, which a write would replace (as the sweep leaves it).
pub(super) fn read(data: &DataDir) -> Result<Document, String> {
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
#[cfg(test)]
mod tests {
    use super::*;
    use crate::connections::test_support::*;

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

    // Making a symbolic link on Windows needs a privilege the test runner may lack.
    #[cfg(unix)]
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
}
