// What the shell knows besides the daemon's status: the data folder (DK-8), the setup and its
// secrets (DK-5) and this launch's token (DK-3 AC2), and how they become one start of the daemon.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use crate::connection_secrets::sweep;
use crate::connections::{self, Change, ConnectionsView, ServerInput, ServerView, Target};
use crate::daemon::launch::{
    child_env, daemon_entry, find_node, free_port, handover_line, search_path, DaemonInputs,
    TelegramInputs,
};
use crate::daemon::supervisor::{Credentials, Handed, LaunchSpec, Prepared, Update};
use crate::data_dir::DataDir;
use crate::ledger_import::{self, LedgerImport};
use crate::oauth_connect::{self, OAuthSet};
use crate::secure_store::SecretStore;
use crate::setup::{
    apply_setup, load_secrets, save_settings, setup_state, Settings, SetupInput, TELEGRAM_BOT_TOKEN,
};
use crate::snapshot::{SetupState, Snapshot};

/// The words a secret's name usually holds. Every value of `mcp.json` is kept as one, and the
/// code cannot tell which are: a value whose name has one of these words, or any header, is
/// hidden in the daemon's output from `SHORTEST_NAMED` characters; any other from
/// `SHORTEST_UNNAMED`, so a `DEBUG=1` does not blank that character wherever the daemon writes
/// it. A word, not a part of one: `PATH` and `API_VERSION` hold none.
const SECRET_WORDS: [&str; 23] = [
    "token",
    "tokens",
    "key",
    "keys",
    "apikey",
    "secret",
    "secrets",
    "password",
    "passwd",
    "pass",
    "pwd",
    "pw",
    "auth",
    "authorization",
    "credential",
    "credentials",
    "creds",
    "cookie",
    "session",
    "pat",
    "dsn",
    "bearer",
    "jwt",
];
const SHORTEST_NAMED: usize = 4;
const SHORTEST_UNNAMED: usize = 8;

/// Whether the value kept under `account` (`mcp/<server>/<env|headers>/<name>`) is hidden in the
/// daemon's output.
fn hidden(account: &str, value: &str) -> bool {
    let mut parts = account.splitn(4, '/').skip(2);
    let field = parts.next().unwrap_or_default();
    let name = parts.next().unwrap_or_default().to_lowercase();
    let named = field == "headers"
        || name
            .split(|c: char| !c.is_ascii_alphanumeric())
            .any(|word| SECRET_WORDS.contains(&word));
    let shortest = if named {
        SHORTEST_NAMED
    } else {
        SHORTEST_UNNAMED
    };
    value.chars().count() >= shortest
}

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
fn tokens_of(login: &Login) -> Vec<String> {
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

/// Reads a variable of the app's own environment; injected so tests never depend on the real one.
pub type Environment = Box<dyn Fn(&str) -> Option<String> + Send + Sync>;

pub struct Core {
    data: DataDir,
    /// Shared with the handler of the model login the daemon hands over (DK-5 AC1).
    store: Arc<dyn SecretStore>,
    environment: Environment,
    /// DK-3 AC2: generated at each app launch, kept only in memory.
    token: String,
    setup: Mutex<SetupCache>,
    /// DK-11: an OAuth connection runs, from the browser to its tokens stored.
    connecting: AtomicBool,
}

/// The one OAuth connection running; the next may start once this is dropped.
pub struct OAuthTurn<'a>(&'a AtomicBool);

impl Drop for OAuthTurn<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// The setup as last saved. Whether the bot token exists is cached, so a snapshot never reads
/// the Keychain.
struct SetupCache {
    settings: Settings,
    has_telegram_bot_token: bool,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Core {
    pub fn new(
        data: DataDir,
        store: Box<dyn SecretStore>,
        environment: Environment,
        settings: Settings,
        token: String,
    ) -> Self {
        let has_telegram_bot_token = match store.get(TELEGRAM_BOT_TOKEN) {
            Ok(token) => token.is_some(),
            Err(error) => {
                eprintln!("{error}");
                false
            }
        };
        Self {
            data,
            store: Arc::from(store),
            environment,
            token,
            setup: Mutex::new(SetupCache {
                settings,
                has_telegram_bot_token,
            }),
            connecting: AtomicBool::new(false),
        }
    }

    /// The data folder (DK-8), where a capture of the screen lives while it is read.
    pub fn data_root(&self) -> &std::path::Path {
        self.data.root()
    }

    pub fn setup_state(&self) -> SetupState {
        let setup = lock(&self.setup);
        setup_state(&setup.settings, setup.has_telegram_bot_token)
    }

    pub fn snapshot(&self, update: Update) -> Snapshot {
        Snapshot {
            daemon: update.status,
            channel: update.channel,
            setup: self.setup_state(),
        }
    }

    /// DK-5 AC1: stores the secrets and saves the rest. The daemon is not touched here.
    pub fn save_setup(&self, input: &SetupInput) -> Result<(), String> {
        // Held throughout, so two saves never interleave their lists of provider keys.
        let mut setup = lock(&self.setup);
        let settings = apply_setup(input, &setup.settings, self.store.as_ref())?;
        save_settings(&self.data, &settings)
            .map_err(|error| format!("could not save the settings: {error}"))?;
        setup.settings = settings;
        match self.store.get(TELEGRAM_BOT_TOKEN) {
            Ok(token) => setup.has_telegram_bot_token = token.is_some(),
            Err(error) => eprintln!("{error}"),
        }
        Ok(())
    }

    /// DK-11: the servers of `mcp.json` for the connections screen, without their values.
    pub fn connections(&self) -> ConnectionsView {
        // Not while a sweep or a save is halfway through the file.
        let _setup = lock(&self.setup);
        connections::view(&self.data, self.store.as_ref())
    }

    /// DK-11: adds a server to `mcp.json`, or replaces one. The daemon is not touched here.
    pub fn save_connection(&self, input: &ServerInput) -> Result<(), String> {
        let mut setup = lock(&self.setup);
        let change = connections::save(&self.data, input)?;
        self.change_connections(&mut setup, change)
    }

    /// DK-11: takes a server out of `mcp.json`. The daemon is not touched here.
    pub fn remove_connection(&self, name: &str) -> Result<(), String> {
        let mut setup = lock(&self.setup);
        let change = connections::remove(&self.data, name)?;
        self.change_connections(&mut setup, change)
    }

    /// Makes `change` under the setup lock, so it never interleaves with a sweep.
    fn change_connections(&self, setup: &mut SetupCache, change: Change) -> Result<(), String> {
        // Listed before they are stored: whatever a save that fails halfway leaves in the
        // Keychain, the next sweep knows of and removes.
        let mut accounts = setup.settings.connection_secrets.clone();
        accounts.extend(change.accounts());
        accounts.sort();
        accounts.dedup();
        if accounts != setup.settings.connection_secrets {
            let settings = Settings {
                connection_secrets: accounts,
                ..setup.settings.clone()
            };
            save_settings(&self.data, &settings)
                .map_err(|error| format!("could not save the settings: {error}"))?;
            setup.settings = settings;
        }
        change.apply(&self.data, self.store.as_ref())
    }

    /// DK-11: moves the values of `mcp.json` to the Keychain and returns the ones the file refers
    /// to. Nothing here stops a start: a server whose secret is missing is left out by the daemon.
    fn connection_secrets(&self) -> Vec<(String, String)> {
        let mut setup = lock(&self.setup);
        let swept = sweep(
            &self.data,
            self.store.as_ref(),
            &setup.settings.connection_secrets,
        );
        if swept.accounts != setup.settings.connection_secrets {
            let settings = Settings {
                connection_secrets: swept.accounts,
                ..setup.settings.clone()
            };
            match save_settings(&self.data, &settings) {
                Ok(()) => setup.settings = settings,
                Err(error) => eprintln!("could not save the settings: {error}"),
            }
        }
        swept.secrets
    }

    /// DK-12: imports the ledger the principal named into the data folder. Called with the
    /// daemon stopped (`Supervisor::while_stopped`): the script replaces the file it reads.
    pub fn import_ledger(&self, typed: &str) -> Result<LedgerImport, String> {
        let home = (self.environment)("HOME");
        let Some(source) = ledger_import::source_path(typed, home.as_deref()) else {
            return Ok(ledger_import::not_a_path());
        };
        let path = search_path((self.environment)("PATH").as_deref());
        let node =
            find_node((self.environment)("ANOMANDER_NODE").as_deref(), &path).ok_or_else(|| {
                format!("node was not found on {path}; set ANOMANDER_NODE to its path")
            })?;
        let entry = daemon_entry((self.environment)("ANOMANDER_DAEMON_ENTRY").as_deref());
        let script = ledger_import::script_of(&entry)
            .filter(|script| script.is_file())
            .ok_or_else(|| format!("the import is not next to {}", entry.display()))?;
        ledger_import::run(&node, &script, &source, &self.data.daemon_paths().db, &path)
    }

    /// DK-5 AC1: the model login kept in the Keychain. An `auth.json` in the data folder (an older
    /// app's, or one `pnpm run login` wrote) is merged into it, provider by provider, and removed
    /// once the merged login reads back from the store; while it does not, the file is kept.
    fn model_login(&self) -> Result<Login, String> {
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
    fn login_handler(&self) -> Credentials {
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

    /// DK-11: the OAuth tokens to hand the daemon, those of the servers of `mcp.json` at the
    /// address they were given for. Those of a server removed, renamed or moved are dropped, and
    /// the store is told. While the shell cannot read the file (a link, which the daemon follows,
    /// or one half written) none is handed over and none is dropped: the principal may fix it.
    fn mcp_oauth(&self) -> Result<OAuthSet, String> {
        let set = oauth_connect::stored(self.store.as_ref())?;
        let view = self.connections();
        if view.invalid.is_some() {
            return Ok(OAuthSet::new());
        }
        let servers: Vec<(String, String)> = view
            .servers
            .into_iter()
            .filter_map(|server| match server.target {
                Target::Http { url } => Some((server.name, url)),
                Target::Process { .. } => None,
            })
            .collect();
        let kept = oauth_connect::pruned(&set, &servers);
        if kept.len() != set.len() {
            if let Err(error) = oauth_connect::store_set(self.store.as_ref(), &kept) {
                eprintln!("{error}");
            }
        }
        Ok(kept)
    }

    /// DK-11: the address of the server `name`, which must be reached over HTTP.
    fn http_url(&self, name: &str) -> Result<String, String> {
        let view = self.connections();
        if let Some(invalid) = view.invalid {
            return Err(invalid);
        }
        match view.servers.into_iter().find(|server| server.name == name) {
            Some(ServerView {
                target: Target::Http { url },
                ..
            }) => Ok(url),
            Some(_) => Err("only a server reached by its address connects with OAuth".into()),
            None => Err(format!("there is no server named {name}")),
        }
    }

    /// DK-11: the turn of an OAuth connection. One at a time: the window can be closed and opened
    /// again while the browser waits, and two connections would race to store their tokens.
    pub fn oauth_turn(&self) -> Result<OAuthTurn<'_>, String> {
        if self.connecting.swap(true, Ordering::SeqCst) {
            return Err("another OAuth connection is waiting for the browser".into());
        }
        Ok(OAuthTurn(&self.connecting))
    }

    /// DK-11: connects the app to the server `name` with OAuth, `open` opening the address the
    /// principal authorizes it on. Nothing is stored here: `keep_oauth` does, with the daemon
    /// stopped. Returns the server's address with the outcome, the one the tokens are for.
    pub fn connect_oauth(
        &self,
        name: &str,
        open: &dyn Fn(&str) -> Result<(), String>,
    ) -> Result<(oauth_connect::Ran, String), String> {
        let url = self.http_url(name)?;
        let path = search_path((self.environment)("PATH").as_deref());
        let node =
            find_node((self.environment)("ANOMANDER_NODE").as_deref(), &path).ok_or_else(|| {
                format!("node was not found on {path}; set ANOMANDER_NODE to its path")
            })?;
        let entry = daemon_entry((self.environment)("ANOMANDER_DAEMON_ENTRY").as_deref());
        let script = oauth_connect::script_of(&entry)
            .filter(|script| script.is_file())
            .ok_or_else(|| format!("the OAuth connection is not next to {}", entry.display()))?;
        let ran = oauth_connect::run(&node, &script, &url, &path, open, oauth_connect::DEADLINE)?;
        Ok((ran, url))
    }

    /// DK-11: keeps the tokens of a connection to `name` at `url`. Call it with the daemon
    /// stopped, so no token it refreshes meanwhile overwrites them.
    pub fn keep_oauth(
        &self,
        name: &str,
        url: &str,
        entry: serde_json::Map<String, serde_json::Value>,
    ) -> Result<(), String> {
        let mut set = oauth_connect::stored(self.store.as_ref())?;
        set.insert(name.to_owned(), oauth_connect::kept_for(entry, url));
        oauth_connect::store_set(self.store.as_ref(), &set)
    }

    /// DK-11: forgets the tokens of `name`. Call it with the daemon stopped, as `keep_oauth`.
    pub fn forget_oauth(&self, name: &str) -> Result<(), String> {
        let mut set = oauth_connect::stored(self.store.as_ref())?;
        if set.remove(name).is_some() {
            oauth_connect::store_set(self.store.as_ref(), &set)?;
        }
        Ok(())
    }

    /// One start of the daemon (DK-1 AC1): `node <repo>/packages/daemon/src/main.ts`, with the
    /// setup in the environment, its secrets on the handover line to its stdin (DK-5 AC2) and a
    /// fresh port.
    pub fn prepare(&self) -> Prepared {
        let settings = lock(&self.setup).settings.clone();
        let secrets = match load_secrets(&settings, self.store.as_ref()) {
            Ok(secrets) => secrets,
            Err(message) => return Prepared::Failed(message),
        };
        // T13: Telegram is a door the daemon may go without, with both halves or not at all; the
        // local channel is always on. Without Telegram the chat needs at least a model; with it,
        // its setup guide and `/login` work without one, as before.
        let telegram = settings
            .principal_chat_id
            .as_deref()
            .zip(secrets.telegram_bot_token.as_deref())
            .map(|(principal_chat_id, bot_token)| TelegramInputs {
                bot_token,
                principal_chat_id,
            });
        if telegram.is_none() && settings.model.is_none() {
            return Prepared::NotConfigured;
        }
        let login = match self.model_login() {
            Ok(login) => login,
            Err(message) => return Prepared::Failed(message),
        };
        // A Keychain that cannot give the OAuth tokens leaves those servers out, not the daemon.
        let mcp_oauth = self.mcp_oauth().unwrap_or_else(|message| {
            eprintln!("{message}; no server is connected with OAuth");
            OAuthSet::new()
        });
        let path = search_path((self.environment)("PATH").as_deref());
        let Some(node) = find_node((self.environment)("ANOMANDER_NODE").as_deref(), &path) else {
            return Prepared::Failed(format!(
                "node was not found on {path}; set ANOMANDER_NODE to its path"
            ));
        };
        let entry = daemon_entry((self.environment)("ANOMANDER_DAEMON_ENTRY").as_deref());
        if !entry.is_file() {
            return Prepared::Failed(format!(
                "the daemon is not at {}; set ANOMANDER_DAEMON_ENTRY to its main.ts",
                entry.display()
            ));
        }
        let port = match free_port() {
            Ok(port) => port,
            Err(error) => {
                return Prepared::Failed(format!("no free port on 127.0.0.1: {error}"));
            }
        };
        let connection_secrets = self.connection_secrets();
        let paths = self.data.daemon_paths();
        let parent = |name: &str| {
            if name == "PATH" {
                // Homebrew's folders, so the daemon finds the same tools as the shell did.
                Some(path.clone())
            } else {
                (self.environment)(name)
            }
        };
        let model_login = serde_json::Value::Object(login.clone()).to_string();
        let mcp_oauth_json = serde_json::Value::Object(mcp_oauth.clone()).to_string();
        let inputs = DaemonInputs {
            telegram,
            model: settings.model.as_deref(),
            vision_model: settings.vision_model.as_deref(),
            provider_keys: &secrets.provider_keys,
            connection_secrets: &connection_secrets,
            model_login: &model_login,
            mcp_oauth: &mcp_oauth_json,
            paths: &paths,
            local_token: &self.token,
            local_port: port,
        };
        let env = child_env(&parent, &inputs);
        let handover = handover_line(&inputs);
        // A stored token is hidden even when it is not handed over.
        let mut redacted = vec![self.token.clone()];
        redacted.extend(secrets.telegram_bot_token.clone());
        redacted.extend(tokens_of(&login));
        redacted.extend(oauth_connect::secrets_of(&mcp_oauth));
        redacted.extend(secrets.provider_keys.into_iter().map(|(_, key)| key));
        redacted.extend(
            connection_secrets
                .into_iter()
                .filter(|(account, secret)| hidden(account, secret))
                .map(|(_, secret)| secret),
        );
        Prepared::Ready(LaunchSpec {
            program: node,
            args: vec![entry.into_os_string()],
            env,
            cwd: self.data.root().to_path_buf(),
            port,
            token: self.token.clone(),
            secrets: redacted,
            handover: Some(handover),
            on_credentials: Some(self.login_handler()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secure_store::MemoryStore;
    use serde_json::json;
    use std::collections::BTreeMap;

    struct Fixture {
        _parent: tempfile::TempDir,
        core: Core,
        root: std::path::PathBuf,
    }

    fn fixture(store: MemoryStore, settings: Settings) -> Fixture {
        let parent = tempfile::tempdir().unwrap_or_else(|e| panic!("no temp dir: {e}"));
        let root = parent.path().join("ANOMANDER");
        let data = DataDir::open(root.clone()).unwrap_or_else(|e| panic!("no data dir: {e}"));
        let environment: Environment = Box::new(|name| match name {
            "PATH" => Some("/usr/bin:/bin".into()),
            "HOME" => Some("/Users/p".into()),
            "ANOMANDER_NODE" => Some("/opt/node/bin/node".into()),
            "OPENAI_API_KEY" => Some("from-the-shell".into()),
            _ => None,
        });
        let core = Core::new(data, Box::new(store), environment, settings, "t".repeat(64));
        Fixture {
            _parent: parent,
            core,
            root,
        }
    }

    fn configured() -> (MemoryStore, Settings) {
        let store = MemoryStore::default();
        let _ = store.set(TELEGRAM_BOT_TOKEN, "bot:secret");
        let _ = store.set("OPENAI_API_KEY", "sk-secret");
        let settings = Settings {
            principal_chat_id: Some("42".into()),
            model: Some("openai/gpt-4o-mini".into()),
            vision_model: None,
            provider_keys: vec!["OPENAI_API_KEY".into()],
            connection_secrets: Vec::new(),
        };
        (store, settings)
    }

    /// DK-5 AC2: what a launch hands over on the daemon's stdin, by variable.
    fn handed(spec: &LaunchSpec) -> BTreeMap<String, String> {
        spec.handover
            .as_deref()
            .and_then(|line| serde_json::from_str(line).ok())
            .unwrap_or_default()
    }

    fn login_env(spec: &LaunchSpec) -> Option<String> {
        handed(spec).remove("ANOMANDER_AUTH_JSON")
    }

    fn ready(core: &Core) -> LaunchSpec {
        match core.prepare() {
            Prepared::Ready(spec) => spec,
            _ => panic!("a configured setup was not ready"),
        }
    }

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

    fn oauth_env(spec: &LaunchSpec) -> Option<serde_json::Value> {
        handed(spec)
            .get("ANOMANDER_MCP_OAUTH")
            .and_then(|json| serde_json::from_str(json).ok())
    }

    /// `mcp.json` with `notes` at its address and a process server.
    fn with_servers(f: &Fixture) {
        std::fs::write(
            f.root.join("mcp.json"),
            json!({ "mcpServers": {
                "notes": { "url": "https://notes.example/mcp" },
                "files": { "command": "files-mcp" }
            }})
            .to_string(),
        )
        .unwrap_or_else(|e| panic!("no mcp.json: {e}"));
    }

    fn entry() -> serde_json::Map<String, serde_json::Value> {
        json!({ "client": { "client_id": "c-1" }, "tokens": { "access_token": "oauth-access-1" } })
            .as_object()
            .cloned()
            .unwrap_or_default()
    }

    #[test]
    fn oauth_tokens_kept_for_a_server_reach_the_daemon_and_are_hidden() -> Result<(), String> {
        let (store, settings) = configured();
        let f = fixture(store, settings);
        with_servers(&f);
        assert_eq!(oauth_env(&ready(&f.core)), Some(json!({})));

        f.core
            .keep_oauth("notes", "https://notes.example/mcp", entry())?;
        let spec = ready(&f.core);

        let mut kept = entry();
        kept.insert("url".into(), "https://notes.example/mcp".into());
        assert_eq!(oauth_env(&spec), Some(json!({ "notes": kept })));
        assert!(spec.secrets.iter().any(|secret| secret == "oauth-access-1"));
        let view = f.core.connections();
        let flags: Vec<_> = view
            .servers
            .iter()
            .map(|s| (s.name.as_str(), s.oauth))
            .collect();
        assert_eq!(flags, vec![("notes", true), ("files", false)]);
        Ok(())
    }

    #[test]
    fn tokens_are_not_handed_over_while_the_file_is_not_as_the_shell_reads_it() -> Result<(), String>
    {
        let (store, settings) = configured();
        let f = fixture(store, settings);
        with_servers(&f);
        f.core
            .keep_oauth("notes", "https://notes.example/mcp", entry())?;
        // A link the daemon follows but the shell does not read, naming another address.
        let linked = f.root.parent().ok_or("no parent")?.join("linked-mcp.json");
        std::fs::write(
            &linked,
            json!({"mcpServers":{"notes":{"url":"https://evil.example/mcp"}}}).to_string(),
        )
        .map_err(|e| e.to_string())?;
        std::fs::remove_file(f.root.join("mcp.json")).map_err(|e| e.to_string())?;
        std::os::unix::fs::symlink(&linked, f.root.join("mcp.json")).map_err(|e| e.to_string())?;

        assert_eq!(oauth_env(&ready(&f.core)), Some(json!({})));
        // Kept, not dropped: the principal may fix the file.
        std::fs::remove_file(f.root.join("mcp.json")).map_err(|e| e.to_string())?;
        with_servers(&f);
        assert!(f.core.connections().servers[0].oauth);
        Ok(())
    }

    #[test]
    fn only_the_secrets_of_an_oauth_entry_are_hidden_from_the_daemons_output() -> Result<(), String>
    {
        let (store, settings) = configured();
        let f = fixture(store, settings);
        with_servers(&f);
        let mut kept = entry();
        kept.insert(
            "client".into(),
            json!({"client_id":"c-1","client_name":"ANOMANDER","client_secret":"oauth-client-secret",
                "grant_types":["authorization_code","refresh_token"],
                "redirect_uris":["http://127.0.0.1:54177/callback"]}),
        );
        kept.insert(
            "tokens".into(),
            json!({"access_token":"oauth-access-1","refresh_token":"oauth-refresh-1",
                "id_token":"oauth-id-1","token_type":"Bearer","scope":"read write"}),
        );
        f.core
            .keep_oauth("notes", "https://notes.example/mcp", kept)?;
        let spec = ready(&f.core);
        let mut hidden: Vec<_> = spec
            .secrets
            .iter()
            .filter(|secret| secret.starts_with("oauth-"))
            .cloned()
            .collect();
        hidden.sort();
        assert_eq!(
            hidden,
            [
                "oauth-access-1",
                "oauth-client-secret",
                "oauth-id-1",
                "oauth-refresh-1"
            ]
        );
        for plain in [
            "ANOMANDER",
            "authorization_code",
            "refresh_token",
            "https://notes.example/mcp",
        ] {
            assert!(
                !spec.secrets.iter().any(|secret| secret == plain),
                "{plain}"
            );
        }
        Ok(())
    }

    #[test]
    fn tokens_of_a_server_removed_renamed_or_moved_are_dropped() -> Result<(), String> {
        let (store, settings) = configured();
        let f = fixture(store, settings);
        with_servers(&f);
        f.core
            .keep_oauth("notes", "https://notes.example/mcp", entry())?;
        f.core
            .keep_oauth("gone", "https://gone.example/mcp", entry())?;
        // The address changed since the tokens were given: they are not for this one.
        std::fs::write(
            f.root.join("mcp.json"),
            json!({ "mcpServers": { "notes": { "url": "https://elsewhere.example/mcp" } } })
                .to_string(),
        )
        .map_err(|e| e.to_string())?;

        assert_eq!(oauth_env(&ready(&f.core)), Some(json!({})));
        // Dropped from the store too, so moving the address back does not bring them back.
        with_servers(&f);
        assert_eq!(oauth_env(&ready(&f.core)), Some(json!({})));
        Ok(())
    }

    #[test]
    fn tokens_are_kept_while_the_file_cannot_be_read() -> Result<(), String> {
        let (store, settings) = configured();
        let f = fixture(store, settings);
        with_servers(&f);
        f.core
            .keep_oauth("notes", "https://notes.example/mcp", entry())?;
        std::fs::write(f.root.join("mcp.json"), "{ half written").map_err(|e| e.to_string())?;
        let _ = ready(&f.core);
        with_servers(&f);
        assert!(f.core.connections().servers[0].oauth);
        Ok(())
    }

    #[test]
    fn forgetting_a_server_drops_its_tokens_and_no_other() -> Result<(), String> {
        let (store, settings) = configured();
        let f = fixture(store, settings);
        with_servers(&f);
        f.core
            .keep_oauth("notes", "https://notes.example/mcp", entry())?;
        f.core.forget_oauth("files")?;
        assert!(f.core.connections().servers[0].oauth);
        f.core.forget_oauth("notes")?;
        assert!(!f.core.connections().servers[0].oauth);
        assert_eq!(oauth_env(&ready(&f.core)), Some(json!({})));
        Ok(())
    }

    #[test]
    fn only_a_server_reached_by_its_address_connects_with_oauth() {
        let (store, settings) = configured();
        let f = fixture(store, settings);
        with_servers(&f);
        let never = |_: &str| -> Result<(), String> { panic!("nothing may be opened") };
        assert_eq!(
            f.core.connect_oauth("files", &never).err(),
            Some("only a server reached by its address connects with OAuth".into())
        );
        assert_eq!(
            f.core.connect_oauth("nobody", &never).err(),
            Some("there is no server named nobody".into())
        );
    }

    #[test]
    fn the_daemon_starts_without_oauth_when_its_tokens_cannot_be_read() {
        let (mut store, settings) = configured();
        store.unreadable = Some("mcp-oauth");
        let f = fixture(store, settings);
        with_servers(&f);
        assert_eq!(oauth_env(&ready(&f.core)), Some(json!({})));
    }

    #[test]
    fn one_oauth_connection_runs_at_a_time() {
        let (store, settings) = configured();
        let f = fixture(store, settings);
        let turn = f.core.oauth_turn();
        assert!(turn.is_ok());
        assert_eq!(
            f.core.oauth_turn().err(),
            Some("another OAuth connection is waiting for the browser".into())
        );
        drop(turn);
        assert!(f.core.oauth_turn().is_ok());
    }

    #[test]
    fn tokens_the_daemon_hands_back_are_stored_for_the_next_start() {
        let (store, settings) = configured();
        let f = fixture(store, settings);
        with_servers(&f);
        let handed = ready(&f.core)
            .on_credentials
            .unwrap_or_else(|| panic!("no credentials handler"));
        let refreshed = r#"{"notes":{"tokens":{"access_token":"oauth-access-2"},"url":"https://notes.example/mcp"}}"#;

        handed(Handed::McpOAuth, refreshed);
        handed(Handed::McpOAuth, "not json");

        assert_eq!(
            oauth_env(&ready(&f.core)),
            serde_json::from_str(refreshed).ok()
        );
        // The model login is another item.
        assert_eq!(login_env(&ready(&f.core)).as_deref(), Some("{}"));
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

    #[test]
    fn an_import_from_what_is_not_a_full_path_runs_nothing() {
        let f = fixture(MemoryStore::default(), Settings::default());
        assert_eq!(
            f.core.import_ledger("Downloads/anomander.db"),
            Ok(ledger_import::not_a_path())
        );
    }

    #[test]
    fn an_import_runs_node_of_the_setup_on_the_daemons_script() {
        let f = fixture(MemoryStore::default(), Settings::default());
        // The fixture's `ANOMANDER_NODE` is not there: the error names it.
        let answer = f.core.import_ledger("~/anomander.db");
        assert!(
            answer
                .as_ref()
                .is_err_and(|error| error.contains("/opt/node/bin/node")),
            "{answer:?}"
        );
        assert!(!f.root.join("anomander.db").exists());
    }

    /// T13: whether the launch carries Telegram, and only the local channel otherwise.
    fn without_telegram(spec: &LaunchSpec) -> bool {
        let handed = handed(spec);
        !handed.contains_key("TELEGRAM_BOT_TOKEN")
            && !spec
                .env
                .iter()
                .any(|(name, _)| name == "ANOMANDER_PRINCIPAL_CHAT_ID")
            && handed.get("ANOMANDER_LOCAL_TOKEN") == Some(&"t".repeat(64))
    }

    #[test]
    fn without_telegram_the_daemon_starts_with_the_local_channel_alone() {
        let (_, mut settings) = configured();
        settings.principal_chat_id = None;
        let store = MemoryStore::default();
        let _ = store.set("OPENAI_API_KEY", "sk-secret");
        let f = fixture(store, settings);
        let spec = ready(&f.core);
        assert!(without_telegram(&spec));
        assert_eq!(
            handed(&spec).get("OPENAI_API_KEY").map(String::as_str),
            Some("sk-secret")
        );
        assert!(!f.core.setup_state().has_telegram_bot_token);
    }

    #[test]
    fn half_of_telegram_is_left_out_of_the_launch() {
        // A token kept from before, without a chat ID.
        let (store, mut settings) = configured();
        settings.principal_chat_id = None;
        let f = fixture(store, settings);
        let spec = ready(&f.core);
        assert!(without_telegram(&spec));
        // Still hidden from the output, in case it shows up there.
        assert!(spec.secrets.iter().any(|secret| secret == "bot:secret"));

        // A chat ID without a token.
        let f = fixture(MemoryStore::default(), configured().1);
        assert!(without_telegram(&ready(&f.core)));
    }

    #[test]
    fn without_telegram_and_without_a_model_it_is_not_configured() {
        let (_, mut settings) = configured();
        settings.principal_chat_id = None;
        settings.model = None;
        let f = fixture(MemoryStore::default(), settings);
        assert!(matches!(f.core.prepare(), Prepared::NotConfigured));

        // With Telegram it starts, as before: its setup guide and `/login` need no model.
        let (store, mut settings) = configured();
        settings.model = None;
        let f = fixture(store, settings);
        assert!(!without_telegram(&ready(&f.core)));
    }

    #[test]
    fn a_launch_runs_this_repositorys_daemon_with_the_setup_in_its_environment_and_its_secrets_on_stdin(
    ) {
        let (store, settings) = configured();
        let f = fixture(store, settings);
        let Prepared::Ready(spec) = f.core.prepare() else {
            panic!("a configured setup was not ready");
        };
        assert_eq!(spec.program, std::path::PathBuf::from("/opt/node/bin/node"));
        assert_eq!(spec.args.len(), 1);
        assert!(std::path::Path::new(&spec.args[0]).ends_with("packages/daemon/src/main.ts"));
        assert_eq!(spec.cwd, f.root);
        let env: BTreeMap<_, _> = spec.env.iter().cloned().collect();
        let get = |name: &str| env.get(name).map(String::as_str);
        let handed = handed(&spec);
        let on_stdin = |name: &str| handed.get(name).map(String::as_str);
        assert_eq!(on_stdin("TELEGRAM_BOT_TOKEN"), Some("bot:secret"));
        assert_eq!(on_stdin("OPENAI_API_KEY"), Some("sk-secret"));
        assert_eq!(on_stdin("ANOMANDER_AUTH_JSON"), Some("{}"));
        assert_eq!(on_stdin("ANOMANDER_MCP_OAUTH"), Some("{}"));
        assert_eq!(
            on_stdin("ANOMANDER_LOCAL_TOKEN"),
            Some("t".repeat(64).as_str())
        );
        // None of them in the environment, which `ps eww` shows.
        for name in handed.keys() {
            assert_eq!(get(name), None, "{name} is in the environment");
        }
        assert_eq!(get("ANOMANDER_SECRETS_ON_STDIN"), Some("1"));
        assert_eq!(get("ANOMANDER_PRINCIPAL_CHAT_ID"), Some("42"));
        assert_eq!(get("ANOMANDER_MODEL"), Some("openai/gpt-4o-mini"));
        assert_eq!(get("ANOMANDER_VISION_MODEL"), None);
        assert_eq!(
            get("ANOMANDER_LOCAL_PORT"),
            Some(spec.port.to_string().as_str())
        );
        assert_eq!(get("ANOMANDER_STOP_WITH_PARENT"), Some("1"));
        assert_eq!(
            get("ANOMANDER_DB_PATH"),
            Some(f.root.join("anomander.db").to_string_lossy().as_ref())
        );
        assert_eq!(get("HOME"), Some("/Users/p"));
        assert_eq!(
            get("PATH"),
            Some("/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin")
        );
        for secret in ["bot:secret", "sk-secret", "t".repeat(64).as_str()] {
            assert!(
                spec.secrets.iter().any(|s| s == secret),
                "{secret} is not redacted"
            );
        }
    }

    #[test]
    fn a_launch_moves_the_values_of_the_connections_to_the_store_and_hands_them_over(
    ) -> Result<(), String> {
        let (store, settings) = configured();
        let f = fixture(store, settings);
        let file = f.root.join("mcp.json");
        let written = json!({
            "mcpServers": {
                "notes": { "command": "npx", "env": { "TOKEN": "tok-secret-1", "DEBUG": "1" } }
            }
        });
        std::fs::write(&file, written.to_string()).map_err(|e| e.to_string())?;

        let Prepared::Ready(spec) = f.core.prepare() else {
            return Err("a configured setup was not ready".into());
        };

        let sent = handed(&spec)
            .remove("ANOMANDER_MCP_SECRETS")
            .ok_or("the secrets were not handed over")?;
        let sent: BTreeMap<String, String> =
            serde_json::from_str(&sent).map_err(|e| e.to_string())?;
        assert_eq!(
            sent.get("mcp/notes/env/TOKEN").map(String::as_str),
            Some("tok-secret-1")
        );
        assert_eq!(
            sent.get("mcp/notes/env/DEBUG").map(String::as_str),
            Some("1")
        );
        // Out of the file, hidden in the daemon's output, and only named in the settings.
        let left = std::fs::read_to_string(&file).map_err(|e| e.to_string())?;
        assert!(!left.contains("tok-secret-1"), "{left}");
        assert!(spec.secrets.iter().any(|secret| secret == "tok-secret-1"));
        assert!(!spec.secrets.iter().any(|secret| secret == "1"));
        let saved =
            std::fs::read_to_string(f.root.join("settings.json")).map_err(|e| e.to_string())?;
        assert!(saved.contains("mcp/notes/env/TOKEN") && !saved.contains("tok-secret-1"));

        // Saving the setup keeps the list: it is what removes them once the file drops them.
        let input: SetupInput = serde_json::from_value(json!({
            "principalChatId": "42", "model": "", "visionModel": ""
        }))
        .map_err(|e| e.to_string())?;
        f.core.save_setup(&input)?;
        let saved =
            std::fs::read_to_string(f.root.join("settings.json")).map_err(|e| e.to_string())?;
        assert!(saved.contains("mcp/notes/env/TOKEN"), "{saved}");

        // The next start reads them back from the store.
        let Prepared::Ready(again) = f.core.prepare() else {
            return Err("the second start was not ready".into());
        };
        assert!(handed(&again)
            .get("ANOMANDER_MCP_SECRETS")
            .is_some_and(|json| json.contains("tok-secret-1")));
        Ok(())
    }

    #[test]
    fn a_connection_saved_from_the_screen_is_handed_over_and_one_removed_leaves_the_store(
    ) -> Result<(), String> {
        let (store, settings) = configured();
        let f = fixture(store, settings);
        let input: ServerInput = serde_json::from_value(json!({
            "name": "notes", "kind": "process", "command": "npx",
            "values": [{ "name": "TOKEN", "value": "tok-typed-1" }]
        }))
        .map_err(|e| e.to_string())?;
        let settings_file =
            || std::fs::read_to_string(f.root.join("settings.json")).map_err(|e| e.to_string());
        let handed_over = |spec: &LaunchSpec| handed(spec).remove("ANOMANDER_MCP_SECRETS");

        f.core.save_connection(&input)?;

        // Only named in the settings, a marker in the file, and stored for the screen.
        let saved = settings_file()?;
        assert!(saved.contains("mcp/notes/env/TOKEN") && !saved.contains("tok-typed-1"));
        let file = std::fs::read_to_string(f.root.join("mcp.json")).map_err(|e| e.to_string())?;
        assert!(
            file.contains("@keychain") && !file.contains("tok-typed-1"),
            "{file}"
        );
        let shown = f.core.connections();
        assert_eq!(shown.invalid, None);
        assert!(shown.servers[0].values[0].stored);
        let Prepared::Ready(spec) = f.core.prepare() else {
            return Err("a configured setup was not ready".into());
        };
        assert!(handed_over(&spec).is_some_and(|json| json.contains("tok-typed-1")));
        assert!(spec.secrets.iter().any(|secret| secret == "tok-typed-1"));

        // The setup still saves, and keeps the list.
        let setup: SetupInput = serde_json::from_value(json!({
            "principalChatId": "7", "model": "", "visionModel": ""
        }))
        .map_err(|e| e.to_string())?;
        f.core.save_setup(&setup)?;
        assert_eq!(f.core.setup_state().principal_chat_id.as_deref(), Some("7"));
        assert!(settings_file()?.contains("mcp/notes/env/TOKEN"));

        f.core.remove_connection("notes")?;
        let Prepared::Ready(spec) = f.core.prepare() else {
            return Err("the start after the removal was not ready".into());
        };
        assert_eq!(handed_over(&spec), None);
        assert!(!settings_file()?.contains("mcp/notes"));
        assert!(f.core.connections().servers.is_empty());
        assert!(f.core.remove_connection("notes").is_err());
        Ok(())
    }

    #[test]
    fn a_connection_the_store_refuses_is_removed_by_the_next_sweep() -> Result<(), String> {
        let f = fixture(MemoryStore::failing(), configured().1);
        let input: ServerInput = serde_json::from_value(json!({
            "name": "notes", "kind": "process", "command": "npx",
            "values": [{ "name": "TOKEN", "value": "tok-typed-1" }]
        }))
        .map_err(|e| e.to_string())?;

        assert!(f.core.save_connection(&input).is_err());

        // No file was written, and the account is known so that a sweep can remove it.
        assert!(!f.root.join("mcp.json").exists());
        let saved =
            std::fs::read_to_string(f.root.join("settings.json")).map_err(|e| e.to_string())?;
        assert!(saved.contains("mcp/notes/env/TOKEN"), "{saved}");
        Ok(())
    }

    #[test]
    fn a_value_of_a_connection_is_hidden_by_its_name_and_its_length() {
        for (account, value) in [
            ("mcp/s/env/API_KEY", "abcd"),
            ("mcp/s/env/GITHUB_TOKEN", "ñ-12"),
            ("mcp/s/env/db_password", "hunter2"),
            ("mcp/s/headers/X-Custom", "abcd"),
            ("mcp/s/env/GH_PAT", "ghp_1234"),
            // Under any name, once it is long enough to be one.
            ("mcp/s/env/ENDPOINT", "https://u:p@host/db"),
        ] {
            assert!(hidden(account, value), "{account}");
        }
        // A value this long is hidden under any name, as before names were looked at.
        for name in [
            "DB_PW",
            "SMTP_PW",
            "PIN",
            "JWT",
            "BEARER",
            "CREDS",
            "DATABASE_URL",
        ] {
            assert!(hidden(&format!("mcp/s/env/{name}"), "12345678"), "{name}");
        }
        for (account, value) in [
            ("mcp/s/env/API_KEY", "abc"),
            ("mcp/s/env/DEBUG", "1"),
            ("mcp/s/env/LANGUAGE", "ñññññññ"),
            // A hint is a whole word of the name: these hold one only inside another.
            ("mcp/s/env/API_VERSION", "2026"),
            ("mcp/s/env/PATH", "/bin"),
            ("mcp/s/env/AUTHOR", "erica"),
            ("mcp/s/env/KEYBOARD", "es-ES"),
        ] {
            assert!(!hidden(account, value), "{account}");
        }
    }

    #[test]
    fn without_connections_no_secret_of_theirs_is_handed_over() {
        let (store, settings) = configured();
        let f = fixture(store, settings);
        let Prepared::Ready(spec) = f.core.prepare() else {
            panic!("a configured setup was not ready");
        };
        assert!(!handed(&spec).contains_key("ANOMANDER_MCP_SECRETS"));
        assert!(!spec
            .env
            .iter()
            .any(|(name, _)| name == "ANOMANDER_MCP_SECRETS"));
        assert!(!f.root.join("settings.json").exists());
    }

    #[test]
    fn saving_the_setup_updates_the_state_and_the_next_launch() -> Result<(), String> {
        let f = fixture(MemoryStore::default(), Settings::default());
        assert!(matches!(f.core.prepare(), Prepared::NotConfigured));
        let input: SetupInput = serde_json::from_value(json!({
            "telegramBotToken": "bot:new",
            "principalChatId": "7",
            "model": "",
            "visionModel": "",
            "providerKeys": { "GEMINI_API_KEY": "g-key" }
        }))
        .map_err(|e| e.to_string())?;
        f.core.save_setup(&input)?;
        let state = f.core.setup_state();
        assert!(state.has_telegram_bot_token);
        assert_eq!(state.principal_chat_id.as_deref(), Some("7"));
        assert_eq!(state.provider_keys, vec!["GEMINI_API_KEY".to_owned()]);
        let saved =
            std::fs::read_to_string(f.root.join("settings.json")).map_err(|e| e.to_string())?;
        assert!(!saved.contains("bot:new") && !saved.contains("g-key"));
        let Prepared::Ready(spec) = f.core.prepare() else {
            return Err("the saved setup was not ready".into());
        };
        assert_eq!(
            handed(&spec).get("GEMINI_API_KEY").map(String::as_str),
            Some("g-key")
        );
        assert!(!spec.env.iter().any(|(name, _)| name == "GEMINI_API_KEY"));
        // The model is unset: the daemon starts its setup guide (R-28).
        assert!(!spec.env.iter().any(|(name, _)| name == "ANOMANDER_MODEL"));
        Ok(())
    }
}
