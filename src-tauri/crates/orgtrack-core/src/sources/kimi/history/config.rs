//! Bounded Kimi CLI configuration reads that resolve the legacy default model.

use std::fs;
use std::io::Read;
use std::path::Path;

use serde_json::Value;

use crate::sources::imported_history::watermark::PrefixHasher;

use super::identity::{DEFAULT_MODEL, MAX_CONFIG_BYTES, MAX_MODEL_BYTES};
use super::paths::ensure_safe_descendant;

#[derive(Debug, Clone)]
pub(super) struct LegacyConfig {
    pub(super) model: String,
    pub(super) fingerprint: String,
}

pub(super) fn read_legacy_config(home: &Path) -> LegacyConfig {
    let kimi_home = home.join(".kimi");
    let model = read_bounded_config(&kimi_home.join("config.toml"), home)
        .and_then(|bytes| model_from_toml(&bytes))
        .or_else(|| {
            read_bounded_config(&kimi_home.join("config.json"), home)
                .and_then(|bytes| model_from_json(&bytes))
        })
        .unwrap_or_else(|| DEFAULT_MODEL.to_string());
    LegacyConfig {
        fingerprint: model_fingerprint(&model),
        model,
    }
}

fn read_bounded_config(path: &Path, identity_home: &Path) -> Option<Vec<u8>> {
    ensure_safe_descendant(path, identity_home, true).ok()?;
    let metadata = fs::metadata(path).ok()?;
    if metadata.len() > MAX_CONFIG_BYTES {
        return None;
    }
    let file = fs::File::open(path).ok()?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_CONFIG_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() as u64 <= MAX_CONFIG_BYTES).then_some(bytes)
}

pub(super) fn model_from_json(bytes: &[u8]) -> Option<String> {
    serde_json::from_slice::<Value>(bytes)
        .ok()
        .and_then(|value| {
            value
                .get("default_model")
                .or_else(|| value.get("model"))
                .and_then(Value::as_str)
                .map(str::trim)
                .map(str::to_string)
        })
        .filter(|model| !model.is_empty() && model.len() <= MAX_MODEL_BYTES)
}

pub(super) fn model_from_toml(bytes: &[u8]) -> Option<String> {
    let content = std::str::from_utf8(bytes).ok()?;
    for line in content.lines() {
        let Some((key, raw_value)) = line.split_once('=') else {
            continue;
        };
        if key.trim() != "default_model" {
            continue;
        }
        let raw_value = raw_value.trim_start();
        let model = if raw_value.starts_with('"') {
            let quoted = take_quoted_value(raw_value, b'"', true)?;
            serde_json::from_str::<String>(quoted).ok()?
        } else if raw_value.starts_with('\'') {
            let quoted = take_quoted_value(raw_value, b'\'', false)?;
            quoted[1..quoted.len().saturating_sub(1)].to_string()
        } else {
            continue;
        };
        let model = model.trim().to_string();
        if !model.is_empty() && model.len() <= MAX_MODEL_BYTES {
            return Some(model);
        }
    }
    None
}

fn take_quoted_value(value: &str, quote: u8, honors_escape: bool) -> Option<&str> {
    let bytes = value.as_bytes();
    if bytes.first().copied() != Some(quote) {
        return None;
    }
    let mut escaped = false;
    for (index, byte) in bytes.iter().copied().enumerate().skip(1) {
        if honors_escape && byte == b'\\' && !escaped {
            escaped = true;
            continue;
        }
        if byte == quote && !escaped {
            return value.get(..=index);
        }
        escaped = false;
    }
    None
}

fn model_fingerprint(model: &str) -> String {
    let mut hasher = PrefixHasher::default();
    hasher.update(model.as_bytes());
    format!("kimi-config-model-v1:{}", hasher.digest())
}
