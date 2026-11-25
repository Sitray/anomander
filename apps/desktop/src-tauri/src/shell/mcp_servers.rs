// DK-11: the servers of `mcp.json` as the connections screen changes them, and the sweep of their
// values to the Keychain before a start.
use super::{lock, Core, SetupCache};
use crate::connection_secrets::sweep;
use crate::connections::{self, Change, ConnectionsView, ServerInput};
use crate::setup::{save_settings, Settings};

impl Core {
    /// DK-11: the servers of `mcp.json` for the connections screen, without their values.
    pub fn connections(&self) -> ConnectionsView {
        // Not while a sweep or a save is halfway through the file.
        let _setup = lock(&self.setup);
        connections::view(&self.data, self.store.as_ref())
    }

    /// DK-11: adds a server to `mcp.json`, or replaces one. The daemon is not touched here.
    pub fn save_connection(&self, input: &ServerInput) -> Result<(), String> {
        let mut setup = lock(&self.setup);
        let change = connections::save(&self.data, input)?;
        self.change_connections(&mut setup, change)
    }

    /// DK-11: takes a server out of `mcp.json`. The daemon is not touched here.
    pub fn remove_connection(&self, name: &str) -> Result<(), String> {
        let mut setup = lock(&self.setup);
        let change = connections::remove(&self.data, name)?;
        self.change_connections(&mut setup, change)
    }

    /// Makes `change` under the setup lock, so it never interleaves with a sweep.
    fn change_connections(&self, setup: &mut SetupCache, change: Change) -> Result<(), String> {
        // Listed before they are stored: whatever a save that fails halfway leaves in the
        // Keychain, the next sweep knows of and removes.
        let mut accounts = setup.settings.connection_secrets.clone();
        accounts.extend(change.accounts());
        accounts.sort();
        accounts.dedup();
        if accounts != setup.settings.connection_secrets {
            let settings = Settings {
                connection_secrets: accounts,
                ..setup.settings.clone()
            };
            save_settings(&self.data, &settings)
                .map_err(|error| format!("could not save the settings: {error}"))?;
            setup.settings = settings;
        }
        change.apply(&self.data, self.store.as_ref())
    }

    /// DK-11: moves the values of `mcp.json` to the Keychain and returns the ones the file refers
    /// to. Nothing here stops a start: a server whose secret is missing is left out by the daemon.
    pub(super) fn connection_secrets(&self) -> Vec<(String, String)> {
        let mut setup = lock(&self.setup);
        let swept = sweep(
            &self.data,
            self.store.as_ref(),
            &setup.settings.connection_secrets,
        );
        if swept.accounts != setup.settings.connection_secrets {
            let settings = Settings {
                connection_secrets: swept.accounts,
                ..setup.settings.clone()
            };
            match save_settings(&self.data, &settings) {
                Ok(()) => setup.settings = settings,
                Err(error) => eprintln!("could not save the settings: {error}"),
            }
        }
        swept.secrets
    }
}

#[cfg(test)]
mod tests {
    use crate::connections::ServerInput;
    use crate::shell::test_support::*;

    #[test]
    fn a_launch_moves_the_values_of_the_connections_to_the_store_and_hands_them_over(
    ) -> Result<(), String> {
        let (store, settings) = configured();
        let f = fixture(store, settings);
        let file = f.root.join("mcp.json");
        let written = json!({
            "mcpServers": {
                "notes": { "command": "npx", "env": { "TOKEN": "tok-secret-1", "DEBUG": "1" } }
            }
        });
        std::fs::write(&file, written.to_string()).map_err(|e| e.to_string())?;

        let Prepared::Ready(spec) = f.core.prepare() else {
            return Err("a configured setup was not ready".into());
        };

        let sent = handed(&spec)
            .remove("ANOMANDER_MCP_SECRETS")
            .ok_or("the secrets were not handed over")?;
        let sent: BTreeMap<String, String> =
            serde_json::from_str(&sent).map_err(|e| e.to_string())?;
        assert_eq!(
            sent.get("mcp/notes/env/TOKEN").map(String::as_str),
            Some("tok-secret-1")
        );
        assert_eq!(
            sent.get("mcp/notes/env/DEBUG").map(String::as_str),
            Some("1")
        );
        // Out of the file, hidden in the daemon's output, and only named in the settings.
        let left = std::fs::read_to_string(&file).map_err(|e| e.to_string())?;
        assert!(!left.contains("tok-secret-1"), "{left}");
        assert!(spec.secrets.iter().any(|secret| secret == "tok-secret-1"));
        assert!(!spec.secrets.iter().any(|secret| secret == "1"));
        let saved =
            std::fs::read_to_string(f.root.join("settings.json")).map_err(|e| e.to_string())?;
        assert!(saved.contains("mcp/notes/env/TOKEN") && !saved.contains("tok-secret-1"));

        // Saving the setup keeps the list: it is what removes them once the file drops them.
        let input: SetupInput = serde_json::from_value(json!({
            "principalChatId": "42", "model": "", "visionModel": ""
        }))
        .map_err(|e| e.to_string())?;
        f.core.save_setup(&input)?;
        let saved =
            std::fs::read_to_string(f.root.join("settings.json")).map_err(|e| e.to_string())?;
        assert!(saved.contains("mcp/notes/env/TOKEN"), "{saved}");

        // The next start reads them back from the store.
        let Prepared::Ready(again) = f.core.prepare() else {
            return Err("the second start was not ready".into());
        };
        assert!(handed(&again)
            .get("ANOMANDER_MCP_SECRETS")
            .is_some_and(|json| json.contains("tok-secret-1")));
        Ok(())
    }

    #[test]
    fn a_connection_saved_from_the_screen_is_handed_over_and_one_removed_leaves_the_store(
    ) -> Result<(), String> {
        let (store, settings) = configured();
        let f = fixture(store, settings);
        let input: ServerInput = serde_json::from_value(json!({
            "name": "notes", "kind": "process", "command": "npx",
            "values": [{ "name": "TOKEN", "value": "tok-typed-1" }]
        }))
        .map_err(|e| e.to_string())?;
        let settings_file =
            || std::fs::read_to_string(f.root.join("settings.json")).map_err(|e| e.to_string());
        let handed_over = |spec: &LaunchSpec| handed(spec).remove("ANOMANDER_MCP_SECRETS");

        f.core.save_connection(&input)?;

        // Only named in the settings, a marker in the file, and stored for the screen.
        let saved = settings_file()?;
        assert!(saved.contains("mcp/notes/env/TOKEN") && !saved.contains("tok-typed-1"));
        let file = std::fs::read_to_string(f.root.join("mcp.json")).map_err(|e| e.to_string())?;
        assert!(
            file.contains("@keychain") && !file.contains("tok-typed-1"),
            "{file}"
        );
        let shown = f.core.connections();
        assert_eq!(shown.invalid, None);
        assert!(shown.servers[0].values[0].stored);
        let Prepared::Ready(spec) = f.core.prepare() else {
            return Err("a configured setup was not ready".into());
        };
        assert!(handed_over(&spec).is_some_and(|json| json.contains("tok-typed-1")));
        assert!(spec.secrets.iter().any(|secret| secret == "tok-typed-1"));

        // The setup still saves, and keeps the list.
        let setup: SetupInput = serde_json::from_value(json!({
            "principalChatId": "7", "model": "", "visionModel": ""
        }))
        .map_err(|e| e.to_string())?;
        f.core.save_setup(&setup)?;
        assert_eq!(f.core.setup_state().principal_chat_id.as_deref(), Some("7"));
        assert!(settings_file()?.contains("mcp/notes/env/TOKEN"));

        f.core.remove_connection("notes")?;
        let Prepared::Ready(spec) = f.core.prepare() else {
            return Err("the start after the removal was not ready".into());
        };
        assert_eq!(handed_over(&spec), None);
        assert!(!settings_file()?.contains("mcp/notes"));
        assert!(f.core.connections().servers.is_empty());
        assert!(f.core.remove_connection("notes").is_err());
        Ok(())
    }

    #[test]
    fn a_connection_the_store_refuses_is_removed_by_the_next_sweep() -> Result<(), String> {
        let f = fixture(MemoryStore::failing(), configured().1);
        let input: ServerInput = serde_json::from_value(json!({
            "name": "notes", "kind": "process", "command": "npx",
            "values": [{ "name": "TOKEN", "value": "tok-typed-1" }]
        }))
        .map_err(|e| e.to_string())?;

        assert!(f.core.save_connection(&input).is_err());

        // No file was written, and the account is known so that a sweep can remove it.
        assert!(!f.root.join("mcp.json").exists());
        let saved =
            std::fs::read_to_string(f.root.join("settings.json")).map_err(|e| e.to_string())?;
        assert!(saved.contains("mcp/notes/env/TOKEN"), "{saved}");
        Ok(())
    }
    #[test]
    fn without_connections_no_secret_of_theirs_is_handed_over() {
        let (store, settings) = configured();
        let f = fixture(store, settings);
        let Prepared::Ready(spec) = f.core.prepare() else {
            panic!("a configured setup was not ready");
        };
        assert!(!handed(&spec).contains_key("ANOMANDER_MCP_SECRETS"));
        assert!(!spec
            .env
            .iter()
            .any(|(name, _)| name == "ANOMANDER_MCP_SECRETS"));
        assert!(!f.root.join("settings.json").exists());
    }
}
