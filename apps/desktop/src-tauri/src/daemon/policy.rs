// DK-1 AC2 and DK-2 AC3: whether a daemon that exited on its own is started again.
use std::time::{Duration, Instant};

use crate::snapshot::StopReason;

/// Exit codes of `packages/protocol/src/daemon-process.ts`, pinned to
/// `packages/protocol/fixtures/exit-codes.json` by a test below.
pub const EXIT_ALREADY_RUNNING: i32 = 3;
pub const EXIT_BOT_IN_USE: i32 = 4;

/// DK-1 AC2: after this many own exits within `EXIT_WINDOW`, the shell stops trying.
pub const MAX_OWN_EXITS: usize = 3;
pub const EXIT_WINDOW: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AfterExit {
    Restart,
    Stop(StopReason),
}

/// The instants of the daemon's own exits; a principal's start clears it (DK-1 AC2).
#[derive(Debug, Default)]
pub struct ExitHistory {
    exits: Vec<Instant>,
}

impl ExitHistory {
    /// Records an own exit at `now` and returns how many fall within the window, this one included.
    pub fn record(&mut self, now: Instant) -> usize {
        self.exits
            .retain(|exit| now.saturating_duration_since(*exit) < EXIT_WINDOW);
        self.exits.push(now);
        self.exits.len()
    }

    pub fn clear(&mut self) {
        self.exits.clear();
    }
}

/// What to do after an own exit with `code` (`None` when a signal ended it), given how many own
/// exits fell within the window, this one included.
pub fn after_exit(code: Option<i32>, exits_in_window: usize) -> AfterExit {
    match code {
        // DK-2 AC3: starting again cannot help while another daemon or bot reader is there.
        Some(EXIT_ALREADY_RUNNING) => AfterExit::Stop(StopReason::AlreadyRunning),
        Some(EXIT_BOT_IN_USE) => AfterExit::Stop(StopReason::BotInUse),
        _ if exits_in_window >= MAX_OWN_EXITS => AfterExit::Stop(StopReason::GaveUp),
        _ => AfterExit::Restart,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// DK-2 AC3: the codes the daemon exits with, as `packages/protocol` pins them.
    fn pinned() -> serde_json::Map<String, serde_json::Value> {
        let text = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../packages/protocol/fixtures/exit-codes.json"
        ));
        match serde_json::from_str(text) {
            Ok(serde_json::Value::Object(codes)) => codes,
            _ => panic!("exit-codes.json is not a JSON object"),
        }
    }

    #[test]
    fn the_exit_codes_are_the_daemons() {
        let codes = pinned();
        let code = |name: &str| codes.get(name).and_then(serde_json::Value::as_i64);
        assert_eq!(
            code("alreadyRunning"),
            Some(i64::from(EXIT_ALREADY_RUNNING))
        );
        assert_eq!(code("botInUse"), Some(i64::from(EXIT_BOT_IN_USE)));
        // Any other code is a failure the supervisor restarts.
        let failed = code("failed")
            .and_then(|code| i32::try_from(code).ok())
            .unwrap_or_else(|| panic!("exit-codes.json has no `failed`"));
        assert_eq!(after_exit(Some(failed), 1), AfterExit::Restart);
    }

    #[test]
    fn a_failure_is_restarted_until_the_third_exit() {
        assert_eq!(after_exit(Some(1), 1), AfterExit::Restart);
        assert_eq!(after_exit(Some(1), 2), AfterExit::Restart);
        assert_eq!(after_exit(Some(1), 3), AfterExit::Stop(StopReason::GaveUp));
    }

    #[test]
    fn an_exit_by_signal_or_with_code_zero_counts_as_an_own_exit() {
        assert_eq!(after_exit(None, 1), AfterExit::Restart);
        assert_eq!(after_exit(Some(0), 1), AfterExit::Restart);
        assert_eq!(after_exit(None, 3), AfterExit::Stop(StopReason::GaveUp));
    }

    #[test]
    fn codes_3_and_4_are_never_retried() {
        assert_eq!(
            after_exit(Some(3), 1),
            AfterExit::Stop(StopReason::AlreadyRunning)
        );
        assert_eq!(
            after_exit(Some(4), 1),
            AfterExit::Stop(StopReason::BotInUse)
        );
    }

    #[test]
    fn only_exits_within_five_minutes_count() {
        let start = Instant::now();
        let mut history = ExitHistory::default();
        assert_eq!(history.record(start), 1);
        assert_eq!(history.record(start + Duration::from_secs(60)), 2);
        // The first exit is now more than 5 minutes old.
        assert_eq!(history.record(start + Duration::from_secs(301)), 2);
        assert_eq!(history.record(start + Duration::from_secs(302)), 3);
    }

    #[test]
    fn clearing_forgets_every_exit() {
        let now = Instant::now();
        let mut history = ExitHistory::default();
        history.record(now);
        history.record(now);
        history.clear();
        assert_eq!(history.record(now), 1);
    }
}
