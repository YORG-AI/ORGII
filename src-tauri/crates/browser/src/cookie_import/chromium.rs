//! Chromium-family cookie reader (Chrome, Edge, Brave, Arc, Vivaldi, …).
//!
//! Chromium stores cookies in a `Cookies` SQLite database. Values are
//! encrypted: on macOS with AES-128-CBC under a key derived from a
//! per-application password held in the login keychain (the `v10` scheme).
//!
//! Two halves live here:
//! - **Pure decryption** ([`derive_chromium_key`], [`decrypt_chromium_value`])
//!   — cross-platform and unit-tested with known vectors.
//! - **Keychain access** ([`chromium_keychain_key`]) — macOS only, and the one
//!   step that triggers the system's own consent prompt.

use std::path::Path;

use super::{CookieReadError, DecryptedCookie, SameSite};

/// Seconds between the Windows/Chromium epoch (1601-01-01) and the Unix epoch.
const CHROMIUM_EPOCH_OFFSET_SECONDS: i64 = 11_644_473_600;

/// PBKDF2 salt Chromium uses for every platform's value encryption.
const CHROMIUM_KDF_SALT: &[u8] = b"saltysalt";

/// PBKDF2 iteration count for the macOS `v10` scheme.
const CHROMIUM_KDF_ROUNDS_MACOS: u32 = 1003;

/// AES-128-CBC IV Chromium uses on macOS: sixteen spaces (`0x20`).
const CHROMIUM_CBC_IV: [u8; 16] = [0x20; 16];

/// DB `meta.version` at which the encrypted payload gains a 32-byte
/// SHA-256(host_key) prefix that must be dropped after decryption.
const CHROMIUM_DOMAIN_HASH_MIN_VERSION: i64 = 24;

type Aes128CbcDec = cbc::Decryptor<aes::Aes128>;

/// Derive the 16-byte AES key from a Chromium keychain password (macOS `v10`).
pub fn derive_chromium_key(password: &[u8]) -> [u8; 16] {
    let mut key = [0u8; 16];
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(
        password,
        CHROMIUM_KDF_SALT,
        CHROMIUM_KDF_ROUNDS_MACOS,
        &mut key,
    );
    key
}

/// Strip PKCS#7 padding leniently: a valid trailing pad is removed, anything
/// else is left untouched so a non-standard tail still yields usable bytes.
fn strip_pkcs7(buffer: &mut Vec<u8>) {
    let Some(&last) = buffer.last() else {
        return;
    };
    let pad = last as usize;
    if (1..=16).contains(&pad) && pad <= buffer.len() {
        let start = buffer.len() - pad;
        if buffer[start..].iter().all(|&byte| byte == last) {
            buffer.truncate(start);
        }
    }
}

/// AES-128-CBC decrypt with the Chromium IV, without automatic unpadding.
fn aes_cbc_decrypt(key: &[u8; 16], ciphertext: &[u8]) -> Option<Vec<u8>> {
    use cbc::cipher::{block_padding::NoPadding, BlockDecryptMut, KeyIvInit};

    if ciphertext.is_empty() || ciphertext.len() % 16 != 0 {
        return None;
    }
    let mut buffer = ciphertext.to_vec();
    Aes128CbcDec::new(key.into(), (&CHROMIUM_CBC_IV).into())
        .decrypt_padded_mut::<NoPadding>(&mut buffer)
        .ok()?;
    strip_pkcs7(&mut buffer);
    Some(buffer)
}

/// Decrypt one Chromium `encrypted_value`.
///
/// Returns `None` when the value uses a scheme this reader does not implement
/// (anything but the macOS `v10` scheme), when no key is available, or when the
/// decrypted bytes are not valid UTF-8.
pub fn decrypt_chromium_value(
    key: Option<&[u8; 16]>,
    encrypted: &[u8],
    db_version: i64,
) -> Option<String> {
    if encrypted.len() < 3 {
        // Some rows carry an empty encrypted blob and a plaintext value instead;
        // those are handled by the caller before reaching here.
        return None;
    }
    if &encrypted[..3] != b"v10" {
        // v11 (Linux libsecret) / DPAPI (Windows) are out of scope for now.
        return None;
    }
    let key = key?;
    let mut plain = aes_cbc_decrypt(key, &encrypted[3..])?;
    if db_version >= CHROMIUM_DOMAIN_HASH_MIN_VERSION {
        if plain.len() < 32 {
            return None;
        }
        plain.drain(..32);
    }
    String::from_utf8(plain).ok()
}

/// Convert a Chromium `expires_utc` (microseconds since 1601) to Unix seconds.
/// `0` marks a session cookie and yields `None`.
fn expires_to_unix(expires_utc: i64) -> Option<i64> {
    if expires_utc <= 0 {
        return None;
    }
    Some(expires_utc / 1_000_000 - CHROMIUM_EPOCH_OFFSET_SECONDS)
}

/// Chromium `samesite`: -1 = unspecified, 0 = None, 1 = Lax, 2 = Strict.
fn same_site_from_chromium(raw: i64) -> SameSite {
    match raw {
        0 => SameSite::None,
        1 => SameSite::Lax,
        2 => SameSite::Strict,
        _ => SameSite::Unspecified,
    }
}

/// Outcome of reading one Chromium cookie store: the decrypted cookies plus a
/// count of rows whose value could not be decrypted (reported to the user
/// rather than hidden).
pub struct ChromiumReadResult {
    pub cookies: Vec<DecryptedCookie>,
    pub undecryptable: usize,
}

/// Read and decrypt every cookie from a Chromium `Cookies` database.
///
/// `key` is the derived AES key (see [`derive_chromium_key`]); pass `None` on a
/// platform where the key cannot be obtained, in which case only rows that
/// happen to store a plaintext value are returned.
pub fn read_cookies(
    store_path: &Path,
    key: Option<&[u8; 16]>,
) -> Result<ChromiumReadResult, CookieReadError> {
    let connection = super::open_sqlite_readonly(store_path)?;

    let db_version: i64 = connection
        .query_row("SELECT value FROM meta WHERE key = 'version'", [], |row| {
            row.get::<_, String>(0)
        })
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);

    let mut statement = connection
        .prepare(
            "SELECT host_key, name, value, encrypted_value, path, expires_utc, \
             is_secure, is_httponly, samesite FROM cookies",
        )
        .map_err(|error| CookieReadError::Query(error.to_string()))?;

    struct RawRow {
        host_key: String,
        name: String,
        value: String,
        encrypted_value: Vec<u8>,
        path: String,
        expires_utc: i64,
        is_secure: bool,
        is_http_only: bool,
        same_site: SameSite,
    }

    let rows = statement
        .query_map([], |row| {
            Ok(RawRow {
                host_key: row.get::<_, String>(0)?,
                name: row.get::<_, String>(1)?,
                value: row.get::<_, String>(2)?,
                encrypted_value: row.get::<_, Vec<u8>>(3)?,
                path: row.get::<_, String>(4)?,
                expires_utc: row.get::<_, i64>(5)?,
                is_secure: row.get::<_, i64>(6)? != 0,
                is_http_only: row.get::<_, i64>(7)? != 0,
                same_site: same_site_from_chromium(row.get::<_, i64>(8)?),
            })
        })
        .map_err(|error| CookieReadError::Query(error.to_string()))?;

    let mut cookies = Vec::new();
    let mut undecryptable = 0usize;

    for row in rows {
        let row = row.map_err(|error| CookieReadError::Query(error.to_string()))?;
        if row.name.is_empty() {
            continue;
        }

        // A non-empty plaintext `value` (older rows) is used directly;
        // otherwise decrypt the `encrypted_value` blob.
        let value = if !row.value.is_empty() {
            Some(row.value.clone())
        } else if row.encrypted_value.is_empty() {
            Some(String::new())
        } else {
            decrypt_chromium_value(key, &row.encrypted_value, db_version)
        };

        match value {
            Some(value) => cookies.push(DecryptedCookie {
                host_key: row.host_key,
                name: row.name,
                value,
                path: row.path,
                expires_utc: expires_to_unix(row.expires_utc),
                is_secure: row.is_secure,
                is_http_only: row.is_http_only,
                same_site: row.same_site,
            }),
            None => undecryptable += 1,
        }
    }

    Ok(ChromiumReadResult {
        cookies,
        undecryptable,
    })
}

/// Derived keys by keychain service, for the life of the process.
///
/// Holding the derived 16-byte key (never the password) means the OS consent
/// prompt appears once per app session: the preview and the later import
/// share it, and a denied attempt caches nothing, so the next click simply
/// prompts again.
#[cfg(target_os = "macos")]
static CHROMIUM_KEYS: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, [u8; 16]>>,
> = std::sync::OnceLock::new();

/// Read the Chromium value-encryption password from the macOS login keychain
/// and derive the AES key, caching the result per service.
///
/// The cache lock is held across the OS call on purpose: a second attempt
/// made while a prompt is still open waits for it, then finds the cached key
/// (or, after a denial, prompts afresh) instead of queueing a second dialog.
#[cfg(target_os = "macos")]
pub fn chromium_keychain_key(
    service: &str,
    account: &str,
) -> Result<[u8; 16], CookieReadError> {
    let cache = CHROMIUM_KEYS.get_or_init(|| std::sync::Mutex::new(Default::default()));
    let mut keys = cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(key) = keys.get(service) {
        return Ok(*key);
    }
    let password = security_framework::passwords::get_generic_password(service, account)
        .map_err(|error| CookieReadError::Keychain {
            code: error.code(),
            message: error.to_string(),
        })?;
    let key = derive_chromium_key(&password);
    keys.insert(service.to_string(), key);
    Ok(key)
}

#[cfg(test)]
#[path = "tests/chromium_tests.rs"]
mod tests;
