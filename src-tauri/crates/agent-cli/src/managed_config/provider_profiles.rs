//! Local, credential-free profile catalog. Native activation remains transactional.
use super::{file_io, manifest, target_lock};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HarnessProviderProfile {
    pub id: String,
    pub revision: u32,
    pub name: String,
    pub target: String,
    pub key_id: String,
    pub endpoint: String,
    pub auth_scheme: String,
    pub models: super::profile_models::ProfileModels,
}
impl HarnessProviderProfile {
    pub fn validate(&self) -> Result<(), String> {
        validate_target(&self.target)?;
        if self.id.is_empty()
            || self.id.len() > 64
            || !self
                .id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err("Invalid profile identifier".into());
        }
        if self.name.trim().is_empty()
            || self.name.len() > 120
            || self.name.chars().any(char::is_control)
            || self.key_id.is_empty()
            || self.key_id.len() > 256
        {
            return Err("A profile name and credential reference are required".into());
        }
        if !matches!(self.auth_scheme.as_str(), "bearer" | "x-api-key") {
            return Err("Unsupported authentication scheme".into());
        }
        // URL semantics are also checked by the key-vault resolver before saving/testing/applying.
        if self.endpoint.is_empty() || self.endpoint.len() > 2048 {
            return Err("Enter a connection endpoint".into());
        }
        let url = url::Url::parse(&self.endpoint).map_err(|_| "Invalid profile endpoint")?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(
                "Use an HTTP(S) endpoint without embedded credentials, query, or fragment".into(),
            );
        }
        if self.target == "codex" && self.auth_scheme != "bearer" {
            return Err("Codex profiles require Bearer authentication".into());
        }
        self.models.validate(&self.target)
    }
}
fn validate_target(target: &str) -> Result<(), String> {
    if !matches!(target, "claude_code" | "claude_desktop" | "codex") {
        return Err("Unsupported provider profile target".into());
    }
    Ok(())
}
fn path(target: &str) -> std::path::PathBuf {
    app_paths::cli_config_profile_manifest(target).with_file_name("provider-profiles.json")
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Catalog {
    version: u32,
    profiles: Vec<HarnessProviderProfile>,
}
fn read_unlocked(target: &str) -> Result<Vec<HarnessProviderProfile>, String> {
    let path = path(target);
    match std::fs::metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(_) => return Err("Cannot read saved provider profiles".into()),
        Ok(meta) if meta.len() > 1024 * 1024 => {
            return Err("Provider profile catalog exceeds its size limit".into())
        }
        Ok(_) => {}
    }
    let raw = std::fs::read(path).map_err(|_| "Cannot read saved provider profiles")?;
    let catalog: Catalog = serde_json::from_slice(&raw)
        .map_err(|_| "Invalid provider profile catalog; restore it from backup")?;
    if catalog.version != 1 || catalog.profiles.len() > 64 {
        return Err("Unsupported provider profile catalog".into());
    }
    let mut ids = std::collections::BTreeSet::new();
    for profile in &catalog.profiles {
        profile.validate()?;
        if profile.target != target || profile.revision == 0 || !ids.insert(&profile.id) {
            return Err("Invalid saved profile identity".into());
        }
    }
    Ok(catalog.profiles)
}
fn write_unlocked(target: &str, profiles: Vec<HarnessProviderProfile>) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(&Catalog {
        version: 1,
        profiles,
    })
    .map_err(|_| "Cannot serialize provider profiles")?;
    file_io::write_sensitive_file_atomic(&path(target), &bytes)
}
pub fn list(target: &str) -> Result<Vec<HarnessProviderProfile>, String> {
    validate_target(target)?;
    let _guard = super::config_operation_guard()?;
    let _lock = target_lock::lock_targets(target)?;
    let _catalog = target_lock::lock_profile_catalog(target)?;
    read_unlocked(target)
}
pub fn save(mut profile: HarnessProviderProfile) -> Result<HarnessProviderProfile, String> {
    profile.validate()?;
    let _guard = super::config_operation_guard()?;
    let _lock = target_lock::lock_targets(&profile.target)?;
    let _catalog = target_lock::lock_profile_catalog(&profile.target)?;
    let mut profiles = read_unlocked(&profile.target)?;
    let existing = profiles.iter().position(|p| p.id == profile.id);
    if existing.map(|i| profiles[i].revision).unwrap_or(0) != profile.revision {
        return Err("This profile changed in another window. Refresh before saving".into());
    }
    profile.revision = profile
        .revision
        .checked_add(1)
        .ok_or("Profile revision limit reached")?;
    if let Some(index) = existing {
        profiles[index] = profile.clone();
    } else {
        if profiles.len() >= 64 {
            return Err("At most 64 profiles can be saved per app".into());
        }
        profiles.push(profile.clone());
    }
    write_unlocked(&profile.target, profiles)?;
    Ok(profile)
}
pub fn delete(target: &str, id: &str, revision: u32) -> Result<(), String> {
    validate_target(target)?;
    let _guard = super::config_operation_guard()?;
    let _lock = target_lock::lock_targets(target)?;
    let _catalog = target_lock::lock_profile_catalog(target)?;
    if manifest::read_manifest(target)?.is_some_and(|m| {
        m.mode != super::CliConfigMode::Default && m.provider_profile.is_some_and(|p| p.id == id)
    }) {
        return Err(
            "Restore or activate another profile before deleting the active profile".into(),
        );
    }
    let mut profiles = read_unlocked(target)?;
    let index = profiles
        .iter()
        .position(|p| p.id == id && p.revision == revision)
        .ok_or("Profile changed or no longer exists; refresh first")?;
    profiles.remove(index);
    write_unlocked(target, profiles)
}
pub(super) fn require_saved_unlocked(profile: &HarnessProviderProfile) -> Result<(), String> {
    profile.validate()?;
    let _catalog = target_lock::lock_profile_catalog(&profile.target)?;
    if !read_unlocked(&profile.target)?.contains(profile) {
        return Err(
            "Save and test the current profile before applying; the saved profile changed".into(),
        );
    }
    Ok(())
}
pub fn applied(target: &str) -> Result<Option<HarnessProviderProfile>, String> {
    validate_target(target)?;
    let _guard = super::config_operation_guard()?;
    let _lock = target_lock::lock_targets(target)?;
    let _catalog = target_lock::lock_profile_catalog(target)?;
    super::transaction::recover_pending_transaction_unlocked(target)?;
    Ok(manifest::read_manifest(target)?
        .filter(|m| m.mode == super::CliConfigMode::Direct)
        .and_then(|m| m.provider_profile))
}
