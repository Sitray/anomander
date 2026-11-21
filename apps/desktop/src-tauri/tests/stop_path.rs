// DK-1 AC1 on every platform, Windows included: the supervisor runs a fake daemon in the real
// `node` (a script in a temporary folder), so the stop path is the one the app takes. A stop closes
// the daemon's stdin and it exits on its own; a kill also ends what the daemon started, as its MCP
// stdio servers. Windows has no SIGTERM: there the closed stdin and the Job Object do the work.
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anomander_desktop_lib::daemon::launch::{find_node, search_path, system_env};
use anomander_desktop_lib::daemon::supervisor::{LaunchSpec, Options, Prepared, Supervisor};
use anomander_desktop_lib::snapshot::DaemonState;

const PORT: u16 = 45_679;

/// Prints the listening line, as `main.ts` does, and ignores SIGTERM: only the closed stdin or a
/// kill ends it.
const LISTEN: &str = "process.on('SIGTERM', () => {});
console.log(`anomander local channel listening on 127.0.0.1:${process.env.ANOMANDER_LOCAL_PORT}`);
setInterval(() => {}, 1000);";

struct Fixture {
    dir: tempfile::TempDir,
    supervisor: Supervisor,
}

impl Fixture {
    /// A supervisor whose daemon is `node` running `body` after `LISTEN`, in a temporary folder.
    fn new(body: &str, options: Options) -> Fixture {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("no temp dir: {e}"));
        let script = dir.path().join("daemon.js");
        std::fs::write(&script, format!("{LISTEN}\n{body}\n"))
            .unwrap_or_else(|e| panic!("could not write the fake daemon: {e}"));
        let path = search_path(std::env::var("PATH").ok().as_deref());
        let node = find_node(None, &path).unwrap_or_else(|| panic!("node is needed: {path}"));
        let cwd = dir.path().to_path_buf();
        let prepare = move || {
            let mut env = system_env(&|name| std::env::var(name).ok());
            env.push(("PATH".into(), path.clone()));
            env.push(("ANOMANDER_LOCAL_PORT".into(), PORT.to_string()));
            Prepared::Ready(LaunchSpec {
                program: node.clone(),
                args: vec![script.clone().into_os_string()],
                env,
                cwd: cwd.clone(),
                port: PORT,
                token: "token".into(),
                secrets: Vec::new(),
                handover: None,
                on_credentials: None,
            })
        };
        let supervisor = Supervisor::new(Box::new(prepare), Box::new(|_| {}), options);
        Fixture { dir, supervisor }
    }

    fn file(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }

    /// Starts the daemon and waits until it listens; returns its process ID.
    fn start(&self) -> u32 {
        self.supervisor.start();
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let update = self.supervisor.current();
            if update.status.state == DaemonState::Running {
                if let Some(pid) = self.supervisor.pid() {
                    return pid;
                }
            }
            assert!(Instant::now() < deadline, "never listened: {update:?}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

/// Waits up to `timeout` for `path` to hold a line, and returns it.
fn read_line(path: &Path, timeout: Duration) -> String {
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(text) = std::fs::read_to_string(path) {
            if text.ends_with('\n') {
                return text.trim().to_owned();
            }
        }
        assert!(
            Instant::now() < deadline,
            "{} was never written",
            path.display()
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// Whether process `pid` is gone within `timeout`.
fn gone(pid: u32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if is_gone(pid) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(unix)]
fn is_gone(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    // SAFETY: signal 0 only checks whether the process exists.
    let alive = unsafe { libc::kill(pid, 0) } == 0;
    !alive && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

#[cfg(windows)]
fn is_gone(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
    };
    // SAFETY: only waits on the process; the handle is closed below.
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    if handle.is_null() {
        return true;
    }
    // SAFETY: `handle` is open, then closed.
    let ended = unsafe { WaitForSingleObject(handle, 0) } == WAIT_OBJECT_0;
    unsafe { CloseHandle(handle) };
    ended
}

/// Starts a `node` that only waits, and writes its process ID to `grandchild.pid`.
const GRANDCHILD: &str = "const c = require('child_process').spawn(process.execPath,
  ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
require('fs').writeFileSync('grandchild.pid', `${c.pid}\\n`);";

#[test]
fn a_stop_closes_the_daemons_stdin_and_it_exits_on_its_own() {
    // It leaves a mark when its stdin ends. The timeout is long: a kill would show in the time.
    let body = "process.stdin.on('end', () => {
  require('fs').writeFileSync('stdin-closed', 'yes\\n');
  process.exit(0);
});
process.stdin.resume();";
    let options = Options {
        restart_delay: Duration::from_millis(20),
        stop_timeout: Duration::from_secs(30),
    };
    let fixture = Fixture::new(body, options);
    let pid = fixture.start();
    let started = Instant::now();
    fixture.supervisor.stop();
    let took = started.elapsed();
    assert!(took < Duration::from_secs(15), "it was killed: {took:?}");
    assert_eq!(
        read_line(&fixture.file("stdin-closed"), Duration::ZERO),
        "yes"
    );
    assert!(
        gone(pid, Duration::from_secs(5)),
        "daemon {pid} is still there"
    );
}

#[test]
fn a_kill_also_ends_what_the_daemon_started() {
    // It ignores the closed stdin too, so the stop ends in a kill.
    let options = Options {
        restart_delay: Duration::from_millis(20),
        stop_timeout: Duration::from_millis(300),
    };
    let fixture = Fixture::new(GRANDCHILD, options);
    let pid = fixture.start();
    let grandchild: u32 = read_line(&fixture.file("grandchild.pid"), Duration::from_secs(10))
        .parse()
        .unwrap_or_else(|e| panic!("not a process ID: {e}"));
    assert!(!is_gone(grandchild));
    fixture.supervisor.stop();
    assert!(
        gone(pid, Duration::from_secs(5)),
        "daemon {pid} is still there"
    );
    assert!(
        gone(grandchild, Duration::from_secs(5)),
        "what the daemon started ({grandchild}) is still there"
    );
}

/// Windows only: elsewhere a daemon that dies alone leaves its process group as it was.
#[cfg(windows)]
#[test]
fn a_daemon_that_exits_on_its_own_leaves_nothing_it_started() {
    // It exits right after starting the grandchild, with an exit code that is not retried.
    let body = format!("{GRANDCHILD}\nsetTimeout(() => process.exit(3), 200);");
    let fixture = Fixture::new(&body, Options::default());
    // Not waited for as running: it may be gone by then.
    fixture.supervisor.start();
    let grandchild: u32 = read_line(&fixture.file("grandchild.pid"), Duration::from_secs(10))
        .parse()
        .unwrap_or_else(|e| panic!("not a process ID: {e}"));
    assert!(
        gone(grandchild, Duration::from_secs(10)),
        "what the daemon started ({grandchild}) is still there"
    );
}
