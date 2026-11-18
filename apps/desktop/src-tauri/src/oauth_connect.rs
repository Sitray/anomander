// DK-11 OAuth: connecting the app to an MCP server reached over HTTP that asks for OAuth. The work
// is the daemon package's (`packages/daemon/scripts/mcp-oauth.ts`), so the MCP SDK stays in Node;
// the shell runs it, opens the authorization address it prints in the browser, and keeps the
// client and tokens it prints in the Keychain item `ITEM`, by server name, with the server's
// address: tokens are only ever handed over for the address they were given for.
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{Map, Value};

use crate::secure_store::SecretStore;

/// The script, from the daemon package's folder.
const SCRIPT: &str = "scripts/mcp-oauth.ts";
/// The Keychain item: one JSON object by server name. Not under `mcp/`, so the sweep of
/// `connection_secrets` never removes it.
pub const ITEM: &str = "mcp-oauth";
/// The field of an entry that holds the server's address; the daemon keeps it as it is.
const URL: &str = "url";
/// Longer than the script's own 5 minutes: it ends first, unless it hangs.
pub const DEADLINE: Duration = Duration::from_secs(6 * 60);

const OPEN_LINE: &str = "anomander oauth-open ";
const DONE_LINE: &str = "anomander oauth-done ";
/// Every word the script may end with.
const OUTCOMES: [&str; 3] = ["connected", "denied", "timed_out"];

/// The servers connected with OAuth, by name. Holds tokens: never logged.
pub type OAuthSet = Map<String, Value>;

/// What the window is told: a word of `OUTCOMES`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthConnect {
    pub outcome: String,
}

/// What one run left: its word, and the client and tokens when it connected. Holds tokens: no
/// `Debug`.
pub struct Ran {
    pub outcome: OAuthConnect,
    pub entry: Option<Map<String, Value>>,
}

/// The script next to the daemon's entry point: `<daemon>/src/main.ts` gives
/// `<daemon>/scripts/mcp-oauth.ts`.
pub fn script_of(entry: &Path) -> Option<PathBuf> {
    Some(entry.parent()?.parent()?.join(SCRIPT))
}

/// Whether the shell opens `address` in the browser: an `https` address, or an `http` one on this
/// machine, with no user name and nothing a terminal or `open` could read another way.
pub fn openable(address: &str) -> bool {
    if address.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return false;
    }
    let (rest, secure) = match (
        address.strip_prefix("https://"),
        address.strip_prefix("http://"),
    ) {
        (Some(rest), _) => (rest, true),
        (None, Some(rest)) => (rest, false),
        _ => return false,
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() || authority.contains('@') {
        return false;
    }
    if secure {
        return true;
    }
    let host = match authority.strip_prefix('[') {
        Some(bracketed) => bracketed.split(']').next().map(|host| format!("[{host}]")),
        None => authority.split(':').next().map(str::to_owned),
    };
    matches!(host.as_deref(), Some("127.0.0.1" | "localhost" | "[::1]"))
}

/// Opens `address` in the principal's browser, by the system's own `open`.
pub fn open_in_browser(address: &str) -> Result<(), String> {
    let status = Command::new("/usr/bin/open")
        .arg(address)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| format!("could not open the browser: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("could not open the browser ({status})"))
    }
}

/// Runs the script for `url` with `node`, has `open` open the address it prints, and reads the
/// tokens and the word it printed. A run longer than `deadline` is ended.
pub fn run(
    node: &Path,
    script: &Path,
    url: &str,
    path: &str,
    open: &dyn Fn(&str) -> Result<(), String>,
    deadline: Duration,
) -> Result<Ran, String> {
    let mut child = Command::new(node)
        .arg(script)
        .arg(url)
        // Nothing of the app's environment: the script needs none of its secrets.
        .env_clear()
        .env("PATH", path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("could not start {}: {error}", node.display()))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let child = Arc::new(Mutex::new(child));
    let done = Arc::new(Mutex::new(false));

    // Ends a script that hangs, which also ends the reading below.
    let watchdog = {
        let (child, done) = (Arc::clone(&child), Arc::clone(&done));
        std::thread::spawn(move || {
            let started = Instant::now();
            while started.elapsed() < deadline {
                if done.lock().map(|done| *done).unwrap_or(true) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            if let Ok(mut child) = child.lock() {
                let _ = child.kill();
            }
        })
    };
    let end = |child: &Arc<Mutex<Child>>| {
        if let Ok(mut child) = child.lock() {
            let _ = child.kill();
        }
    };

    let mut entry = None;
    let mut last = String::new();
    let mut refused: Option<String> = None;
    if let Some(stdout) = stdout {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if let Some(address) = line.strip_prefix(OPEN_LINE) {
                // The address comes from the server: only a web page is opened.
                let opened = if openable(address) {
                    open(address)
                } else {
                    Err("the server gave an authorization address that is not https".into())
                };
                if let Err(error) = opened {
                    refused = Some(error);
                    end(&child);
                    break;
                }
            } else if let Some(json) = line.strip_prefix(DONE_LINE) {
                match serde_json::from_str(json) {
                    Ok(Value::Object(found)) => entry = Some(found),
                    _ => {
                        refused = Some("the connection gave no tokens".into());
                        end(&child);
                        break;
                    }
                }
            } else {
                last = line;
            }
        }
    }
    let said = stderr.map(read_all).unwrap_or_default();
    let status = child.lock().map_err(|_| "poisoned".to_string())?.wait();
    if let Ok(mut done) = done.lock() {
        *done = true;
    }
    let _ = watchdog.join();
    if let Some(refused) = refused {
        return Err(refused);
    }
    let status = status.map_err(|error| format!("could not wait for the connection: {error}"))?;
    let word = last.trim();
    if status.success() && OUTCOMES.contains(&word) {
        if word == "connected" && entry.is_none() {
            return Err("the connection gave no tokens".into());
        }
        return Ok(Ran {
            outcome: OAuthConnect {
                outcome: word.to_owned(),
            },
            entry: if word == "connected" { entry } else { None },
        });
    }
    // Its error output holds only an error code, never an address or a token.
    let reason = said.lines().rev().find(|line| !line.trim().is_empty());
    Err(match reason {
        Some(reason) => reason.trim().to_string(),
        None => format!("the connection ended without an answer ({status})"),
    })
}

fn read_all(mut reader: impl Read) -> String {
    let mut bytes = Vec::new();
    let _ = reader.read_to_end(&mut bytes);
    String::from_utf8_lossy(&bytes).into_owned()
}

/// What `store` keeps; nothing, or what is not a JSON object, is an empty set.
pub fn stored(store: &dyn SecretStore) -> Result<OAuthSet, String> {
    Ok(match store.get(ITEM).map_err(|error| error.to_string())? {
        Some(text) => match serde_json::from_str(&text) {
            Ok(Value::Object(set)) => set,
            _ => {
                eprintln!("the stored OAuth tokens are not a JSON object: they are not used");
                OAuthSet::new()
            }
        },
        None => OAuthSet::new(),
    })
}

/// Stores `set` whole.
pub fn store_set(store: &dyn SecretStore, set: &OAuthSet) -> Result<(), String> {
    store
        .set(ITEM, &Value::Object(set.clone()).to_string())
        .map_err(|error| error.to_string())
}

/// Whether `set` holds tokens of `server` given for `url`.
pub fn connected(set: &OAuthSet, server: &str, url: &str) -> bool {
    set.get(server)
        .and_then(|entry| entry.get(URL))
        .and_then(Value::as_str)
        == Some(url)
}

/// `entry` as kept for `url`.
pub fn kept_for(mut entry: Map<String, Value>, url: &str) -> Value {
    entry.insert(URL.into(), url.into());
    Value::Object(entry)
}

/// The entries of `set` whose server is in `servers` (name and address) with the address they
/// were given for: a server removed, renamed or moved to another address loses its tokens.
pub fn pruned(set: &OAuthSet, servers: &[(String, String)]) -> OAuthSet {
    set.iter()
        .filter(|(name, _)| {
            servers
                .iter()
                .any(|(server, url)| server == *name && connected(set, name, url))
        })
        .map(|(name, entry)| (name.clone(), entry.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::launch::{daemon_entry, find_node, search_path};
    use crate::secure_store::MemoryStore;
    use serde_json::json;
    use std::os::unix::fs::PermissionsExt;

    /// A fake `node` that runs `body` with `/bin/sh`.
    fn fake_node(dir: &Path, body: &str) -> PathBuf {
        let node = dir.join("node");
        std::fs::write(&node, format!("#!/bin/sh\n{body}\n"))
            .unwrap_or_else(|e| panic!("no fake node: {e}"));
        std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755))
            .unwrap_or_else(|e| panic!("no fake node: {e}"));
        node
    }

    fn run_fake(body: &str, opened: &Mutex<Vec<String>>) -> Result<Ran, String> {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("no temp dir: {e}"));
        let node = fake_node(dir.path(), body);
        let open = |address: &str| {
            if let Ok(mut opened) = opened.lock() {
                opened.push(address.to_owned());
            }
            Ok(())
        };
        run(
            &node,
            Path::new("/x/mcp-oauth.ts"),
            "https://notes.example/mcp",
            "/usr/bin:/bin",
            &open,
            Duration::from_secs(5),
        )
    }

    #[test]
    fn it_opens_the_address_and_keeps_the_tokens_of_a_connection() -> Result<(), String> {
        let opened = Mutex::new(Vec::new());
        let ran = run_fake(
            r#"echo 'anomander oauth-open https://auth.example/authorize?state=s'
echo 'anomander oauth-done {"client":{"client_id":"c"},"tokens":{"access_token":"a-secret"}}'
echo connected"#,
            &opened,
        )?;
        assert_eq!(ran.outcome.outcome, "connected");
        assert_eq!(
            ran.entry.map(Value::Object),
            Some(json!({"client":{"client_id":"c"},"tokens":{"access_token":"a-secret"}}))
        );
        assert_eq!(
            opened.lock().map(|o| o.clone()).unwrap_or_default(),
            vec!["https://auth.example/authorize?state=s".to_owned()]
        );
        Ok(())
    }

    #[test]
    fn a_refusal_or_a_late_principal_keeps_no_tokens() -> Result<(), String> {
        let opened = Mutex::new(Vec::new());
        for word in ["denied", "timed_out"] {
            let ran = run_fake(&format!("echo {word}"), &opened)?;
            assert_eq!(ran.outcome.outcome, word);
            assert!(ran.entry.is_none());
        }
        Ok(())
    }

    #[test]
    fn an_address_that_is_not_a_web_page_is_never_opened_and_ends_the_run() {
        let opened = Mutex::new(Vec::new());
        let ran = run_fake(
            "echo 'anomander oauth-open file:///etc/passwd'\nsleep 3\necho connected",
            &opened,
        );
        assert!(ran.is_err());
        assert!(opened.lock().map(|o| o.is_empty()).unwrap_or(false));
    }

    #[test]
    fn an_error_says_what_the_script_said_and_an_unknown_end_is_an_error() {
        let opened = Mutex::new(Vec::new());
        assert_eq!(
            run_fake(
                "echo 'could not connect with OAuth: ECONNREFUSED' >&2\nexit 1",
                &opened
            )
            .err(),
            Some("could not connect with OAuth: ECONNREFUSED".into())
        );
        assert!(run_fake("echo deleted_everything", &opened).is_err());
        // Connected, but no tokens printed.
        assert!(run_fake("echo connected", &opened).is_err());
        assert!(run_fake("echo 'anomander oauth-done [1]'\necho connected", &opened).is_err());
    }

    #[test]
    fn a_run_that_hangs_is_ended() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("no temp dir: {e}"));
        let node = fake_node(dir.path(), "exec sleep 30");
        let started = Instant::now();
        let ran = run(
            &node,
            Path::new("/x/mcp-oauth.ts"),
            "https://notes.example/mcp",
            "/usr/bin:/bin",
            &|_| Ok(()),
            Duration::from_millis(300),
        );
        assert!(ran.is_err());
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn only_a_web_page_is_opened() {
        for good in [
            "https://auth.example/authorize?x=1",
            "https://auth.example:8443/a",
            "http://127.0.0.1:8080/authorize",
            "http://localhost/authorize",
            "http://[::1]:9/a",
        ] {
            assert!(openable(good), "{good}");
        }
        for bad in [
            "file:///etc/passwd",
            "http://auth.example/authorize",
            "http://127.0.0.1@evil.example/",
            "https://user@auth.example/",
            "https://",
            "javascript:alert(1)",
            "-a Terminal",
            "https://auth.example/a b",
            "https://auth.example/\n",
            "http://localhost.evil.example/",
            "http://127.0.0.1.evil.example/",
        ] {
            assert!(!openable(bad), "{bad}");
        }
    }

    #[test]
    fn tokens_are_kept_by_server_and_address_and_lost_when_either_changes() -> Result<(), String> {
        let store = MemoryStore::default();
        assert!(stored(&store)?.is_empty());
        let mut set = stored(&store)?;
        set.insert(
            "notes".into(),
            kept_for(
                json!({"tokens":{"access_token":"a"}})
                    .as_object()
                    .cloned()
                    .unwrap_or_default(),
                "https://notes.example/mcp",
            ),
        );
        set.insert(
            "old".into(),
            kept_for(Map::new(), "https://old.example/mcp"),
        );
        store_set(&store, &set)?;
        let set = stored(&store)?;
        assert!(connected(&set, "notes", "https://notes.example/mcp"));
        assert!(!connected(&set, "notes", "https://other.example/mcp"));
        assert!(!connected(&set, "missing", "https://notes.example/mcp"));

        let servers = vec![
            ("notes".to_owned(), "https://notes.example/mcp".to_owned()),
            ("old".to_owned(), "https://moved.example/mcp".to_owned()),
        ];
        let kept = pruned(&set, &servers);
        assert_eq!(kept.keys().collect::<Vec<_>>(), vec!["notes"]);
        Ok(())
    }

    #[test]
    fn what_is_stored_and_not_an_object_is_an_empty_set() -> Result<(), String> {
        let store = MemoryStore::default();
        let _ = store.set(ITEM, "[1]");
        assert!(stored(&store)?.is_empty());
        Ok(())
    }

    #[test]
    fn the_script_sits_next_to_the_daemons_entry_point() {
        let script = script_of(&daemon_entry(None))
            .unwrap_or_else(|| panic!("the entry point has no package folder"));
        assert!(script.ends_with("packages/daemon/scripts/mcp-oauth.ts"));
        assert!(script.is_file());
    }

    #[test]
    fn the_real_script_says_only_why_it_failed() {
        let path = search_path(std::env::var("PATH").ok().as_deref());
        let node = find_node(None, &path).unwrap_or_else(|| panic!("node is needed: {path}"));
        let script = script_of(&daemon_entry(None))
            .unwrap_or_else(|| panic!("the entry point has no package folder"));
        let ran = run(
            &node,
            &script,
            "http://127.0.0.1:9/mcp",
            &path,
            &|_| Err("nothing may be opened".into()),
            DEADLINE,
        );
        let said = ran.err().unwrap_or_default();
        assert!(said.starts_with("could not connect with OAuth: "), "{said}");
        assert!(!said.contains("127.0.0.1"));
    }
}
