// DK-15: connecting a model with the principal's subscription from the app's Suscripciones screen.
// The flows are pi-ai's, run by `packages/daemon/scripts/login.ts --shell <account>` in Node, as
// the MCP OAuth connection runs its script (`oauth_connect.rs`); the shell opens the browser on
// the address it prints, shows the window a device code or a field for the address the browser
// ended on, and keeps the credential it prints at the end in the Keychain item `model-login`,
// the one the daemon gets at each start (DK-5 AC1). The window learns which accounts are
// connected, never a token.
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{Map, Value};

use crate::oauth_connect::openable;
use crate::secure_store::SecretStore;
use crate::shell::MODEL_LOGIN;

/// The script, from the daemon package's folder.
const SCRIPT: &str = "scripts/login.ts";
/// The accounts offered for login, as `LOGIN_ACCOUNTS` of
/// `packages/daemon/src/auth/telegram-login.ts` (R-27 AC1); the script refuses any other.
pub const ACCOUNTS: [&str; 2] = ["openai", "kimi-coding"];
/// The accounts that can be disconnected (R-27 AC6): those, plus the ones no longer offered
/// for login, so a login stored before can still be removed.
pub const LOGOUT_ACCOUNTS: [&str; 4] = ["openai", "kimi-coding", "anthropic", "github-copilot"];
/// Longer than the script's own 10 minutes (R-27 AC4): it ends first, unless it hangs.
pub const DEADLINE: Duration = Duration::from_secs(11 * 60);

const OPEN_LINE: &str = "anomander login-open ";
const CODE_LINE: &str = "anomander login-code ";
const PROMPT_LINE: &str = "anomander login-prompt";
const DONE_LINE: &str = "anomander login-done ";
/// Every word the script may end with.
const OUTCOMES: [&str; 3] = ["connected", "timed_out", "cancelled"];
/// The most the shell takes as an answer: a redirect address is a few hundred characters.
const LONGEST_ANSWER: usize = 4096;

/// One account as the window sees it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    pub provider_id: String,
    /// Whether a login is stored for it.
    pub connected: bool,
    /// Whether it is offered for login; otherwise it is listed only while connected.
    pub login: bool,
}

/// What the Suscripciones screen shows: the accounts, in the order of `LOGOUT_ACCOUNTS`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionsView {
    pub accounts: Vec<AccountView>,
}

/// What the window is told while a login runs. Never a token or an address.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Step {
    /// The browser was opened on the login page.
    Opened,
    /// A device code to type on the page the browser was opened on.
    DeviceCode { code: String },
    /// The flow waits for the address the browser ended on, pasted in the window.
    Prompt,
}

/// How a login ended: a word of `OUTCOMES`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginOutcome {
    pub outcome: String,
}

/// What one run left: its word, and the credential by provider when it connected. Holds a
/// token: no `Debug`.
pub struct Ran {
    pub outcome: LoginOutcome,
    pub credential: Option<Map<String, Value>>,
}

/// The one login running: its turn, and the stdin of its script while it waits for an answer.
#[derive(Default)]
pub struct Session {
    running: AtomicBool,
    stdin: Mutex<Option<ChildStdin>>,
}

/// The turn of a login; the next may start once this is dropped.
pub struct Turn<'a>(&'a Session);

impl Drop for Turn<'_> {
    fn drop(&mut self) {
        *lock(&self.0.stdin) = None;
        self.0.running.store(false, Ordering::SeqCst);
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Session {
    /// One login at a time: two would race to store their credential, and the window can be
    /// closed and opened again while the browser waits.
    pub fn turn(&self) -> Result<Turn<'_>, String> {
        if self.running.swap(true, Ordering::SeqCst) {
            return Err("another login is waiting for the browser".into());
        }
        Ok(Turn(self))
    }

    /// Writes what the principal pasted as the one line the script waits for, once (DK-15 AC2):
    /// the pipe is let go of after it. Refused when no login waits, or when the text could be
    /// more than one line.
    pub fn answer(&self, text: &str) -> Result<(), String> {
        let text = text.trim();
        if text.is_empty() || text.chars().count() > LONGEST_ANSWER {
            return Err("the answer is empty or too long".into());
        }
        if text.chars().any(char::is_control) {
            return Err("the answer holds a control character".into());
        }
        let Some(mut pipe) = lock(&self.stdin).take() else {
            return Err("no login is waiting for an answer".into());
        };
        pipe.write_all(format!("{text}\n").as_bytes())
            .and_then(|()| pipe.flush())
            .map_err(|error| format!("could not answer the login: {error}"))
    }
}

/// The script next to the daemon's entry point: `<daemon>/src/main.ts` gives
/// `<daemon>/scripts/login.ts`.
pub fn script_of(entry: &Path) -> Option<PathBuf> {
    Some(entry.parent()?.parent()?.join(SCRIPT))
}

/// The login as stored: a JSON object by provider; nothing, or what is not one, is empty.
fn stored(store: &dyn SecretStore) -> Result<Map<String, Value>, String> {
    Ok(
        match store.get(MODEL_LOGIN).map_err(|error| error.to_string())? {
            Some(text) => match serde_json::from_str(&text) {
                Ok(Value::Object(login)) => login,
                _ => {
                    eprintln!("the stored model login is not a JSON object: it is not used");
                    Map::new()
                }
            },
            None => Map::new(),
        },
    )
}

/// Whether `entry` is a credential pi-ai would use.
fn is_credential(entry: &Value) -> bool {
    matches!(
        entry.get("type").and_then(Value::as_str),
        Some("oauth" | "api_key")
    )
}

/// What the window shows: every account, and whether a credential is stored for it.
pub fn view(store: &dyn SecretStore) -> Result<SubscriptionsView, String> {
    let login = stored(store)?;
    Ok(SubscriptionsView {
        accounts: LOGOUT_ACCOUNTS
            .iter()
            .map(|id| AccountView {
                provider_id: (*id).to_owned(),
                connected: login.get(*id).is_some_and(is_credential),
                login: ACCOUNTS.contains(id),
            })
            .collect(),
    })
}

/// Keeps the credential a login gave, with the daemon stopped so no token it refreshes
/// meanwhile overwrites it. The entries of other providers stay as they are.
pub fn keep(store: &dyn SecretStore, credential: &Map<String, Value>) -> Result<(), String> {
    let mut login = stored(store)?;
    for (provider, entry) in credential {
        login.insert(provider.clone(), entry.clone());
    }
    store
        .set(MODEL_LOGIN, &Value::Object(login).to_string())
        .map_err(|error| error.to_string())
}

/// Forgets the login of `provider_id`, with the daemon stopped as `keep`. Only an account of
/// `LOGOUT_ACCOUNTS`; forgetting one that is not stored changes nothing.
pub fn forget(store: &dyn SecretStore, provider_id: &str) -> Result<(), String> {
    if !LOGOUT_ACCOUNTS.contains(&provider_id) {
        return Err(format!(
            "{provider_id} is not an account that can be disconnected"
        ));
    }
    let mut login = stored(store)?;
    if login.remove(provider_id).is_some() {
        store
            .set(MODEL_LOGIN, &Value::Object(login).to_string())
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Runs the script for `provider_id` with `node`, has `open` open the pages it prints, tells
/// `notify` each step for the window, and reads the credential and the word it printed. The
/// script's stdin is kept in `session` while it runs, for `Session::answer`. A run longer than
/// `deadline` is ended.
#[allow(clippy::too_many_arguments)]
pub fn run(
    node: &Path,
    script: &Path,
    provider_id: &str,
    auth_path: &Path,
    path: &str,
    session: &Session,
    open: &dyn Fn(&str) -> Result<(), String>,
    notify: &dyn Fn(Step),
    deadline: Duration,
) -> Result<Ran, String> {
    if !ACCOUNTS.contains(&provider_id) {
        return Err(format!("{provider_id} is not an account offered for login"));
    }
    let mut child = Command::new(node)
        .arg(script)
        .arg("--shell")
        .arg(provider_id)
        // Nothing of the app's environment: the script needs none of its secrets. The auth path
        // only places the device ID; the script writes no `auth.json`.
        .env_clear()
        .env("PATH", path)
        .env("ANOMANDER_AUTH_PATH", auth_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("could not start {}: {error}", node.display()))?;
    let stdout = child.stdout.take();
    *lock(&session.stdin) = child.stdin.take();
    // Read meanwhile: a full error pipe would hold the script, and so the reading below.
    let stderr = child.stderr.take();
    let stderr_reader = std::thread::spawn(move || stderr.map(read_all).unwrap_or_default());
    let child = Arc::new(Mutex::new(child));
    let done = Arc::new(Mutex::new(false));

    // Ends a script that hangs, which also ends the reading below.
    let watchdog = {
        let (child, done) = (Arc::clone(&child), Arc::clone(&done));
        std::thread::spawn(move || {
            let started = Instant::now();
            while started.elapsed() < deadline {
                if done.lock().map(|done| *done).unwrap_or(true) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            if let Ok(mut child) = child.lock() {
                let _ = child.kill();
            }
        })
    };
    let end = |child: &Arc<Mutex<Child>>| {
        if let Ok(mut child) = child.lock() {
            let _ = child.kill();
        }
    };

    let mut credential = None;
    let mut last = String::new();
    let mut refused: Option<String> = None;
    if let Some(stdout) = stdout {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if let Some(address) = line.strip_prefix(OPEN_LINE) {
                // The address comes from the provider: only a web page is opened.
                if let Err(error) = open_page(address, open) {
                    refused = Some(error);
                    end(&child);
                    break;
                }
                notify(Step::Opened);
            } else if let Some(rest) = line.strip_prefix(CODE_LINE) {
                let (code, address) = rest.split_once(' ').unwrap_or((rest, ""));
                if let Err(error) = open_page(address, open) {
                    refused = Some(error);
                    end(&child);
                    break;
                }
                notify(Step::DeviceCode {
                    code: code.to_owned(),
                });
            } else if line == PROMPT_LINE {
                notify(Step::Prompt);
            } else if let Some(json) = line.strip_prefix(DONE_LINE) {
                match serde_json::from_str(json) {
                    Ok(Value::Object(found))
                        if found.len() == 1
                            && found.get(provider_id).is_some_and(is_credential) =>
                    {
                        credential = Some(found)
                    }
                    _ => {
                        refused = Some("the login gave no credential".into());
                        end(&child);
                        break;
                    }
                }
            } else {
                last = line;
            }
        }
    }
    *lock(&session.stdin) = None;
    let said = stderr_reader.join().unwrap_or_default();
    // Polled, not waited on with the lock held: the watchdog must still be able to end it.
    let status = loop {
        let polled = child.lock().map_err(|_| "poisoned".to_string())?.try_wait();
        match polled {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(error) => break Err(error),
        }
    };
    if let Ok(mut done) = done.lock() {
        *done = true;
    }
    let _ = watchdog.join();
    if let Some(refused) = refused {
        return Err(refused);
    }
    let status = status.map_err(|error| format!("could not wait for the login: {error}"))?;
    let word = last.trim();
    if status.success() && OUTCOMES.contains(&word) {
        if word == "connected" && credential.is_none() {
            return Err("the login gave no credential".into());
        }
        return Ok(Ran {
            outcome: LoginOutcome {
                outcome: word.to_owned(),
            },
            credential: if word == "connected" {
                credential
            } else {
                None
            },
        });
    }
    // Its error output holds only the kind of failure, never an address or a token.
    let reason = said.lines().rev().find(|line| !line.trim().is_empty());
    Err(match reason {
        Some(reason) => reason.trim().chars().take(300).collect(),
        None => format!("the login ended without an answer ({status})"),
    })
}

fn open_page(address: &str, open: &dyn Fn(&str) -> Result<(), String>) -> Result<(), String> {
    if openable(address) {
        open(address)
    } else {
        Err("the provider gave a login address that is not https".into())
    }
}

fn read_all(mut reader: impl Read) -> String {
    let mut bytes = Vec::new();
    let _ = reader.read_to_end(&mut bytes);
    String::from_utf8_lossy(&bytes).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::launch::{daemon_entry, find_node, search_path};
    use crate::secure_store::MemoryStore;
    use serde_json::json;
    use std::os::unix::fs::PermissionsExt;

    const OAUTH: &str =
        r#"{"type":"oauth","access":"access-secret","refresh":"refresh-secret","expires":1}"#;

    /// A fake `node` that runs `body` with `/bin/sh`.
    fn fake_node(dir: &Path, body: &str) -> PathBuf {
        let node = dir.join("node");
        std::fs::write(&node, format!("#!/bin/sh\n{body}\n"))
            .unwrap_or_else(|e| panic!("no fake node: {e}"));
        std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755))
            .unwrap_or_else(|e| panic!("no fake node: {e}"));
        node
    }

    struct Fake {
        opened: Mutex<Vec<String>>,
        steps: Mutex<Vec<Step>>,
    }

    impl Fake {
        fn new() -> Self {
            Self {
                opened: Mutex::new(Vec::new()),
                steps: Mutex::new(Vec::new()),
            }
        }
        fn opened(&self) -> Vec<String> {
            self.opened.lock().map(|o| o.clone()).unwrap_or_default()
        }
        fn steps(&self) -> Vec<Step> {
            self.steps.lock().map(|s| s.clone()).unwrap_or_default()
        }
    }

    fn run_fake(body: &str, fake: &Fake, session: &Session, provider: &str) -> Result<Ran, String> {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("no temp dir: {e}"));
        let node = fake_node(dir.path(), body);
        let open = |address: &str| {
            if let Ok(mut opened) = fake.opened.lock() {
                opened.push(address.to_owned());
            }
            Ok(())
        };
        let notify = |step: Step| {
            if let Ok(mut steps) = fake.steps.lock() {
                steps.push(step);
            }
        };
        run(
            &node,
            Path::new("/x/login.ts"),
            provider,
            &dir.path().join("auth.json"),
            "/usr/bin:/bin",
            session,
            &open,
            &notify,
            Duration::from_secs(5),
        )
    }

    #[test]
    fn a_device_code_login_opens_the_page_shows_the_code_and_keeps_the_credential(
    ) -> Result<(), String> {
        let fake = Fake::new();
        let ran = run_fake(
            &format!(
                r#"echo 'anomander login-code ABCD-1234 https://kimi.example/device'
echo 'anomander login-done {{"kimi-coding":{OAUTH}}}'
echo connected"#
            ),
            &fake,
            &Session::default(),
            "kimi-coding",
        )?;
        assert_eq!(ran.outcome.outcome, "connected");
        assert_eq!(
            ran.credential.map(Value::Object),
            Some(json!({"kimi-coding": serde_json::from_str::<Value>(OAUTH).ok()}))
        );
        assert_eq!(
            fake.opened(),
            vec!["https://kimi.example/device".to_owned()]
        );
        assert_eq!(
            fake.steps(),
            vec![Step::DeviceCode {
                code: "ABCD-1234".into()
            }]
        );
        Ok(())
    }

    #[test]
    fn the_answer_goes_to_the_waiting_script_and_is_refused_when_none_waits() -> Result<(), String>
    {
        let fake = Fake::new();
        let session = Arc::new(Session::default());
        // The answer comes from another thread while the script waits, as the window's does.
        let answering = std::thread::spawn({
            let session = Arc::clone(&session);
            move || {
                let started = Instant::now();
                while lock(&session.stdin).is_none() {
                    if started.elapsed() > Duration::from_secs(4) {
                        return Err("the script never ran".to_string());
                    }
                    std::thread::sleep(Duration::from_millis(30));
                }
                // What could be more than one line, or nothing, never reaches the script.
                if session.answer("two\nlines")
                    != Err("the answer holds a control character".into())
                {
                    return Err("a second line was taken".to_string());
                }
                if session.answer("   ") != Err("the answer is empty or too long".into()) {
                    return Err("an empty answer was taken".to_string());
                }
                session.answer(" http://localhost:1455/auth/callback?code=c&state=s ")
            }
        });
        let ran = run_fake(
            &format!(
                r#"echo 'anomander login-open https://auth.example/authorize?state=s'
echo 'anomander login-prompt'
read -r pasted
if [ "$pasted" = "http://localhost:1455/auth/callback?code=c&state=s" ]; then
  echo 'anomander login-done {{"openai":{OAUTH}}}'
  echo connected
else
  echo "unexpected: $pasted" >&2
  exit 1
fi"#
            ),
            &fake,
            &session,
            "openai",
        )?;
        assert_eq!(
            answering.join().unwrap_or_else(|_| Err("panicked".into())),
            Ok(())
        );
        assert_eq!(ran.outcome.outcome, "connected");
        assert!(ran.credential.is_some());
        assert_eq!(fake.steps(), vec![Step::Opened, Step::Prompt]);
        assert_eq!(
            fake.opened(),
            vec!["https://auth.example/authorize?state=s".to_owned()]
        );
        // The run is over: nothing waits for an answer any more.
        assert_eq!(
            session.answer("late"),
            Err("no login is waiting for an answer".into())
        );
        Ok(())
    }

    #[test]
    fn a_late_or_cancelled_login_keeps_no_credential() -> Result<(), String> {
        for word in ["timed_out", "cancelled"] {
            let fake = Fake::new();
            let ran = run_fake(
                &format!("echo {word}"),
                &fake,
                &Session::default(),
                "openai",
            )?;
            assert_eq!(ran.outcome.outcome, word);
            assert!(ran.credential.is_none());
        }
        Ok(())
    }

    #[test]
    fn only_an_account_offered_for_login_is_run() {
        let fake = Fake::new();
        for provider in ["anthropic", "github-copilot", "nope", "", "--shell"] {
            let ran = run_fake("echo connected", &fake, &Session::default(), provider);
            assert_eq!(
                ran.err(),
                Some(format!("{provider} is not an account offered for login"))
            );
        }
    }

    #[test]
    fn an_address_that_is_not_a_web_page_is_never_opened_and_ends_the_run() {
        let fake = Fake::new();
        for line in [
            "anomander login-open file:///etc/passwd",
            "anomander login-code ABCD file:///etc/passwd",
            "anomander login-code ABCD",
        ] {
            let ran = run_fake(
                &format!("echo '{line}'\nsleep 3\necho connected"),
                &fake,
                &Session::default(),
                "openai",
            );
            assert!(ran.is_err(), "{line}");
        }
        assert!(fake.opened().is_empty());
        assert!(fake.steps().is_empty());
    }

    #[test]
    fn a_credential_that_is_not_one_for_the_account_is_refused() {
        let fake = Fake::new();
        for json in [
            "[1]",
            r#"{"other":{"type":"oauth"}}"#,
            r#"{"openai":{"note":"no type"}}"#,
            r#"{"openai":{"type":"oauth"},"other":"text"}"#,
            // One account per login: another one could overwrite a stored login.
            r#"{"openai":{"type":"oauth"},"anthropic":{"type":"oauth"}}"#,
        ] {
            let ran = run_fake(
                &format!("echo 'anomander login-done {json}'\necho connected"),
                &fake,
                &Session::default(),
                "openai",
            );
            assert_eq!(
                ran.err(),
                Some("the login gave no credential".into()),
                "{json}"
            );
        }
        // Connected, but nothing printed.
        assert!(run_fake("echo connected", &fake, &Session::default(), "openai").is_err());
        assert!(run_fake(
            "echo deleted_everything",
            &fake,
            &Session::default(),
            "openai"
        )
        .is_err());
    }

    #[test]
    fn an_error_says_what_the_script_said() {
        let fake = Fake::new();
        assert_eq!(
            run_fake(
                "echo 'login failed: TypeError' >&2\nexit 1",
                &fake,
                &Session::default(),
                "openai"
            )
            .err(),
            Some("login failed: TypeError".into())
        );
    }

    #[test]
    fn a_run_that_hangs_is_ended() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("no temp dir: {e}"));
        let node = fake_node(dir.path(), "exec sleep 30");
        let started = Instant::now();
        let session = Session::default();
        let ran = run(
            &node,
            Path::new("/x/login.ts"),
            "openai",
            &dir.path().join("auth.json"),
            "/usr/bin:/bin",
            &session,
            &|_| Ok(()),
            &|_| {},
            Duration::from_millis(300),
        );
        assert!(ran.is_err());
        assert!(started.elapsed() < Duration::from_secs(10));
        assert!(lock(&session.stdin).is_none());
    }

    #[test]
    fn one_login_runs_at_a_time() -> Result<(), String> {
        let session = Session::default();
        let turn = session.turn()?;
        assert_eq!(
            session.turn().err(),
            Some("another login is waiting for the browser".into())
        );
        drop(turn);
        assert!(session.turn().is_ok());
        Ok(())
    }

    #[test]
    fn the_view_names_every_account_and_which_are_connected() -> Result<(), String> {
        let store = MemoryStore::default();
        let empty = view(&store)?;
        assert_eq!(
            empty
                .accounts
                .iter()
                .map(|a| (a.provider_id.as_str(), a.connected, a.login))
                .collect::<Vec<_>>(),
            vec![
                ("openai", false, true),
                ("kimi-coding", false, true),
                ("anthropic", false, false),
                ("github-copilot", false, false),
            ]
        );
        let _ = store.set(
            MODEL_LOGIN,
            &format!(r#"{{"openai":{OAUTH},"anthropic":{{"type":"api_key","key":"k"}},"note":"kept","kimi-coding":{{"no":"type"}}}}"#),
        );
        let connected: Vec<_> = view(&store)?
            .accounts
            .into_iter()
            .filter(|a| a.connected)
            .map(|a| a.provider_id)
            .collect();
        assert_eq!(connected, vec!["openai".to_owned(), "anthropic".to_owned()]);
        // The view carries no token.
        let text = serde_json::to_string(&view(&store)?).unwrap_or_default();
        assert!(!text.contains("secret"));
        assert!(text.contains("\"providerId\":\"openai\""));
        Ok(())
    }

    #[test]
    fn a_credential_kept_joins_the_stored_login_and_forgetting_takes_only_its_account(
    ) -> Result<(), String> {
        let store = MemoryStore::default();
        let _ = store.set(
            MODEL_LOGIN,
            r#"{"anthropic":{"type":"oauth","access":"a"},"note":"kept"}"#,
        );
        let credential = serde_json::from_str::<Value>(&format!(r#"{{"openai":{OAUTH}}}"#))
            .ok()
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default();
        keep(&store, &credential)?;
        let read = || store.get(MODEL_LOGIN).map_err(|error| error.to_string());
        let kept: Value = serde_json::from_str(&read()?.unwrap_or_default()).unwrap_or(Value::Null);
        assert_eq!(kept["anthropic"]["access"], "a");
        assert_eq!(kept["note"], "kept");
        assert_eq!(kept["openai"]["refresh"], "refresh-secret");

        forget(&store, "openai")?;
        let left: Value = serde_json::from_str(&read()?.unwrap_or_default()).unwrap_or(Value::Null);
        assert!(left.get("openai").is_none());
        assert_eq!(left["anthropic"]["access"], "a");
        assert_eq!(left["note"], "kept");

        // Not stored: nothing is written. Not an account: refused.
        let before = read()?;
        forget(&store, "kimi-coding")?;
        assert_eq!(read()?, before);
        assert!(forget(&store, "nope").is_err());
        Ok(())
    }

    #[test]
    fn what_is_stored_and_not_an_object_is_an_empty_login() -> Result<(), String> {
        let store = MemoryStore::default();
        let _ = store.set(MODEL_LOGIN, "[1]");
        assert!(view(&store)?.accounts.iter().all(|a| !a.connected));
        Ok(())
    }

    #[test]
    fn the_steps_are_spelled_as_in_shell_ts() {
        assert_eq!(
            serde_json::to_value(Step::Opened).ok(),
            Some(json!({"kind":"opened"}))
        );
        assert_eq!(
            serde_json::to_value(Step::DeviceCode { code: "AB".into() }).ok(),
            Some(json!({"kind":"device_code","code":"AB"}))
        );
        assert_eq!(
            serde_json::to_value(Step::Prompt).ok(),
            Some(json!({"kind":"prompt"}))
        );
        assert_eq!(
            serde_json::to_value(LoginOutcome {
                outcome: "connected".into()
            })
            .ok(),
            Some(json!({"outcome":"connected"}))
        );
    }

    #[test]
    fn the_script_sits_next_to_the_daemons_entry_point() {
        let script = script_of(&daemon_entry(None))
            .unwrap_or_else(|| panic!("the entry point has no package folder"));
        assert!(script.ends_with("packages/daemon/scripts/login.ts"));
        assert!(script.is_file());
    }

    #[test]
    fn the_real_script_refuses_an_account_before_touching_the_data_folder() {
        let path = search_path(std::env::var("PATH").ok().as_deref());
        let node = find_node(None, &path).unwrap_or_else(|| panic!("node is needed: {path}"));
        let script = script_of(&daemon_entry(None))
            .unwrap_or_else(|| panic!("the entry point has no package folder"));
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("no temp dir: {e}"));
        // The shell refuses it first; the script's own refusal is what `login.test.ts` checks.
        let ran = run(
            &node,
            &script,
            "anthropic",
            &dir.path().join("auth.json"),
            &path,
            &Session::default(),
            &|_| Err("nothing may be opened".into()),
            &|_| {},
            DEADLINE,
        );
        assert!(ran.is_err());
        assert!(std::fs::read_dir(dir.path())
            .map(|d| d.count() == 0)
            .unwrap_or(false));
    }

    #[test]
    fn the_answer_is_written_once() -> Result<(), String> {
        let fake = Fake::new();
        let session = Arc::new(Session::default());
        let answering = std::thread::spawn({
            let session = Arc::clone(&session);
            move || {
                let started = Instant::now();
                while lock(&session.stdin).is_none() {
                    if started.elapsed() > Duration::from_secs(4) {
                        return Err("never ran".to_string());
                    }
                    std::thread::sleep(Duration::from_millis(30));
                }
                session.answer("http://localhost:1455/auth/callback?code=c&state=s")?;
                match session.answer("second") {
                    Err(error) if error == "no login is waiting for an answer" => Ok(()),
                    other => Err(format!("a second answer was taken: {other:?}")),
                }
            }
        });
        let ran = run_fake(
            "echo 'anomander login-prompt'\nread -r a\nsleep 1\necho cancelled",
            &fake,
            &session,
            "openai",
        )?;
        assert_eq!(
            answering.join().unwrap_or_else(|_| Err("panicked".into())),
            Ok(())
        );
        assert_eq!(ran.outcome.outcome, "cancelled");
        Ok(())
    }
}
