// What the shell knows besides the daemon's status: the data folder (DK-8), the setup and its
// secrets (DK-5) and this launch's token (DK-3 AC2), and how they become one start of the daemon.
use std::sync::{Mutex, MutexGuard, PoisonError};

use crate::connection_secrets::sweep;
use crate::daemon::launch::{
    child_env, daemon_entry, find_node, free_port, search_path, DaemonInputs,
};
use crate::daemon::supervisor::{LaunchSpec, Prepared, Update};
use crate::data_dir::DataDir;
use crate::secure_store::SecretStore;
use crate::setup::{
    apply_setup, load_secrets, save_settings, setup_state, Settings, SetupInput, TELEGRAM_BOT_TOKEN,
};
use crate::snapshot::{SetupState, Snapshot};

/// A value of `mcp.json` this short may be no secret (`DEBUG=1`), and hiding it would blank the
/// daemon's output wherever those characters appear.
const SHORTEST_REDACTED: usize = 8;

/// Reads a variable of the app's own environment; injected so tests never depend on the real one.
pub type Environment = Box<dyn Fn(&str) -> Option<String> + Send + Sync>;

pub struct Core {
    data: DataDir,
    store: Box<dyn SecretStore>,
    environment: Environment,
    /// DK-3 AC2: generated at each app launch, kept only in memory.
    token: String,
    setup: Mutex<SetupCache>,
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
            store,
            environment,
            token,
            setup: Mutex::new(SetupCache {
                settings,
                has_telegram_bot_token,
            }),
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

    /// One start of the daemon (DK-1 AC1): `node <repo>/packages/daemon/src/main.ts`, with the
    /// setup and its secrets in the environment (DK-5 AC2) and a fresh port.
    pub fn prepare(&self) -> Prepared {
        let settings = lock(&self.setup).settings.clone();
        let Some(chat_id) = settings.principal_chat_id.clone() else {
            return Prepared::NotConfigured;
        };
        let secrets = match load_secrets(&settings, self.store.as_ref()) {
            Ok(secrets) => secrets,
            Err(message) => return Prepared::Failed(message),
        };
        let Some(bot_token) = secrets.telegram_bot_token else {
            return Prepared::NotConfigured;
        };
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
        let env = child_env(
            &parent,
            &DaemonInputs {
                telegram_bot_token: &bot_token,
                principal_chat_id: &chat_id,
                model: settings.model.as_deref(),
                vision_model: settings.vision_model.as_deref(),
                provider_keys: &secrets.provider_keys,
                connection_secrets: &connection_secrets,
                paths: &paths,
                local_token: &self.token,
                local_port: port,
            },
        );
        let mut redacted = vec![bot_token, self.token.clone()];
        redacted.extend(secrets.provider_keys.into_iter().map(|(_, key)| key));
        redacted.extend(
            connection_secrets
                .into_iter()
                .map(|(_, secret)| secret)
                .filter(|secret| secret.len() >= SHORTEST_REDACTED),
        );
        Prepared::Ready(LaunchSpec {
            program: node,
            args: vec![entry.into_os_string()],
            env,
            cwd: self.data.root().to_path_buf(),
            port,
            token: self.token.clone(),
            secrets: redacted,
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

    #[test]
    fn without_a_chat_id_or_a_bot_token_it_is_not_configured() {
        let (store, mut settings) = configured();
        settings.principal_chat_id = None;
        let f = fixture(store, settings);
        assert!(matches!(f.core.prepare(), Prepared::NotConfigured));

        let f = fixture(MemoryStore::default(), configured().1);
        assert!(matches!(f.core.prepare(), Prepared::NotConfigured));
        assert!(!f.core.setup_state().has_telegram_bot_token);
    }

    #[test]
    fn a_launch_runs_this_repositorys_daemon_with_the_setup_in_its_environment() {
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
        assert_eq!(get("TELEGRAM_BOT_TOKEN"), Some("bot:secret"));
        assert_eq!(get("OPENAI_API_KEY"), Some("sk-secret"));
        assert_eq!(get("ANOMANDER_PRINCIPAL_CHAT_ID"), Some("42"));
        assert_eq!(get("ANOMANDER_MODEL"), Some("openai/gpt-4o-mini"));
        assert_eq!(get("ANOMANDER_VISION_MODEL"), None);
        assert_eq!(get("ANOMANDER_LOCAL_TOKEN"), Some("t".repeat(64).as_str()));
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

        let sent = spec
            .env
            .iter()
            .find(|(name, _)| name == "ANOMANDER_MCP_SECRETS")
            .map(|(_, json)| json.as_str())
            .ok_or("the secrets were not handed over")?;
        let sent: BTreeMap<String, String> =
            serde_json::from_str(sent).map_err(|e| e.to_string())?;
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
        assert!(again.env.iter().any(|(name, json)| {
            name == "ANOMANDER_MCP_SECRETS" && json.contains("tok-secret-1")
        }));
        Ok(())
    }

    #[test]
    fn without_connections_no_secret_of_theirs_is_handed_over() {
        let (store, settings) = configured();
        let f = fixture(store, settings);
        let Prepared::Ready(spec) = f.core.prepare() else {
            panic!("a configured setup was not ready");
        };
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
        assert!(spec
            .env
            .contains(&("GEMINI_API_KEY".into(), "g-key".into())));
        // The model is unset: the daemon starts its setup guide (R-28).
        assert!(!spec.env.iter().any(|(name, _)| name == "ANOMANDER_MODEL"));
        Ok(())
    }
}
