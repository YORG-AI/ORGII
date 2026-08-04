use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::types::{flexible_datetime, ModelKey, ModelType};

fn default_version() -> String {
    "2.0".to_string()
}

/// Root model for keys storage file (`credentials.json` on disk — key name unchanged).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyStore {
    /// Version for migration support
    #[serde(default = "default_version")]
    pub version: String,
    /// Entries keyed by `ModelKey.id` (JSON field remains `credentials` for on-disk format)
    #[serde(default)]
    #[serde(rename = "credentials")]
    pub keys: HashMap<String, ModelKey>,
    /// Last updated timestamp
    #[serde(default = "Utc::now", with = "flexible_datetime")]
    pub updated_at: chrono::DateTime<Utc>,
}

impl Default for KeyStore {
    fn default() -> Self {
        Self {
            version: default_version(),
            keys: HashMap::new(),
            updated_at: Utc::now(),
        }
    }
}

impl KeyStore {
    /// Get key by agent type and optional ID
    pub fn get(&self, agent_type: &ModelType, key_id: Option<&str>) -> Option<&ModelKey> {
        if let Some(id) = key_id {
            let entry = self.keys.get(id)?;
            if &entry.model_type == agent_type {
                return Some(entry);
            }
            return None;
        }

        // Return oldest entry of this agent type (deterministic ordering)
        self.keys
            .values()
            .filter(|c| &c.model_type == agent_type)
            .min_by_key(|c| c.created_at)
    }

    /// Get key by ID only
    pub fn get_by_id(&self, key_id: &str) -> Option<&ModelKey> {
        self.keys.get(key_id)
    }

    /// Get all keys for an agent type
    pub fn get_all(&self, agent_type: &ModelType) -> Vec<&ModelKey> {
        self.keys
            .values()
            .filter(|c| &c.model_type == agent_type)
            .collect()
    }

    /// Save or update a key
    pub fn set(&mut self, mut key: ModelKey) -> ModelKey {
        key.normalize_enabled_models();
        key.updated_at = Utc::now();
        let saved = key.clone();
        self.keys.insert(key.id.clone(), key);
        self.updated_at = Utc::now();
        saved
    }

    /// Delete key by agent type and optional ID
    pub fn delete(&mut self, agent_type: &ModelType, key_id: Option<&str>) -> bool {
        if let Some(id) = key_id {
            if let Some(entry) = self.keys.get(id) {
                if &entry.model_type == agent_type {
                    self.keys.remove(id);
                    self.updated_at = Utc::now();
                    return true;
                }
            }
            return false;
        }

        // Delete oldest entry of this agent type (deterministic ordering)
        let id_to_delete = self
            .keys
            .iter()
            .filter(|(_, c)| &c.model_type == agent_type)
            .min_by_key(|(_, c)| c.created_at)
            .map(|(id, _)| id.clone());

        if let Some(id) = id_to_delete {
            self.keys.remove(&id);
            self.updated_at = Utc::now();
            return true;
        }
        false
    }

    /// Delete key by ID only
    pub fn delete_by_id(&mut self, key_id: &str) -> bool {
        if self.keys.remove(key_id).is_some() {
            self.updated_at = Utc::now();
            true
        } else {
            false
        }
    }
}
