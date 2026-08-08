//! Claude Code OAuth credentials stored through Bun's Windows secrets backend.
//!
//! Bun maps `{ service, name }` to a generic Credential Manager target named
//! `service/name`. Claude stores short JSON directly and larger JSON as a
//! bounded base64 manifest plus numbered chunks. Detection is on-demand only,
//! reads exact Claude-owned targets, and never enumerates unrelated credentials.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Deserialize;
use zeroize::Zeroizing;

const CREDENTIAL_ACCOUNT: &str = "claude-code-user";
const CREDENTIAL_CHUNK_BYTES: usize = 2_400;
const CREDENTIAL_MAX_CHUNKS: usize = 256;
pub(super) const CLAUDE_SECURESTORAGE_CONFIG_DIR_ENV: &str = "CLAUDE_SECURESTORAGE_CONFIG_DIR";

#[derive(Debug, Deserialize)]
struct CredentialManifest {
    n: usize,
    l: usize,
}

#[cfg(windows)]
pub(super) fn read_credentials() -> Option<String> {
    let services = credential_services();
    read_credentials_with(&services, read_windows_generic_credential)
}

#[cfg(windows)]
fn credential_services() -> Vec<String> {
    let configured_dir = std::env::var(CLAUDE_SECURESTORAGE_CONFIG_DIR_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            std::env::var("CLAUDE_CONFIG_DIR")
                .ok()
                .filter(|value| !value.trim().is_empty())
        });
    let mut services = configured_dir
        .map(|config_dir| {
            vec![scoped_claude_keychain_service(std::path::Path::new(
                config_dir.trim(),
            ))]
        })
        .unwrap_or_default();
    services.push("Claude Code-credentials".to_string());
    services
}

fn scoped_claude_keychain_service(config_dir: &std::path::Path) -> String {
    use sha2::{Digest, Sha256};
    use unicode_normalization::UnicodeNormalization;

    let normalized = config_dir.to_string_lossy().nfc().collect::<String>();
    let suffix = Sha256::digest(normalized.as_bytes());
    format!("Claude Code-credentials-{:x}", suffix)
        .chars()
        .take("Claude Code-credentials-".len() + 8)
        .collect()
}

fn read_credentials_with<F>(services: &[String], mut read_credential: F) -> Option<String>
where
    F: FnMut(&str, usize) -> Option<Zeroizing<Vec<u8>>>,
{
    for service in services {
        let target = format!("{service}/{CREDENTIAL_ACCOUNT}");
        if let Some(credentials) = read_credential(&target, CREDENTIAL_CHUNK_BYTES)
            .and_then(|bytes| credential_bytes_to_string(&bytes))
        {
            return Some(credentials);
        }

        let marker_target = format!("{target}#m");
        let Some(marker) = read_credential(&marker_target, CREDENTIAL_CHUNK_BYTES) else {
            continue;
        };
        let Ok(manifest) = serde_json::from_slice::<CredentialManifest>(&marker) else {
            continue;
        };
        if manifest.n == 0
            || manifest.n > CREDENTIAL_MAX_CHUNKS
            || manifest.l == 0
            || manifest.l > manifest.n.saturating_mul(CREDENTIAL_CHUNK_BYTES)
        {
            continue;
        }

        let mut encoded = Zeroizing::new(Vec::with_capacity(manifest.l));
        let mut complete = true;
        for chunk_index in 0..manifest.n {
            let chunk_target = format!("{target}#{chunk_index}");
            let Some(chunk) = read_credential(&chunk_target, CREDENTIAL_CHUNK_BYTES) else {
                complete = false;
                break;
            };
            encoded.extend_from_slice(&chunk);
            if encoded.len() > manifest.l {
                complete = false;
                break;
            }
        }
        if !complete || encoded.len() != manifest.l {
            continue;
        }

        let Ok(decoded) = STANDARD.decode(encoded.as_slice()) else {
            continue;
        };
        let decoded = Zeroizing::new(decoded);
        if let Some(credentials) = credential_bytes_to_string(&decoded) {
            return Some(credentials);
        }
    }

    None
}

fn credential_bytes_to_string(bytes: &[u8]) -> Option<String> {
    let value = std::str::from_utf8(bytes).ok()?.trim();
    if value.is_empty()
        || !serde_json::from_str::<serde_json::Value>(value)
            .ok()?
            .get("claudeAiOauth")?
            .is_object()
    {
        return None;
    }
    Some(value.to_string())
}

#[cfg(windows)]
fn read_windows_generic_credential(target: &str, max_bytes: usize) -> Option<Zeroizing<Vec<u8>>> {
    use std::ptr;
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_NOT_FOUND};
    use windows_sys::Win32::Security::Credentials::{
        CredFree, CredReadW, CREDENTIALW, CRED_TYPE_GENERIC,
    };

    struct CredentialGuard(*mut CREDENTIALW);

    impl Drop for CredentialGuard {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CredFree(self.0.cast()) };
            }
        }
    }

    let target_wide = target
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut credential = ptr::null_mut();
    if unsafe { CredReadW(target_wide.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) } == 0 {
        let error = unsafe { GetLastError() };
        if error != ERROR_NOT_FOUND {
            tracing::warn!(
                error,
                "auto_detect::claude: Windows Credential Manager read failed; skipping"
            );
        }
        return None;
    }

    let credential = CredentialGuard(credential);
    let value = unsafe { credential.0.as_ref() }?;
    let blob_len = value.CredentialBlobSize as usize;
    if blob_len == 0 || blob_len > max_bytes || value.CredentialBlob.is_null() {
        return None;
    }

    let mut bytes = Zeroizing::new(vec![0_u8; blob_len]);
    unsafe {
        ptr::copy_nonoverlapping(value.CredentialBlob, bytes.as_mut_ptr(), blob_len);
    }
    Some(bytes)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn read_from(
        entries: HashMap<String, Vec<u8>>,
    ) -> impl FnMut(&str, usize) -> Option<Zeroizing<Vec<u8>>> {
        move |target, max_bytes| {
            entries
                .get(target)
                .and_then(|bytes| (bytes.len() <= max_bytes).then(|| Zeroizing::new(bytes.clone())))
        }
    }

    #[test]
    fn reads_direct_credential() {
        let service = "Claude Code-credentials".to_string();
        let target = format!("{service}/{CREDENTIAL_ACCOUNT}");
        let credentials = r#"{"claudeAiOauth":{"accessToken":"access-token"}}"#;
        let entries = HashMap::from([(target, credentials.as_bytes().to_vec())]);

        let detected = read_credentials_with(&[service], read_from(entries));

        assert_eq!(detected.as_deref(), Some(credentials));
    }

    #[test]
    fn reassembles_chunked_credential() {
        let service = "Claude Code-credentials".to_string();
        let target = format!("{service}/{CREDENTIAL_ACCOUNT}");
        let credentials = format!(
            r#"{{"claudeAiOauth":{{"accessToken":"{}"}}}}"#,
            "a".repeat(CREDENTIAL_CHUNK_BYTES)
        );
        let encoded = STANDARD.encode(credentials.as_bytes());
        let chunks = encoded
            .as_bytes()
            .chunks(CREDENTIAL_CHUNK_BYTES)
            .collect::<Vec<_>>();
        let manifest = format!(r#"{{"n":{},"l":{}}}"#, chunks.len(), encoded.len());
        let mut entries = HashMap::from([(format!("{target}#m"), manifest.into_bytes())]);
        for (index, chunk) in chunks.into_iter().enumerate() {
            entries.insert(format!("{target}#{index}"), chunk.to_vec());
        }

        let detected = read_credentials_with(&[service], read_from(entries));

        assert_eq!(detected.as_deref(), Some(credentials.as_str()));
    }

    #[test]
    fn ignores_incomplete_chunked_credential() {
        let service = "Claude Code-credentials".to_string();
        let target = format!("{service}/{CREDENTIAL_ACCOUNT}");
        let entries = HashMap::from([(format!("{target}#m"), br#"{"n":2,"l":12}"#.to_vec())]);

        let detected = read_credentials_with(&[service], read_from(entries));

        assert!(detected.is_none());
    }

    #[test]
    fn falls_through_to_next_service() {
        let scoped = "Claude Code-credentials-deadbeef".to_string();
        let default = "Claude Code-credentials".to_string();
        let invalid_target = format!("{scoped}/{CREDENTIAL_ACCOUNT}");
        let target = format!("{default}/{CREDENTIAL_ACCOUNT}");
        let credentials = r#"{"claudeAiOauth":{"accessToken":"fallback"}}"#;
        let entries = HashMap::from([
            (invalid_target, b"not-json".to_vec()),
            (target, credentials.as_bytes().to_vec()),
        ]);

        let detected = read_credentials_with(&[scoped, default], read_from(entries));

        assert_eq!(detected.as_deref(), Some(credentials));
    }

    #[cfg(windows)]
    #[test]
    fn scoped_service_normalizes_unicode_config_dir() {
        let composed = scoped_claude_keychain_service(std::path::Path::new("C:\\caf\u{e9}"));
        let decomposed = scoped_claude_keychain_service(std::path::Path::new("C:\\cafe\u{301}"));

        assert_eq!(composed, decomposed);
    }
}
