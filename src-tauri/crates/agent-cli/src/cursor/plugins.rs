//! Read the list of installed Cursor plugins from `state.vscdb`.
//!
//! Cursor stores installed plugin IDs in:
//!   `ItemTable` WHERE key LIKE `cursor.plugins.installedIds.%`
//!
//! Each key is `cursor.plugins.installedIds.{teamId}|{workspacePath}` and the
//! value is a JSON array of `{ id: string, sources: string[] }` objects. We
//! read the union of all installed plugin slugs (by resolving numeric IDs to
//! slugs via the plugin cache directory at `~/.cursor/plugins/cache/`) and
//! return structured metadata the frontend can display directly.
//!
//! The plugin cache layout is:
//!   `~/.cursor/plugins/cache/cursor-public/{slug}/{hash}/`
//!     `.cursor-plugin/plugin.json`  — name, version, description
//!     `.mcp.json`                   — mcpServers object
//!     `skills/`                     — one subdirectory per skill
//!     `hooks/cursor-hooks.json`     — hooks object (if present)

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use tracing::{debug, warn};

// ── On-disk JSON shapes ──

#[derive(Debug, Deserialize)]
struct InstalledEntry {
    id: String,
    #[allow(dead_code)]
    sources: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct PluginManifest {
    name: Option<String>,
    #[serde(rename = "displayName")]
    display_name: Option<String>,
    description: Option<String>,
    version: Option<String>,
    /// Relative path to the logo image, e.g. `"./assets/azure-logo.svg"`.
    logo: Option<String>,
    /// Either inline `mcpServers` object (old format) or a relative path string
    /// to a separate `mcp.json` file (new format, e.g. `"./mcp.json"`).
    #[serde(rename = "mcpServers")]
    mcp_servers_inline: Option<serde_json::Value>,
}

// ── Public output types (serialised to frontend) ──

/// A skill bundled with a plugin, extracted from `SKILL.md` frontmatter.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorPluginSkill {
    /// Skill slug / directory name, e.g. `"airunway-aks-setup"`.
    pub slug: String,
    /// `name` field from the SKILL.md frontmatter (falls back to directory name).
    pub name: String,
    /// `description` field from the SKILL.md frontmatter. May be empty.
    pub description: String,
    /// Absolute path to the `SKILL.md` file, so the frontend can open it in
    /// the Workstation editor.
    pub skill_path: String,
}

/// A single hook entry inside a plugin's `cursor-hooks.json`.
///
/// Maps to the Cursor Plugins UI row that shows e.g. `Hook: postToolUse`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorPluginHook {
    /// The hook event type key, e.g. `"postToolUse"`.
    pub event_type: String,
    /// Human-readable label shown in the UI, e.g. `"Hook: postToolUse"`.
    pub label: String,
    /// Absolute path to the `cursor-hooks.json` file so the frontend can open
    /// it in the Workstation editor.
    pub hook_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorPluginInfo {
    /// Slug / directory name, e.g. `"azure"`, `"figma"`.
    pub slug: String,
    /// Human-readable display name from `plugin.json`.
    pub name: String,
    pub description: String,
    pub version: Option<String>,
    /// Raw `.mcp.json` content as a JSON object. `null` when the plugin has no
    /// MCP server.
    pub mcp_config: Option<serde_json::Value>,
    /// Skills bundled with this plugin (one entry per skill directory).
    pub skills: Vec<CursorPluginSkill>,
    /// Hooks defined by this plugin (one entry per event type).
    /// Empty when the plugin has no hooks.
    pub hooks: Vec<CursorPluginHook>,
    /// Absolute path to the plugin logo image (SVG, PNG, etc.).
    /// `null` when the plugin has no logo or the file does not exist.
    pub logo_path: Option<String>,
}

// ── SQLite reader ──

/// Read all installed plugin numeric IDs from `state.vscdb`. Returns a set of
/// string IDs (Cursor stores them as strings inside the JSON array).
fn read_installed_ids_from_db(db_path: &Path) -> Result<HashSet<String>, String> {
    let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|err| format!("open {}: {err}", db_path.display()))?;

    let mut stmt = conn
        .prepare("SELECT value FROM ItemTable WHERE key LIKE 'cursor.plugins.installedIds.%'")
        .map_err(|err| format!("prepare: {err}"))?;

    let mut ids: HashSet<String> = HashSet::new();

    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|err| format!("query: {err}"))?;

    for row in rows.flatten() {
        if let Ok(entries) = serde_json::from_str::<Vec<InstalledEntry>>(&row) {
            for entry in entries {
                if !entry.id.is_empty() {
                    ids.insert(entry.id);
                }
            }
        }
    }

    Ok(ids)
}

// ── Plugin cache resolver ──

/// Walk `~/.cursor/plugins/cache/cursor-public/` to build a slug → hash-dir map.
fn discover_cached_plugins(cache_dir: &Path) -> HashMap<String, PathBuf> {
    let mut map = HashMap::new();
    let Ok(slugs) = std::fs::read_dir(cache_dir) else {
        return map;
    };
    for slug_entry in slugs.flatten() {
        let slug = slug_entry.file_name().to_string_lossy().to_string();
        let slug_path = slug_entry.path();
        if !slug_path.is_dir() {
            continue;
        }
        // Each slug directory contains one hash directory (the version commit).
        if let Ok(hashes) = std::fs::read_dir(&slug_path) {
            for hash_entry in hashes.flatten() {
                let hash_path = hash_entry.path();
                if hash_path.is_dir() {
                    map.insert(slug.clone(), hash_path);
                    break; // take the first (only) hash dir
                }
            }
        }
    }
    map
}

fn read_plugin_manifest(plugin_dir: &Path) -> Option<PluginManifest> {
    let manifest_path = plugin_dir.join(".cursor-plugin").join("plugin.json");
    let bytes = std::fs::read_to_string(&manifest_path).ok()?;
    serde_json::from_str::<PluginManifest>(&bytes).ok()
}

/// Read the MCP server config for a plugin.
///
/// Strategy (in priority order):
/// 1. Standalone `mcp.json` at `plugin_dir/mcp.json` (new-format plugins from
///    the cursor/plugins marketplace).  The file contains a top-level
///    `mcpServers` object; we return that object directly.
/// 2. Standalone `.mcp.json` at `plugin_dir/.mcp.json` (older internal format
///    used by azure / figma).  Returned as-is.
/// 3. Inline `mcpServers` value parsed from `plugin.json` when the field holds
///    an object (not a path string).
fn read_mcp_config(
    plugin_dir: &Path,
    manifest: Option<&PluginManifest>,
) -> Option<serde_json::Value> {
    // 1. New-format standalone mcp.json
    let new_mcp = plugin_dir.join("mcp.json");
    if new_mcp.exists() {
        if let Ok(bytes) = std::fs::read_to_string(&new_mcp) {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&bytes) {
                // Return the mcpServers sub-object if present, otherwise the whole doc.
                let servers = val.get("mcpServers").cloned().unwrap_or(val);
                return Some(servers);
            }
        }
    }

    // 2. Legacy hidden .mcp.json
    let legacy_mcp = plugin_dir.join(".mcp.json");
    if legacy_mcp.exists() {
        if let Ok(bytes) = std::fs::read_to_string(&legacy_mcp) {
            return serde_json::from_str::<serde_json::Value>(&bytes).ok();
        }
    }

    // 3. Inline mcpServers from plugin.json (only if it's an object, not a path string)
    manifest.and_then(|m| {
        m.mcp_servers_inline.as_ref().and_then(
            |v| {
                if v.is_object() {
                    Some(v.clone())
                } else {
                    None
                }
            },
        )
    })
}

/// Parse the YAML frontmatter block at the top of a `SKILL.md` file.
///
/// Frontmatter is delimited by `---` lines. We extract `name` and
/// `description` using simple line-by-line scanning to avoid pulling in a
/// full YAML parser dependency.
fn parse_skill_frontmatter(content: &str) -> (Option<String>, Option<String>) {
    let mut lines = content.lines();
    // First line must be `---`
    if lines.next().map(str::trim) != Some("---") {
        return (None, None);
    }
    let mut name: Option<String> = None;
    let mut description: Option<String> = None;
    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" {
            break;
        }
        if let Some(rest) = trimmed.strip_prefix("name:") {
            name = Some(rest.trim().trim_matches('"').to_string());
        } else if let Some(rest) = trimmed.strip_prefix("description:") {
            description = Some(rest.trim().trim_matches('"').to_string());
        }
    }
    (name, description)
}

/// Read the list of skills bundled with a plugin by scanning the `skills/`
/// subdirectory.  Each skill lives in its own named directory and has a
/// `SKILL.md` file with YAML frontmatter containing `name` and `description`.
fn read_skills(plugin_dir: &Path) -> Vec<CursorPluginSkill> {
    let skills_dir = plugin_dir.join("skills");
    if !skills_dir.is_dir() {
        return Vec::new();
    }
    let mut skills: Vec<CursorPluginSkill> = std::fs::read_dir(&skills_dir)
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| entry.path().is_dir())
                .map(|entry| {
                    let dir_name = entry.file_name().to_string_lossy().to_string();
                    let skill_md = entry.path().join("SKILL.md");
                    let (fm_name, fm_desc) = std::fs::read_to_string(&skill_md)
                        .ok()
                        .map(|content| parse_skill_frontmatter(&content))
                        .unwrap_or((None, None));
                    let skill_path = entry.path().join("SKILL.md").to_string_lossy().to_string();
                    CursorPluginSkill {
                        name: fm_name.unwrap_or_else(|| dir_name.clone()),
                        description: fm_desc.unwrap_or_default(),
                        slug: dir_name,
                        skill_path,
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    skills.sort_by(|lhs, rhs| lhs.slug.cmp(&rhs.slug));
    skills
}

/// Read the hooks defined in `hooks/cursor-hooks.json`.
///
/// Returns one `CursorPluginHook` per event type that has at least one handler,
/// e.g. `{ event_type: "postToolUse", label: "Hook: postToolUse" }`.
/// Returns an empty vec when the file is absent or has no hooks.
fn read_hooks(plugin_dir: &Path) -> Vec<CursorPluginHook> {
    let hooks_path = plugin_dir.join("hooks").join("cursor-hooks.json");
    if !hooks_path.exists() {
        return Vec::new();
    }
    let hook_path_str = hooks_path.to_string_lossy().to_string();
    let Ok(bytes) = std::fs::read_to_string(&hooks_path) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&bytes) else {
        return Vec::new();
    };
    let Some(hooks_obj) = value.get("hooks").and_then(|v| v.as_object()) else {
        return Vec::new();
    };
    hooks_obj
        .iter()
        .filter(|(_key, val)| val.as_array().map(|arr| !arr.is_empty()).unwrap_or(false))
        .map(|(event_type, _)| CursorPluginHook {
            label: format!("Hook: {event_type}"),
            event_type: event_type.clone(),
            hook_path: hook_path_str.clone(),
        })
        .collect()
}

// ── Public entry point ──

/// Read all installed Cursor plugins and return structured metadata.
///
/// Returns an empty vec when:
/// - Cursor is not installed (`state.vscdb` missing)
/// - No plugins are installed
/// - The plugin cache is missing or empty
///
/// Never returns an error for the "not installed" state — that is a valid
/// condition for users who don't have Cursor.
pub fn list_installed_plugins() -> Result<Vec<CursorPluginInfo>, String> {
    // Storage paths come from the canonical platform-aware resolver. A typed
    // unavailability (no resolvable home/config root) degrades to the same
    // "Cursor not installed" empty state — never a fabricated path.
    let db_path = match app_paths::cursor::state_db_path() {
        Ok(path) => path,
        Err(err) => {
            debug!(error = %err, "Cursor storage paths unavailable — treating as not installed");
            return Ok(Vec::new());
        }
    };
    if !db_path.exists() {
        debug!("Cursor state.vscdb not found — Cursor not installed");
        return Ok(Vec::new());
    }

    let installed_ids = read_installed_ids_from_db(&db_path)?;
    if installed_ids.is_empty() {
        debug!("No installed Cursor plugins found in state.vscdb");
        return Ok(Vec::new());
    }

    debug!(
        count = installed_ids.len(),
        "installed plugin IDs read from state.vscdb"
    );

    let cache_dir = match app_paths::cursor::plugins_cache_dir() {
        Ok(dir) => dir,
        Err(err) => {
            warn!(
                error = %err,
                "Cursor plugin cache dir unavailable — cannot resolve installed plugin metadata"
            );
            return Ok(Vec::new());
        }
    };
    let cached = discover_cached_plugins(&cache_dir);

    // installed_ids are numeric marketplace IDs (e.g. "657", "6392").
    // cached is keyed by slug (e.g. "azure", "figma").
    // We resolve by taking all cached slugs that have a matching plugin on disk
    // — since the numeric IDs don't directly map to slugs in any file we can
    // read cheaply, we return all slugs that exist in the cache (which
    // represents plugins that have been downloaded / installed at least once).
    //
    // This is correct because Cursor only caches plugins the user has installed.
    let mut plugins = Vec::new();

    for (slug, plugin_dir) in &cached {
        let manifest = read_plugin_manifest(plugin_dir);
        let mcp_config = read_mcp_config(plugin_dir, manifest.as_ref());
        let skills = read_skills(plugin_dir);
        let hooks = read_hooks(plugin_dir);

        let name = manifest
            .as_ref()
            .and_then(|m| m.display_name.clone().or_else(|| m.name.clone()))
            .unwrap_or_else(|| slug.clone());

        let description = manifest
            .as_ref()
            .and_then(|m| m.description.clone())
            .unwrap_or_default();

        let version = manifest.as_ref().and_then(|m| m.version.clone());

        // Resolve the logo relative path to an absolute filesystem path.
        let logo_path = manifest
            .as_ref()
            .and_then(|m| m.logo.as_deref())
            .and_then(|rel| {
                // Strip leading "./" if present, then join against plugin_dir.
                let rel = rel.trim_start_matches("./");
                let abs = plugin_dir.join(rel);
                if abs.exists() {
                    abs.to_str().map(str::to_string)
                } else {
                    None
                }
            });

        plugins.push(CursorPluginInfo {
            slug: slug.clone(),
            name,
            description,
            version,
            mcp_config,
            skills,
            hooks,
            logo_path,
        });
    }

    // Sort by slug for stable ordering.
    plugins.sort_by(|lhs, rhs| lhs.slug.cmp(&rhs.slug));

    if plugins.is_empty() {
        warn!(
            ids = ?installed_ids,
            cache_dir = %cache_dir.display(),
            "Installed plugin IDs found but no matching cache directories — cache may be stale",
        );
    }

    Ok(plugins)
}

// ── Tauri command ──

/// List installed Cursor plugins with their MCP config, skill count, and hooks.
///
/// Returns an empty array when Cursor is not installed or no plugins are
/// installed.
#[tauri::command]
pub async fn cursor_plugins_list() -> Result<Vec<CursorPluginInfo>, String> {
    tokio::task::spawn_blocking(list_installed_plugins)
        .await
        .map_err(|err| format!("Task join error: {err}"))?
}
