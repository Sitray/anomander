// The fixture the tests of the connections' modules share: a data folder with `mcp.json`.
pub(super) use super::*;
pub(super) use crate::connection_secrets::{sweep, FILE_NAME};
pub(super) use crate::secure_store::MemoryStore;
#[cfg(unix)]
pub(super) use std::os::unix::fs::PermissionsExt;

pub(super) type Outcome = Result<(), String>;

pub(super) struct Fixture {
    _parent: tempfile::TempDir,
    pub(super) data: DataDir,
}

impl Fixture {
    pub(super) fn new() -> Result<Self, String> {
        let parent = tempfile::tempdir().map_err(|e| e.to_string())?;
        let data = DataDir::open(parent.path().join("ANOMANDER")).map_err(|e| e.to_string())?;
        Ok(Self {
            _parent: parent,
            data,
        })
    }

    /// With the file the principal wrote by hand, not swept yet.
    pub(super) fn written() -> Result<Self, String> {
        let f = Self::new()?;
        f.write(&written().to_string())?;
        Ok(f)
    }

    pub(super) fn path(&self) -> std::path::PathBuf {
        self.data.root().join(FILE_NAME)
    }

    pub(super) fn write(&self, text: &str) -> Outcome {
        std::fs::write(self.path(), text).map_err(|e| e.to_string())
    }

    pub(super) fn text(&self) -> Result<String, String> {
        std::fs::read_to_string(self.path()).map_err(|e| e.to_string())
    }

    pub(super) fn file(&self) -> Result<Value, String> {
        serde_json::from_str(&self.text()?).map_err(|e| e.to_string())
    }

    pub(super) fn save(&self, store: &dyn SecretStore, input: Value) -> Outcome {
        let input: ServerInput = serde_json::from_value(input).map_err(|e| e.to_string())?;
        save(&self.data, &input)?.apply(&self.data, store)
    }
}

pub(super) fn written() -> Value {
    json!({
        "mcpServers": {
            "zeta": {
                "command": "npx",
                "args": ["-y", "zeta-mcp"],
                "env": { "TOKEN": "tok-1", "EMPTY": "" },
                "readOnly": ["search"]
            },
            "alpha": {
                "url": "https://example.com/mcp",
                "headers": { "Authorization": "Bearer b-2" }
            }
        }
    })
}

pub(super) const TYPED: &str = "typed-secret-9";
pub(super) const ZETA_TOKEN: &str = "mcp/zeta/env/TOKEN";
pub(super) const ALPHA_HEADER: &str = "mcp/alpha/headers/Authorization";

pub(super) fn notes() -> Value {
    json!({
        "name": "notes",
        "kind": "process",
        "command": "npx",
        "args": ["-y", "notes-mcp"],
        "values": [{ "name": "API_KEY", "value": TYPED }],
        "readOnly": ["list"]
    })
}
