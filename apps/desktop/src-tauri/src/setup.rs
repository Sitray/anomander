// DK-5 AC1: what the setup screen saves. Secrets go to the `SecretStore` (the Keychain); the
// rest, with the names of the stored provider keys, to `settings.json` in the data folder (DK-8).
use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::data_dir::DataDir;
use crate::secure_store::SecretStore;
use crate::snapshot::SetupState;

/// The Keychain account of the bot token: the daemon's variable name.
pub const TELEGRAM_BOT_TOKEN: &str = "TELEGRAM_BOT_TOKEN";

/// T13: Telegram is optional, but half of it is a mistake rather than a choice.
pub const HALF_TELEGRAM: &str = "Telegram needs both the bot token and your chat ID; leave both empty to use ANOMANDER without Telegram";

/// What `settings.json` holds: no secret, only which ones are stored.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub principal_chat_id: Option<String>,
    pub model: Option<String>,
    pub vision_model: Option<String>,
    pub provider_keys: Vec<String>,
    /// The Keychain accounts that hold values of `mcp.json` (`connection_secrets`).
    pub connection_secrets: Vec<String>,
    /// DK-21: `ANOMANDER_DAILY_AI_CALL_LIMIT`; unset, the daemon's default. Absent from the file
    /// while unset, so a file written before it reads the same.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub daily_ai_call_limit: Option<u32>,
}

/// `SetupInput` of `shell.ts`. Holds secrets: no `Debug`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupInput {
    /// Omitted (or empty) keeps the stored token.
    #[serde(default)]
    pub telegram_bot_token: Option<String>,
    pub principal_chat_id: String,
    pub model: String,
    pub vision_model: String,
    /// A string stores the key (an empty one changes nothing), `null` removes it.
    #[serde(default)]
    pub provider_keys: BTreeMap<String, Option<String>>,
    /// DK-21: from 1 to 10000; omitted keeps the stored one.
    #[serde(default)]
    pub daily_ai_call_limit: Option<u32>,
}

/// DK-21: the daily limit of AI calls the setup takes.
pub const DAILY_AI_CALL_LIMITS: std::ops::RangeInclusive<u32> = 1..=10_000;

/// The secrets one start of the daemon needs. No `Debug`.
pub struct Secrets {
    pub telegram_bot_token: Option<String>,
    pub provider_keys: Vec<(String, String)>,
}

/// A provider variable such as `OPENAI_API_KEY`: `^[A-Z][A-Z0-9_]*_API_KEY$`.
pub fn is_provider_key_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix("_API_KEY") else {
        return false;
    };
    let mut chars = stem.chars();
    chars.next().is_some_and(|first| first.is_ascii_uppercase())
        && chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
}

/// `ANOMANDER_PRINCIPAL_CHAT_ID` as the daemon reads it: `^-?\d+$`.
fn is_chat_id(value: &str) -> bool {
    let digits = value.strip_prefix('-').unwrap_or(value);
    !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
}

/// A provider-qualified model ID, as the daemon's `parseModelId`: `provider/id`, neither empty.
fn is_model_id(value: &str) -> bool {
    value
        .split_once('/')
        .is_some_and(|(provider, id)| !provider.is_empty() && !id.is_empty())
}

/// A trimmed value, `None` when empty.
fn optional(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

fn checked_model(field: &str, value: &str) -> Result<Option<String>, String> {
    match optional(value) {
        Some(model) if !is_model_id(&model) => Err(format!(
            "the {field} must be provider-qualified, as in openai/gpt-4o-mini: {model}"
        )),
        model => Ok(model),
    }
}

/// Reads `settings.json`; a missing file is an empty setup.
pub fn load_settings(path: &Path) -> Result<Settings, String> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| format!("{} is not valid settings: {error}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
        Err(error) => Err(format!("could not read {}: {error}", path.display())),
    }
}

/// Writes `settings.json` with mode `600` (DK-8 AC1).
pub fn save_settings(dir: &DataDir, settings: &Settings) -> std::io::Result<()> {
    let mut json = serde_json::to_vec_pretty(settings).map_err(std::io::Error::other)?;
    json.push(b'\n');
    let name = dir
        .settings_path()
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "settings.json".into());
    dir.write_private(&name, &json)
}

/// Validates `input` whole, then stores its secrets and returns the settings to save. Nothing is
/// stored when any field is invalid.
pub fn apply_setup(
    input: &SetupInput,
    current: &Settings,
    store: &dyn SecretStore,
) -> Result<Settings, String> {
    // Validate everything first, so an invalid field stores nothing.
    let principal_chat_id = optional(&input.principal_chat_id);
    if let Some(chat_id) = &principal_chat_id {
        if !is_chat_id(chat_id) {
            return Err(format!(
                "the principal chat ID must be an integer: {chat_id}"
            ));
        }
    }
    // Both halves of Telegram, typed now or the token stored before, or neither: an empty chat ID
    // with no token typed goes without Telegram, whatever token is stored.
    let token = input.telegram_bot_token.as_deref().and_then(optional);
    let has_token = || -> Result<bool, String> {
        Ok(token.is_some() || store.get(TELEGRAM_BOT_TOKEN).map_err(|e| e.0)?.is_some())
    };
    if principal_chat_id.is_none() && token.is_some()
        || principal_chat_id.is_some() && !has_token()?
    {
        return Err(HALF_TELEGRAM.to_owned());
    }
    if let Some(limit) = input
        .daily_ai_call_limit
        .filter(|limit| !DAILY_AI_CALL_LIMITS.contains(limit))
    {
        return Err(format!(
            "the daily limit of AI calls must be a whole number from 1 to 10000: {limit}"
        ));
    }
    let model = checked_model("model", &input.model)?;
    let vision_model = checked_model("vision model", &input.vision_model)?;
    if let Some(name) = input
        .provider_keys
        .keys()
        .find(|name| !is_provider_key_name(name))
    {
        return Err(format!(
            "{name} is not a provider key name such as OPENAI_API_KEY"
        ));
    }

    let failed = |error: crate::secure_store::StoreError| error.0;
    if let Some(token) = token {
        store.set(TELEGRAM_BOT_TOKEN, &token).map_err(failed)?;
    }
    let mut provider_keys = current.provider_keys.clone();
    for (name, key) in &input.provider_keys {
        match key.as_deref().map(str::trim) {
            None => {
                store.delete(name).map_err(failed)?;
                provider_keys.retain(|stored| stored != name);
            }
            Some("") => {}
            Some(key) => {
                store.set(name, key).map_err(failed)?;
                provider_keys.push(name.clone());
            }
        }
    }
    provider_keys.sort();
    provider_keys.dedup();
    Ok(Settings {
        principal_chat_id,
        model,
        vision_model,
        provider_keys,
        connection_secrets: current.connection_secrets.clone(),
        daily_ai_call_limit: input.daily_ai_call_limit.or(current.daily_ai_call_limit),
    })
}

/// The setup a Docker install's `.env` holds, for a one-time import (`ANOMANDER_IMPORT_ENV`): the
/// bot token, the principal's chat ID, both models and every provider key. Paths, schedules and
/// everything else are left out: the app owns its data folder. Lines are `NAME=value`, a value
/// optionally in single or double quotes; comments and anything else are skipped.
pub fn setup_from_env_file(text: &str) -> SetupInput {
    let mut input = SetupInput {
        telegram_bot_token: None,
        principal_chat_id: String::new(),
        model: String::new(),
        vision_model: String::new(),
        provider_keys: BTreeMap::new(),
        daily_ai_call_limit: None,
    };
    for line in text.lines() {
        let line = line.trim();
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((name, value)) = line.split_once('=') else {
            continue;
        };
        let (name, value) = (name.trim(), value.trim());
        let value = ['"', '\'']
            .iter()
            .find_map(|&quote| value.strip_prefix(quote)?.strip_suffix(quote))
            .unwrap_or(value);
        if value.is_empty() {
            continue;
        }
        match name {
            TELEGRAM_BOT_TOKEN => input.telegram_bot_token = Some(value.to_owned()),
            "ANOMANDER_PRINCIPAL_CHAT_ID" => input.principal_chat_id = value.to_owned(),
            "ANOMANDER_MODEL" => input.model = value.to_owned(),
            "ANOMANDER_VISION_MODEL" => input.vision_model = value.to_owned(),
            name if is_provider_key_name(name) => {
                input
                    .provider_keys
                    .insert(name.to_owned(), Some(value.to_owned()));
            }
            _ => {}
        }
    }
    input
}

pub fn setup_state(settings: &Settings, has_telegram_bot_token: bool) -> SetupState {
    SetupState {
        has_telegram_bot_token,
        principal_chat_id: settings.principal_chat_id.clone(),
        model: settings.model.clone(),
        vision_model: settings.vision_model.clone(),
        provider_keys: settings.provider_keys.clone(),
    }
}

/// The stored secrets of `settings`; a listed provider key missing from the store is skipped.
pub fn load_secrets(settings: &Settings, store: &dyn SecretStore) -> Result<Secrets, String> {
    let telegram_bot_token = store.get(TELEGRAM_BOT_TOKEN).map_err(|error| error.0)?;
    let mut provider_keys = Vec::new();
    for name in &settings.provider_keys {
        if let Some(key) = store.get(name).map_err(|error| error.0)? {
            provider_keys.push((name.clone(), key));
        }
    }
    Ok(Secrets {
        telegram_bot_token,
        provider_keys,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_env_file_becomes_a_setup_with_its_secrets_and_none_of_its_paths() {
        let input = setup_from_env_file(
            "# Telegram\nTELEGRAM_BOT_TOKEN=123:abc\nANOMANDER_PRINCIPAL_CHAT_ID=4242\n\
             ANOMANDER_DB_PATH=/app/data/anomander.db\nANOMANDER_MODEL=\"google/gemini-x\"\n\
             export ANOMANDER_VISION_MODEL='google/gemini-y'\nGEMINI_API_KEY=g-key\n\
             OPENAI_API_KEY=\nTZ=Europe/Madrid\nnot a line\n",
        );
        assert_eq!(input.telegram_bot_token.as_deref(), Some("123:abc"));
        assert_eq!(input.principal_chat_id, "4242");
        assert_eq!(input.model, "google/gemini-x");
        assert_eq!(input.vision_model, "google/gemini-y");
        assert_eq!(
            input.provider_keys.into_iter().collect::<Vec<_>>(),
            vec![("GEMINI_API_KEY".to_owned(), Some("g-key".to_owned()))]
        );
    }
    use crate::secure_store::MemoryStore;
    use serde_json::json;

    fn input(value: serde_json::Value) -> SetupInput {
        serde_json::from_value(value).unwrap_or_else(|error| panic!("bad test input: {error}"))
    }

    fn full_input() -> SetupInput {
        input(json!({
            "telegramBotToken": " bot:secret ",
            "principalChatId": " 42 ",
            "model": "openai/gpt-4o-mini",
            "visionModel": "",
            "providerKeys": { "OPENAI_API_KEY": "sk-secret", "ANTHROPIC_API_KEY": "sk-ant" }
        }))
    }

    /// DK-21: a setup with a daily limit of AI calls (`limit`), and nothing else but a model.
    fn with_limit(limit: Option<i64>) -> serde_json::Value {
        let mut value = json!({
            "principalChatId": "",
            "model": "openai/gpt-4o-mini",
            "visionModel": "",
            "telegramBotToken": "",
            "providerKeys": { "OPENAI_API_KEY": "sk-new" }
        });
        if let (Some(limit), Some(object)) = (limit, value.as_object_mut()) {
            object.insert("dailyAiCallLimit".into(), json!(limit));
        }
        value
    }

    #[test]
    fn a_daily_ai_call_limit_from_1_to_10000_is_kept_and_an_omitted_one_keeps_the_stored(
    ) -> Result<(), String> {
        let store = MemoryStore::default();
        for limit in [1, 500, 10_000] {
            let settings = apply_setup(
                &input(with_limit(Some(limit))),
                &Settings::default(),
                &store,
            )?;
            assert_eq!(settings.daily_ai_call_limit, u32::try_from(limit).ok());
        }
        let stored = Settings {
            daily_ai_call_limit: Some(500),
            ..Settings::default()
        };
        let kept = apply_setup(&input(with_limit(None)), &stored, &store)?;
        assert_eq!(kept.daily_ai_call_limit, Some(500));
        assert_eq!(
            apply_setup(&input(with_limit(None)), &Settings::default(), &store)?
                .daily_ai_call_limit,
            None
        );
        Ok(())
    }

    #[test]
    fn a_daily_ai_call_limit_outside_1_to_10000_is_refused_and_nothing_is_stored() {
        for limit in [0, 10_001] {
            let store = MemoryStore::default();
            assert_eq!(
                apply_setup(
                    &input(with_limit(Some(limit))),
                    &Settings::default(),
                    &store
                ),
                Err(format!(
                    "the daily limit of AI calls must be a whole number from 1 to 10000: {limit}"
                ))
            );
            assert_eq!(store.get("OPENAI_API_KEY").ok().flatten(), None);
        }
    }

    #[test]
    fn provider_key_names_follow_the_daemons_pattern() {
        for name in [
            "OPENAI_API_KEY",
            "GEMINI_API_KEY",
            "X_API_KEY",
            "A2_B_API_KEY",
        ] {
            assert!(is_provider_key_name(name), "{name}");
        }
        for name in [
            "",
            "_API_KEY",
            "API_KEY",
            "openai_API_KEY",
            "1X_API_KEY",
            "TELEGRAM_BOT_TOKEN",
            "OPENAI_API_KEY ",
            "OPEN-AI_API_KEY",
            "PATH",
        ] {
            assert!(!is_provider_key_name(name), "{name}");
        }
    }

    #[test]
    fn secrets_go_to_the_store_and_the_rest_to_the_settings() -> Result<(), String> {
        let store = MemoryStore::default();
        let settings = apply_setup(&full_input(), &Settings::default(), &store)?;
        assert_eq!(
            settings,
            Settings {
                principal_chat_id: Some("42".into()),
                model: Some("openai/gpt-4o-mini".into()),
                vision_model: None,
                provider_keys: vec!["ANTHROPIC_API_KEY".into(), "OPENAI_API_KEY".into()],
                connection_secrets: Vec::new(),
                daily_ai_call_limit: None,
            }
        );
        assert_eq!(
            store.get(TELEGRAM_BOT_TOKEN).ok().flatten().as_deref(),
            Some("bot:secret")
        );
        assert_eq!(
            store.get("OPENAI_API_KEY").ok().flatten().as_deref(),
            Some("sk-secret")
        );
        let saved = serde_json::to_string(&settings).map_err(|e| e.to_string())?;
        assert!(!saved.contains("secret") && !saved.contains("sk-ant"));
        Ok(())
    }

    #[test]
    fn an_omitted_or_empty_token_keeps_the_stored_one() -> Result<(), String> {
        let store = MemoryStore::default();
        store.set(TELEGRAM_BOT_TOKEN, "bot:old").map_err(|e| e.0)?;
        for token in [json!(null), json!(""), json!("  ")] {
            let mut value = json!({ "principalChatId": "1", "model": "", "visionModel": "" });
            if !token.is_null() {
                value["telegramBotToken"] = token;
            }
            apply_setup(&input(value), &Settings::default(), &store)?;
            assert_eq!(
                store.get(TELEGRAM_BOT_TOKEN).ok().flatten().as_deref(),
                Some("bot:old")
            );
        }
        Ok(())
    }

    #[test]
    fn null_removes_a_key_and_unmentioned_keys_stay() -> Result<(), String> {
        let store = MemoryStore::default();
        let first = apply_setup(&full_input(), &Settings::default(), &store)?;
        let second = apply_setup(
            &input(json!({
                "principalChatId": "42",
                "model": "openai/gpt-4o-mini",
                "visionModel": "openai/gpt-4o",
                "providerKeys": { "OPENAI_API_KEY": null, "GEMINI_API_KEY": "" }
            })),
            &first,
            &store,
        )?;
        assert_eq!(second.provider_keys, vec!["ANTHROPIC_API_KEY".to_owned()]);
        assert_eq!(second.vision_model.as_deref(), Some("openai/gpt-4o"));
        assert_eq!(store.names(), vec!["ANTHROPIC_API_KEY", TELEGRAM_BOT_TOKEN]);
        Ok(())
    }

    #[test]
    fn an_invalid_field_is_refused_and_nothing_is_stored() {
        let cases = [
            (
                json!({ "principalChatId": "abc", "model": "", "visionModel": "" }),
                "chat ID",
            ),
            (
                json!({ "principalChatId": "4 2", "model": "", "visionModel": "" }),
                "chat ID",
            ),
            (
                json!({ "principalChatId": "1", "model": "gpt-4o", "visionModel": "" }),
                "model",
            ),
            (
                json!({ "principalChatId": "1", "model": "", "visionModel": "openai/" }),
                "model",
            ),
            (
                json!({ "principalChatId": "1", "model": "", "visionModel": "",
                        "providerKeys": { "PATH": "x" } }),
                "PATH",
            ),
        ];
        for (mut value, needle) in cases {
            value["telegramBotToken"] = json!("bot:secret");
            let store = MemoryStore::default();
            let result = apply_setup(&input(value), &Settings::default(), &store);
            match result {
                Err(message) => {
                    assert!(message.contains(needle), "{message}");
                    assert!(!message.contains("bot:secret"));
                }
                Ok(_) => panic!("accepted an invalid {needle}"),
            }
            assert!(store.names().is_empty());
        }
    }

    #[test]
    fn a_negative_chat_id_is_valid_and_an_empty_one_is_unset() -> Result<(), String> {
        let store = MemoryStore::default();
        let base = json!({ "model": "", "visionModel": "" });
        let mut negative = base.clone();
        negative["principalChatId"] = json!("-1001");
        negative["telegramBotToken"] = json!("bot:1");
        let settings = apply_setup(&input(negative), &Settings::default(), &store)?;
        assert_eq!(settings.principal_chat_id.as_deref(), Some("-1001"));
        let mut empty = base;
        empty["principalChatId"] = json!("");
        let settings = apply_setup(&input(empty), &Settings::default(), &store)?;
        assert_eq!(settings.principal_chat_id, None);
        Ok(())
    }

    #[test]
    fn telegram_is_optional_and_saving_without_it_works() -> Result<(), String> {
        let store = MemoryStore::default();
        let settings = apply_setup(
            &input(json!({
                "principalChatId": " ",
                "model": "openai/gpt-4o-mini",
                "visionModel": "",
                "providerKeys": { "OPENAI_API_KEY": "sk-1" }
            })),
            &Settings::default(),
            &store,
        )?;
        assert_eq!(settings.principal_chat_id, None);
        assert_eq!(settings.model.as_deref(), Some("openai/gpt-4o-mini"));
        assert_eq!(store.names(), vec!["OPENAI_API_KEY"]);
        Ok(())
    }

    #[test]
    fn half_of_telegram_is_refused_and_nothing_is_stored() {
        let cases = [
            json!({ "telegramBotToken": "bot:secret", "principalChatId": "",
                    "model": "", "visionModel": "", "providerKeys": { "OPENAI_API_KEY": "sk-1" } }),
            json!({ "principalChatId": "42", "model": "", "visionModel": "",
                    "providerKeys": { "OPENAI_API_KEY": "sk-1" } }),
        ];
        for value in cases {
            let store = MemoryStore::default();
            match apply_setup(&input(value), &Settings::default(), &store) {
                Err(message) => {
                    assert_eq!(message, HALF_TELEGRAM);
                    assert!(!message.contains("bot:secret"));
                }
                Ok(_) => panic!("accepted half of Telegram"),
            }
            assert!(store.names().is_empty());
        }
    }

    #[test]
    fn a_chat_id_with_the_token_stored_before_is_telegram_whole() -> Result<(), String> {
        let store = MemoryStore::default();
        store.set(TELEGRAM_BOT_TOKEN, "bot:old").map_err(|e| e.0)?;
        let value = json!({ "principalChatId": "42", "model": "", "visionModel": "" });
        let settings = apply_setup(&input(value), &Settings::default(), &store)?;
        assert_eq!(settings.principal_chat_id.as_deref(), Some("42"));
        Ok(())
    }

    #[test]
    fn a_store_failure_is_reported_without_the_secret() {
        let store = MemoryStore::failing();
        match apply_setup(&full_input(), &Settings::default(), &store) {
            Err(message) => assert!(!message.contains("secret"), "{message}"),
            Ok(_) => panic!("a failed write was reported as saved"),
        }
    }

    #[test]
    fn the_setup_state_says_which_secrets_exist_but_not_their_values() {
        let settings = Settings {
            principal_chat_id: Some("42".into()),
            model: Some("openai/gpt-4o-mini".into()),
            vision_model: None,
            provider_keys: vec!["OPENAI_API_KEY".into()],
            connection_secrets: Vec::new(),
            daily_ai_call_limit: None,
        };
        assert_eq!(
            setup_state(&settings, true),
            SetupState {
                has_telegram_bot_token: true,
                principal_chat_id: Some("42".into()),
                model: Some("openai/gpt-4o-mini".into()),
                vision_model: None,
                provider_keys: vec!["OPENAI_API_KEY".into()],
            }
        );
    }

    #[test]
    fn loading_secrets_skips_a_listed_key_the_store_lacks() -> Result<(), String> {
        let store = MemoryStore::default();
        store.set(TELEGRAM_BOT_TOKEN, "bot:1").map_err(|e| e.0)?;
        store.set("OPENAI_API_KEY", "sk-1").map_err(|e| e.0)?;
        let settings = Settings {
            provider_keys: vec!["GEMINI_API_KEY".into(), "OPENAI_API_KEY".into()],
            ..Settings::default()
        };
        let secrets = load_secrets(&settings, &store)?;
        assert_eq!(secrets.telegram_bot_token.as_deref(), Some("bot:1"));
        assert_eq!(
            secrets.provider_keys,
            vec![("OPENAI_API_KEY".to_owned(), "sk-1".to_owned())]
        );
        Ok(())
    }

    #[test]
    fn settings_are_saved_as_camel_case_json_with_mode_600() -> Result<(), String> {
        let parent = tempfile::tempdir().map_err(|e| e.to_string())?;
        let dir = DataDir::open(parent.path().join("ANOMANDER")).map_err(|e| e.to_string())?;
        let settings = Settings {
            principal_chat_id: Some("42".into()),
            model: None,
            vision_model: Some("openai/gpt-4o".into()),
            provider_keys: vec!["OPENAI_API_KEY".into()],
            connection_secrets: vec!["mcp/notes/env/TOKEN".into()],
            daily_ai_call_limit: None,
        };
        save_settings(&dir, &settings).map_err(|e| e.to_string())?;
        let text = std::fs::read_to_string(dir.settings_path()).map_err(|e| e.to_string())?;
        let value: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        assert_eq!(
            value,
            json!({
                "principalChatId": "42",
                "model": null,
                "visionModel": "openai/gpt-4o",
                "providerKeys": ["OPENAI_API_KEY"],
                "connectionSecrets": ["mcp/notes/env/TOKEN"]
            })
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.settings_path())
                .map_err(|e| e.to_string())?
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        assert_eq!(load_settings(&dir.settings_path())?, settings);
        Ok(())
    }

    #[test]
    fn a_missing_settings_file_is_an_empty_setup_and_a_broken_one_an_error() -> Result<(), String> {
        let parent = tempfile::tempdir().map_err(|e| e.to_string())?;
        let path = parent.path().join("settings.json");
        assert_eq!(load_settings(&path)?, Settings::default());
        std::fs::write(&path, "{not json").map_err(|e| e.to_string())?;
        assert!(load_settings(&path).is_err());
        // Unknown and missing fields are tolerated.
        std::fs::write(&path, r#"{"model":"a/b","later":1}"#).map_err(|e| e.to_string())?;
        assert_eq!(load_settings(&path)?.model.as_deref(), Some("a/b"));
        Ok(())
    }
}
