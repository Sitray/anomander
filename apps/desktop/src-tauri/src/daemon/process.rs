// How the shell starts its `node` children on Windows. A release build is a GUI app with no
// console, so each console child would open a window of its own; and Windows has no process
// groups to signal, so a Job Object ends what the daemon started (its MCP stdio servers).
use std::process::Command;

/// Starts a child apart from this app's console.
pub trait WithoutConsole {
    /// On Windows: no console window (`CREATE_NO_WINDOW`; what the child starts shares its hidden
    /// console), and a process group of its own (`CREATE_NEW_PROCESS_GROUP`), so a Ctrl-C in the
    /// terminal of `tauri dev` reaches the app, not the child. Nothing elsewhere.
    fn without_console(&mut self) -> &mut Self;
}

impl WithoutConsole for Command {
    #[cfg(windows)]
    fn without_console(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::{CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW};
        self.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP)
    }

    #[cfg(not(windows))]
    fn without_console(&mut self) -> &mut Self {
        self
    }
}

#[cfg(windows)]
pub use job::Job;

#[cfg(windows)]
mod job {
    use std::io;
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// A child and every process it starts. They all end when the job is terminated, and when its
    /// last handle closes: when this is dropped, or when the app exits or crashes.
    pub struct Job(HANDLE);

    // SAFETY: a job handle is a kernel handle, usable from any thread.
    unsafe impl Send for Job {}
    // SAFETY: as above; the calls made on it are thread-safe.
    unsafe impl Sync for Job {}

    impl Job {
        /// Puts `child` in a new job. The child runs a moment outside it, between its spawn and
        /// this: `node` starts nothing that early.
        pub fn around(child: &Child) -> io::Result<Job> {
            // SAFETY: no attributes and no name; the handle is not inheritable, so no child holds
            // the job open.
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            let job = Job(handle);
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            // SAFETY: `limits` is the structure the class names, with its size.
            let limited = unsafe {
                SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    std::ptr::from_ref(&limits).cast(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if limited == 0 {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: the child's handle stays open while `child` lives, which outlives this call.
            if unsafe { AssignProcessToJobObject(job.0, child.as_raw_handle()) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(job)
        }

        /// Ends every process still in the job. A handle, not a process ID: it never reaches a
        /// process outside the job, even after the child is gone.
        pub fn terminate(&self) {
            // SAFETY: `self.0` is an open job handle.
            unsafe { TerminateJobObject(self.0, 1) };
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: closed once, here; `KILL_ON_JOB_CLOSE` ends what is left in it.
            unsafe { CloseHandle(self.0) };
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::io::{BufRead, BufReader, Write};
        use std::process::{ChildStdin, Command, Stdio};
        use std::time::Duration;

        use crate::daemon::launch::{find_node, search_path, system_env};
        use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
        };

        /// Whether process `pid` ends within `timeout`; one that cannot be opened is gone.
        fn ends(pid: u32, timeout: Duration) -> bool {
            // SAFETY: only waits on the process; the handle is closed below.
            let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
            if handle.is_null() {
                return true;
            }
            // SAFETY: `handle` is open, then closed.
            let waited = unsafe { WaitForSingleObject(handle, timeout.as_millis() as u32) };
            unsafe { CloseHandle(handle) };
            waited == WAIT_OBJECT_0
        }

        /// A `node` that, once it reads a line, starts another and prints that one's process ID.
        fn node() -> (Child, ChildStdin) {
            let path = search_path(std::env::var("PATH").ok().as_deref());
            let node = find_node(None, &path).unwrap_or_else(|| panic!("node is needed: {path}"));
            let script = "process.stdin.once('data', () => { \
                const c = require('child_process').spawn(process.execPath, \
                ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); \
                console.log(c.pid); }); setInterval(() => {}, 1000);";
            let mut child = Command::new(node)
                .args(["-e", script])
                .env_clear()
                .envs(system_env(&|name| std::env::var(name).ok()))
                .env("PATH", &path)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .unwrap_or_else(|e| panic!("could not start node: {e}"));
            let stdin = child.stdin.take().unwrap_or_else(|| panic!("no stdin"));
            (child, stdin)
        }

        /// Has the child start its own child, and returns that one's process ID.
        fn grandchild(child: &mut Child, stdin: &mut ChildStdin) -> u32 {
            stdin
                .write_all(b"go\n")
                .unwrap_or_else(|e| panic!("could not write: {e}"));
            let stdout = child.stdout.take().unwrap_or_else(|| panic!("no stdout"));
            let mut line = String::new();
            BufReader::new(stdout)
                .read_line(&mut line)
                .unwrap_or_else(|e| panic!("no grandchild: {e}"));
            line.trim()
                .parse()
                .unwrap_or_else(|e| panic!("not a process ID {line:?}: {e}"))
        }

        #[test]
        fn closing_the_job_ends_the_child_and_what_it_started() {
            let (mut child, mut stdin) = node();
            let job = Job::around(&child).unwrap_or_else(|e| panic!("no job: {e}"));
            let grandchild = grandchild(&mut child, &mut stdin);
            drop(job);
            assert!(
                ends(grandchild, Duration::from_secs(5)),
                "{grandchild} lives"
            );
            assert!(ends(child.id(), Duration::from_secs(5)), "the child lives");
            let _ = child.wait();
        }

        #[test]
        fn terminating_the_job_ends_what_the_child_started() {
            let (mut child, mut stdin) = node();
            let job = Job::around(&child).unwrap_or_else(|e| panic!("no job: {e}"));
            let grandchild = grandchild(&mut child, &mut stdin);
            job.terminate();
            assert!(
                ends(grandchild, Duration::from_secs(5)),
                "{grandchild} lives"
            );
            let _ = child.wait();
        }

        // No control without the job: node (libuv) already puts what it spawns in a job of its own
        // that ends with node, so a grandchild started by node dies with it either way (CI showed
        // it). Ours also covers what node starts detached, and a node that hangs.
    }
}
