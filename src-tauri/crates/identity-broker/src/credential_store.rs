use std::collections::BTreeMap;
use std::fmt;
#[cfg(all(not(debug_assertions), target_os = "macos"))]
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex};

use zeroize::Zeroize;

use crate::types::CredentialRef;
use crate::{CredentialStoreError, SecureStoreStatus};

pub struct SecretBytes(Vec<u8>);

impl SecretBytes {
    pub fn new(value: impl Into<Vec<u8>>) -> Self {
        Self(value.into())
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn expose(&self) -> &[u8] {
        &self.0
    }

    pub(crate) fn copy_secret(&self) -> Self {
        Self(self.0.clone())
    }
}

impl fmt::Debug for SecretBytes {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("<redacted>")
    }
}

impl fmt::Display for SecretBytes {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("<redacted>")
    }
}

impl Drop for SecretBytes {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

pub trait CredentialStore: Send + Sync {
    fn put_refresh_credential(
        &self,
        key: &CredentialRef,
        secret: SecretBytes,
    ) -> Result<(), CredentialStoreError>;

    fn get_refresh_credential(
        &self,
        key: &CredentialRef,
    ) -> Result<Option<SecretBytes>, CredentialStoreError>;

    fn delete_refresh_credential(&self, key: &CredentialRef) -> Result<(), CredentialStoreError>;

    fn health(&self) -> SecureStoreStatus;
}

#[derive(Default)]
pub struct MemoryCredentialStore {
    values: Mutex<BTreeMap<String, Vec<u8>>>,
}

impl MemoryCredentialStore {
    fn lock_values(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, Vec<u8>>> {
        self.values
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl CredentialStore for MemoryCredentialStore {
    fn put_refresh_credential(
        &self,
        key: &CredentialRef,
        secret: SecretBytes,
    ) -> Result<(), CredentialStoreError> {
        if let Some(mut replaced) = self
            .lock_values()
            .insert(key.as_str().to_owned(), secret.expose().to_vec())
        {
            replaced.zeroize();
        }
        Ok(())
    }

    fn get_refresh_credential(
        &self,
        key: &CredentialRef,
    ) -> Result<Option<SecretBytes>, CredentialStoreError> {
        Ok(self
            .lock_values()
            .get(key.as_str())
            .cloned()
            .map(SecretBytes::new))
    }

    fn delete_refresh_credential(&self, key: &CredentialRef) -> Result<(), CredentialStoreError> {
        if let Some(mut removed) = self.lock_values().remove(key.as_str()) {
            removed.zeroize();
        }
        Ok(())
    }

    fn health(&self) -> SecureStoreStatus {
        SecureStoreStatus::Available
    }
}

pub struct FaultCredentialStore {
    inner: Arc<MemoryCredentialStore>,
    fail_put: bool,
    fail_get: bool,
    fail_delete: bool,
    status: SecureStoreStatus,
}

impl FaultCredentialStore {
    pub fn fail_put() -> Self {
        Self {
            inner: Arc::new(MemoryCredentialStore::default()),
            fail_put: true,
            fail_get: false,
            fail_delete: false,
            status: SecureStoreStatus::Available,
        }
    }

    pub fn unavailable() -> Self {
        Self {
            inner: Arc::new(MemoryCredentialStore::default()),
            fail_put: true,
            fail_get: true,
            fail_delete: true,
            status: SecureStoreStatus::Unavailable,
        }
    }
}

impl CredentialStore for FaultCredentialStore {
    fn put_refresh_credential(
        &self,
        key: &CredentialRef,
        secret: SecretBytes,
    ) -> Result<(), CredentialStoreError> {
        if self.fail_put {
            return Err(CredentialStoreError::OperationFailed { operation: "write" });
        }
        self.inner.put_refresh_credential(key, secret)
    }

    fn get_refresh_credential(
        &self,
        key: &CredentialRef,
    ) -> Result<Option<SecretBytes>, CredentialStoreError> {
        if self.fail_get {
            return Err(match self.status {
                SecureStoreStatus::Locked => CredentialStoreError::Locked,
                SecureStoreStatus::Unavailable => CredentialStoreError::Unavailable,
                SecureStoreStatus::Available => {
                    CredentialStoreError::OperationFailed { operation: "read" }
                }
            });
        }
        self.inner.get_refresh_credential(key)
    }

    fn delete_refresh_credential(&self, key: &CredentialRef) -> Result<(), CredentialStoreError> {
        if self.fail_delete {
            return Err(CredentialStoreError::OperationFailed {
                operation: "delete",
            });
        }
        self.inner.delete_refresh_credential(key)
    }

    fn health(&self) -> SecureStoreStatus {
        self.status
    }
}

pub struct UnavailableCredentialStore;

impl CredentialStore for UnavailableCredentialStore {
    fn put_refresh_credential(
        &self,
        _key: &CredentialRef,
        _secret: SecretBytes,
    ) -> Result<(), CredentialStoreError> {
        Err(CredentialStoreError::Unavailable)
    }

    fn get_refresh_credential(
        &self,
        _key: &CredentialRef,
    ) -> Result<Option<SecretBytes>, CredentialStoreError> {
        Err(CredentialStoreError::Unavailable)
    }

    fn delete_refresh_credential(&self, _key: &CredentialRef) -> Result<(), CredentialStoreError> {
        Err(CredentialStoreError::Unavailable)
    }

    fn health(&self) -> SecureStoreStatus {
        SecureStoreStatus::Unavailable
    }
}

#[cfg(all(not(debug_assertions), target_os = "macos"))]
pub struct MacOsKeychainCredentialStore {
    service: String,
    status: AtomicU8,
}

#[cfg(all(not(debug_assertions), target_os = "macos"))]
impl MacOsKeychainCredentialStore {
    pub fn new(runtime_profile: &str) -> Self {
        let profile: String = runtime_profile
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                    character
                } else {
                    '_'
                }
            })
            .take(80)
            .collect();
        Self {
            service: format!("ai.orgii.identity.{profile}"),
            status: AtomicU8::new(0),
        }
    }

    fn classify(
        &self,
        error: security_framework::base::Error,
        operation: &'static str,
    ) -> CredentialStoreError {
        use security_framework_sys::base::errSecAuthFailed as ERR_SEC_AUTH_FAILED;

        const ERR_SEC_NOT_AVAILABLE: i32 = -25_291;
        const ERR_SEC_INTERACTION_NOT_ALLOWED: i32 = -25_308;
        let classified = match error.code() {
            ERR_SEC_AUTH_FAILED | ERR_SEC_INTERACTION_NOT_ALLOWED => CredentialStoreError::Locked,
            ERR_SEC_NOT_AVAILABLE => CredentialStoreError::Unavailable,
            _ => CredentialStoreError::OperationFailed { operation },
        };
        self.status.store(
            match classified {
                CredentialStoreError::Locked => 1,
                CredentialStoreError::Unavailable => 2,
                CredentialStoreError::OperationFailed { .. } => 0,
            },
            Ordering::Relaxed,
        );
        classified
    }

    fn mark_available(&self) {
        self.status.store(0, Ordering::Relaxed);
    }
}

#[cfg(all(not(debug_assertions), target_os = "macos"))]
impl CredentialStore for MacOsKeychainCredentialStore {
    fn put_refresh_credential(
        &self,
        key: &CredentialRef,
        secret: SecretBytes,
    ) -> Result<(), CredentialStoreError> {
        security_framework::passwords::set_generic_password(
            &self.service,
            key.as_str(),
            secret.expose(),
        )
        .map(|()| self.mark_available())
        .map_err(|error| self.classify(error, "write"))
    }

    fn get_refresh_credential(
        &self,
        key: &CredentialRef,
    ) -> Result<Option<SecretBytes>, CredentialStoreError> {
        use security_framework_sys::base::errSecItemNotFound;

        match security_framework::passwords::get_generic_password(&self.service, key.as_str()) {
            Ok(value) => {
                self.mark_available();
                Ok(Some(SecretBytes::new(value)))
            }
            Err(error) if error.code() == errSecItemNotFound => {
                self.mark_available();
                Ok(None)
            }
            Err(error) => Err(self.classify(error, "read")),
        }
    }

    fn delete_refresh_credential(&self, key: &CredentialRef) -> Result<(), CredentialStoreError> {
        use security_framework_sys::base::errSecItemNotFound;

        match security_framework::passwords::delete_generic_password(&self.service, key.as_str()) {
            Ok(()) => {
                self.mark_available();
                Ok(())
            }
            Err(error) if error.code() == errSecItemNotFound => {
                self.mark_available();
                Ok(())
            }
            Err(error) => Err(self.classify(error, "delete")),
        }
    }

    fn health(&self) -> SecureStoreStatus {
        match self.status.load(Ordering::Relaxed) {
            1 => SecureStoreStatus::Locked,
            2 => SecureStoreStatus::Unavailable,
            _ => SecureStoreStatus::Available,
        }
    }
}

pub fn platform_credential_store(runtime_profile: &str) -> Arc<dyn CredentialStore> {
    // A `cargo tauri dev` executable is rebuilt with a new ad-hoc code
    // identity. macOS consequently asks for the login-Keychain password on
    // repeated launches/focus restores even though the application path is
    // unchanged. Keep debug credentials process-local: this removes the
    // prompt without weakening a Keychain item's ACL. Debug sessions require
    // sign-in again after restart; signed release builds remain persistent.
    #[cfg(debug_assertions)]
    {
        let _ = runtime_profile;
        Arc::new(MemoryCredentialStore::default())
    }

    #[cfg(all(not(debug_assertions), target_os = "macos"))]
    {
        Arc::new(MacOsKeychainCredentialStore::new(runtime_profile))
    }

    #[cfg(all(not(debug_assertions), not(target_os = "macos")))]
    {
        let _ = runtime_profile;
        Arc::new(UnavailableCredentialStore)
    }
}

#[cfg(all(test, debug_assertions))]
mod tests {
    use super::*;
    use crate::{IdentityRealm, IdentitySessionId};

    #[test]
    fn debug_platform_credentials_are_process_local_and_do_not_persist() {
        let session_id = IdentitySessionId::parse("550e8400-e29b-41d4-a716-446655440000").unwrap();
        let key = CredentialRef::for_session(IdentityRealm::HostedServiceLegacy, &session_id);
        let first = platform_credential_store("yorg.orgii");
        let restarted = platform_credential_store("yorg.orgii");
        first
            .put_refresh_credential(&key, SecretBytes::new(b"debug-refresh".to_vec()))
            .unwrap();
        assert!(first.get_refresh_credential(&key).unwrap().is_some());
        assert!(restarted.get_refresh_credential(&key).unwrap().is_none());
    }
}
