// DK-1: the shell starts the daemon, starts it again when it exits on its own, and stops it so
// that no daemon process is left. DK-2 AC3: an exit code that says starting again cannot help
// stops the retries.
//
// One child at a time. Every launch gets a generation; anything that happens to an older one
// (its output, its exit, a pending restart) is ignored, so a stop or a new start always wins.
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use super::output::{listening_port, redact, scrub};
use super::policy::{after_exit, AfterExit, ExitHistory};
use crate::snapshot::{DaemonState, DaemonStatus, LocalChannel, StopReason};

/// How often the exit of the child is checked.
const POLL: Duration = Duration::from_millis(25);
/// After SIGKILL, how long to wait for the operating system to end the child.
const KILL_GRACE: Duration = Duration::from_secs(2);
/// After the exit, how long to wait for the last stderr line still in the pipe.
const STDERR_GRACE: Duration = Duration::from_millis(500);

/// One start of the daemon. Holds secrets: no `Debug`.
pub struct LaunchSpec {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    /// The child's whole environment; the parent's is cleared.
    pub env: Vec<(String, String)>,
    pub cwd: PathBuf,
    /// The local channel's port this launch was given (DK-3).
    pub port: u16,
    /// This app launch's token (DK-3 AC2).
    pub token: String,
    /// Every secret value, removed from the error line and the forwarded log.
    pub secrets: Vec<String>,
}

pub enum Prepared {
    /// The setup lacks the bot token or the chat ID: nothing is spawned.
    NotConfigured,
    Ready(LaunchSpec),
    /// The launch cannot be built, such as without `node`; the message carries no secret.
    Failed(String),
}

/// What changed. `seq` grows with every change, so a listener can drop one that arrives late.
#[derive(Clone, Debug)]
pub struct Update {
    pub seq: u64,
    pub status: DaemonStatus,
    pub channel: Option<LocalChannel>,
}

#[derive(Clone, Copy, Debug)]
pub struct Options {
    /// The pause before starting again after an own exit, while the state is `failing`.
    pub restart_delay: Duration,
    /// DK-1 AC1: how long a SIGTERM gets before SIGKILL.
    pub stop_timeout: Duration,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            restart_delay: Duration::from_secs(1),
            stop_timeout: Duration::from_secs(5),
        }
    }
}

/// Builds each launch: called before every start, so each one reads the current setup and gets a
/// fresh port.
pub type Prepare = Box<dyn Fn() -> Prepared + Send + Sync>;
/// Called after every change, from any thread, possibly while a start or stop is in progress: it
/// must not block.
pub type Notify = Box<dyn Fn(Update) + Send + Sync>;

pub struct Supervisor {
    inner: Arc<Inner>,
}

struct Inner {
    prepare: Prepare,
    notify: Notify,
    options: Options,
    /// Serializes starts, stops and delayed restarts, so a new daemon never starts while the old
    /// one still holds the database lock (DK-2 AC1).
    ops: Mutex<()>,
    state: Mutex<State>,
}

struct State {
    seq: u64,
    status: DaemonStatus,
    channel: Option<LocalChannel>,
    generation: u64,
    child: Option<Arc<Running>>,
    history: ExitHistory,
    shut_down: bool,
}

struct Running {
    generation: u64,
    pid: u32,
    port: u16,
    token: String,
    child: Mutex<Child>,
    /// DK-1 AC1: held for the child's whole life; the daemon stops when it closes.
    stdin: Mutex<Option<ChildStdin>>,
    exited: Flag,
    stderr_done: Flag,
    /// The last non-empty stderr line, already redacted.
    last_error: Mutex<Option<String>>,
}

/// A one-way flag threads can wait on.
#[derive(Default)]
struct Flag {
    set: Mutex<bool>,
    changed: Condvar,
}

impl Flag {
    fn raise(&self) {
        *lock(&self.set) = true;
        self.changed.notify_all();
    }

    /// Whether the flag was raised within `timeout`.
    fn wait(&self, timeout: Duration) -> bool {
        let guard = lock(&self.set);
        let (guard, _) = self
            .changed
            .wait_timeout_while(guard, timeout, |set| !*set)
            .unwrap_or_else(PoisonError::into_inner);
        *guard
    }
}

/// A panicked thread must not take the supervisor down with it.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Supervisor {
    pub fn new(prepare: Prepare, notify: Notify, options: Options) -> Self {
        let status = DaemonStatus {
            state: DaemonState::Stopped,
            reason: None,
            last_error: None,
        };
        let state = State {
            seq: 0,
            status,
            channel: None,
            generation: 0,
            child: None,
            history: ExitHistory::default(),
            shut_down: false,
        };
        Self {
            inner: Arc::new(Inner {
                prepare,
                notify,
                options,
                ops: Mutex::new(()),
                state: Mutex::new(state),
            }),
        }
    }

    /// A start by the principal or at launch: resets the exit counter (DK-1 AC2). A running daemon
    /// is left as it is; a pending restart happens now.
    pub fn start(&self) {
        let _ops = lock(&self.inner.ops);
        let generation = {
            let mut state = lock(&self.inner.state);
            state.history.clear();
            if state.shut_down || state.child.is_some() {
                return;
            }
            state.generation += 1;
            state.generation
        };
        Inner::launch(&self.inner, generation, false);
    }

    /// A stop by the principal: never restarted. Returns once the daemon process is gone.
    pub fn stop(&self) {
        let _ops = lock(&self.inner.ops);
        let (child, update) = {
            let mut state = lock(&self.inner.state);
            if state.status.state == DaemonState::Stopped && state.child.is_none() {
                return;
            }
            state.generation += 1;
            state.status = DaemonStatus::stopped(StopReason::StoppedByPrincipal, None);
            state.channel = None;
            (state.child.take(), state.publish())
        };
        (self.inner.notify)(update);
        if let Some(child) = child {
            self.inner.terminate(&child);
        }
    }

    /// Stops the daemon if it runs and starts it again, with the current setup.
    pub fn restart(&self) {
        let _ops = lock(&self.inner.ops);
        let (child, update) = {
            let mut state = lock(&self.inner.state);
            if state.shut_down {
                return;
            }
            state.generation += 1;
            state.history.clear();
            state.status = DaemonStatus {
                state: DaemonState::Starting,
                reason: None,
                last_error: None,
            };
            state.channel = None;
            (state.child.take(), state.publish())
        };
        (self.inner.notify)(update);
        if let Some(child) = child {
            self.inner.terminate(&child);
        }
        let generation = lock(&self.inner.state).generation;
        Inner::launch(&self.inner, generation, false);
    }

    /// Quitting the app (DK-1 AC1): stops the daemon, waits for it, and never starts it again.
    /// Nothing is notified: the app is going away.
    pub fn shutdown(&self) {
        self.inner.shutdown();
    }

    pub fn current(&self) -> Update {
        lock(&self.inner.state).update()
    }

    /// The daemon's process ID while one runs.
    pub fn pid(&self) -> Option<u32> {
        lock(&self.inner.state)
            .child
            .as_ref()
            .map(|child| child.pid)
    }
}

// The last resort: a supervisor dropped without a quit still leaves no daemon (DK-1 AC1).
impl Drop for Supervisor {
    fn drop(&mut self) {
        self.inner.shutdown();
    }
}

impl State {
    fn update(&self) -> Update {
        Update {
            seq: self.seq,
            status: self.status.clone(),
            channel: self.channel.clone(),
        }
    }

    fn publish(&mut self) -> Update {
        self.seq += 1;
        self.update()
    }

    fn is_current(&self, running: &Arc<Running>) -> bool {
        self.generation == running.generation
            && self
                .child
                .as_ref()
                .is_some_and(|child| Arc::ptr_eq(child, running))
    }
}

impl Inner {
    fn shutdown(&self) {
        let _ops = lock(&self.ops);
        let child = {
            let mut state = lock(&self.state);
            state.shut_down = true;
            state.generation += 1;
            state.status = DaemonStatus::stopped(StopReason::StoppedByPrincipal, None);
            state.channel = None;
            state.child.take()
        };
        if let Some(child) = child {
            self.terminate(&child);
        }
    }

    /// Prepares and spawns generation `generation`. Called with `ops` held. `failing` keeps the
    /// state `failing` until the daemon listens again (DK-1 AC2).
    fn launch(inner: &Arc<Inner>, generation: u64, failing: bool) {
        if lock(&inner.state).shut_down {
            return;
        }
        let prepared = (inner.prepare)();
        let mut state = lock(&inner.state);
        if state.shut_down || state.generation != generation {
            return;
        }
        let last_error = state.status.last_error.clone();
        state.channel = None;
        let mut started = None;
        state.status = match prepared {
            Prepared::NotConfigured => DaemonStatus::stopped(StopReason::NotConfigured, None),
            Prepared::Failed(message) => DaemonStatus {
                state: DaemonState::Stopped,
                reason: None,
                last_error: Some(redact(&message, &[])),
            },
            Prepared::Ready(spec) => match Inner::spawn(inner, generation, spec) {
                Ok(running) => {
                    started = Some(running);
                    DaemonStatus {
                        state: if failing {
                            DaemonState::Failing
                        } else {
                            DaemonState::Starting
                        },
                        reason: None,
                        last_error: if failing { last_error } else { None },
                    }
                }
                Err(message) => DaemonStatus {
                    state: DaemonState::Stopped,
                    reason: None,
                    last_error: Some(message),
                },
            },
        };
        state.child = started;
        let update = state.publish();
        drop(state);
        (inner.notify)(update);
    }

    /// Spawns the child and its three watchers: stdout, stderr and the exit.
    fn spawn(
        inner: &Arc<Inner>,
        generation: u64,
        spec: LaunchSpec,
    ) -> Result<Arc<Running>, String> {
        let mut command = Command::new(&spec.program);
        command
            .args(&spec.args)
            .env_clear()
            .envs(spec.env.iter().map(|(name, value)| (name, value)))
            .current_dir(&spec.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // Its own process group: a Ctrl-C in the terminal of `tauri dev` reaches the app, not
            // the daemon, and a stop reaches whatever the daemon started.
            .process_group(0);
        let mut child = command
            .spawn()
            .map_err(|error| format!("could not start {}: {error}", spec.program.display()))?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let running = Arc::new(Running {
            generation,
            pid: child.id(),
            port: spec.port,
            token: spec.token,
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            exited: Flag::default(),
            stderr_done: Flag::default(),
            last_error: Mutex::new(None),
        });
        let secrets = Arc::new(spec.secrets);

        let watchers = [
            stdout.map(|stdout| {
                let (inner, running, secrets) = (
                    Arc::clone(inner),
                    Arc::clone(&running),
                    Arc::clone(&secrets),
                );
                watcher("anomander-daemon-stdout", move || {
                    for_each_line(stdout, |line| {
                        // A closed output must not end this thread: the daemon would block on a full pipe.
                        let _ = writeln!(
                            std::io::stdout(),
                            "[daemon] {}",
                            scrub(line, &as_strs(&secrets))
                        );
                        if listening_port(line) == Some(running.port) {
                            inner.listening(&running);
                        }
                    });
                })
            }),
            Some({
                let running = Arc::clone(&running);
                watcher("anomander-daemon-stderr", move || {
                    if let Some(stderr) = stderr {
                        for_each_line(stderr, |line| {
                            let secrets = as_strs(&secrets);
                            let _ =
                                writeln!(std::io::stderr(), "[daemon] {}", scrub(line, &secrets));
                            if !line.trim().is_empty() {
                                *lock(&running.last_error) = Some(redact(line, &secrets));
                            }
                        });
                    }
                    running.stderr_done.raise();
                })
            }),
            Some({
                let (inner, running) = (Arc::clone(inner), Arc::clone(&running));
                watcher("anomander-daemon-exit", move || {
                    let code = running.wait_for_exit();
                    running.exited.raise();
                    // The last error line may still be in the pipe.
                    running.stderr_done.wait(STDERR_GRACE);
                    inner.exited(&running, code);
                })
            }),
        ];
        if let Some(Err(error)) = watchers.into_iter().flatten().find(Result::is_err) {
            kill_group(&running, libc::SIGKILL);
            return Err(format!("could not watch the daemon: {error}"));
        }
        Ok(running)
    }

    /// DK-3: the local channel listens, so the chat can connect.
    fn listening(&self, running: &Arc<Running>) {
        let mut state = lock(&self.state);
        if !state.is_current(running) || state.status.state == DaemonState::Running {
            return;
        }
        state.status = DaemonStatus {
            state: DaemonState::Running,
            reason: None,
            last_error: None,
        };
        state.channel = Some(LocalChannel {
            url: format!("ws://127.0.0.1:{}", running.port),
            token: running.token.clone(),
        });
        let update = state.publish();
        drop(state);
        (self.notify)(update);
    }

    /// The child is gone. When nobody asked for it, it exited on its own: DK-1 AC2.
    fn exited(self: &Arc<Self>, running: &Arc<Running>, code: Option<i32>) {
        let mut state = lock(&self.state);
        if !state.is_current(running) {
            return;
        }
        state.child = None;
        state.channel = None;
        let last_error = lock(&running.last_error).clone();
        let exits = state.history.record(Instant::now());
        match after_exit(code, exits) {
            AfterExit::Stop(reason) => state.status = DaemonStatus::stopped(reason, last_error),
            AfterExit::Restart => {
                state.status = DaemonStatus {
                    state: DaemonState::Failing,
                    reason: None,
                    last_error,
                };
                state.generation += 1;
                let generation = state.generation;
                let inner = Arc::clone(self);
                let scheduled = watcher("anomander-daemon-restart", move || {
                    std::thread::sleep(inner.options.restart_delay);
                    let _ops = lock(&inner.ops);
                    Inner::launch(&inner, generation, true);
                });
                if let Err(error) = scheduled {
                    state.status = DaemonStatus {
                        state: DaemonState::Stopped,
                        reason: None,
                        last_error: Some(format!("could not start the daemon again: {error}")),
                    };
                }
            }
        }
        let update = state.publish();
        drop(state);
        (self.notify)(update);
    }

    /// DK-1 AC1: closes stdin and sends SIGTERM, then SIGKILL after `stop_timeout`; returns once
    /// the process is gone.
    fn terminate(&self, running: &Running) {
        drop(lock(&running.stdin).take());
        kill_group(running, libc::SIGTERM);
        if running.exited.wait(self.options.stop_timeout) {
            return;
        }
        eprintln!(
            "anomander daemon {} did not stop within {:?}; killing it",
            running.pid, self.options.stop_timeout
        );
        kill_group(running, libc::SIGKILL);
        if !running.exited.wait(KILL_GRACE) {
            eprintln!(
                "anomander daemon {} is still there after SIGKILL",
                running.pid
            );
        }
    }
}

impl Running {
    /// Polls instead of blocking in `wait`, so a stop can signal the child under the same lock:
    /// a reaped process ID could otherwise be reused by another process before the signal.
    fn wait_for_exit(&self) -> Option<i32> {
        loop {
            match lock(&self.child).try_wait() {
                Ok(Some(status)) => return status.code(),
                Ok(None) => {}
                Err(error) => {
                    eprintln!("could not wait for anomander daemon {}: {error}", self.pid);
                    return None;
                }
            }
            std::thread::sleep(POLL);
        }
    }
}

/// Sends `signal` to the child's process group, while the child is not yet reaped.
fn kill_group(running: &Running, signal: libc::c_int) {
    let mut child = lock(&running.child);
    if !matches!(child.try_wait(), Ok(None)) {
        return;
    }
    let Ok(pid) = libc::pid_t::try_from(running.pid) else {
        return;
    };
    // SAFETY: `pid` is our unreaped child and the leader of its own group (`process_group(0)`),
    // so neither ID can belong to another process yet.
    let sent = unsafe { libc::kill(-pid, signal) } == 0;
    if !sent {
        // SAFETY: as above.
        unsafe { libc::kill(pid, signal) };
    }
}

fn watcher(name: &str, body: impl FnOnce() + Send + 'static) -> std::io::Result<()> {
    std::thread::Builder::new()
        .name(name.to_owned())
        .spawn(body)
        .map(drop)
}

/// Calls `each` with every line of `reader`, decoded leniently, until the pipe closes. The pipe
/// is always drained, so the daemon never blocks on a full one.
fn for_each_line(reader: impl Read, mut each: impl FnMut(&str)) {
    let mut reader = BufReader::new(reader);
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        match reader.read_until(b'\n', &mut buffer) {
            Ok(0) | Err(_) => return,
            Ok(_) => {
                let line = String::from_utf8_lossy(&buffer);
                each(line.trim_end_matches(['\n', '\r']));
            }
        }
    }
}

fn as_strs(secrets: &[String]) -> Vec<&str> {
    secrets.iter().map(String::as_str).collect()
}
