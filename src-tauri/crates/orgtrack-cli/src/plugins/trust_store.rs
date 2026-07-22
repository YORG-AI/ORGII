//! Exec-plugin trust store: `~/.orgtrack/trust.json` maps a plugin id to a
//! sha256 of its manifest + executable. Any change to either re-arms trust.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use super::{home_dir, Discovered, LoaderImpl};

fn trust_store_path() -> Option<PathBuf> {
    home_dir().map(|home| home.join(".orgtrack/trust.json"))
}

pub(super) fn load_trust_store() -> BTreeMap<String, String> {
    let Some(path) = trust_store_path() else {
        return BTreeMap::new();
    };
    let Ok(raw) = std::fs::read_to_string(path) else {
        return BTreeMap::new();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

/// Pin trust for one exec plugin (loader or processor) by recording its current
/// content hash.
pub fn trust(id: &str, discovered: &Discovered) -> Result<String, String> {
    let (manifest_dir, exec_path) = exec_paths_for(id, discovered)?;
    let manifest_path = manifest_dir.join("plugin.toml");
    let hash = content_hash(&manifest_path, &exec_path)?;

    let mut store = load_trust_store();
    store.insert(id.to_string(), hash.clone());
    let path = trust_store_path().ok_or_else(|| "cannot resolve HOME for trust store".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| format!("create {}: {err}", parent.display()))?;
    }
    let serialized = serde_json::to_string_pretty(&store).map_err(|err| err.to_string())?;
    std::fs::write(&path, serialized).map_err(|err| format!("write {}: {err}", path.display()))?;
    Ok(hash)
}

/// Resolve (manifest_dir, exec_path) for an exec plugin id, or an error if the
/// id is unknown or names a declarative (code-free) loader.
fn exec_paths_for(id: &str, discovered: &Discovered) -> Result<(PathBuf, PathBuf), String> {
    if let Some(loader) = discovered.loaders.iter().find(|plugin| plugin.id == id) {
        return match &loader.imp {
            LoaderImpl::Exec(spec) => Ok((loader.manifest_dir.clone(), spec.exec_path.clone())),
            LoaderImpl::Jsonl(_) => Err(format!(
                "'{id}' is a declarative loader — it runs no code and needs no trust"
            )),
        };
    }
    if let Some(processor) = discovered.processors.iter().find(|plugin| plugin.id == id) {
        return Ok((processor.manifest_dir.clone(), processor.spec.exec_path.clone()));
    }
    if let Some(hook) = discovered.hooks.iter().find(|plugin| plugin.id == id) {
        return Ok((hook.manifest_dir.clone(), hook.spec.exec_path.clone()));
    }
    Err(format!("no plugin with id '{id}' (see `orgtrack plugins list`)"))
}

/// sha256 over the manifest bytes then the executable bytes — any edit to
/// either re-arms trust.
pub(super) fn content_hash(manifest_path: &Path, exec_path: &Path) -> Result<String, String> {
    let mut hasher = Sha256::new();
    let manifest = std::fs::read(manifest_path).map_err(|err| format!("read manifest: {err}"))?;
    hasher.update(&manifest);
    let exec = std::fs::read(exec_path).map_err(|err| format!("read exec: {err}"))?;
    hasher.update(&exec);
    Ok(format!("{:x}", hasher.finalize()))
}
