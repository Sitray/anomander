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
    /// What the daemon handed over on its credentials lines (DK-5 AC1).
    credentials: Arc<Mutex<Vec<String>>>,
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
        let credentials = Arc::new(Mutex::new(Vec::new()));
        let handed = Arc::clone(&credentials);
        let on_credentials: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(move |line: &str| {
            if let Ok(mut handed) = handed.lock() {
                handed.push(line.to_owned());
            }
        });
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
                on_credentials: Some(Arc::clone(&on_credentials)),
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
            credentials,
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

#[test]
fn work_done_while_stopped_runs_with_no_daemon_and_the_daemon_comes_back() {
    let fixture = Fixture::new(&format!("{LISTEN}\nread -r _"), fast());
    fixture.supervisor.start();
    fixture.wait_for_state(DaemonState::Running);
    let first = wait_for_pid(&fixture);
    let seen = fixture
        .supervisor
        .while_stopped(|| (is_gone(first), fixture.supervisor.pid()));
    assert_eq!(seen, (true, None));
    fixture.wait_for_state(DaemonState::Running);
    assert_eq!(fixture.launches(), 2);
}

#[test]
fn nothing_starts_the_daemon_while_the_work_runs() {
    let fixture = Arc::new(Fixture::new(&format!("{LISTEN}\nread -r _"), fast()));
    let starter = Arc::clone(&fixture);
    let launches = fixture.supervisor.while_stopped(|| {
        // A start asked meanwhile, as from the menu bar, waits for the work to end.
        let start = std::thread::spawn(move || starter.supervisor.start());
        std::thread::sleep(Duration::from_millis(300));
        let launches = fixture.launches();
        (launches, start)
    });
    assert_eq!(launches.0, 0);
    launches
        .1
        .join()
        .unwrap_or_else(|_| panic!("the start panicked"));
    fixture.wait_for_state(DaemonState::Running);
    assert_eq!(fixture.launches(), 1);
}

#[test]
fn a_daemon_stopped_before_the_work_stays_stopped() {
    let fixture = Fixture::new(&format!("{LISTEN}\nread -r _"), fast());
    assert_eq!(fixture.supervisor.while_stopped(|| 7), 7);
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(fixture.launches(), 0);
    assert_eq!(
        fixture.supervisor.current().status.state,
        DaemonState::Stopped
    );
}

#[test]
fn a_pending_restart_is_dropped_and_one_daemon_comes_back() {
    // The first launch exits at once, so a restart is due in 400 ms; later ones listen.
    let body =
        format!("if [ \"$(wc -l < \"$COUNT\")\" -lt 2 ]; then exit 1; fi\n{LISTEN}\nread -r _");
    let options = Options {
        restart_delay: Duration::from_millis(400),
        stop_timeout: Duration::from_millis(300),
    };
    let fixture = Fixture::new(&body, options);
    fixture.supervisor.start();
    fixture.wait_for_state(DaemonState::Failing);
    let during = fixture.supervisor.while_stopped(|| {
        std::thread::sleep(Duration::from_millis(800));
        (fixture.launches(), fixture.supervisor.pid())
    });
    assert_eq!(during, (1, None));
    fixture.wait_for_state(DaemonState::Running);
    std::thread::sleep(Duration::from_millis(600));
    assert_eq!(fixture.launches(), 2);
}

#[test]
fn a_start_asked_while_a_running_daemon_is_stopped_launches_it_once() {
    let fixture = Arc::new(Fixture::new(&format!("{LISTEN}\nread -r _"), fast()));
    fixture.supervisor.start();
    fixture.wait_for_state(DaemonState::Running);
    let starter = Arc::clone(&fixture);
    let start = fixture.supervisor.while_stopped(|| {
        let start = std::thread::spawn(move || starter.supervisor.start());
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(fixture.supervisor.pid(), None);
        start
    });
    start.join().unwrap_or_else(|_| panic!("start panicked"));
    fixture.wait_for_state(DaemonState::Running);
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(fixture.launches(), 2);
}

#[test]
fn a_stop_asked_meanwhile_wins_after_the_work() {
    let fixture = Arc::new(Fixture::new(&format!("{LISTEN}\nread -r _"), fast()));
    fixture.supervisor.start();
    fixture.wait_for_state(DaemonState::Running);
    let stopper = Arc::clone(&fixture);
    let stop = fixture.supervisor.while_stopped(|| {
        let stop = std::thread::spawn(move || stopper.supervisor.stop());
        std::thread::sleep(Duration::from_millis(200));
        stop
    });
    stop.join().unwrap_or_else(|_| panic!("stop panicked"));
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(fixture.supervisor.pid(), None);
    assert_eq!(
        fixture.supervisor.current().status.state,
        DaemonState::Stopped
    );
}

#[test]
fn quitting_meanwhile_leaves_no_daemon() {
    let fixture = Arc::new(Fixture::new(&format!("{LISTEN}\nread -r _"), fast()));
    fixture.supervisor.start();
    fixture.wait_for_state(DaemonState::Running);
    let quitter = Arc::clone(&fixture);
    let quit = fixture.supervisor.while_stopped(|| {
        let quit = std::thread::spawn(move || quitter.supervisor.shutdown());
        std::thread::sleep(Duration::from_millis(200));
        quit
    });
    quit.join().unwrap_or_else(|_| panic!("quit panicked"));
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(fixture.supervisor.pid(), None);
}

#[test]
fn the_login_the_daemon_hands_over_reaches_the_shell_and_only_the_shell() {
    let body = format!(
        "echo 'anomander credentials {{\"openai\":{{\"type\":\"api_key\",\"key\":\"sk-9\"}}}}'\n{LISTEN}\nread -r _"
    );
    let fixture = Fixture::new(&body, fast());
    fixture.supervisor.start();
    fixture.wait_for_state(DaemonState::Running);
    let handed = fixture
        .credentials
        .lock()
        .map(|handed| handed.clone())
        .unwrap_or_default();
    assert_eq!(
        handed,
        vec![r#"{"openai":{"type":"api_key","key":"sk-9"}}"#.to_owned()]
    );
}

/// DK-5 AC1: what a daemon hands over as it stops is stored before the next one is prepared, even
/// when storing it is slow (a Keychain write). Otherwise the next daemon starts with the old login.
#[test]
fn a_restart_hands_over_the_login_the_stopping_daemon_handed_back() -> Result<(), String> {
    let dir = tempfile::tempdir().map_err(|e| e.to_string())?;
    let script = dir.path().join("daemon.sh");
    std::fs::write(
        &script,
        format!("trap 'echo \"anomander credentials {{\\\"gen\\\":\\\"$GEN\\\"}}\"; exit 0' TERM\n{LISTEN}\nwhile :; do sleep 0.01; done\n"),
    )
    .map_err(|e| e.to_string())?;
    let stored = Arc::new(Mutex::new(String::from("none")));
    let seen = Arc::new(Mutex::new(Vec::<String>::new()));
    let on_credentials: Arc<dyn Fn(&str) + Send + Sync> = {
        let stored = Arc::clone(&stored);
        Arc::new(move |line: &str| {
            std::thread::sleep(Duration::from_millis(150));
            if let Ok(mut stored) = stored.lock() {
                line.clone_into(&mut stored);
            }
        })
    };
    let (stored_now, seen_now) = (Arc::clone(&stored), Arc::clone(&seen));
    let generation = Arc::new(Mutex::new(0u32));
    let cwd = dir.path().to_path_buf();
    let prepare = move || {
        let now = stored_now.lock().map(|s| s.clone()).unwrap_or_default();
        if let Ok(mut seen) = seen_now.lock() {
            seen.push(now);
        }
        let generation = generation
            .lock()
            .map(|mut g| {
                *g += 1;
                *g
            })
            .unwrap_or_default();
        Prepared::Ready(LaunchSpec {
            program: PathBuf::from("/bin/sh"),
            args: vec![script.clone().into_os_string()],
            env: vec![
                ("PATH".into(), "/usr/bin:/bin".into()),
                ("GEN".into(), generation.to_string()),
                ("ANOMANDER_LOCAL_PORT".into(), PORT.to_string()),
            ],
            cwd: cwd.clone(),
            port: PORT,
            token: TOKEN.into(),
            secrets: vec![],
            on_credentials: Some(Arc::clone(&on_credentials)),
        })
    };
    let supervisor = Supervisor::new(Box::new(prepare), Box::new(|_| {}), fast());
    let wait_running = |supervisor: &Supervisor| {
        let deadline = Instant::now() + Duration::from_secs(10);
        while supervisor.current().status.state != DaemonState::Running {
            assert!(Instant::now() < deadline, "the daemon never ran");
            std::thread::sleep(Duration::from_millis(5));
        }
    };
    supervisor.start();
    wait_running(&supervisor);
    supervisor.restart();
    wait_running(&supervisor);
    supervisor.while_stopped(|| ());
    wait_running(&supervisor);
    supervisor.stop();

    let seen = seen.lock().map(|s| s.clone()).unwrap_or_default();
    assert_eq!(seen, ["none", r#"{"gen":"1"}"#, r#"{"gen":"2"}"#]);
    let stored = stored.lock().map(|s| s.clone()).unwrap_or_default();
    assert_eq!(stored, r#"{"gen":"3"}"#);
    Ok(())
}
