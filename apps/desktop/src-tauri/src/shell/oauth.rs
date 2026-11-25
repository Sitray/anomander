// DK-11: connecting a server with OAuth, and the tokens of the servers handed to the daemon.
use std::sync::atomic::{AtomicBool, Ordering};

use super::Core;
use crate::connections::{ServerView, Target};
use crate::daemon::launch::{handed_locale, DaemonRuntime};
use crate::oauth_connect::{self, OAuthSet};

/// The one OAuth connection running; the next may start once this is dropped.
pub struct OAuthTurn<'a>(&'a AtomicBool);

impl Drop for OAuthTurn<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl Core {
    /// DK-11: the OAuth tokens to hand the daemon, those of the servers of `mcp.json` at the
    /// address they were given for. Those of a server removed, renamed or moved are dropped, and
    /// the store is told. While the shell cannot read the file (a link, which the daemon follows,
    /// or one half written) none is handed over and none is dropped: the principal may fix it.
    pub(super) fn mcp_oauth(&self) -> Result<OAuthSet, String> {
        let set = oauth_connect::stored(self.store.as_ref())?;
        let view = self.connections();
        if view.invalid.is_some() {
            return Ok(OAuthSet::new());
        }
        let servers: Vec<(String, String)> = view
            .servers
            .into_iter()
            .filter_map(|server| match server.target {
                Target::Http { url } => Some((server.name, url)),
                Target::Process { .. } => None,
            })
            .collect();
        let kept = oauth_connect::pruned(&set, &servers);
        if kept.len() != set.len() {
            if let Err(error) = oauth_connect::store_set(self.store.as_ref(), &kept) {
                eprintln!("{error}");
            }
        }
        Ok(kept)
    }

    /// DK-11: the address of the server `name`, which must be reached over HTTP.
    fn http_url(&self, name: &str) -> Result<String, String> {
        let view = self.connections();
        if let Some(invalid) = view.invalid {
            return Err(invalid);
        }
        match view.servers.into_iter().find(|server| server.name == name) {
            Some(ServerView {
                target: Target::Http { url },
                ..
            }) => Ok(url),
            Some(_) => Err("only a server reached by its address connects with OAuth".into()),
            None => Err(format!("there is no server named {name}")),
        }
    }

    /// DK-11: the turn of an OAuth connection. One at a time: the window can be closed and opened
    /// again while the browser waits, and two connections would race to store their tokens.
    pub fn oauth_turn(&self) -> Result<OAuthTurn<'_>, String> {
        if self.connecting.swap(true, Ordering::SeqCst) {
            return Err("another OAuth connection is waiting for the browser".into());
        }
        Ok(OAuthTurn(&self.connecting))
    }

    /// DK-11: connects the app to the server `name` with OAuth, `open` opening the address the
    /// principal authorizes it on. Nothing is stored here: `keep_oauth` does, with the daemon
    /// stopped. Returns the server's address with the outcome, the one the tokens are for.
    pub fn connect_oauth(
        &self,
        name: &str,
        open: &dyn Fn(&str) -> Result<(), String>,
    ) -> Result<(oauth_connect::Ran, String), String> {
        let url = self.http_url(name)?;
        let DaemonRuntime { node, entry, path } = self.daemon_runtime()?;
        let script = oauth_connect::script_of(&entry)
            .filter(|script| script.is_file())
            .ok_or_else(|| format!("the OAuth connection is not next to {}", entry.display()))?;
        let locale = handed_locale(&*self.environment);
        let ran = oauth_connect::run(
            &node,
            &script,
            &url,
            &path,
            locale.as_deref(),
            open,
            oauth_connect::DEADLINE,
        )?;
        Ok((ran, url))
    }

    /// DK-11: keeps the tokens of a connection to `name` at `url`. Call it with the daemon
    /// stopped, so no token it refreshes meanwhile overwrites them.
    pub fn keep_oauth(
        &self,
        name: &str,
        url: &str,
        entry: serde_json::Map<String, serde_json::Value>,
    ) -> Result<(), String> {
        let mut set = oauth_connect::stored(self.store.as_ref())?;
        set.insert(name.to_owned(), oauth_connect::kept_for(entry, url));
        oauth_connect::store_set(self.store.as_ref(), &set)
    }

    /// DK-11: forgets the tokens of `name`. Call it with the daemon stopped, as `keep_oauth`.
    pub fn forget_oauth(&self, name: &str) -> Result<(), String> {
        let mut set = oauth_connect::stored(self.store.as_ref())?;
        if set.remove(name).is_some() {
            oauth_connect::store_set(self.store.as_ref(), &set)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::daemon::supervisor::Handed;
    use crate::shell::test_support::*;

    fn oauth_env(spec: &LaunchSpec) -> Option<serde_json::Value> {
        handed(spec)
            .get("ANOMANDER_MCP_OAUTH")
            .and_then(|json| serde_json::from_str(json).ok())
    }

    /// `mcp.json` with `notes` at its address and a process server.
    fn with_servers(f: &Fixture) {
        std::fs::write(
            f.root.join("mcp.json"),
            json!({ "mcpServers": {
                "notes": { "url": "https://notes.example/mcp" },
                "files": { "command": "files-mcp" }
            }})
            .to_string(),
        )
        .unwrap_or_else(|e| panic!("no mcp.json: {e}"));
    }

    fn entry() -> serde_json::Map<String, serde_json::Value> {
        json!({ "client": { "client_id": "c-1" }, "tokens": { "access_token": "oauth-access-1" } })
            .as_object()
            .cloned()
            .unwrap_or_default()
    }

    #[test]
    fn oauth_tokens_kept_for_a_server_reach_the_daemon_and_are_hidden() -> Result<(), String> {
        let (store, settings) = configured();
        let f = fixture(store, settings);
        with_servers(&f);
        assert_eq!(oauth_env(&ready(&f.core)), Some(json!({})));

        f.core
            .keep_oauth("notes", "https://notes.example/mcp", entry())?;
        let spec = ready(&f.core);

        let mut kept = entry();
        kept.insert("url".into(), "https://notes.example/mcp".into());
        assert_eq!(oauth_env(&spec), Some(json!({ "notes": kept })));
        assert!(spec.secrets.iter().any(|secret| secret == "oauth-access-1"));
        let view = f.core.connections();
        let flags: Vec<_> = view
            .servers
            .iter()
            .map(|s| (s.name.as_str(), s.oauth))
            .collect();
        assert_eq!(flags, vec![("notes", true), ("files", false)]);
        Ok(())
    }

    // Making a symbolic link on Windows needs a privilege the test runner may lack.
    #[cfg(unix)]
    #[test]
    fn tokens_are_not_handed_over_while_the_file_is_not_as_the_shell_reads_it() -> Result<(), String>
    {
        let (store, settings) = configured();
        let f = fixture(store, settings);
        with_servers(&f);
        f.core
            .keep_oauth("notes", "https://notes.example/mcp", entry())?;
        // A link the daemon follows but the shell does not read, naming another address.
        let linked = f.root.parent().ok_or("no parent")?.join("linked-mcp.json");
        std::fs::write(
            &linked,
            json!({"mcpServers":{"notes":{"url":"https://evil.example/mcp"}}}).to_string(),
        )
        .map_err(|e| e.to_string())?;
        std::fs::remove_file(f.root.join("mcp.json")).map_err(|e| e.to_string())?;
        std::os::unix::fs::symlink(&linked, f.root.join("mcp.json")).map_err(|e| e.to_string())?;

        assert_eq!(oauth_env(&ready(&f.core)), Some(json!({})));
        // Kept, not dropped: the principal may fix the file.
        std::fs::remove_file(f.root.join("mcp.json")).map_err(|e| e.to_string())?;
        with_servers(&f);
        assert!(f.core.connections().servers[0].oauth);
        Ok(())
    }

    #[test]
    fn only_the_secrets_of_an_oauth_entry_are_hidden_from_the_daemons_output() -> Result<(), String>
    {
        let (store, settings) = configured();
        let f = fixture(store, settings);
        with_servers(&f);
        let mut kept = entry();
        kept.insert(
            "client".into(),
            json!({"client_id":"c-1","client_name":"ANOMANDER","client_secret":"oauth-client-secret",
                "grant_types":["authorization_code","refresh_token"],
                "redirect_uris":["http://127.0.0.1:54177/callback"]}),
        );
        kept.insert(
            "tokens".into(),
            json!({"access_token":"oauth-access-1","refresh_token":"oauth-refresh-1",
                "id_token":"oauth-id-1","token_type":"Bearer","scope":"read write"}),
        );
        f.core
            .keep_oauth("notes", "https://notes.example/mcp", kept)?;
        let spec = ready(&f.core);
        let mut hidden: Vec<_> = spec
            .secrets
            .iter()
            .filter(|secret| secret.starts_with("oauth-"))
            .cloned()
            .collect();
        hidden.sort();
        assert_eq!(
            hidden,
            [
                "oauth-access-1",
                "oauth-client-secret",
                "oauth-id-1",
                "oauth-refresh-1"
            ]
        );
        for plain in [
            "ANOMANDER",
            "authorization_code",
            "refresh_token",
            "https://notes.example/mcp",
        ] {
            assert!(
                !spec.secrets.iter().any(|secret| secret == plain),
                "{plain}"
            );
        }
        Ok(())
    }

    #[test]
    fn tokens_of_a_server_removed_renamed_or_moved_are_dropped() -> Result<(), String> {
        let (store, settings) = configured();
        let f = fixture(store, settings);
        with_servers(&f);
        f.core
            .keep_oauth("notes", "https://notes.example/mcp", entry())?;
        f.core
            .keep_oauth("gone", "https://gone.example/mcp", entry())?;
        // The address changed since the tokens were given: they are not for this one.
        std::fs::write(
            f.root.join("mcp.json"),
            json!({ "mcpServers": { "notes": { "url": "https://elsewhere.example/mcp" } } })
                .to_string(),
        )
        .map_err(|e| e.to_string())?;

        assert_eq!(oauth_env(&ready(&f.core)), Some(json!({})));
        // Dropped from the store too, so moving the address back does not bring them back.
        with_servers(&f);
        assert_eq!(oauth_env(&ready(&f.core)), Some(json!({})));
        Ok(())
    }

    #[test]
    fn tokens_are_kept_while_the_file_cannot_be_read() -> Result<(), String> {
        let (store, settings) = configured();
        let f = fixture(store, settings);
        with_servers(&f);
        f.core
            .keep_oauth("notes", "https://notes.example/mcp", entry())?;
        std::fs::write(f.root.join("mcp.json"), "{ half written").map_err(|e| e.to_string())?;
        let _ = ready(&f.core);
        with_servers(&f);
        assert!(f.core.connections().servers[0].oauth);
        Ok(())
    }

    #[test]
    fn forgetting_a_server_drops_its_tokens_and_no_other() -> Result<(), String> {
        let (store, settings) = configured();
        let f = fixture(store, settings);
        with_servers(&f);
        f.core
            .keep_oauth("notes", "https://notes.example/mcp", entry())?;
        f.core.forget_oauth("files")?;
        assert!(f.core.connections().servers[0].oauth);
        f.core.forget_oauth("notes")?;
        assert!(!f.core.connections().servers[0].oauth);
        assert_eq!(oauth_env(&ready(&f.core)), Some(json!({})));
        Ok(())
    }

    #[test]
    fn only_a_server_reached_by_its_address_connects_with_oauth() {
        let (store, settings) = configured();
        let f = fixture(store, settings);
        with_servers(&f);
        let never = |_: &str| -> Result<(), String> { panic!("nothing may be opened") };
        assert_eq!(
            f.core.connect_oauth("files", &never).err(),
            Some("only a server reached by its address connects with OAuth".into())
        );
        assert_eq!(
            f.core.connect_oauth("nobody", &never).err(),
            Some("there is no server named nobody".into())
        );
    }

    #[test]
    fn the_daemon_starts_without_oauth_when_its_tokens_cannot_be_read() {
        let (mut store, settings) = configured();
        store.unreadable = Some("mcp-oauth");
        let f = fixture(store, settings);
        with_servers(&f);
        assert_eq!(oauth_env(&ready(&f.core)), Some(json!({})));
    }

    #[test]
    fn one_oauth_connection_runs_at_a_time() {
        let (store, settings) = configured();
        let f = fixture(store, settings);
        let turn = f.core.oauth_turn();
        assert!(turn.is_ok());
        assert_eq!(
            f.core.oauth_turn().err(),
            Some("another OAuth connection is waiting for the browser".into())
        );
        drop(turn);
        assert!(f.core.oauth_turn().is_ok());
    }

    #[test]
    fn tokens_the_daemon_hands_back_are_stored_for_the_next_start() {
        let (store, settings) = configured();
        let f = fixture(store, settings);
        with_servers(&f);
        let handed = ready(&f.core)
            .on_credentials
            .unwrap_or_else(|| panic!("no credentials handler"));
        let refreshed = r#"{"notes":{"tokens":{"access_token":"oauth-access-2"},"url":"https://notes.example/mcp"}}"#;

        handed(Handed::McpOAuth, refreshed);
        handed(Handed::McpOAuth, "not json");

        assert_eq!(
            oauth_env(&ready(&f.core)),
            serde_json::from_str(refreshed).ok()
        );
        // The model login is another item.
        assert_eq!(login_env(&ready(&f.core)).as_deref(), Some("{}"));
    }
}
