// How the shell starts the daemon (DK-1 AC1): which `node`, which entry point, the child's
// environment, and the line on its stdin that carries the secrets (DK-5 AC2) and this launch's
// token (DK-3 AC2). Secrets never go in the environment: `ps eww` shows it to the principal's
// other processes.
use std::net::{Ipv4Addr, TcpListener};
use std::path::{Path, PathBuf};

/// The parent variables the daemon inherits; everything else starts cleared, so nothing from the
/// principal's shell (such as a stray `OPENAI_API_KEY` or `NODE_OPTIONS`) reaches it.
const INHERITED: [&str; 4] = ["PATH", "HOME", "TMPDIR", "LANG"];

/// What Windows itself needs in a child's environment: without `SystemRoot`, for one, Node cannot
/// open a socket. None elsewhere.
#[cfg(windows)]
const SYSTEM: &[&str] = &[
    "SystemRoot",
    "SystemDrive",
    "windir",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "PATHEXT",
    "ComSpec",
];
#[cfg(not(windows))]
const SYSTEM: &[&str] = &[];

/// The system's own variables of `parent` (`SYSTEM`), for a child started from a cleared
/// environment; empty outside Windows.
pub fn system_env(parent: &dyn Fn(&str) -> Option<String>) -> Vec<(String, String)> {
    SYSTEM
        .iter()
        .filter_map(|name| parent(name).map(|value| ((*name).to_owned(), value)))
        .collect()
}

/// Where macOS keeps the system clock's zone: a link into a `zoneinfo` folder.
#[cfg(unix)]
const LOCALTIME: &str = "/etc/localtime";

/// The IANA zone a `zoneinfo` link points to, such as `Europe/Madrid`.
pub fn zone_of_link(target: &str) -> Option<String> {
    let (_, zone) = target.split_once("/zoneinfo/")?;
    is_time_zone(zone).then(|| zone.to_owned())
}

/// The zone of this machine's clock, for the daemon's `TZ`: its dates are the principal's.
#[cfg(unix)]
pub fn system_time_zone() -> Option<String> {
    let target = std::fs::read_link(LOCALTIME).ok()?;
    zone_of_link(&target.to_string_lossy())
}

/// The zone of this machine's clock, for the daemon's `TZ`, as Windows maps it to an IANA name.
#[cfg(windows)]
pub fn system_time_zone() -> Option<String> {
    iana_time_zone::get_timezone()
        .ok()
        .filter(|zone| is_time_zone(zone))
}

/// The shape of an IANA zone name. The daemon refuses to start with a `TZ` that is not one.
pub fn is_time_zone(zone: &str) -> bool {
    !zone.is_empty()
        && zone.len() <= 64
        && zone.split('/').all(|part| {
            !part.is_empty()
                && part
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '+'))
        })
}

/// A GUI app gets a minimal `PATH` on macOS; Homebrew's `node` lives in one of these. On Windows
/// an app gets the principal's whole `PATH`, Node's installer folder included.
#[cfg(unix)]
const EXTRA_PATH: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin"];
#[cfg(unix)]
const DEFAULT_PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin";
#[cfg(windows)]
const EXTRA_PATH: &[&str] = &[];
#[cfg(windows)]
const DEFAULT_PATH: &str = r"C:\Windows\system32;C:\Windows";

/// The name of Node's executable.
const NODE: &str = if cfg!(windows) { "node.exe" } else { "node" };

/// A build run from this repository (`tauri dev`, `cargo test`, a debug build) finds the entry
/// point from the crate at compile time; a release app carries its own (`Bundled`), and
/// `ANOMANDER_DAEMON_ENTRY` overrides both at run time.
const BUILT_ENTRY: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../packages/daemon/src/main.ts"
);

/// The folder of the app's resources that holds the daemon a release app carries, as
/// `scripts/stage-daemon.mjs` lays it out and `tauri.release.conf.json` ships it.
const BUNDLED_DIR: &str = "daemon";

/// What a release app says when the daemon it carries lacks its Node or its entry point. It names
/// no path: the one compiled in is the builder's checkout, never on the principal's machine.
pub const INCOMPLETE: &str = "the app's bundled daemon is incomplete; reinstall ANOMANDER";

/// B11: the daemon a release app carries in its resources: its own Node in `bin/`, and the
/// daemon's tree laid out as in this repository, its production dependencies included.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Bundled {
    root: PathBuf,
}

impl Bundled {
    /// The daemon in `resources`, when its folder is there, whole or not (`runtime` refuses one
    /// that is not); a build run from this repository carries none.
    pub fn find(resources: &Path) -> Option<Self> {
        let root = resources.join(BUNDLED_DIR);
        root.is_dir().then_some(Self { root })
    }

    /// The folder of its Node, last on the daemon's `PATH`.
    pub fn bin(&self) -> PathBuf {
        self.root.join("bin")
    }

    pub fn node(&self) -> PathBuf {
        self.bin().join(NODE)
    }

    pub fn entry(&self) -> PathBuf {
        ["packages", "daemon", "src", "main.ts"]
            .iter()
            .fold(self.root.clone(), |path, part| path.join(part))
    }
}

/// Which Node runs the daemon and its scripts, from which entry point, and the `PATH` they get.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DaemonRuntime {
    pub node: PathBuf,
    pub entry: PathBuf,
    pub path: String,
}

/// `ANOMANDER_NODE` and `ANOMANDER_DAEMON_ENTRY` of `parent` when set; else what the app carries
/// (`bundled`), its Node's folder last on `PATH`, and `INCOMPLETE` when it lacks either; else, in
/// a build run from this repository, its daemon and the first `node` on `PATH`.
pub fn runtime(
    parent: &dyn Fn(&str) -> Option<String>,
    bundled: Option<&Bundled>,
) -> Result<DaemonRuntime, String> {
    let searched = search_path(parent("PATH").as_deref());
    let node_override = parent("ANOMANDER_NODE").filter(|node| !node.is_empty());
    let entry_override = parent("ANOMANDER_DAEMON_ENTRY").filter(|entry| !entry.is_empty());
    let Some(bundled) = bundled else {
        let node = find_node(node_override.as_deref(), &searched).ok_or_else(|| {
            format!("node was not found on {searched}; set ANOMANDER_NODE to its path")
        })?;
        let entry = daemon_entry(entry_override.as_deref());
        return Ok(DaemonRuntime {
            node,
            entry,
            path: searched,
        });
    };
    // A release app never falls back to the checkout it was built from: it is not on this machine.
    let node = match node_override {
        Some(node) => PathBuf::from(node),
        None if is_executable(&bundled.node()) => bundled.node(),
        None => return Err(INCOMPLETE.to_owned()),
    };
    let entry = match entry_override {
        Some(entry) => PathBuf::from(entry),
        None if bundled.entry().is_file() => bundled.entry(),
        None => return Err(INCOMPLETE.to_owned()),
    };
    // Last: a server the principal added that runs `node` or `npx` gets their own Node.
    let path = last_on_path(&bundled.bin(), &searched);
    Ok(DaemonRuntime { node, entry, path })
}

/// `path` with `folder` last, and only there.
fn last_on_path(folder: &Path, path: &str) -> String {
    let rest = std::env::split_paths(path).filter(|other| other != folder);
    std::env::join_paths(rest.chain(std::iter::once(folder.to_path_buf())))
        .map(|joined| joined.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_owned())
}

/// Where the daemon keeps its data, inside the app's data folder (DK-8).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DaemonPaths {
    pub db: PathBuf,
    pub inbox: PathBuf,
    pub auth: PathBuf,
    /// The servers the principal connected (DK-11): `mcp.json`, which they write themselves.
    pub connections: PathBuf,
}

/// Telegram's front door: the bot token and the principal's chat ID, both or neither. Holds a
/// secret: no `Debug`.
pub struct TelegramInputs<'a> {
    pub bot_token: &'a str,
    pub principal_chat_id: &'a str,
}

/// What one start of the daemon needs. Holds secrets: no `Debug`.
pub struct DaemonInputs<'a> {
    /// `None` starts the daemon without Telegram: the local channel is its only front door.
    pub telegram: Option<TelegramInputs<'a>>,
    pub model: Option<&'a str>,
    pub vision_model: Option<&'a str>,
    /// By provider variable, such as `OPENAI_API_KEY`.
    pub provider_keys: &'a [(String, String)],
    /// The values of `mcp.json` kept in the Keychain, by account (`connection_secrets`).
    pub connection_secrets: &'a [(String, String)],
    /// DK-5 AC1: the model login kept in the Keychain, as a JSON object; `{}` without one.
    pub model_login: &'a str,
    /// DK-11: the OAuth tokens of the servers connected with OAuth, as a JSON object; `{}` without.
    pub mcp_oauth: &'a str,
    pub paths: &'a DaemonPaths,
    pub local_token: &'a str,
    pub local_port: u16,
    /// DK-25: the zone chosen in Configuración, over this machine's.
    pub time_zone: Option<&'a str>,
    /// DK-25: the currency chosen in Configuración; unset, the daemon's default.
    pub currency: Option<&'a str>,
}

/// The `ANOMANDER_LOCALE` of `parent` (the system's language, as the shell read it), for a child
/// that speaks to the principal; only `es` or `en`.
pub fn handed_locale(parent: &dyn Fn(&str) -> Option<String>) -> Option<String> {
    parent("ANOMANDER_LOCALE").filter(|locale| matches!(locale.as_str(), "es" | "en"))
}

/// The daemon's whole environment, for a child started from a cleared one. It holds no secret:
/// those travel on the handover line (`handover_line`).
pub fn child_env(
    parent: &dyn Fn(&str) -> Option<String>,
    inputs: &DaemonInputs,
) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = INHERITED
        .iter()
        .filter(|name| **name != "PATH")
        .filter_map(|name| parent(name).map(|value| ((*name).to_owned(), value)))
        .collect();
    env.extend(system_env(parent));
    env.push(("PATH".into(), search_path(parent("PATH").as_deref())));
    // DK-25: the zone chosen in Configuración, else this machine's. Without either the daemon
    // takes its default zone, whatever this machine's is.
    let zone = inputs
        .time_zone
        .filter(|zone| is_time_zone(zone))
        .map(str::to_owned)
        .or_else(|| parent("TZ").filter(|zone| is_time_zone(zone)));
    if let Some(zone) = zone {
        env.push(("TZ".into(), zone));
    }
    // DK-25: without it the daemon writes new expenses in euros.
    if let Some(currency) = inputs.currency {
        env.push(("ANOMANDER_CURRENCY".into(), currency.to_owned()));
    }
    // The system's language, as the shell read it; without it the daemon speaks Spanish.
    if let Some(locale) = handed_locale(parent) {
        env.push(("ANOMANDER_LOCALE".into(), locale));
    }
    let mut set = |name: &str, value: &str| env.push((name.to_owned(), value.to_owned()));
    if let Some(telegram) = &inputs.telegram {
        set("ANOMANDER_PRINCIPAL_CHAT_ID", telegram.principal_chat_id);
    }
    // Unset, the daemon starts its setup guide (R-28).
    if let Some(model) = inputs.model {
        set("ANOMANDER_MODEL", model);
    }
    if let Some(model) = inputs.vision_model {
        set("ANOMANDER_VISION_MODEL", model);
    }
    set("ANOMANDER_DB_PATH", &inputs.paths.db.to_string_lossy());
    set("ANOMANDER_INBOX_DIR", &inputs.paths.inbox.to_string_lossy());
    set("ANOMANDER_AUTH_PATH", &inputs.paths.auth.to_string_lossy());
    // The daemon reads it only if it exists: without the file there are no connections.
    set(
        "ANOMANDER_MCP_CONFIG",
        &inputs.paths.connections.to_string_lossy(),
    );
    set("ANOMANDER_LOCAL_PORT", &inputs.local_port.to_string());
    // DK-1 AC1: the daemon stops when its stdin closes, so a crashed app leaves no daemon.
    set("ANOMANDER_STOP_WITH_PARENT", "1");
    // DK-5 AC2: the daemon reads the secrets from the first line of its stdin.
    set("ANOMANDER_SECRETS_ON_STDIN", "1");
    env
}

/// DK-5 AC2: the secrets, by the variable the daemon would read them from, as one JSON object on
/// one line (JSON escapes every line break inside a value). The supervisor writes it, then `\n`,
/// to the daemon's stdin. Holds secrets: never log it.
pub fn handover_line(inputs: &DaemonInputs) -> String {
    let mut handed = serde_json::Map::new();
    let mut set = |name: &str, value: &str| {
        handed.insert(name.to_owned(), value.into());
    };
    if let Some(telegram) = &inputs.telegram {
        set("TELEGRAM_BOT_TOKEN", telegram.bot_token);
    }
    for (name, key) in inputs.provider_keys {
        set(name, key);
    }
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
    // With it the daemon keeps the login in memory and never writes `auth.json` (DK-5 AC1).
    set("ANOMANDER_AUTH_JSON", inputs.model_login);
    set("ANOMANDER_MCP_OAUTH", inputs.mcp_oauth);
    set("ANOMANDER_LOCAL_TOKEN", inputs.local_token);
    serde_json::Value::Object(handed).to_string()
}

/// The parent's `PATH` with Homebrew's folders after it, each folder once.
pub fn search_path(parent: Option<&str>) -> String {
    let mut folders: Vec<PathBuf> = Vec::new();
    let parent = parent
        .filter(|path| !path.is_empty())
        .unwrap_or(DEFAULT_PATH);
    let extra = EXTRA_PATH.iter().map(PathBuf::from);
    for folder in std::env::split_paths(parent).chain(extra) {
        if !folder.as_os_str().is_empty() && !folders.contains(&folder) {
            folders.push(folder);
        }
    }
    // Only a folder holding the separator cannot be joined, and splitting removed every one.
    std::env::join_paths(folders)
        .map(|joined| joined.to_string_lossy().into_owned())
        .unwrap_or_else(|_| parent.to_owned())
}

/// `ANOMANDER_NODE` when set, else the first executable `node` on `path`.
pub fn find_node(override_path: Option<&str>, path: &str) -> Option<PathBuf> {
    if let Some(node) = override_path.filter(|node| !node.is_empty()) {
        return Some(PathBuf::from(node));
    }
    std::env::split_paths(path)
        .filter(|folder| !folder.as_os_str().is_empty())
        .map(|folder| folder.join(NODE))
        .find(|node| is_executable(node))
}

/// `ANOMANDER_DAEMON_ENTRY` when set, else `packages/daemon/src/main.ts` of this repository.
pub fn daemon_entry(override_path: Option<&str>) -> PathBuf {
    match override_path.filter(|entry| !entry.is_empty()) {
        Some(entry) => PathBuf::from(entry),
        None => {
            let built = PathBuf::from(BUILT_ENTRY);
            // On Windows `canonicalize` gives a verbatim `\\?\` path; Node is handed a plain one.
            #[cfg(windows)]
            let resolved = std::path::absolute(&built);
            #[cfg(not(windows))]
            let resolved = built.canonicalize();
            resolved.unwrap_or(built)
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

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

/// Windows has no executable bit: the name (`node.exe`) says it.
#[cfg(windows)]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    /// The parent's `PATH` in the tests, and what the daemon gets from it.
    #[cfg(unix)]
    const PARENT_PATH: &str = "/usr/bin:/bin";
    #[cfg(unix)]
    const SEARCHED_PATH: &str = "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin";
    #[cfg(windows)]
    const PARENT_PATH: &str = r"C:\Windows\system32;C:\Program Files\nodejs";
    #[cfg(windows)]
    const SEARCHED_PATH: &str = PARENT_PATH;
    const SEPARATOR: char = if cfg!(windows) { ';' } else { ':' };

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
            "PATH" => Some(PARENT_PATH.into()),
            "HOME" => Some("/Users/p".into()),
            "TMPDIR" => Some("/tmp/x/".into()),
            "LANG" => Some("es_ES.UTF-8".into()),
            "OPENAI_API_KEY" => Some("from-the-shell".into()),
            "NODE_OPTIONS" => Some("--inspect".into()),
            _ => None,
        }
    }

    fn full_inputs<'a>(keys: &'a [(String, String)], paths: &'a DaemonPaths) -> DaemonInputs<'a> {
        DaemonInputs {
            telegram: Some(TelegramInputs {
                bot_token: "bot:1",
                principal_chat_id: "42",
            }),
            model: Some("openai/gpt-4o-mini"),
            vision_model: Some("openai/gpt-4o"),
            provider_keys: keys,
            connection_secrets: &[],
            model_login: r#"{"openai":{"type":"api_key","key":"sk-2"}}"#,
            mcp_oauth: r#"{"notes":{}}"#,
            paths,
            local_token: "t".repeat(64).leak(),
            local_port: 50123,
            time_zone: None,
            currency: None,
        }
    }

    #[test]
    fn the_child_env_holds_its_configuration_and_no_secret() {
        let keys = vec![("OPENAI_API_KEY".to_owned(), "sk-1".to_owned())];
        let paths = paths();
        let env: BTreeMap<_, _> = child_env(&parent, &full_inputs(&keys, &paths))
            .into_iter()
            .collect();
        let expected: BTreeMap<String, String> = [
            ("PATH", SEARCHED_PATH),
            ("HOME", "/Users/p"),
            ("TMPDIR", "/tmp/x/"),
            ("LANG", "es_ES.UTF-8"),
            ("ANOMANDER_PRINCIPAL_CHAT_ID", "42"),
            ("ANOMANDER_MODEL", "openai/gpt-4o-mini"),
            ("ANOMANDER_VISION_MODEL", "openai/gpt-4o"),
            ("ANOMANDER_DB_PATH", "/data/anomander.db"),
            ("ANOMANDER_INBOX_DIR", "/data/inbox"),
            ("ANOMANDER_AUTH_PATH", "/data/auth.json"),
            ("ANOMANDER_MCP_CONFIG", "/data/mcp.json"),
            ("ANOMANDER_LOCAL_PORT", "50123"),
            ("ANOMANDER_STOP_WITH_PARENT", "1"),
            ("ANOMANDER_SECRETS_ON_STDIN", "1"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .collect();
        assert_eq!(env, expected);
    }

    #[test]
    fn the_secrets_travel_as_one_json_line_and_only_there() {
        let keys = vec![("OPENAI_API_KEY".to_owned(), "sk-1".to_owned())];
        let paths = paths();
        let secrets = vec![("mcp/notes/env/TOKEN".to_owned(), "line\nbreak".to_owned())];
        let inputs = DaemonInputs {
            connection_secrets: &secrets,
            ..full_inputs(&keys, &paths)
        };
        let line = handover_line(&inputs);
        assert!(!line.contains('\n') && !line.contains('\r'), "{line}");
        let handed: BTreeMap<String, String> =
            serde_json::from_str(&line).unwrap_or_else(|e| panic!("not a JSON object: {e}"));
        let expected: BTreeMap<String, String> = [
            ("TELEGRAM_BOT_TOKEN", "bot:1"),
            ("OPENAI_API_KEY", "sk-1"),
            (
                "ANOMANDER_AUTH_JSON",
                r#"{"openai":{"type":"api_key","key":"sk-2"}}"#,
            ),
            (
                "ANOMANDER_MCP_SECRETS",
                r#"{"mcp/notes/env/TOKEN":"line\nbreak"}"#,
            ),
            ("ANOMANDER_MCP_OAUTH", r#"{"notes":{}}"#),
            ("ANOMANDER_LOCAL_TOKEN", &"t".repeat(64)),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .collect();
        assert_eq!(handed, expected);
        // Not one of them is in the environment, where `ps eww` would show it.
        let env = child_env(&parent, &inputs);
        for value in handed.values() {
            assert!(
                !env.iter().any(|(_, v)| v == value),
                "{value} is in the env"
            );
        }
        for name in handed.keys() {
            assert!(!env.iter().any(|(n, _)| n == name), "{name} is in the env");
        }
    }

    #[test]
    fn without_telegram_neither_its_chat_id_nor_its_token_is_handed() {
        let keys = vec![("OPENAI_API_KEY".to_owned(), "sk-1".to_owned())];
        let paths = paths();
        let inputs = DaemonInputs {
            telegram: None,
            ..full_inputs(&keys, &paths)
        };
        let env: BTreeMap<_, _> = child_env(&parent, &inputs).into_iter().collect();
        let handed: BTreeMap<String, String> =
            serde_json::from_str(&handover_line(&inputs)).unwrap_or_default();
        assert!(!env.contains_key("ANOMANDER_PRINCIPAL_CHAT_ID"));
        assert!(!handed.contains_key("TELEGRAM_BOT_TOKEN"));
        // The local channel is the daemon's front door.
        assert_eq!(
            handed.get("ANOMANDER_LOCAL_TOKEN").map(String::as_str),
            Some("t".repeat(64).as_str())
        );
        assert_eq!(
            env.get("ANOMANDER_LOCAL_PORT").map(String::as_str),
            Some("50123")
        );
    }

    #[test]
    fn an_unset_model_and_absent_parent_variables_are_left_out() {
        let paths = paths();
        let inputs = DaemonInputs {
            telegram: Some(TelegramInputs {
                bot_token: "bot:1",
                principal_chat_id: "42",
            }),
            model: None,
            vision_model: None,
            provider_keys: &[],
            connection_secrets: &[],
            model_login: "{}",
            mcp_oauth: "{}",
            paths: &paths,
            local_token: "t",
            local_port: 1,
            time_zone: None,
            currency: None,
        };
        let env: BTreeMap<_, _> = child_env(&|_| None, &inputs).into_iter().collect();
        let handed: BTreeMap<String, String> =
            serde_json::from_str(&handover_line(&inputs)).unwrap_or_default();
        assert!(!handed.contains_key("ANOMANDER_MCP_SECRETS"));
        assert!(!env.contains_key("ANOMANDER_MODEL"));
        assert!(!env.contains_key("ANOMANDER_VISION_MODEL"));
        assert!(!env.contains_key("HOME"));
        #[cfg(unix)]
        assert_eq!(
            env.get("PATH").map(String::as_str),
            Some("/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin")
        );
        #[cfg(windows)]
        assert_eq!(env.get("PATH").map(String::as_str), Some(DEFAULT_PATH));
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
            telegram: Some(TelegramInputs {
                bot_token: "bot:1",
                principal_chat_id: "42",
            }),
            model: None,
            vision_model: None,
            provider_keys: &[],
            connection_secrets: &secrets,
            model_login: "{}",
            mcp_oauth: "{}",
            paths: &paths,
            local_token: "t",
            local_port: 1,
            time_zone: None,
            currency: None,
        };
        let handed: BTreeMap<String, String> =
            serde_json::from_str(&handover_line(&inputs)).unwrap_or_default();
        let sent: BTreeMap<String, String> = handed
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
                telegram: Some(TelegramInputs {
                    bot_token: "bot:1",
                    principal_chat_id: "42",
                }),
                model: None,
                vision_model: None,
                provider_keys: &[],
                connection_secrets: &[],
                model_login: "{}",
                mcp_oauth: "{}",
                paths: &paths,
                local_token: "t",
                local_port: 1,
                time_zone: None,
                currency: None,
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

    // DK-25: what the principal chose in Configuración wins over this machine's zone.
    #[test]
    fn the_daemon_gets_the_zone_and_the_currency_chosen_in_configuracion() {
        let paths = paths();
        let parent = |name: &str| (name == "TZ").then(|| "Europe/Madrid".to_owned());
        let env_with = |time_zone, currency| -> BTreeMap<String, String> {
            let inputs = DaemonInputs {
                time_zone,
                currency,
                ..full_inputs(&[], &paths)
            };
            child_env(&parent, &inputs).into_iter().collect()
        };
        let chosen = env_with(Some("America/Mexico_City"), Some("MXN"));
        assert_eq!(
            chosen.get("TZ").map(String::as_str),
            Some("America/Mexico_City")
        );
        assert_eq!(
            chosen.get("ANOMANDER_CURRENCY").map(String::as_str),
            Some("MXN")
        );
        let unset = env_with(None, None);
        assert_eq!(unset.get("TZ").map(String::as_str), Some("Europe/Madrid"));
        assert!(!unset.contains_key("ANOMANDER_CURRENCY"));
    }

    #[test]
    fn the_daemon_speaks_the_language_the_shell_read_from_the_system() {
        let paths = paths();
        let env_with = |locale: Option<&'static str>| -> BTreeMap<String, String> {
            let parent = move |name: &str| match name {
                "ANOMANDER_LOCALE" => locale.map(str::to_owned),
                _ => None,
            };
            let inputs = DaemonInputs {
                telegram: None,
                model: None,
                vision_model: None,
                provider_keys: &[],
                connection_secrets: &[],
                model_login: "{}",
                mcp_oauth: "{}",
                paths: &paths,
                local_token: "t",
                local_port: 1,
                time_zone: None,
                currency: None,
            };
            child_env(&parent, &inputs).into_iter().collect()
        };
        for locale in ["es", "en"] {
            assert_eq!(
                env_with(Some(locale))
                    .get("ANOMANDER_LOCALE")
                    .map(String::as_str),
                Some(locale)
            );
        }
        // Anything else is not the shell's answer: the daemon keeps its default, Spanish.
        for locale in [None, Some(""), Some("fr"), Some("es-ES"), Some("EN")] {
            assert!(
                !env_with(locale).contains_key("ANOMANDER_LOCALE"),
                "{locale:?}"
            );
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

    #[cfg(unix)]
    #[test]
    fn homebrew_folders_already_on_path_are_not_repeated() {
        assert_eq!(
            search_path(Some("/opt/homebrew/bin:/usr/bin::")),
            "/opt/homebrew/bin:/usr/bin:/usr/local/bin"
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_windows_path_is_split_at_its_semicolons_each_folder_once() {
        assert_eq!(
            search_path(Some(
                r"C:\Program Files\nodejs;;C:\Windows;C:\Program Files\nodejs"
            )),
            r"C:\Program Files\nodejs;C:\Windows"
        );
    }

    #[cfg(windows)]
    #[test]
    fn node_exe_is_found_on_the_path() -> std::io::Result<()> {
        let dir = tempfile::tempdir()?;
        let (empty, bin) = (dir.path().join("empty"), dir.path().join("bin"));
        std::fs::create_dir_all(&empty)?;
        std::fs::create_dir_all(&bin)?;
        std::fs::write(bin.join("node.exe"), "")?;
        let path = search_path(Some(&format!("{};{}", empty.display(), bin.display())));
        assert_eq!(find_node(None, &path), Some(bin.join("node.exe")));
        assert_eq!(find_node(None, &empty.display().to_string()), None);
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn node_is_found_on_the_path_and_must_be_executable() -> std::io::Result<()> {
        use std::os::unix::fs::PermissionsExt;
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

    /// A resource folder carrying the daemon, as `scripts/stage-daemon.mjs` lays it out.
    fn carried(resources: &Path) -> std::io::Result<Bundled> {
        let bin = resources.join("daemon").join("bin");
        let src = resources.join("daemon/packages/daemon/src");
        std::fs::create_dir_all(&bin)?;
        std::fs::create_dir_all(&src)?;
        std::fs::write(bin.join(NODE), "")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(bin.join(NODE), std::fs::Permissions::from_mode(0o755))?;
        }
        std::fs::write(src.join("main.ts"), "")?;
        Bundled::find(resources).ok_or_else(|| std::io::Error::other("the daemon is not found"))
    }

    #[test]
    fn the_carried_daemon_is_found_by_its_folder_whatever_it_holds() -> std::io::Result<()> {
        let dir = tempfile::tempdir()?;
        assert_eq!(Bundled::find(dir.path()), None);
        let bundled = carried(dir.path())?;
        assert_eq!(
            bundled.node(),
            dir.path().join("daemon").join("bin").join(NODE)
        );
        assert!(bundled.entry().ends_with("packages/daemon/src/main.ts"));
        // A folder missing its entry point is still the app's daemon: an incomplete one.
        std::fs::remove_file(bundled.entry())?;
        assert_eq!(Bundled::find(dir.path()), Some(bundled));
        Ok(())
    }

    #[test]
    fn an_incomplete_carried_daemon_is_an_error_never_the_checkout(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let bundled = carried(dir.path())?;
        let complete = runtime(&parent, Some(&bundled))?;
        assert_eq!(complete.node, bundled.node());
        assert_eq!(complete.entry, bundled.entry());
        // Without its entry point, then also without its Node: the same error, which names no
        // path of the machine that built the app.
        std::fs::remove_file(bundled.entry())?;
        let no_entry = runtime(&parent, Some(&bundled));
        std::fs::remove_file(bundled.node())?;
        let neither = runtime(&parent, Some(&bundled));
        std::fs::create_dir_all(bundled.entry().parent().ok_or("no parent")?)?;
        std::fs::write(bundled.entry(), "")?;
        let no_node = runtime(&parent, Some(&bundled));
        for ran in [no_entry, neither, no_node] {
            assert_eq!(ran, Err(INCOMPLETE.to_owned()));
        }
        assert!(!INCOMPLETE.contains('/') && !INCOMPLETE.contains('\\'));
        // The overrides still win over what is missing.
        let overridden = |name: &str| match name {
            "ANOMANDER_NODE" => Some("/custom/node".to_owned()),
            "ANOMANDER_DAEMON_ENTRY" => Some("/x/main.ts".to_owned()),
            _ => parent(name),
        };
        std::fs::remove_file(bundled.entry())?;
        let ran = runtime(&overridden, Some(&bundled))?;
        assert_eq!(ran.node, PathBuf::from("/custom/node"));
        assert_eq!(ran.entry, PathBuf::from("/x/main.ts"));
        Ok(())
    }

    // The daemon and the web search run the carried Node by its path; a server the principal
    // added that runs `node` or `npx` gets theirs, so the carried folder comes last.
    #[test]
    fn the_carried_node_folder_comes_last_on_the_path() -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let bundled = carried(dir.path())?;
        let ran = runtime(&parent, Some(&bundled))?;
        let expected = std::env::join_paths(
            std::env::split_paths(SEARCHED_PATH).chain(std::iter::once(bundled.bin())),
        )?;
        assert_eq!(ran.path, expected.to_string_lossy());
        // Already first on the principal's `PATH`, it still comes last, and only once.
        let listed = format!("{}{}{PARENT_PATH}", bundled.bin().display(), SEPARATOR);
        let parent = |name: &str| (name == "PATH").then(|| listed.clone());
        assert_eq!(runtime(&parent, Some(&bundled))?.path, ran.path);
        Ok(())
    }

    #[test]
    fn the_overrides_win_over_the_carried_daemon() -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let bundled = carried(dir.path())?;
        let parent = |name: &str| match name {
            "ANOMANDER_NODE" => Some("/custom/node".to_owned()),
            "ANOMANDER_DAEMON_ENTRY" => Some("/x/main.ts".to_owned()),
            _ => parent(name),
        };
        let ran = runtime(&parent, Some(&bundled))?;
        assert_eq!(ran.node, PathBuf::from("/custom/node"));
        assert_eq!(ran.entry, PathBuf::from("/x/main.ts"));
        Ok(())
    }

    #[test]
    fn without_a_carried_daemon_the_checkout_and_the_path_give_it() -> std::io::Result<()> {
        let dir = tempfile::tempdir()?;
        let bin = dir.path().join("bin");
        std::fs::create_dir_all(&bin)?;
        std::fs::write(bin.join(NODE), "")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(bin.join(NODE), std::fs::Permissions::from_mode(0o755))?;
        }
        let listed = bin.display().to_string();
        let parent = |name: &str| (name == "PATH").then(|| listed.clone());
        let ran = runtime(&parent, None).map_err(std::io::Error::other)?;
        assert_eq!(ran.node, bin.join(NODE));
        assert_eq!(ran.entry, daemon_entry(None));
        assert!(ran.entry.is_file());
        assert_eq!(ran.path, search_path(Some(&listed)));
        Ok(())
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
