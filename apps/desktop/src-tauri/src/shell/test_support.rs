// The fixture the tests of the shell's modules share: a `Core` over a temporary data folder.
pub(super) use super::*;
pub(super) use crate::secure_store::MemoryStore;
pub(super) use crate::setup::load_settings;
pub(super) use serde_json::json;
pub(super) use std::collections::BTreeMap;

/// The fixture's environment, in this platform's shape, and the `PATH` the daemon gets from it.
#[cfg(unix)]
pub(super) mod platform {
    pub const PATH: &str = "/usr/bin:/bin";
    pub const SEARCHED_PATH: &str = "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin";
    pub const HOME: &str = "/Users/p";
    pub const NODE: &str = "/opt/node/bin/node";
}
#[cfg(windows)]
pub(super) mod platform {
    pub const PATH: &str = r"C:\Windows\system32;C:\Program Files\nodejs";
    pub const SEARCHED_PATH: &str = PATH;
    pub const HOME: &str = r"C:\Users\p";
    pub const NODE: &str = r"C:\opt\node\node.exe";
}

pub(super) struct Fixture {
    _parent: tempfile::TempDir,
    pub(super) core: Core,
    pub(super) root: std::path::PathBuf,
}

pub(super) fn fixture(store: MemoryStore, settings: Settings) -> Fixture {
    let parent = tempfile::tempdir().unwrap_or_else(|e| panic!("no temp dir: {e}"));
    let root = parent.path().join("ANOMANDER");
    let data = DataDir::open(root.clone()).unwrap_or_else(|e| panic!("no data dir: {e}"));
    let environment: Environment = Box::new(|name| match name {
        "PATH" => Some(platform::PATH.into()),
        "HOME" => Some(platform::HOME.into()),
        "ANOMANDER_NODE" => Some(platform::NODE.into()),
        "OPENAI_API_KEY" => Some("from-the-shell".into()),
        _ => None,
    });
    let core = Core::new(
        data,
        Box::new(store),
        environment,
        None,
        settings,
        "t".repeat(64),
    );
    Fixture {
        _parent: parent,
        core,
        root,
    }
}

pub(super) fn configured() -> (MemoryStore, Settings) {
    let store = MemoryStore::default();
    let _ = store.set(TELEGRAM_BOT_TOKEN, "bot:secret");
    let _ = store.set("OPENAI_API_KEY", "sk-secret");
    let settings = Settings {
        principal_chat_id: Some("42".into()),
        model: Some("openai/gpt-4o-mini".into()),
        vision_model: None,
        provider_keys: vec!["OPENAI_API_KEY".into()],
        connection_secrets: Vec::new(),
        notifications: NotificationMode::Content,
        daily_ai_call_limit: None,
        ..Settings::default()
    };
    (store, settings)
}

/// DK-5 AC2: what a launch hands over on the daemon's stdin, by variable.
pub(super) fn handed(spec: &LaunchSpec) -> BTreeMap<String, String> {
    spec.handover
        .as_deref()
        .and_then(|line| serde_json::from_str(line).ok())
        .unwrap_or_default()
}

pub(super) fn login_env(spec: &LaunchSpec) -> Option<String> {
    handed(spec).remove("ANOMANDER_AUTH_JSON")
}

pub(super) fn ready(core: &Core) -> LaunchSpec {
    match core.prepare() {
        Prepared::Ready(spec) => spec,
        _ => panic!("a configured setup was not ready"),
    }
}
