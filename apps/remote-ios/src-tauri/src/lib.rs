//! Lightweight native shell for ORG2 Remote.
//!
//! The agent runtime remains on the paired Desktop. This crate owns only the
//! iOS webview, deep-link delivery, system-browser handoff, and Keychain.

const KEYCHAIN_SERVICE: &str = "org2ai.org2.remote";
const MAX_KEYCHAIN_VALUE_BYTES: usize = 64 * 1024;
const EXACT_KEYCHAIN_KEYS: &[&str] = &[
    "org2.remote.auth.session.v1",
    "org2.remote.auth.oauth-attempt.v1",
    "org2.remote.auth.pairing-intent.v1",
];
const PREFIXED_KEYCHAIN_KEYS: &[&str] = &[
    "org2.remote.auth.pkce.v1:",
    "org2.remote.pairing-inventory.v1:",
];

fn validate_keychain_key(key: &str) -> Result<(), String> {
    let allowed = !key.is_empty()
        && key.len() <= 512
        && (EXACT_KEYCHAIN_KEYS.contains(&key)
            || PREFIXED_KEYCHAIN_KEYS
                .iter()
                .any(|prefix| key.starts_with(prefix) && key.len() > prefix.len()));
    if allowed {
        Ok(())
    } else {
        Err("keychain_key_not_allowed".to_string())
    }
}

fn validate_keychain_value(value: &str) -> Result<(), String> {
    if value.len() <= MAX_KEYCHAIN_VALUE_BYTES {
        Ok(())
    } else {
        Err("keychain_value_too_large".to_string())
    }
}

#[cfg(target_vendor = "apple")]
#[tauri::command]
fn mobile_keychain_read(key: String) -> Result<Option<String>, String> {
    use security_framework::passwords::get_generic_password;
    use security_framework_sys::base::errSecItemNotFound;

    validate_keychain_key(&key)?;
    match get_generic_password(KEYCHAIN_SERVICE, &key) {
        Ok(bytes) => String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| "keychain_value_invalid_utf8".to_string()),
        Err(error) if error.code() == errSecItemNotFound => Ok(None),
        Err(error) => Err(format!("keychain_read_failed:{}", error.code())),
    }
}

#[cfg(target_vendor = "apple")]
#[tauri::command]
fn mobile_keychain_write(key: String, value: String) -> Result<(), String> {
    use security_framework::passwords::set_generic_password;

    validate_keychain_key(&key)?;
    validate_keychain_value(&value)?;
    set_generic_password(KEYCHAIN_SERVICE, &key, value.as_bytes())
        .map_err(|error| format!("keychain_write_failed:{}", error.code()))
}

#[cfg(target_vendor = "apple")]
#[tauri::command]
fn mobile_keychain_delete(key: String) -> Result<(), String> {
    use security_framework::passwords::delete_generic_password;
    use security_framework_sys::base::errSecItemNotFound;

    validate_keychain_key(&key)?;
    match delete_generic_password(KEYCHAIN_SERVICE, &key) {
        Ok(()) => Ok(()),
        Err(error) if error.code() == errSecItemNotFound => Ok(()),
        Err(error) => Err(format!("keychain_delete_failed:{}", error.code())),
    }
}

#[cfg(not(target_vendor = "apple"))]
#[tauri::command]
fn mobile_keychain_read(_key: String) -> Result<Option<String>, String> {
    Err("keychain_unavailable".to_string())
}

#[cfg(not(target_vendor = "apple"))]
#[tauri::command]
fn mobile_keychain_write(_key: String, _value: String) -> Result<(), String> {
    Err("keychain_unavailable".to_string())
}

#[cfg(not(target_vendor = "apple"))]
#[tauri::command]
fn mobile_keychain_delete(_key: String) -> Result<(), String> {
    Err("keychain_unavailable".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            mobile_keychain_read,
            mobile_keychain_write,
            mobile_keychain_delete
        ])
        .run(tauri::generate_context!())
        .expect("failed to run ORG2 Remote");
}

#[cfg(test)]
mod tests {
    use super::{validate_keychain_key, validate_keychain_value};

    #[test]
    fn accepts_only_owned_keychain_namespaces() {
        assert!(validate_keychain_key("org2.remote.auth.session.v1").is_ok());
        assert!(validate_keychain_key("org2.remote.auth.pkce.v1:code-verifier").is_ok());
        assert!(validate_keychain_key("org2.remote.pairing-inventory.v1:user-a").is_ok());
        assert!(validate_keychain_key("org2.remote.auth.pkce.v1:").is_err());
        assert!(validate_keychain_key("untrusted.key").is_err());
        assert!(validate_keychain_key(&"x".repeat(513)).is_err());
    }

    #[test]
    fn bounds_keychain_values_before_native_io() {
        assert!(validate_keychain_value("normal value").is_ok());
        assert!(validate_keychain_value(&"x".repeat(64 * 1024 + 1)).is_err());
    }
}
