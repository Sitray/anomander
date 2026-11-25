// What the shell knows besides the daemon's status: the data folder (DK-8), the setup and its
// secrets (DK-5) and this launch's token (DK-3 AC2), and how they become one start of the daemon.
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use crate::daemon::launch::{
    child_env, free_port, handover_line, runtime, Bundled, DaemonInputs, DaemonRuntime,
    TelegramInputs,
};
use crate::daemon::supervisor::{LaunchSpec, Prepared, Update};
use crate::data_dir::DataDir;
use crate::ledger_import::{self, LedgerImport};
use crate::oauth_connect::{self, OAuthSet};
use crate::secure_store::SecretStore;
use crate::setup::{
    apply_setup, load_secrets, save_settings, setup_state, Settings, SetupInput,
    DAILY_AI_CALL_LIMITS, TELEGRAM_BOT_TOKEN,
};
use crate::snapshot::{NotificationMode, SetupState, Snapshot};

mod login;
mod mcp_servers;
mod oauth;
mod redaction;
#[cfg(test)]
mod test_support;

use login::tokens_of;
use redaction::hidden;

pub use login::MODEL_LOGIN;
pub use oauth::OAuthTurn;

/// Reads a variable of the app's own environment; injected so tests never depend on the real one.
pub type Environment = Box<dyn Fn(&str) -> Option<String> + Send + Sync>;

pub struct Core {
    data: DataDir,
    /// Shared with the handler of the model login the daemon hands over (DK-5 AC1).
    store: Arc<dyn SecretStore>,
    environment: Environment,
    /// B11: the daemon a release app carries; `None` runs this repository's.
    bundled: Option<Bundled>,
    /// DK-3 AC2: generated at each app launch, kept only in memory.
    token: String,
    setup: Mutex<SetupCache>,
    /// DK-11: an OAuth connection runs, from the browser to its tokens stored.
    connecting: AtomicBool,
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
        bundled: Option<Bundled>,
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
            bundled,
            token,
            setup: Mutex::new(SetupCache {
                settings,
                has_telegram_bot_token,
            }),
            connecting: AtomicBool::new(false),
        }
    }

    /// B11: the Node and the entry point the daemon and its scripts run with, and their `PATH`.
    pub fn daemon_runtime(&self) -> Result<DaemonRuntime, String> {
        runtime(&*self.environment, self.bundled.as_ref())
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

    /// DK-22: what the notifications show, as last saved.
    pub fn notifications(&self) -> NotificationMode {
        lock(&self.setup).settings.notifications
    }

    /// DK-22: saves what the notifications show, at once. The daemon is not touched.
    pub fn set_notifications(&self, mode: NotificationMode) -> Result<(), String> {
        let mut setup = lock(&self.setup);
        let settings = Settings {
            notifications: mode,
            ..setup.settings.clone()
        };
        save_settings(&self.data, &settings)
            .map_err(|error| format!("could not save the settings: {error}"))?;
        setup.settings = settings;
        Ok(())
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

    /// DK-12: imports the ledger the principal named into the data folder. Called with the
    /// daemon stopped (`Supervisor::while_stopped`): the script replaces the file it reads.
    pub fn import_ledger(&self, typed: &str) -> Result<LedgerImport, String> {
        let home = (self.environment)("HOME");
        let Some(source) = ledger_import::source_path(typed, home.as_deref()) else {
            return Ok(ledger_import::not_a_path());
        };
        let DaemonRuntime { node, entry, path } = self.daemon_runtime()?;
        let script = ledger_import::script_of(&entry)
            .filter(|script| script.is_file())
            .ok_or_else(|| format!("the import is not next to {}", entry.display()))?;
        ledger_import::run(&node, &script, &source, &self.data.daemon_paths().db, &path)
    }
    /// One start of the daemon (DK-1 AC1): `node <daemon>/src/main.ts`, the daemon the app carries
    /// or else this repository's, with the setup in the environment, its secrets on the handover
    /// line to its stdin (DK-5 AC2) and a fresh port.
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
        let DaemonRuntime { node, entry, path } = match self.daemon_runtime() {
            Ok(runtime) => runtime,
            Err(message) => return Prepared::Failed(message),
        };
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
                // Homebrew's folders, so the daemon finds the same tools as the shell did; last,
                // the folder of the Node a release app carries.
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
            time_zone: settings.time_zone.as_deref(),
            currency: settings.currency.as_deref(),
        };
        let mut env = child_env(&parent, &inputs);
        // DK-21: the principal's own limit; unset, or out of range in a file edited by hand, the
        // daemon keeps its default.
        if let Some(limit) = settings
            .daily_ai_call_limit
            .filter(|limit| DAILY_AI_CALL_LIMITS.contains(limit))
        {
            env.push(("ANOMANDER_DAILY_AI_CALL_LIMIT".into(), limit.to_string()));
        }
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
    use super::test_support::*;

    #[test]
    fn notify_only_is_saved_at_once_and_the_setup_says_it() -> Result<(), String> {
        let (store, settings) = configured();
        let f = fixture(store, settings);
        assert_eq!(f.core.notifications(), NotificationMode::Content);

        f.core.set_notifications(NotificationMode::NoticeOnly)?;

        assert_eq!(f.core.notifications(), NotificationMode::NoticeOnly);
        assert_eq!(
            f.core.setup_state().notifications,
            NotificationMode::NoticeOnly
        );
        let saved = load_settings(&f.root.join("settings.json"))?;
        assert_eq!(saved.notifications, NotificationMode::NoticeOnly);
        // The rest of the setup is left as it was.
        assert_eq!(saved.model.as_deref(), Some("openai/gpt-4o-mini"));
        Ok(())
    }

    // DK-25: the zone and the currency saved in Configuración reach the daemon's next start.
    #[test]
    fn the_zone_and_the_currency_saved_in_configuracion_reach_the_daemon() -> Result<(), String> {
        let (store, settings) = configured();
        let f = fixture(store, settings);
        let input: SetupInput = serde_json::from_value(json!({
            "principalChatId": "42", "model": "openai/gpt-4o-mini", "visionModel": "",
            "timeZone": "America/Mexico_City", "currency": "mxn"
        }))
        .map_err(|e| e.to_string())?;
        f.core.save_setup(&input)?;
        let env: BTreeMap<String, String> = ready(&f.core).env.into_iter().collect();
        assert_eq!(
            env.get("TZ").map(String::as_str),
            Some("America/Mexico_City")
        );
        assert_eq!(
            env.get("ANOMANDER_CURRENCY").map(String::as_str),
            Some("MXN")
        );
        Ok(())
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
                .is_err_and(|error| error.contains(platform::NODE)),
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
    fn a_stored_daily_ai_call_limit_reaches_the_daemons_environment_and_none_leaves_its_default() {
        let limit = |spec: &LaunchSpec| {
            spec.env
                .iter()
                .find(|(name, _)| name == "ANOMANDER_DAILY_AI_CALL_LIMIT")
                .map(|(_, value)| value.clone())
        };
        let (store, mut settings) = configured();
        settings.daily_ai_call_limit = Some(500);
        assert_eq!(
            limit(&ready(&fixture(store, settings).core)).as_deref(),
            Some("500")
        );

        let (store, settings) = configured();
        assert_eq!(limit(&ready(&fixture(store, settings).core)), None);
    }

    #[test]
    fn a_stored_daily_ai_call_limit_outside_1_to_10000_leaves_the_daemons_default() {
        for bad in [0, 10_001, u32::MAX] {
            let (store, mut settings) = configured();
            settings.daily_ai_call_limit = Some(bad);
            let spec = ready(&fixture(store, settings).core);
            assert!(!spec
                .env
                .iter()
                .any(|(n, _)| n == "ANOMANDER_DAILY_AI_CALL_LIMIT"));
        }
    }

    // B11: a release app runs the daemon it carries with the Node it carries, last on `PATH`; its
    // scripts are looked for next to that daemon.
    #[test]
    fn a_release_app_runs_the_daemon_and_the_node_it_carries(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let resources = tempfile::tempdir()?;
        let carried = resources.path().join("daemon");
        let node = carried
            .join("bin")
            .join(if cfg!(windows) { "node.exe" } else { "node" });
        let entry = carried.join("packages/daemon/src/main.ts");
        std::fs::create_dir_all(carried.join("bin"))?;
        std::fs::create_dir_all(carried.join("packages/daemon/src"))?;
        std::fs::write(&node, "")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755))?;
        }
        std::fs::write(&entry, "")?;
        let bundled = Bundled::find(resources.path()).ok_or("the carried daemon was not found")?;
        let parent = tempfile::tempdir()?;
        let root = parent.path().join("ANOMANDER");
        let environment: Environment = Box::new(|name| match name {
            "PATH" => Some(platform::PATH.into()),
            "HOME" => Some(platform::HOME.into()),
            _ => None,
        });
        let (store, settings) = configured();
        let core = Core::new(
            DataDir::open(root)?,
            Box::new(store),
            environment,
            Some(bundled.clone()),
            settings,
            "t".repeat(64),
        );
        let spec = ready(&core);
        assert_eq!(spec.program, bundled.node());
        assert_eq!(spec.args, vec![bundled.entry().into_os_string()]);
        let path = spec
            .env
            .iter()
            .find(|(name, _)| name == "PATH")
            .map(|(_, path)| path.clone())
            .unwrap_or_default();
        assert_eq!(
            std::env::split_paths(&path).last(),
            Some(bundled.bin()),
            "{path}"
        );
        // The carried tree has no import script here: the error points at the carried daemon.
        let answer = core.import_ledger("~/anomander.db");
        let carried_entry = bundled.entry().display().to_string();
        assert!(
            answer
                .as_ref()
                .is_err_and(|error| error.contains(&carried_entry)),
            "{answer:?}"
        );
        Ok(())
    }

    #[test]
    fn a_launch_runs_this_repositorys_daemon_with_the_setup_in_its_environment_and_its_secrets_on_stdin(
    ) {
        let (store, settings) = configured();
        let f = fixture(store, settings);
        let Prepared::Ready(spec) = f.core.prepare() else {
            panic!("a configured setup was not ready");
        };
        assert_eq!(spec.program, std::path::PathBuf::from(platform::NODE));
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
        assert_eq!(get("HOME"), Some(platform::HOME));
        assert_eq!(get("PATH"), Some(platform::SEARCHED_PATH));
        for secret in ["bot:secret", "sk-secret", "t".repeat(64).as_str()] {
            assert!(
                spec.secrets.iter().any(|s| s == secret),
                "{secret} is not redacted"
            );
        }
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
