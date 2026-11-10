// The shapes of `apps/desktop/src/shell.ts`, the seam with the window. Field names and enum strings
// must match it exactly; change both together.
use serde::Serialize;

/// DK-6 AC1: what the menu bar icon shows. `Starting` is a daemon launched and not yet listening.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DaemonState {
    Starting,
    Running,
    Stopped,
    Failing,
}

/// Why the daemon is not running, when the shell knows.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    /// The setup still lacks the bot token or the principal's chat ID.
    NotConfigured,
    /// Exit code 3: another daemon runs on the same database (DK-2 AC1).
    AlreadyRunning,
    /// Exit code 4: another ANOMANDER uses the Telegram bot (DK-2 AC2).
    BotInUse,
    /// It exited 3 times within 5 minutes (DK-1 AC2).
    GaveUp,
    /// Stopped from the menu bar or the window.
    StoppedByPrincipal,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonStatus {
    pub state: DaemonState,
    pub reason: Option<StopReason>,
    /// The daemon's last error line, with every secret removed (DK-1 AC2).
    pub last_error: Option<String>,
}

impl DaemonStatus {
    pub fn stopped(reason: StopReason, last_error: Option<String>) -> Self {
        Self {
            state: DaemonState::Stopped,
            reason: Some(reason),
            last_error,
        }
    }
}

/// Where the chat connects (DK-3); only while the daemon is `running`.
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalChannel {
    pub url: String,
    pub token: String,
}

// DK-3 AC3: the token never reaches a log, not even through `{:?}`.
impl std::fmt::Debug for LocalChannel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LocalChannel")
            .field("url", &self.url)
            .field("token", &"[secret]")
            .finish()
    }
}

/// What the setup screen shows. Secrets are never sent back: only whether each one is stored.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupState {
    pub has_telegram_bot_token: bool,
    pub principal_chat_id: Option<String>,
    pub model: Option<String>,
    pub vision_model: Option<String>,
    pub provider_keys: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub daemon: DaemonStatus,
    pub channel: Option<LocalChannel>,
    pub setup: SetupState,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_running_snapshot_has_the_field_names_of_shell_ts() {
        let snapshot = Snapshot {
            daemon: DaemonStatus {
                state: DaemonState::Running,
                reason: None,
                last_error: None,
            },
            channel: Some(LocalChannel {
                url: "ws://127.0.0.1:4312".into(),
                token: "abc".into(),
            }),
            setup: SetupState {
                has_telegram_bot_token: true,
                principal_chat_id: Some("42".into()),
                model: Some("openai/gpt-4o-mini".into()),
                vision_model: None,
                provider_keys: vec!["OPENAI_API_KEY".into()],
            },
        };
        assert_eq!(
            serde_json::to_value(&snapshot).ok(),
            Some(json!({
                "daemon": { "state": "running", "reason": null, "lastError": null },
                "channel": { "url": "ws://127.0.0.1:4312", "token": "abc" },
                "setup": {
                    "hasTelegramBotToken": true,
                    "principalChatId": "42",
                    "model": "openai/gpt-4o-mini",
                    "visionModel": null,
                    "providerKeys": ["OPENAI_API_KEY"]
                }
            }))
        );
    }

    #[test]
    fn every_state_and_reason_is_spelled_as_in_shell_ts() {
        let spelled = |value: serde_json::Value| value.as_str().map(str::to_owned);
        let states = [
            (DaemonState::Starting, "starting"),
            (DaemonState::Running, "running"),
            (DaemonState::Stopped, "stopped"),
            (DaemonState::Failing, "failing"),
        ];
        for (state, name) in states {
            assert_eq!(
                serde_json::to_value(state)
                    .ok()
                    .and_then(spelled)
                    .as_deref(),
                Some(name)
            );
        }
        let reasons = [
            (StopReason::NotConfigured, "not_configured"),
            (StopReason::AlreadyRunning, "already_running"),
            (StopReason::BotInUse, "bot_in_use"),
            (StopReason::GaveUp, "gave_up"),
            (StopReason::StoppedByPrincipal, "stopped_by_principal"),
        ];
        for (reason, name) in reasons {
            assert_eq!(
                serde_json::to_value(reason)
                    .ok()
                    .and_then(spelled)
                    .as_deref(),
                Some(name)
            );
        }
    }

    #[test]
    fn a_stopped_snapshot_carries_its_reason_and_last_error() {
        let status = DaemonStatus::stopped(StopReason::GaveUp, Some("boom".into()));
        assert_eq!(
            serde_json::to_value(&status).ok(),
            Some(json!({ "state": "stopped", "reason": "gave_up", "lastError": "boom" }))
        );
    }

    #[test]
    fn the_token_never_shows_in_debug() {
        let channel = LocalChannel {
            url: "ws://127.0.0.1:1".into(),
            token: "do-not-print".into(),
        };
        assert!(!format!("{channel:?}").contains("do-not-print"));
    }
}
