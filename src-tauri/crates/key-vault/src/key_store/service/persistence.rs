//! Credentials-file persistence: fault-isolating load/save of the on-disk
//! `credentials.json` envelope plus the locked read-modify-write helper the
//! rest of the service builds on.

use serde_json::Value as JsonValue;
use std::fs;

use super::super::store::KeyStore;
use super::super::types::ModelKey;
use super::KeyService;

const RETIRED_MODEL_TYPES: &[&str] = &["gemini_cli"];

#[derive(Debug)]
pub(super) struct InvalidStoredCredential {
    id: String,
    raw: JsonValue,
    error: String,
}

#[derive(Debug)]
pub(super) struct LoadedKeyStore {
    pub(super) store: KeyStore,
    pub(super) invalid_credentials: Vec<InvalidStoredCredential>,
    retired_credential_count: usize,
}

impl LoadedKeyStore {
    pub(super) fn log_diagnostics(&self, storage_file: &std::path::Path) {
        if self.retired_credential_count > 0 {
            tracing::info!(
                path = %storage_file.display(),
                count = self.retired_credential_count,
                "Ignored retired Key Vault credentials"
            );
        }
        for credential in &self.invalid_credentials {
            tracing::warn!(
                path = %storage_file.display(),
                credential_id = %credential.id,
                error = %credential.error,
                "Ignored invalid Key Vault credential; raw entry will be preserved"
            );
        }
    }

    pub(super) fn invalid_credential_error(&self, key_id: &str) -> Option<String> {
        self.invalid_credentials.iter().find_map(|credential| {
            let raw_id = credential.raw.get("id").and_then(JsonValue::as_str);
            (credential.id == key_id || raw_id == Some(key_id)).then(|| {
                format!(
                    "Credential {key_id:?} is invalid and was preserved: {}",
                    credential.error
                )
            })
        })
    }

    pub(super) fn ensure_any_valid_credentials(
        &self,
        storage_file: &std::path::Path,
    ) -> Result<(), String> {
        if self.store.keys.is_empty() && !self.invalid_credentials.is_empty() {
            return Err(format!(
                "No valid credentials could be loaded; {} invalid credential(s) were preserved in {}",
                self.invalid_credentials.len(),
                storage_file.display()
            ));
        }

        Ok(())
    }
}

impl KeyService {
    // ---- Storage ----

    /// Load keys from file.
    ///
    /// Root-level read/parse failures are returned to the caller. Individual
    /// malformed credentials are isolated in `LoadedKeyStore` so valid
    /// siblings remain usable and future writes can preserve the raw entries.
    pub(super) fn load_store_checked(&self) -> Result<LoadedKeyStore, String> {
        if !self.storage_file.exists() {
            return Ok(LoadedKeyStore {
                store: KeyStore::default(),
                invalid_credentials: Vec::new(),
                retired_credential_count: 0,
            });
        }

        let contents = fs::read_to_string(&self.storage_file)
            .map_err(|e| format!("Failed to read {:?}: {}", self.storage_file, e))?;

        deserialize_key_store(&contents)
            .map_err(|e| format!("Corrupted credentials file {:?}: {}", self.storage_file, e))
    }

    /// Load keys, returning default on missing file but logging errors.
    pub(super) fn load_store(&self) -> KeyStore {
        match self.load_store_checked() {
            Ok(loaded) => loaded.store,
            Err(err) => {
                eprintln!("[KeyService] {}", err);
                KeyStore::default()
            }
        }
    }

    /// Save keys to file (atomic write + restrictive permissions).
    /// Secrets (api_key, session_token) are written directly to the JSON file,
    /// protected by 0o600 permissions.
    fn save_store(
        &self,
        store: &KeyStore,
        invalid_credentials: &[InvalidStoredCredential],
    ) -> Result<(), String> {
        let contents = serialize_key_store(store, invalid_credentials)
            .map_err(|e| format!("Failed to serialize credentials: {}", e))?;

        // Write to a temp file first, then rename — atomic on same filesystem
        let tmp_path = self.storage_file.with_extension("json.tmp");
        fs::write(&tmp_path, &contents)
            .map_err(|e| format!("Failed to write credentials temp file: {}", e))?;

        // Restrict permissions before rename so the file is never world-readable
        app_paths::set_sensitive_file_permissions(&tmp_path).ok();

        fs::rename(&tmp_path, &self.storage_file)
            .map_err(|e| format!("Failed to rename credentials file: {}", e))
    }

    /// Update store atomically with a closure.
    /// Uses checked load to avoid overwriting a corrupted file.
    pub(super) fn update_store<F, T>(&self, updater: F) -> Result<T, String>
    where
        F: FnOnce(&mut KeyStore) -> T,
    {
        let _guard = self.lock.lock().map_err(|e| format!("Lock error: {}", e))?;

        let mut loaded = self.load_store_checked()?;
        let result = updater(&mut loaded.store);
        if !loaded.invalid_credentials.is_empty() {
            loaded.log_diagnostics(&self.storage_file);
        }
        self.save_store(&loaded.store, &loaded.invalid_credentials)?;

        Ok(result)
    }
}

fn deserialize_key_store(contents: &str) -> Result<LoadedKeyStore, serde_json::Error> {
    let mut value = serde_json::from_str::<serde_json::Value>(contents)?;
    let credentials = value
        .get_mut("credentials")
        .and_then(serde_json::Value::as_object_mut)
        .map(std::mem::take)
        .unwrap_or_default();

    // Parse the envelope separately from its entries. One unsupported or
    // malformed credential must not poison every valid sibling in the vault.
    let mut store = serde_json::from_value::<KeyStore>(value)?;
    let mut invalid_credentials = Vec::new();
    let mut retired_credential_count = 0;

    for (storage_id, raw) in credentials {
        let agent_type = raw.get("agent_type").and_then(JsonValue::as_str);
        if agent_type.is_some_and(|value| RETIRED_MODEL_TYPES.contains(&value)) {
            retired_credential_count += 1;
            continue;
        }

        match serde_json::from_value::<ModelKey>(raw.clone()) {
            Ok(key) => {
                store.keys.insert(storage_id, key);
            }
            Err(error) => invalid_credentials.push(InvalidStoredCredential {
                id: storage_id,
                raw,
                error: error.to_string(),
            }),
        }
    }

    Ok(LoadedKeyStore {
        store,
        invalid_credentials,
        retired_credential_count,
    })
}

fn serialize_key_store(
    store: &KeyStore,
    invalid_credentials: &[InvalidStoredCredential],
) -> Result<String, String> {
    let mut value = serde_json::to_value(store).map_err(|error| error.to_string())?;
    let credentials = value
        .get_mut("credentials")
        .and_then(JsonValue::as_object_mut)
        .ok_or_else(|| "serialized KeyStore has no credentials object".to_string())?;

    // Valid entries win if a previously invalid id is repaired explicitly.
    for credential in invalid_credentials {
        credentials
            .entry(credential.id.clone())
            .or_insert_with(|| credential.raw.clone());
    }

    serde_json::to_string_pretty(&value).map_err(|error| error.to_string())
}
