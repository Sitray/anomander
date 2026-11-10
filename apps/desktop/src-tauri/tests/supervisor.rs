// DK-1 AC1-AC2 and DK-2 AC3, end to end: the supervisor runs a fake daemon (a `sh` script in a
// temporary folder) that behaves as `packages/daemon/src/main.ts` does at its edges.
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anomander_desktop_lib::daemon::supervisor::{
    LaunchSpec, Options, Prepared, Supervisor, Update,
};
use anomander_desktop_lib::snapshot::{DaemonState, StopReason};

const PORT: u16 = 45_678;
const SECRET: &str = "hunter2-bot-token";
const TOKEN: &str = "launch-token-for-the-test";

const LISTEN: &str =
    r#"echo "anomander local channel listening on 127.0.0.1:$ANOMANDER_LOCAL_PORT""#;

struct Fixture {
    dir: tempfile::TempDir,
    states: Arc<Mutex<Vec<DaemonState>>>,
    supervisor: Supervisor,
}

impl Fixture {
    /// A supervisor whose daemon is `/bin/sh` running `body`; each launch appends a line to `count`.
    fn new(body: &str, options: Options) -> Fixture {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("no temp dir: {e}"));
        let script = dir.path().join("daemon.sh");
        let count = dir.path().join("count");
        std::fs::write(&script, format!("echo x >> \"$COUNT\"\n{body}\n"))
            .unwrap_or_else(|e| panic!("could not write the fake daemon: {e}"));
        let cwd = dir.path().to_path_buf();
        let prepare = move || {
            Prepared::Ready(LaunchSpec {
                program: PathBuf::from("/bin/sh"),
                args: vec![script.clone().into_os_string()],
                env: vec![
                    ("PATH".into(), "/usr/bin:/bin".into()),
                    ("COUNT".into(), count.display().to_string()),
                    ("SECRET".into(), SECRET.into()),
                    ("ANOMANDER_LOCAL_PORT".into(), PORT.to_string()),
                ],
                cwd: cwd.clone(),
                port: PORT,
                token: TOKEN.into(),
                secrets: vec![SECRET.into(), TOKEN.into()],
            })
        };
        let states = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&states);
        let notify = move |update: Update| {
            if let Ok(mut seen) = seen.lock() {
                seen.push(update.status.state);
            }
        };
        let supervisor = Supervisor::new(Box::new(prepare), Box::new(notify), options);
        Fixture {
            dir,
            states,
            supervisor,
        }
    }

    fn launches(&self) -> usize {
        std::fs::read_to_string(self.dir.path().join("count"))
            .map(|text| text.lines().count())
            .unwrap_or(0)
    }

    fn wait_for(&self, what: &str, done: impl Fn(&Update) -> bool) -> Update {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let update = self.supervisor.current();
            if done(&update) {
                return update;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {what}: {update:?}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn wait_for_state(&self, state: DaemonState) -> Update {
        self.wait_for(&format!("{state:?}"), |update| update.status.state == state)
    }
}

fn fast() -> Options {
    Options {
        restart_delay: Duration::from_millis(20),
        stop_timeout: Duration::from_millis(300),
    }
}

fn is_gone(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    // SAFETY: signal 0 only checks whether the process exists.
    let alive = unsafe { libc::kill(pid, 0) } == 0;
    !alive && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

fn wait_for_pid(fixture: &Fixture) -> u32 {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(pid) = fixture.supervisor.pid() {
            return pid;
        }
        assert!(Instant::now() < deadline, "the daemon never started");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn it_is_running_once_the_local_channel_listens() {
    let fixture = Fixture::new(&format!("{LISTEN}\nread -r _"), fast());
    fixture.supervisor.start();
    let update = fixture.wait_for_state(DaemonState::Running);
    assert_eq!(update.status.reason, None);
    assert_eq!(update.status.last_error, None);
    let channel = update
        .channel
        .unwrap_or_else(|| panic!("running without a channel"));
    assert_eq!(channel.url, format!("ws://127.0.0.1:{PORT}"));
    assert_eq!(channel.token, TOKEN);
    let states = fixture.states.lock().map(|s| s.clone()).unwrap_or_default();
    assert_eq!(states.first(), Some(&DaemonState::Starting));
}

#[test]
fn a_daemon_that_exits_on_its_own_is_started_again() {
    let body = format!(
        "if [ \"$(wc -l < \"$COUNT\")\" -lt 2 ]; then echo \"anomander daemon failed: boom $SECRET\" >&2; exit 1; fi\n{LISTEN}\nread -r _"
    );
    let fixture = Fixture::new(&body, fast());
    fixture.supervisor.start();
    let update = fixture.wait_for_state(DaemonState::Running);
    assert_eq!(fixture.launches(), 2);
    assert_eq!(update.status.last_error, None);
    let states = fixture.states.lock().map(|s| s.clone()).unwrap_or_default();
    assert!(states.contains(&DaemonState::Failing), "{states:?}");
}

#[test]
fn after_three_own_exits_it_gives_up_with_the_last_error_and_no_secret() {
    let body = "echo 'first line' >&2\necho \"anomander daemon failed: boom $SECRET\" >&2\necho '' >&2\nexit 1";
    let fixture = Fixture::new(body, fast());
    fixture.supervisor.start();
    let update = fixture.wait_for_state(DaemonState::Stopped);
    assert_eq!(update.status.reason, Some(StopReason::GaveUp));
    assert_eq!(
        update.status.last_error.as_deref(),
        Some("anomander daemon failed: boom [secret]")
    );
    assert_eq!(update.channel, None);
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(fixture.launches(), 3);
}

#[test]
fn exit_codes_3_and_4_are_not_retried() {
    for (code, reason) in [(3, StopReason::AlreadyRunning), (4, StopReason::BotInUse)] {
        let fixture = Fixture::new(
            &format!("echo 'anomander daemon failed: why' >&2\nexit {code}"),
            fast(),
        );
        fixture.supervisor.start();
        let update = fixture.wait_for_state(DaemonState::Stopped);
        assert_eq!(update.status.reason, Some(reason));
        assert_eq!(
            update.status.last_error.as_deref(),
            Some("anomander daemon failed: why")
        );
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(fixture.launches(), 1, "exit code {code}");
    }
}

#[test]
fn a_start_by_the_principal_resets_the_exit_counter() {
    let fixture = Fixture::new("exit 1", fast());
    fixture.supervisor.start();
    let _ = fixture.wait_for("gave up", |u| u.status.reason == Some(StopReason::GaveUp));
    fixture.supervisor.start();
    let _ = fixture.wait_for("gave up again", |u| {
        u.status.reason == Some(StopReason::GaveUp)
    });
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(fixture.launches(), 6);
}

#[test]
fn a_stop_by_the_principal_leaves_no_process_and_is_never_restarted() {
    let fixture = Fixture::new(&format!("{LISTEN}\nread -r _"), fast());
    fixture.supervisor.start();
    fixture.wait_for_state(DaemonState::Running);
    let pid = wait_for_pid(&fixture);
    fixture.supervisor.stop();
    assert!(is_gone(pid), "daemon {pid} is still there");
    let update = fixture.supervisor.current();
    assert_eq!(update.status.state, DaemonState::Stopped);
    assert_eq!(update.status.reason, Some(StopReason::StoppedByPrincipal));
    assert_eq!(update.channel, None);
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(fixture.launches(), 1);
}

#[test]
fn a_daemon_that_ignores_sigterm_is_killed_after_the_timeout() {
    // It ignores SIGTERM and the closed stdin; its `sleep` children are killed with it.
    let body = format!("trap '' TERM\n{LISTEN}\nwhile :; do sleep 1; done");
    let fixture = Fixture::new(&body, fast());
    fixture.supervisor.start();
    fixture.wait_for_state(DaemonState::Running);
    let pid = wait_for_pid(&fixture);
    let started = Instant::now();
    fixture.supervisor.stop();
    let took = started.elapsed();
    assert!(is_gone(pid), "daemon {pid} is still there");
    assert!(took >= Duration::from_millis(300), "{took:?}");
    assert!(took < Duration::from_secs(3), "{took:?}");
}

#[test]
fn dropping_the_supervisor_stops_the_daemon() {
    let fixture = Fixture::new(&format!("{LISTEN}\nread -r _"), fast());
    fixture.supervisor.start();
    fixture.wait_for_state(DaemonState::Running);
    let pid = wait_for_pid(&fixture);
    let Fixture {
        dir, supervisor, ..
    } = fixture;
    drop(supervisor);
    assert!(is_gone(pid), "daemon {pid} is still there");
    drop(dir);
}

#[test]
fn without_a_bot_token_or_chat_id_nothing_is_spawned() {
    let notify = |_: Update| {};
    let supervisor = Supervisor::new(
        Box::new(|| Prepared::NotConfigured),
        Box::new(notify),
        fast(),
    );
    supervisor.start();
    let update = supervisor.current();
    assert_eq!(update.status.state, DaemonState::Stopped);
    assert_eq!(update.status.reason, Some(StopReason::NotConfigured));
    assert_eq!(supervisor.pid(), None);
}

#[test]
fn a_launch_that_cannot_be_prepared_is_stopped_with_its_error() {
    let notify = |_: Update| {};
    let prepare = || Prepared::Failed("node was not found".into());
    let supervisor = Supervisor::new(Box::new(prepare), Box::new(notify), fast());
    supervisor.start();
    let update = supervisor.current();
    assert_eq!(update.status.state, DaemonState::Stopped);
    assert_eq!(update.status.reason, None);
    assert_eq!(
        update.status.last_error.as_deref(),
        Some("node was not found")
    );
}

#[test]
fn a_restart_replaces_the_running_daemon() {
    let fixture = Fixture::new(&format!("{LISTEN}\nread -r _"), fast());
    fixture.supervisor.start();
    fixture.wait_for_state(DaemonState::Running);
    let first = wait_for_pid(&fixture);
    fixture.supervisor.restart();
    assert!(is_gone(first), "the first daemon {first} is still there");
    fixture.wait_for_state(DaemonState::Running);
    assert_eq!(fixture.launches(), 2);
}
