//! Chromium decryption round-trip tests.
//!
//! These build a `v10` ciphertext with a standard AES-128-CBC encryptor and the
//! Chromium IV, then assert the reader recovers the plaintext — validating the
//! IV, PKCS#7 handling, `v10` prefix, and the v24 domain-hash prefix strip
//! without touching the keychain or a real browser store.

use super::{decrypt_chromium_value, derive_chromium_key, expires_to_unix, read_cookies};

fn encrypt_v10(key: &[u8; 16], plaintext: &[u8]) -> Vec<u8> {
    use cbc::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
    type Encryptor = cbc::Encryptor<aes::Aes128>;

    let iv = [0x20u8; 16];
    let ciphertext = Encryptor::new(key.into(), (&iv).into())
        .encrypt_padded_vec_mut::<Pkcs7>(plaintext);
    let mut encoded = b"v10".to_vec();
    encoded.extend_from_slice(&ciphertext);
    encoded
}

#[test]
fn derive_key_is_deterministic_and_16_bytes() {
    let first = derive_chromium_key(b"peanuts");
    let second = derive_chromium_key(b"peanuts");
    assert_eq!(first, second);
    assert_eq!(first.len(), 16);
    assert_ne!(first, derive_chromium_key(b"different"));
}

#[test]
fn round_trip_v10_value_without_domain_hash() {
    let key = derive_chromium_key(b"peanuts");
    let encrypted = encrypt_v10(&key, b"session=abc123");
    assert_eq!(
        decrypt_chromium_value(Some(&key), &encrypted, 0).as_deref(),
        Some("session=abc123")
    );
}

#[test]
fn round_trip_v10_strips_domain_hash_on_v24() {
    let key = derive_chromium_key(b"peanuts");
    // v24+ prepends a 32-byte SHA-256(host) before encryption.
    let mut payload = vec![0u8; 32];
    payload.extend_from_slice(b"token=xyz");
    let encrypted = encrypt_v10(&key, &payload);

    assert_eq!(
        decrypt_chromium_value(Some(&key), &encrypted, 24).as_deref(),
        Some("token=xyz")
    );
    // Reading the same bytes as an older DB keeps the 32-byte prefix.
    assert_eq!(
        decrypt_chromium_value(Some(&key), &encrypted, 0).map(|value| value.len()),
        Some(32 + "token=xyz".len())
    );
}

#[test]
fn rejects_unknown_scheme_and_missing_key() {
    let key = derive_chromium_key(b"peanuts");
    // Windows/Linux schemes are not implemented here.
    assert_eq!(decrypt_chromium_value(Some(&key), b"v11ciphertext", 0), None);
    // No key means nothing can be decrypted.
    let encrypted = encrypt_v10(&key, b"value");
    assert_eq!(decrypt_chromium_value(None, &encrypted, 0), None);
}

/// Regression: a real Chrome profile held some `encrypted_value` cells with
/// SQLite type TEXT rather than BLOB (older rows). A strict blob read failed on
/// the first such row and took the whole profile down as "unreadable".
#[test]
fn reads_text_typed_ciphertext_and_skips_only_the_bad_row() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("Cookies");
    let key = derive_chromium_key(b"peanuts");

    let payload = |value: &[u8]| {
        let mut bytes = vec![0u8; 32];
        bytes.extend_from_slice(value);
        encrypt_v10(&key, &bytes)
    };
    {
        let db = rusqlite::Connection::open(&path).expect("create db");
        db.execute_batch(
            "CREATE TABLE meta(key TEXT, value TEXT);
             INSERT INTO meta VALUES ('version', '24');
             CREATE TABLE cookies(host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB,
               path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER,
               samesite INTEGER);",
        )
        .expect("schema");
        db.execute(
            "INSERT INTO cookies VALUES ('.a.com', 'blob', '', ?1, '/', 0, 1, 0, 0)",
            [rusqlite::types::Value::Blob(payload(b"blob-value"))],
        )
        .expect("blob row");
        // CAST keeps the bytes but stores the cell with type TEXT.
        db.execute(
            "INSERT INTO cookies VALUES ('.b.com', 'text', '', CAST(?1 AS TEXT), '/', 0, 1, 0, 0)",
            [rusqlite::types::Value::Blob(payload(b"text-value"))],
        )
        .expect("text row");
        db.execute(
            "INSERT INTO cookies VALUES ('.c.com', 'odd', '', 42, '/', 0, 1, 0, 0)",
            [],
        )
        .expect("odd row");
    }

    let result = read_cookies(&path, Some(&key)).expect("profile reads");
    let names: Vec<&str> = result.cookies.iter().map(|cookie| cookie.name.as_str()).collect();
    assert_eq!(names, ["blob", "text"]);
    assert_eq!(result.cookies[0].value, "blob-value");
    assert_eq!(result.cookies[1].value, "text-value");
    assert_eq!(result.undecryptable, 1, "the integer-typed row is counted, not fatal");
}

/// Read a real Chromium `Cookies` database without a key when
/// `ORGII_CHROMIUM_COOKIES_PATH` points at one — proves the SQLite read path
/// gets through every row shape a live profile holds (values stay
/// undecryptable without the keychain, which is expected). Run with
/// `cargo test -p browser chromium -- --ignored --nocapture`.
#[test]
#[ignore]
fn reads_real_profile_from_env() {
    let Ok(path) = std::env::var("ORGII_CHROMIUM_COOKIES_PATH") else {
        return;
    };
    let result = read_cookies(std::path::Path::new(&path), None).expect("profile reads");
    eprintln!(
        "{path}: {} plaintext cookies, {} undecryptable without a key",
        result.cookies.len(),
        result.undecryptable
    );
    assert!(result.cookies.len() + result.undecryptable > 0);
}

#[test]
fn expires_conversion_handles_session_and_absolute() {
    // 0 (and negatives) mark a session cookie.
    assert_eq!(expires_to_unix(0), None);
    assert_eq!(expires_to_unix(-1), None);
    // Chromium epoch is 1601; 1_700_000_000 unix seconds round-trips.
    let unix = 1_700_000_000i64;
    let chromium_micros = (unix + 11_644_473_600) * 1_000_000;
    assert_eq!(expires_to_unix(chromium_micros), Some(unix));
}
