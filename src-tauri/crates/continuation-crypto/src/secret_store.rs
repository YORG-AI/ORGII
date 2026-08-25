use std::sync::{Mutex, OnceLock};

use zeroize::Zeroizing;

use crate::SecretStoreError;

const KEYRING_SERVICE: &str = "ai.org2.continuation-device";

pub(crate) mod sealed {
    pub trait Sealed {}
}

/// Secret bytes with deterministic zeroization and no `Debug`/serde surface.
pub struct SecretBytes(Zeroizing<Vec<u8>>);

impl SecretBytes {
    pub fn new(bytes: Vec<u8>) -> Self {
        Self(Zeroizing::new(bytes))
    }

    pub fn as_slice(&self) -> &[u8] {
        self.0.as_slice()
    }
}

/// Minimal secure-store capability required by the identity manager.
///
/// `Ok(None)` means the named device has never initialized an identity.
/// Backend lock, availability, permission, and corruption failures are errors;
/// implementations must never silently fall back to a file or memory secret.
pub trait DeviceSecretStore: sealed::Sealed + Send + Sync {
    fn load(&self, entry_id: &str) -> Result<Option<SecretBytes>, SecretStoreError>;
    fn store(&self, entry_id: &str, secret: &SecretBytes) -> Result<(), SecretStoreError>;
}

/// Production secure store backed by Keychain, Windows Credential Manager, or
/// Linux Secret Service according to the compilation target.
#[derive(Clone, Copy, Default)]
pub struct KeyringDeviceSecretStore;

impl sealed::Sealed for KeyringDeviceSecretStore {}

fn keyring_access_gate() -> &'static Mutex<()> {
    static GATE: OnceLock<Mutex<()>> = OnceLock::new();
    GATE.get_or_init(|| Mutex::new(()))
}

#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
fn entry(device_id: &str) -> Result<keyring::Entry, SecretStoreError> {
    keyring::Entry::new(KEYRING_SERVICE, device_id).map_err(|_| SecretStoreError::Unavailable)
}

#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
fn map_load_error(error: keyring::Error) -> Result<Option<SecretBytes>, SecretStoreError> {
    match error {
        keyring::Error::NoEntry => Ok(None),
        keyring::Error::Ambiguous(_) => Err(SecretStoreError::Ambiguous),
        keyring::Error::PlatformFailure(_) => Err(SecretStoreError::Unavailable),
        keyring::Error::NoStorageAccess(_) => Err(SecretStoreError::AccessDenied),
        _ => Err(SecretStoreError::Unavailable),
    }
}

impl DeviceSecretStore for KeyringDeviceSecretStore {
    fn load(&self, device_id: &str) -> Result<Option<SecretBytes>, SecretStoreError> {
        #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
        {
            let _guard = keyring_access_gate()
                .lock()
                .map_err(|_| SecretStoreError::Unavailable)?;
            match entry(device_id)?.get_secret() {
                Ok(secret) => Ok(Some(SecretBytes::new(secret))),
                Err(error) => map_load_error(error),
            }
        }

        #[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
        {
            let _ = device_id;
            Err(SecretStoreError::Unavailable)
        }
    }

    fn store(&self, device_id: &str, secret: &SecretBytes) -> Result<(), SecretStoreError> {
        #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
        {
            let _guard = keyring_access_gate()
                .lock()
                .map_err(|_| SecretStoreError::Unavailable)?;
            entry(device_id)?
                .set_secret(secret.as_slice())
                .map_err(|_| SecretStoreError::Rejected)
        }

        #[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
        {
            let _ = (device_id, secret);
            Err(SecretStoreError::Unavailable)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_service_name_is_nonempty_and_domain_scoped() {
        assert_eq!(KEYRING_SERVICE, "ai.org2.continuation-device");
    }
}
