//! Stable skill provenance and consent digests.
//!
//! A remotely installed skill keeps one small sidecar next to `SKILL.md`.
//! The sidecar is deliberately part of the workspace artifact so a skill
//! moved into `<repo>/.orgii/skills/` keeps its origin and stable identity.
//! It is not a release/version history: refresh replaces the current bundle
//! only after the user explicitly asks for it.

use std::fmt::Write as _;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const PROVENANCE_FILENAME: &str = ".orgii-skill-origin.json";
pub const SKILLS_SH_DETAIL_CACHE_FILENAME: &str = ".skills-sh-detail.json";
const PROVENANCE_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillOrigin {
    /// Typed source family (`skills_sh`, `external_agent`, ...).
    pub provider: String,
    /// Provider-owned stable locator. It must never contain credentials.
    pub locator: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillConsentDigests {
    pub identity_digest: String,
    pub content_digest: String,
    pub schema_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillProvenance {
    pub schema_version: u32,
    /// Stable ORGII identity. Refresh never derives this from the new bundle.
    pub id: String,
    /// Stable loader/binding name (the containing directory name).
    pub name: String,
    pub origin: SkillOrigin,
    /// Exact bundle/schema the user approved at the last install or refresh.
    pub consent: SkillConsentDigests,
}

pub fn sha256_digest(bytes: &[u8]) -> String {
    format_sha256(Sha256::digest(bytes).as_slice())
}

fn format_sha256(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity("sha256:".len() + bytes.len() * 2);
    encoded.push_str("sha256:");
    for byte in bytes {
        let _ = write!(&mut encoded, "{byte:02x}");
    }
    encoded
}

pub fn identity_digest(id: &str, name: &str, origin: &SkillOrigin) -> String {
    let value = serde_json::json!({
        "id": id,
        "name": name,
        "origin": origin,
    });
    sha256_digest(&serde_json::to_vec(&value).unwrap_or_default())
}

pub fn schema_digest(schema: &Value) -> String {
    sha256_digest(&serde_json::to_vec(schema).unwrap_or_default())
}

/// Canonical discovery/capability schema used by both the installer consent
/// record and the live loader. The Markdown body is covered by
/// [`content_digest`]; this value covers parsed frontmatter plus bundled file
/// names so requirement or resource-surface changes are independently visible.
pub fn schema_value(skill_dir: &Path) -> Result<Value, String> {
    let skill_md_path = skill_dir.join("SKILL.md");
    let skill_md = fs::read_to_string(&skill_md_path)
        .map_err(|err| format!("Failed to read {}: {err}", skill_md_path.display()))?;
    let mut files = Vec::new();
    collect_content_files(skill_dir, skill_dir, &mut files)?;
    let bundled_files: Vec<String> = files
        .into_iter()
        .filter(|path| path != Path::new("SKILL.md"))
        .map(|path| path.to_string_lossy().replace('\\', "/"))
        .collect();
    Ok(schema_value_from_content(&skill_md, &bundled_files))
}

pub fn schema_value_from_content(skill_md: &str, bundled_files: &[String]) -> Value {
    let frontmatter = skill_md
        .strip_prefix("---")
        .and_then(|after| after.find("---").map(|end| &after[..end]))
        .map(|raw| {
            serde_yaml::from_str::<Value>(raw)
                .unwrap_or_else(|_| Value::String(raw.trim().to_string()))
        })
        .unwrap_or(Value::Null);
    let mut bundled_files = bundled_files.to_vec();
    bundled_files.sort();
    serde_json::json!({
        "bundledFiles": bundled_files,
        "frontmatter": frontmatter,
    })
}

pub(crate) fn is_internal_metadata(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == PROVENANCE_FILENAME || name == SKILLS_SH_DETAIL_CACHE_FILENAME)
}

fn collect_content_files(base: &Path, dir: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    let entries = fs::read_dir(dir)
        .map_err(|err| format!("Failed to read skill directory {}: {err}", dir.display()))?;
    for entry in entries {
        let entry = entry
            .map_err(|err| format!("Failed to read skill entry in {}: {err}", dir.display()))?;
        let file_type = entry.file_type().map_err(|err| {
            format!(
                "Failed to inspect skill entry {}: {err}",
                entry.path().display()
            )
        })?;
        let path = entry.path();
        if file_type.is_dir() {
            collect_content_files(base, &path, files)?;
        } else if file_type.is_file() && !is_internal_metadata(&path) {
            files.push(
                path.strip_prefix(base)
                    .map_err(|err| {
                        format!("Failed to relativize skill file {}: {err}", path.display())
                    })?
                    .to_path_buf(),
            );
        }
    }
    Ok(())
}

/// Digest the current body plus every bundled regular file. Relative paths,
/// lengths, and bytes are framed so two different file layouts cannot collide
/// through concatenation. Sidecar/cache files are intentionally excluded.
pub fn content_digest(skill_dir: &Path) -> Result<String, String> {
    let mut files = Vec::new();
    collect_content_files(skill_dir, skill_dir, &mut files)?;
    files.sort();

    let mut hasher = Sha256::new();
    for relative in files {
        let relative_bytes = relative.to_string_lossy().as_bytes().to_vec();
        hasher.update((relative_bytes.len() as u64).to_le_bytes());
        hasher.update(&relative_bytes);

        let path = skill_dir.join(&relative);
        let mut file = fs::File::open(&path)
            .map_err(|err| format!("Failed to open skill file {}: {err}", path.display()))?;
        let file_len = file
            .metadata()
            .map_err(|err| format!("Failed to inspect skill file {}: {err}", path.display()))?
            .len();
        hasher.update(file_len.to_le_bytes());
        let mut buffer = [0_u8; 16 * 1024];
        loop {
            let read = file
                .read(&mut buffer)
                .map_err(|err| format!("Failed to hash skill file {}: {err}", path.display()))?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
    }
    Ok(format_sha256(hasher.finalize().as_slice()))
}

pub fn read_provenance(skill_dir: &Path) -> Result<Option<SkillProvenance>, String> {
    let path = skill_dir.join(PROVENANCE_FILENAME);
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => {
            return Err(format!(
                "Failed to read skill provenance {}: {err}",
                path.display()
            ))
        }
    };
    let record: SkillProvenance = serde_json::from_str(&raw)
        .map_err(|err| format!("Failed to parse skill provenance {}: {err}", path.display()))?;
    if record.schema_version != PROVENANCE_SCHEMA_VERSION {
        return Err(format!(
            "Unsupported skill provenance schema {} at {}",
            record.schema_version,
            path.display()
        ));
    }
    if record.id.trim().is_empty()
        || record.name.trim().is_empty()
        || record.origin.provider.trim().is_empty()
        || record.origin.locator.trim().is_empty()
    {
        return Err(format!(
            "Skill provenance has an empty identity/origin field at {}",
            path.display()
        ));
    }
    Ok(Some(record))
}

/// Write into a staging directory. The caller publishes the whole directory
/// with the snapshot, so no observer can see a new bundle with old consent.
pub fn write_provenance(skill_dir: &Path, record: &SkillProvenance) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(record)
        .map_err(|err| format!("Failed to serialize skill provenance: {err}"))?;
    fs::write(skill_dir.join(PROVENANCE_FILENAME), json)
        .map_err(|err| format!("Failed to write skill provenance: {err}"))
}

pub fn build_provenance(
    id: String,
    name: String,
    origin: SkillOrigin,
    skill_dir: &Path,
    schema: &Value,
) -> Result<SkillProvenance, String> {
    if id.trim().is_empty()
        || name.trim().is_empty()
        || origin.provider.trim().is_empty()
        || origin.locator.trim().is_empty()
    {
        return Err("Skill provenance id, name, and origin are required".to_string());
    }
    let consent = SkillConsentDigests {
        identity_digest: identity_digest(&id, &name, &origin),
        content_digest: content_digest(skill_dir)?,
        schema_digest: schema_digest(schema),
    };
    Ok(SkillProvenance {
        schema_version: PROVENANCE_SCHEMA_VERSION,
        id,
        name,
        origin,
        consent,
    })
}

/// Treat an explicit editor save as fresh consent for an already-managed
/// skill while preserving its stable identity and origin. Locally-authored
/// skills have no sidecar and therefore need no update.
pub fn refresh_existing_consent(skill_dir: &Path) -> Result<(), String> {
    let Some(existing) = read_provenance(skill_dir)? else {
        return Ok(());
    };
    let directory_name = skill_dir
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("Skill directory has no UTF-8 name: {}", skill_dir.display()))?;
    if existing.name != directory_name {
        return Err(format!(
            "Skill provenance name '{}' does not match directory '{}'",
            existing.name, directory_name
        ));
    }
    let schema = schema_value(skill_dir)?;
    let refreshed = build_provenance(
        existing.id,
        existing.name,
        existing.origin,
        skill_dir,
        &schema,
    )?;
    write_provenance(skill_dir, &refreshed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_digest_is_order_stable_and_tracks_bundled_files() {
        let first = tempfile::tempdir().unwrap();
        fs::write(first.path().join("SKILL.md"), "# Test").unwrap();
        fs::create_dir_all(first.path().join("scripts")).unwrap();
        fs::write(first.path().join("scripts/run.sh"), "echo one").unwrap();
        let before = content_digest(first.path()).unwrap();

        fs::write(
            first.path().join(PROVENANCE_FILENAME),
            r#"{"ignored":true}"#,
        )
        .unwrap();
        assert_eq!(before, content_digest(first.path()).unwrap());

        fs::write(first.path().join("scripts/run.sh"), "echo two").unwrap();
        assert_ne!(before, content_digest(first.path()).unwrap());
    }

    #[test]
    fn provenance_round_trip_keeps_stable_identity() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("SKILL.md"), "# Test").unwrap();
        let origin = SkillOrigin {
            provider: "skills_sh".into(),
            locator: "owner/repo/test".into(),
        };
        let record = build_provenance(
            "skill:test".into(),
            "test".into(),
            origin,
            dir.path(),
            &serde_json::json!({"name": "test"}),
        )
        .unwrap();
        write_provenance(dir.path(), &record).unwrap();
        assert_eq!(read_provenance(dir.path()).unwrap(), Some(record));
    }

    #[test]
    fn explicit_editor_consent_keeps_identity_and_refreshes_content_digest() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("SKILL.md"), "# Before").unwrap();
        let origin = SkillOrigin {
            provider: "skills_sh".into(),
            locator: "owner/repo/test".into(),
        };
        let before = build_provenance(
            "skills_sh:owner/repo/test".into(),
            dir.path()
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            origin,
            dir.path(),
            &schema_value(dir.path()).unwrap(),
        )
        .unwrap();
        write_provenance(dir.path(), &before).unwrap();

        fs::write(dir.path().join("SKILL.md"), "# After").unwrap();
        refresh_existing_consent(dir.path()).unwrap();
        let after = read_provenance(dir.path()).unwrap().unwrap();
        assert_eq!(after.id, before.id);
        assert_eq!(after.name, before.name);
        assert_eq!(after.origin, before.origin);
        assert_ne!(after.consent.content_digest, before.consent.content_digest);
    }
}
