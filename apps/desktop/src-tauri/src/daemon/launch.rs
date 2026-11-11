// How the shell starts the daemon (DK-1 AC1): which `node`, which entry point, and the child's
// environment, which carries the secrets (DK-5 AC2) and this launch's token (DK-3 AC2).
use std::net::{Ipv4Addr, TcpListener};
use std::path::{Path, PathBuf};

/// The parent variables the daemon inherits; everything else starts cleared, so nothing from the
/// principal's shell (such as a stray `OPENAI_API_KEY` or `NODE_OPTIONS`) reaches it.
const INHERITED: [&str; 4] = ["PATH", "HOME", "TMPDIR", "LANG"];

/// Where macOS keeps the system clock's zone: a link into a `zoneinfo` folder.
const LOCALTIME: &str = "/etc/localtime";

/// The IANA zone a `zoneinfo` link points to, such as `Europe/Madrid`.
pub fn zone_of_link(target: &str) -> Option<String> {
    let (_, zone) = target.split_once("/zoneinfo/")?;
    is_time_zone(zone).then(|| zone.to_owned())
}

/// The zone of this machine's clock, for the daemon's `TZ`: its dates are the principal's.
pub fn system_time_zone() -> Option<String> {
    let target = std::fs::read_link(LOCALTIME).ok()?;
    zone_of_link(&target.to_string_lossy())
}

/// The shape of an IANA zone name. The daemon refuses to start with a `TZ` that is not one.
fn is_time_zone(zone: &str) -> bool {
    !zone.is_empty()
        && zone.len() <= 64
        && zone.split('/').all(|part| {
            !part.is_empty()
                && part
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '+'))
        })
}

/// A GUI app gets a minimal `PATH`; Homebrew's `node` lives in one of these.
const EXTRA_PATH: [&str; 2] = ["/opt/homebrew/bin", "/usr/local/bin"];
const DEFAULT_PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin";

/// v1 is built and run by the principal from this repository, so the entry point is found from the
/// crate at compile time; `ANOMANDER_DAEMON_ENTRY` overrides it at run time.
const BUILT_ENTRY: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../packages/daemon/src/main.ts"
);

/// Where the daemon keeps its data, inside the app's data folder (DK-8).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DaemonPaths {
    pub db: PathBuf,
    pub inbox: PathBuf,
    pub auth: PathBuf,
    /// The servers the principal connected (DK-11): `mcp.json`, which they write themselves.
    pub connections: PathBuf,
}

/// What one start of the daemon needs. Holds secrets: no `Debug`.
pub struct DaemonInputs<'a> {
    pub telegram_bot_token: &'a str,
    pub principal_chat_id: &'a str,
    pub model: Option<&'a str>,
    pub vision_model: Option<&'a str>,
    /// By provider variable, such as `OPENAI_API_KEY`.
    pub provider_keys: &'a [(String, String)],
    /// The values of `mcp.json` kept in the Keychain, by account (`connection_secrets`).
    pub connection_secrets: &'a [(String, String)],
    pub paths: &'a DaemonPaths,
    pub local_token: &'a str,
    pub local_port: u16,
}

/// The daemon's whole environment, for a child started from a cleared one.
pub fn child_env(
    parent: &dyn Fn(&str) -> Option<String>,
    inputs: &DaemonInputs,
) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = INHERITED
        .iter()
        .filter(|name| **name != "PATH")
        .filter_map(|name| parent(name).map(|value| ((*name).to_owned(), value)))
        .collect();
    env.push(("PATH".into(), search_path(parent("PATH").as_deref())));
    // Without it the daemon takes its default zone, whatever this machine's is.
    if let Some(zone) = parent("TZ").filter(|zone| is_time_zone(zone)) {
        env.push(("TZ".into(), zone));
    }
    let mut set = |name: &str, value: &str| env.push((name.to_owned(), value.to_owned()));
    set("TELEGRAM_BOT_TOKEN", inputs.telegram_bot_token);
    set("ANOMANDER_PRINCIPAL_CHAT_ID", inputs.principal_chat_id);
    // Unset, the daemon starts its setup guide (R-28).
    if let Some(model) = inputs.model {
        set("ANOMANDER_MODEL", model);
    }
    if let Some(model) = inputs.vision_model {
        set("ANOMANDER_VISION_MODEL", model);
    }
    for (name, key) in inputs.provider_keys {
        set(name, key);
    }
    set("ANOMANDER_DB_PATH", &inputs.paths.db.to_string_lossy());
    set("ANOMANDER_INBOX_DIR", &inputs.paths.inbox.to_string_lossy());
    set("ANOMANDER_AUTH_PATH", &inputs.paths.auth.to_string_lossy());
    // The daemon reads it only if it exists: without the file there are no connections.
    set(
        "ANOMANDER_MCP_CONFIG",
        &inputs.paths.connections.to_string_lossy(),
    );
    if !inputs.connection_secrets.is_empty() {
        let secrets: serde_json::Map<String, serde_json::Value> = inputs
            .connection_secrets
            .iter()
            .map(|(account, secret)| (account.clone(), secret.as_str().into()))
            .collect();
        set(
            "ANOMANDER_MCP_SECRETS",
            &serde_json::Value::Object(secrets).to_string(),
        );
    }
    set("ANOMANDER_LOCAL_TOKEN", inputs.local_token);
    set("ANOMANDER_LOCAL_PORT", &inputs.local_port.to_string());
    // DK-1 AC1: the daemon stops when its stdin closes, so a crashed app leaves no daemon.
    set("ANOMANDER_STOP_WITH_PARENT", "1");
    env
}

/// The parent's `PATH` with Homebrew's folders after it, each folder once.
pub fn search_path(parent: Option<&str>) -> String {
    let mut folders: Vec<&str> = Vec::new();
    let parent = parent
        .filter(|path| !path.is_empty())
        .unwrap_or(DEFAULT_PATH);
    for folder in parent.split(':').chain(EXTRA_PATH) {
        if !folder.is_empty() && !folders.contains(&folder) {
            folders.push(folder);
        }
    }
    folders.join(":")
}

/// `ANOMANDER_NODE` when set, else the first executable `node` on `path`.
pub fn find_node(override_path: Option<&str>, path: &str) -> Option<PathBuf> {
    if let Some(node) = override_path.filter(|node| !node.is_empty()) {
        return Some(PathBuf::from(node));
    }
    path.split(':')
        .filter(|folder| !folder.is_empty())
        .map(|folder| Path::new(folder).join("node"))
        .find(|node| is_executable(node))
}

/// `ANOMANDER_DAEMON_ENTRY` when set, else `packages/daemon/src/main.ts` of this repository.
pub fn daemon_entry(override_path: Option<&str>) -> PathBuf {
    match override_path.filter(|entry| !entry.is_empty()) {
        Some(entry) => PathBuf::from(entry),
        None => {
            let built = PathBuf::from(BUILT_ENTRY);
            built.canonicalize().unwrap_or(built)
        }
    }
}

/// DK-3 AC2: 32 random bytes from the operating system's CSPRNG, as hex; kept only in memory.
pub fn launch_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|error| format!("could not generate the local channel token: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// A port free on `127.0.0.1` right now; picked just before each start.
pub fn free_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    Ok(listener.local_addr()?.port())
}

fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::os::unix::fs::PermissionsExt;

    fn paths() -> DaemonPaths {
        DaemonPaths {
            db: "/data/anomander.db".into(),
            inbox: "/data/inbox".into(),
            auth: "/data/auth.json".into(),
            connections: "/data/mcp.json".into(),
        }
    }

    fn parent(name: &str) -> Option<String> {
        match name {
            "PATH" => Some("/usr/bin:/bin".into()),
            "HOME" => Some("/Users/p".into()),
            "TMPDIR" => Some("/tmp/x/".into()),
            "LANG" => Some("es_ES.UTF-8".into()),
            "OPENAI_API_KEY" => Some("from-the-shell".into()),
            "NODE_OPTIONS" => Some("--inspect".into()),
            _ => None,
        }
    }

    #[test]
    fn the_child_gets_its_configuration_secrets_and_token_and_nothing_else() {
        let keys = vec![("OPENAI_API_KEY".to_owned(), "sk-1".to_owned())];
        let paths = paths();
        let inputs = DaemonInputs {
            telegram_bot_token: "bot:1",
            principal_chat_id: "42",
            model: Some("openai/gpt-4o-mini"),
            vision_model: Some("openai/gpt-4o"),
            provider_keys: &keys,
            connection_secrets: &[],
            paths: &paths,
            local_token: "t".repeat(64).leak(),
            local_port: 50123,
        };
        let env: BTreeMap<_, _> = child_env(&parent, &inputs).into_iter().collect();
        let expected: BTreeMap<String, String> = [
            ("PATH", "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin"),
            ("HOME", "/Users/p"),
            ("TMPDIR", "/tmp/x/"),
            ("LANG", "es_ES.UTF-8"),
            ("TELEGRAM_BOT_TOKEN", "bot:1"),
            ("ANOMANDER_PRINCIPAL_CHAT_ID", "42"),
            ("ANOMANDER_MODEL", "openai/gpt-4o-mini"),
            ("ANOMANDER_VISION_MODEL", "openai/gpt-4o"),
            ("OPENAI_API_KEY", "sk-1"),
            ("ANOMANDER_DB_PATH", "/data/anomander.db"),
            ("ANOMANDER_INBOX_DIR", "/data/inbox"),
            ("ANOMANDER_AUTH_PATH", "/data/auth.json"),
            ("ANOMANDER_MCP_CONFIG", "/data/mcp.json"),
            ("ANOMANDER_LOCAL_TOKEN", &"t".repeat(64)),
            ("ANOMANDER_LOCAL_PORT", "50123"),
            ("ANOMANDER_STOP_WITH_PARENT", "1"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .collect();
        assert_eq!(env, expected);
    }

    #[test]
    fn an_unset_model_and_absent_parent_variables_are_left_out() {
        let paths = paths();
        let inputs = DaemonInputs {
            telegram_bot_token: "bot:1",
            principal_chat_id: "42",
            model: None,
            vision_model: None,
            provider_keys: &[],
            connection_secrets: &[],
            paths: &paths,
            local_token: "t",
            local_port: 1,
        };
        let env: BTreeMap<_, _> = child_env(&|_| None, &inputs).into_iter().collect();
        assert!(!env.contains_key("ANOMANDER_MCP_SECRETS"));
        assert!(!env.contains_key("ANOMANDER_MODEL"));
        assert!(!env.contains_key("ANOMANDER_VISION_MODEL"));
        assert!(!env.contains_key("HOME"));
        assert_eq!(
            env.get("PATH").map(String::as_str),
            Some("/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin")
        );
    }

    #[test]
    fn the_secrets_of_the_connections_travel_as_one_json_object_by_account() {
        let paths = paths();
        let secrets = vec![
            (
                "mcp/notes/env/TOKEN".to_owned(),
                "a \"quoted\" one".to_owned(),
            ),
            (
                "mcp/remote/headers/Authorization".to_owned(),
                "Bearer b".to_owned(),
            ),
        ];
        let inputs = DaemonInputs {
            telegram_bot_token: "bot:1",
            principal_chat_id: "42",
            model: None,
            vision_model: None,
            provider_keys: &[],
            connection_secrets: &secrets,
            paths: &paths,
            local_token: "t",
            local_port: 1,
        };
        let env: BTreeMap<_, _> = child_env(&|_| None, &inputs).into_iter().collect();
        let sent: BTreeMap<String, String> = env
            .get("ANOMANDER_MCP_SECRETS")
            .and_then(|json| serde_json::from_str(json).ok())
            .unwrap_or_default();
        assert_eq!(sent, secrets.into_iter().collect());
    }

    #[test]
    fn the_daemon_gets_the_time_zone_of_this_machine_when_it_is_one() {
        let paths = paths();
        let env_with = |zone: Option<&'static str>| -> BTreeMap<String, String> {
            let parent = move |name: &str| match name {
                "TZ" => zone.map(str::to_owned),
                _ => None,
            };
            let inputs = DaemonInputs {
                telegram_bot_token: "bot:1",
                principal_chat_id: "42",
                model: None,
                vision_model: None,
                provider_keys: &[],
                connection_secrets: &[],
                paths: &paths,
                local_token: "t",
                local_port: 1,
            };
            child_env(&parent, &inputs).into_iter().collect()
        };
        assert_eq!(
            env_with(Some("America/Argentina/Buenos_Aires"))
                .get("TZ")
                .map(String::as_str),
            Some("America/Argentina/Buenos_Aires")
        );
        // Anything else would stop the daemon at its start: it keeps its default.
        for zone in [
            None,
            Some(""),
            Some(":/etc/localtime"),
            Some("../x"),
            Some("Europe/Ma drid"),
        ] {
            assert!(!env_with(zone).contains_key("TZ"), "{zone:?}");
        }
    }

    #[test]
    fn the_zone_is_read_from_where_the_system_clock_points() {
        assert_eq!(
            zone_of_link("/var/db/timezone/zoneinfo/Europe/Madrid").as_deref(),
            Some("Europe/Madrid")
        );
        assert_eq!(
            zone_of_link("/usr/share/zoneinfo/America/Argentina/Buenos_Aires").as_deref(),
            Some("America/Argentina/Buenos_Aires")
        );
        assert_eq!(zone_of_link("/etc/somewhere/else"), None);
        assert_eq!(zone_of_link("/usr/share/zoneinfo/"), None);
    }

    #[test]
    fn homebrew_folders_already_on_path_are_not_repeated() {
        assert_eq!(
            search_path(Some("/opt/homebrew/bin:/usr/bin::")),
            "/opt/homebrew/bin:/usr/bin:/usr/local/bin"
        );
    }

    #[test]
    fn node_is_found_on_the_path_and_must_be_executable() -> std::io::Result<()> {
        let dir = tempfile::tempdir()?;
        let plain = dir.path().join("plain");
        let bin = dir.path().join("bin");
        std::fs::create_dir_all(&plain)?;
        std::fs::create_dir_all(&bin)?;
        std::fs::write(plain.join("node"), "")?;
        std::fs::write(bin.join("node"), "")?;
        std::fs::set_permissions(bin.join("node"), std::fs::Permissions::from_mode(0o755))?;
        let path = format!("{}:{}", plain.display(), bin.display());
        assert_eq!(find_node(None, &path), Some(bin.join("node")));
        assert_eq!(find_node(None, &plain.display().to_string()), None);
        Ok(())
    }

    #[test]
    fn anomander_node_overrides_the_search() {
        assert_eq!(
            find_node(Some("/custom/node"), "/usr/bin"),
            Some(PathBuf::from("/custom/node"))
        );
        // An empty override counts as unset.
        assert_eq!(find_node(Some(""), ""), None);
    }

    #[test]
    fn the_entry_is_this_repositorys_daemon_unless_overridden() {
        assert!(daemon_entry(None).ends_with("packages/daemon/src/main.ts"));
        assert!(daemon_entry(None).is_file());
        assert_eq!(
            daemon_entry(Some("/x/main.ts")),
            PathBuf::from("/x/main.ts")
        );
        assert!(daemon_entry(Some("")).ends_with("packages/daemon/src/main.ts"));
    }

    #[test]
    fn each_token_is_64_hex_characters_and_new() -> Result<(), String> {
        let first = launch_token()?;
        let second = launch_token()?;
        assert_eq!(first.len(), 64);
        assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(first, second);
        Ok(())
    }

    #[test]
    fn a_free_port_is_not_zero() -> std::io::Result<()> {
        assert_ne!(free_port()?, 0);
        Ok(())
    }
}
