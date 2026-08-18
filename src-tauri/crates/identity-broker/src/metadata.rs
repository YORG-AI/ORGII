use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::types::{PersistedRegistry, MAX_PERSISTED_SESSIONS, REGISTRY_SCHEMA_VERSION};
use crate::BrokerError;

const MAX_METADATA_BYTES: u64 = 1024 * 1024;

pub(crate) trait SessionMetadataStore: Send + Sync {
    fn load(&self) -> Result<Option<PersistedRegistry>, BrokerError>;
    fn save(&self, registry: &PersistedRegistry) -> Result<(), BrokerError>;
}

pub(crate) struct FileSessionMetadataStore {
    path: PathBuf,
    operation_gate: Mutex<()>,
}

impl FileSessionMetadataStore {
    pub(crate) fn new(path: PathBuf) -> Self {
        Self {
            path,
            operation_gate: Mutex::new(()),
        }
    }

    fn parent(&self) -> Result<&Path, BrokerError> {
        self.path
            .parent()
            .ok_or(BrokerError::InvalidMetadata("metadata path has no parent"))
    }

    fn open_lock_file(&self) -> Result<File, BrokerError> {
        let parent = self.parent()?;
        std::fs::create_dir_all(parent).map_err(|source| BrokerError::MetadataIo {
            operation: "directory creation",
            source,
        })?;
        let lock_path = self.path.with_extension("lock");
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(lock_path)
            .map_err(|source| BrokerError::MetadataIo {
                operation: "lock open",
                source,
            })?;
        fs2::FileExt::lock_exclusive(&file).map_err(|source| BrokerError::MetadataIo {
            operation: "lock acquisition",
            source,
        })?;
        Ok(file)
    }

    fn validate(registry: &PersistedRegistry) -> Result<(), BrokerError> {
        if registry.schema_version != REGISTRY_SCHEMA_VERSION {
            return Err(BrokerError::InvalidMetadata("unsupported schema version"));
        }
        if registry.sessions.len() > MAX_PERSISTED_SESSIONS {
            return Err(BrokerError::InvalidMetadata("session limit exceeded"));
        }
        let mut session_ids = std::collections::BTreeSet::new();
        for session in &registry.sessions {
            if !session.session_id.is_valid() {
                return Err(BrokerError::InvalidMetadata("invalid session id"));
            }
            if !session_ids.insert(session.session_id.clone()) {
                return Err(BrokerError::InvalidMetadata("duplicate session id"));
            }
            if !session.credential_ref.is_valid() {
                return Err(BrokerError::InvalidMetadata("invalid credential reference"));
            }
            if session.issuer.len() > 2048
                || session.subject.is_empty()
                || session.subject.len() > 512
            {
                return Err(BrokerError::InvalidMetadata("invalid session metadata"));
            }
        }
        if registry.active_sessions.iter().any(|(realm, id)| {
            !registry
                .sessions
                .iter()
                .any(|session| session.realm == *realm && session.session_id == *id)
        }) {
            return Err(BrokerError::InvalidMetadata(
                "active session does not exist",
            ));
        }
        if registry
            .quarantined_credentials
            .iter()
            .any(|credential_ref| !credential_ref.is_valid())
        {
            return Err(BrokerError::InvalidMetadata(
                "invalid quarantined credential reference",
            ));
        }
        Ok(())
    }
}

impl SessionMetadataStore for FileSessionMetadataStore {
    fn load(&self) -> Result<Option<PersistedRegistry>, BrokerError> {
        let _operation = self
            .operation_gate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _file_lock = self.open_lock_file()?;
        if !self.path.exists() {
            return Ok(None);
        }
        let metadata = std::fs::metadata(&self.path).map_err(|source| BrokerError::MetadataIo {
            operation: "metadata inspection",
            source,
        })?;
        if metadata.len() > MAX_METADATA_BYTES {
            return Err(BrokerError::InvalidMetadata("metadata file is too large"));
        }
        let mut file = File::open(&self.path).map_err(|source| BrokerError::MetadataIo {
            operation: "read",
            source,
        })?;
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        file.read_to_end(&mut bytes)
            .map_err(|source| BrokerError::MetadataIo {
                operation: "read",
                source,
            })?;
        let registry: PersistedRegistry =
            serde_json::from_slice(&bytes).map_err(BrokerError::MetadataSerialization)?;
        Self::validate(&registry)?;
        Ok(Some(registry))
    }

    fn save(&self, registry: &PersistedRegistry) -> Result<(), BrokerError> {
        Self::validate(registry)?;
        let _operation = self
            .operation_gate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _file_lock = self.open_lock_file()?;
        let parent = self.parent()?;
        let bytes =
            serde_json::to_vec_pretty(registry).map_err(BrokerError::MetadataSerialization)?;
        let mut temporary =
            tempfile::NamedTempFile::new_in(parent).map_err(|source| BrokerError::MetadataIo {
                operation: "temporary file creation",
                source,
            })?;
        temporary
            .write_all(&bytes)
            .and_then(|()| temporary.as_file_mut().sync_all())
            .map_err(|source| BrokerError::MetadataIo {
                operation: "temporary file write",
                source,
            })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            temporary
                .as_file()
                .set_permissions(std::fs::Permissions::from_mode(0o600))
                .map_err(|source| BrokerError::MetadataIo {
                    operation: "permission update",
                    source,
                })?;
        }
        temporary
            .persist(&self.path)
            .map_err(|error| BrokerError::MetadataIo {
                operation: "atomic replace",
                source: error.error,
            })?;
        #[cfg(unix)]
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|source| BrokerError::MetadataIo {
                operation: "directory sync",
                source,
            })?;
        Ok(())
    }
}

#[cfg(test)]
#[derive(Default)]
pub(crate) struct MemorySessionMetadataStore {
    registry: Mutex<Option<PersistedRegistry>>,
}

#[cfg(test)]
impl SessionMetadataStore for MemorySessionMetadataStore {
    fn load(&self) -> Result<Option<PersistedRegistry>, BrokerError> {
        Ok(self
            .registry
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone())
    }

    fn save(&self, registry: &PersistedRegistry) -> Result<(), BrokerError> {
        *self
            .registry
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(registry.clone());
        Ok(())
    }
}
