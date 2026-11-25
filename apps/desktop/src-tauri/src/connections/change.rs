// DK-11: a change to `mcp.json` the screen asked for, checked and then made: the values to the
// store first, then the file, unless the principal saved it meanwhile.
use serde_json::{Map, Value};

use super::SERVERS;
use crate::connection_secrets::FILE_NAME;
use crate::data_dir::DataDir;
use crate::secure_store::{SecretStore, StoreError};

/// A change to the file, checked and not yet made. Holds secrets: no `Debug`.
pub struct Change {
    /// The file as it was read: it must still be so when it is written.
    pub(super) read: Option<Vec<u8>>,
    pub(super) file: Value,
    pub(super) writes: Vec<Write>,
}

/// What a change does to the store before the file is written.
pub(super) enum Write {
    /// A value typed in the screen.
    Typed { account: String, value: String },
    /// A kept value whose server, or its kind, changed: copied, and the sweep removes the old one
    /// once the file no longer names it.
    Moved { from: String, to: String },
}

impl Change {
    /// The accounts this change may store.
    pub fn accounts(&self) -> Vec<String> {
        self.writes
            .iter()
            .map(|write| match write {
                Write::Typed { account, .. } | Write::Moved { to: account, .. } => account.clone(),
            })
            .collect()
    }

    /// Stores the values, then writes the file with mode `600`.
    pub fn apply(self, data: &DataDir, store: &dyn SecretStore) -> Result<(), String> {
        // The principal may have saved the file since it was read: theirs stays.
        if std::fs::read(data.root().join(FILE_NAME)).ok() != self.read {
            return Err(format!("{FILE_NAME} changed meanwhile: nothing was saved"));
        }
        let failed = |error: StoreError| error.0;
        for write in &self.writes {
            match write {
                Write::Typed { account, value } => store.set(account, value).map_err(failed)?,
                Write::Moved { from, to } => {
                    // Nothing stored is a marker that already waited for its value.
                    if let Some(value) = store.get(from).map_err(failed)? {
                        store.set(to, &value).map_err(failed)?;
                    }
                }
            }
        }
        let unwritten = |error: std::io::Error| format!("could not write {FILE_NAME}: {error}");
        let mut json = serde_json::to_vec_pretty(&self.file)
            .map_err(std::io::Error::other)
            .map_err(unwritten)?;
        json.push(b'\n');
        data.write_private(FILE_NAME, &json).map_err(unwritten)
    }
}

/// The servers with `original` replaced where it stands by `with`, or taken out; a new one goes
/// last. The others keep their order and everything they hold.
pub(super) fn replace(file: &mut Value, original: Option<&str>, mut with: Option<(String, Value)>) {
    let Some(servers) = file.get_mut(SERVERS).and_then(Value::as_object_mut) else {
        return;
    };
    let mut next = Map::new();
    for (name, entry) in std::mem::take(servers) {
        if Some(name.as_str()) != original {
            next.insert(name, entry);
        } else if let Some((name, entry)) = with.take() {
            next.insert(name, entry);
        }
    }
    if let Some((name, entry)) = with {
        next.insert(name, entry);
    }
    *servers = next;
}

#[cfg(test)]
mod tests {
    use crate::connections::test_support::*;

    #[test]
    fn a_file_saved_since_it_was_read_is_not_written_over() -> Outcome {
        let f = Fixture::written()?;
        let store = MemoryStore::default();
        let input: ServerInput = serde_json::from_value(notes()).map_err(|e| e.to_string())?;
        let change = save(&f.data, &input)?;
        let theirs = json!({ "mcpServers": {} }).to_string();
        f.write(&theirs)?;

        assert!(change.apply(&f.data, &store).is_err());

        assert_eq!(f.text()?, theirs);
        assert!(store.names().is_empty());
        Ok(())
    }

    #[test]
    fn a_value_the_store_refuses_leaves_the_file_as_it_was() -> Outcome {
        let f = Fixture::written()?;
        let before = f.text()?;

        let Err(error) = f.save(&MemoryStore::failing(), notes()) else {
            return Err("saved without its value".into());
        };

        assert!(!error.contains(TYPED), "{error}");
        assert_eq!(f.text()?, before);
        Ok(())
    }
}
