//! Agent definitions store — in-memory state + disk persistence.
//!
//! # Storage layout (Storage contract §12)
//!
//! Two JSON files on disk:
//!
//! - `~/.orgii/agent-definitions.json` — user-created agents (no prefix).
//!   Editable via `update(id, patch)`; builtins are rejected.
//! - `~/.orgii/builtin-overrides.json` — map of `builtin:*` → **field-level
//!   delta** against the compiled-in builtin (top-level JSON keys whose
//!   value differs). The effective definition is composed at load time as
//!   `compiled builtin + delta`, so ship-time changes to builtin tool
//!   lists / prompts / rosters still reach users who customised other
//!   fields. Written via `update_with_overlay(id, patch)` for builtin
//!   ids. "Reset to builtin" = remove the key from this file. Legacy
//!   full-snapshot entries are reduced to deltas on first load.
//!
//! # Lookup order (`get`)
//!
//! 1. If `id.starts_with("builtin:")`:
//!    - Return the in-memory effective definition (compiled + delta,
//!      composed at load/write time), or the compiled-in builtin when no
//!      overlay exists.
//! 2. Else: lookup in the user-definitions vec.
//!
//! # Change notification
//!
//! Every successful mutation invokes the process-wide `on_change` hook
//! (installed once at Tauri setup) with the affected agent id; the hook
//! emits `orgii-agent-defs-changed` so frontend atoms refresh without
//! manual polling. Mutating definitions outside the store's methods is
//! a bug.

use std::collections::BTreeMap;
#[cfg(not(test))]
use std::sync::OnceLock;
use std::sync::{Arc, Mutex};
use tracing::{error, info, warn};

use super::schema::AgentDefinition;
use app_paths::{agent_definitions as storage_path, builtin_overrides as overrides_path};

#[cfg(not(test))]
static PROCESS_STORE: OnceLock<Arc<AgentDefinitionsStore>> = OnceLock::new();

/// Process-wide shared `AgentDefinitionsStore`.
///
/// This is the ONLY way production code should obtain a store. The Tauri
/// setup manages the same `Arc`, so command handlers
/// (`State<'_, Arc<AgentDefinitionsStore>>`) and library callers observe
/// one consistent in-memory state — no per-call disk re-reads, no
/// write-path/read-path split brain, and the one-shot migrations in
/// `AgentDefinitionsStore::new()` run exactly once per process.
///
/// In `cfg(test)` builds this returns a FRESH store per call so tests that
/// point `ORGII_HOME` at a tempdir (`OrgiiHomeGuard`) stay isolated from
/// each other — mirroring the historical ad-hoc-construction behavior.
pub fn definitions_store() -> Arc<AgentDefinitionsStore> {
    #[cfg(test)]
    {
        Arc::new(AgentDefinitionsStore::new())
    }
    #[cfg(not(test))]
    {
        PROCESS_STORE
            .get_or_init(|| Arc::new(AgentDefinitionsStore::new()))
            .clone()
    }
}

/// Store for user-created agent definitions and builtin overrides.
pub struct AgentDefinitionsStore {
    pub(crate) agents: Mutex<Vec<AgentDefinition>>,
    /// Effective (compiled + delta) definitions for overridden builtins.
    /// Persistence reduces these back to top-level field deltas.
    pub(crate) builtin_overrides: Mutex<BTreeMap<String, AgentDefinition>>,
}

type ChangeHook = Box<dyn Fn(&str) + Send + Sync>;

static ON_CHANGE: std::sync::OnceLock<ChangeHook> = std::sync::OnceLock::new();

/// Install the process-wide definition-change hook. Called once from the
/// Tauri setup; the hook emits `orgii-agent-defs-changed` to the frontend.
/// Subsequent calls are ignored.
pub fn set_definitions_changed_hook(hook: impl Fn(&str) + Send + Sync + 'static) {
    let _ = ON_CHANGE.set(Box::new(hook));
}

pub(crate) fn notify_change(agent_id: &str) {
    if let Some(hook) = ON_CHANGE.get() {
        hook(agent_id);
    }
}

impl Default for AgentDefinitionsStore {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentDefinitionsStore {
    pub fn new() -> Self {
        let mut agents = load_from_disk(&storage_path());
        let mut builtin_overrides = load_overrides_from_disk(&overrides_path());

        // One-shot migration: pre-existing on-disk overlays / user defs may
        // list `builtin:explore` / `builtin:general` (and other internal
        // primitives) as explicit sub-agents — remnants from before these
        // were declared runtime primitives. Strip them eagerly and re-
        // persist so the file on disk converges to the new shape.
        let mut overlays_changed = false;
        for agent in builtin_overrides.values_mut() {
            if super::builtin::strip_forbidden_sub_agents(agent) {
                overlays_changed = true;
            }
        }
        let mut agents_changed = false;
        for agent in agents.iter_mut() {
            if super::builtin::strip_forbidden_sub_agents(agent) {
                agents_changed = true;
            }
        }
        if overlays_changed {
            if let Err(err) = save_overrides_to_disk(&overrides_path(), &builtin_overrides) {
                error!("[agent-definitions] migration: failed to persist overrides: {err}");
            } else {
                info!(
                    "[agent-definitions] migration: stripped internal sub-agent ids from {} \
                     overlay(s)",
                    builtin_overrides.len()
                );
            }
        }
        if agents_changed {
            if let Err(err) = save_to_disk(&storage_path(), &agents) {
                error!("[agent-definitions] migration: failed to persist agents: {err}");
            } else {
                info!(
                    "[agent-definitions] migration: stripped internal sub-agent ids from \
                     user definitions"
                );
            }
        }

        Self {
            agents: Mutex::new(agents),
            builtin_overrides: Mutex::new(builtin_overrides),
        }
    }

    pub(crate) fn persist(&self, agents: &[AgentDefinition]) {
        let path = storage_path();
        if let Err(err) = save_to_disk(&path, agents) {
            error!("[agent-definitions] Failed to persist: {}", err);
        }
    }

    pub(crate) fn persist_overrides(&self, overrides: &BTreeMap<String, AgentDefinition>) {
        let path = overrides_path();
        if let Err(err) = save_overrides_to_disk(&path, overrides) {
            error!("[agent-definitions] Failed to persist overrides: {}", err);
        }
    }

    /// Look up an agent by id. For `builtin:*`, the compiled-in definition
    /// is first consulted, then replaced by any entry in
    /// `builtin-overrides.json`. For non-builtin ids, returns the user
    /// agent from the on-disk store.
    pub fn get(&self, id: &str) -> Option<AgentDefinition> {
        if super::builtin::is_builtin_agent(id) {
            let overlay = self
                .builtin_overrides
                .lock()
                .expect("builtin-overrides mutex poisoned")
                .get(id)
                .cloned();
            if let Some(override_def) = overlay {
                return Some(override_def);
            }
            return super::builtin::get_builtin_agent(id);
        }
        let guard = self
            .agents
            .lock()
            .expect("agent-definitions mutex poisoned");
        guard.iter().find(|a| a.id == id).cloned()
    }

    /// Snapshot of all user-defined agents currently in the store. Does
    /// NOT include builtin agents — consult `builtin::get_builtin_agents`
    /// for those.
    pub fn snapshot(&self) -> Vec<AgentDefinition> {
        self.agents
            .lock()
            .expect("agent-definitions mutex poisoned")
            .clone()
    }

    /// Atomically mutate a **user-created** agent definition by id.
    ///
    /// Use `update_with_overlay` for `builtin:*` ids.
    pub fn update<F>(&self, id: &str, patch: F) -> Result<AgentDefinition, String>
    where
        F: FnOnce(&mut AgentDefinition),
    {
        if super::builtin::is_builtin_agent(id) {
            return Err(format!(
                "update() rejects builtin id '{}'; use update_with_overlay()",
                id
            ));
        }
        let (updated, snapshot) = {
            let mut guard = self
                .agents
                .lock()
                .expect("agent-definitions mutex poisoned");
            let agent = guard
                .iter_mut()
                .find(|a| a.id == id)
                .ok_or_else(|| format!("agent '{}' not found", id))?;
            patch(agent);
            super::builtin::strip_forbidden_sub_agents(agent);
            (agent.clone(), guard.clone())
        };
        self.persist(&snapshot);
        notify_change(id);
        Ok(updated)
    }

    /// Update a `builtin:*` agent by writing an overlay to
    /// `~/.orgii/builtin-overrides.json`. If no overlay exists yet, the
    /// compiled-in builtin is cloned as the starting point and then
    /// patched; subsequent updates edit the existing overlay.
    ///
    /// Non-builtin ids are rejected — call `update()` for those.
    pub fn update_with_overlay<F>(&self, id: &str, patch: F) -> Result<AgentDefinition, String>
    where
        F: FnOnce(&mut AgentDefinition),
    {
        if !super::builtin::is_builtin_agent(id) {
            return Err(format!(
                "update_with_overlay() requires a builtin id; got '{}'",
                id
            ));
        }
        let (updated, snapshot) = {
            let mut guard = self
                .builtin_overrides
                .lock()
                .expect("builtin-overrides mutex poisoned");
            // Start from existing overlay, or compiled-in builtin.
            let base = match guard.get(id) {
                Some(existing) => existing.clone(),
                None => super::builtin::get_builtin_agent(id)
                    .ok_or_else(|| format!("builtin '{}' does not exist", id))?,
            };
            let mut agent = base;
            patch(&mut agent);
            super::builtin::strip_forbidden_sub_agents(&mut agent);
            guard.insert(id.to_string(), agent.clone());
            (agent, guard.clone())
        };
        self.persist_overrides(&snapshot);
        notify_change(id);
        Ok(updated)
    }

    /// Remove a builtin overlay, reverting to the compiled-in definition.
    /// Returns `Ok(())` whether or not an overlay existed.
    pub fn reset_builtin(&self, id: &str) -> Result<(), String> {
        if !super::builtin::is_builtin_agent(id) {
            return Err(format!("reset_builtin requires a builtin id; got '{}'", id));
        }
        let snapshot = {
            let mut guard = self
                .builtin_overrides
                .lock()
                .expect("builtin-overrides mutex poisoned");
            guard.remove(id);
            guard.clone()
        };
        self.persist_overrides(&snapshot);
        notify_change(id);
        Ok(())
    }

    /// Insert a new user-created agent definition. Rejects duplicate ids
    /// and builtin ids. The single creation chokepoint — strips forbidden
    /// sub-agents, persists, and fires the change hook.
    pub fn insert(&self, mut agent: AgentDefinition) -> Result<String, String> {
        if super::builtin::is_builtin_agent(&agent.id) {
            return Err(format!("insert() rejects builtin id '{}'", agent.id));
        }
        super::builtin::strip_forbidden_sub_agents(&mut agent);
        let id = agent.id.clone();
        let snapshot = {
            let mut guard = self
                .agents
                .lock()
                .expect("agent-definitions mutex poisoned");
            if guard.iter().any(|existing| existing.id == id) {
                return Err(format!("Agent with id '{}' already exists", id));
            }
            guard.push(agent);
            guard.clone()
        };
        self.persist(&snapshot);
        notify_change(&id);
        Ok(id)
    }

    /// Insert-or-replace a user-created agent definition by id. Used by
    /// import flows that legitimately overwrite. Same invariants as
    /// `insert` otherwise.
    pub fn upsert(&self, mut agent: AgentDefinition) -> Result<(), String> {
        if super::builtin::is_builtin_agent(&agent.id) {
            return Err(format!("upsert() rejects builtin id '{}'", agent.id));
        }
        super::builtin::strip_forbidden_sub_agents(&mut agent);
        let id = agent.id.clone();
        let snapshot = {
            let mut guard = self
                .agents
                .lock()
                .expect("agent-definitions mutex poisoned");
            if let Some(existing) = guard.iter_mut().find(|a| a.id == id) {
                *existing = agent;
            } else {
                guard.push(agent);
            }
            guard.clone()
        };
        self.persist(&snapshot);
        notify_change(&id);
        Ok(())
    }

    /// Remove a user-created agent definition by id. Returns `true` when a
    /// definition was removed. Refuses when any agent org still references
    /// the agent (dangling org members previously only failed at launch).
    pub fn remove(&self, id: &str) -> Result<bool, String> {
        let referencing = super::orgs::orgs_store().org_names_referencing_agent(id);
        if !referencing.is_empty() {
            return Err(format!(
                "Agent '{}' is still referenced by org(s): {}. Remove it from those orgs first.",
                id,
                referencing.join(", ")
            ));
        }
        let (removed, snapshot) = {
            let mut guard = self
                .agents
                .lock()
                .expect("agent-definitions mutex poisoned");
            let len_before = guard.len();
            guard.retain(|agent| agent.id != id);
            (guard.len() < len_before, guard.clone())
        };
        if removed {
            self.persist(&snapshot);
            notify_change(id);
        }
        Ok(removed)
    }
}

// ── File I/O ──

/// One-shot migration for the retired `loadWorkspaceSettings` field: if an
/// on-disk definition still carries it, fold its value into the two fields
/// that replaced it (`loadWorkspaceResources` / `loadWorkspaceRules`) when
/// those are unset, then drop the legacy key. Returns `true` when the value
/// was changed and should be re-persisted.
fn migrate_legacy_workspace_settings(value: &mut serde_json::Value) -> bool {
    let Some(obj) = value.as_object_mut() else {
        return false;
    };
    let Some(legacy) = obj.remove("loadWorkspaceSettings") else {
        return false;
    };
    if legacy.as_bool().is_some() {
        for key in ["loadWorkspaceResources", "loadWorkspaceRules"] {
            if obj.get(key).is_none_or(serde_json::Value::is_null) {
                obj.insert(key.to_string(), legacy.clone());
            }
        }
    }
    true
}

/// One-shot migration for the stale `summaryMaxTokens: 4096` compaction
/// override. 4096 was the shipped default before it was raised to 20_000
/// (a 4k cap truncates the 9-section compaction summary mid-section, cf.
/// claude_code COMPACT_MAX_OUTPUT_TOKENS = 20_000); overlays written back
/// then froze the old default as if the user had chosen it. Values other
/// than 4096 are genuine user choices and are left alone. Returns `true`
/// when the value was changed and should be re-persisted.
fn migrate_stale_summary_max_tokens(value: &mut serde_json::Value) -> bool {
    const STALE_DEFAULT: u64 = 4096;
    let Some(summary_max) = value
        .pointer_mut("/sessionModel/compaction/summaryMaxTokens")
        .filter(|v| v.as_u64() == Some(STALE_DEFAULT))
    else {
        return false;
    };
    *summary_max = serde_json::json!(super::schema::CompactionConfig::default().summary_max_tokens);
    true
}

fn load_from_disk(path: &std::path::Path) -> Vec<AgentDefinition> {
    if !path.exists() {
        return Vec::new();
    }
    match std::fs::read_to_string(path) {
        Ok(content) => match serde_json::from_str::<Vec<serde_json::Value>>(&content) {
            Ok(mut raw) => {
                let migrated = raw.iter_mut().fold(false, |acc, v| {
                    migrate_legacy_workspace_settings(v) | migrate_stale_summary_max_tokens(v) | acc
                });
                let agents: Vec<AgentDefinition> = raw
                    .into_iter()
                    .filter_map(|v| match serde_json::from_value(v) {
                        Ok(agent) => Some(agent),
                        Err(err) => {
                            error!(
                                "[agent-definitions] Skipping unparsable entry in {}: {}",
                                path.display(),
                                err
                            );
                            None
                        }
                    })
                    .collect();
                if migrated {
                    if let Err(err) = save_to_disk(path, &agents) {
                        error!(
                            "[agent-definitions] migration: failed to persist \
                             loadWorkspaceSettings removal: {err}"
                        );
                    }
                }
                info!(
                    "[agent-definitions] Loaded {} agents from {}",
                    agents.len(),
                    path.display()
                );
                agents
            }
            Err(err) => {
                error!(
                    "[agent-definitions] Failed to parse {}: {}",
                    path.display(),
                    err
                );
                Vec::new()
            }
        },
        Err(err) => {
            error!(
                "[agent-definitions] Failed to read {}: {}",
                path.display(),
                err
            );
            Vec::new()
        }
    }
}

fn save_to_disk(path: &std::path::Path, agents: &[AgentDefinition]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create directory: {}", err))?;
    }
    let content = serde_json::to_string_pretty(agents)
        .map_err(|err| format!("Failed to serialize agents: {}", err))?;
    std::fs::write(path, content).map_err(|err| format!("Failed to write agents: {}", err))?;
    info!(
        "[agent-definitions] Saved {} agents to {}",
        agents.len(),
        path.display()
    );
    Ok(())
}

fn load_overrides_from_disk(path: &std::path::Path) -> BTreeMap<String, AgentDefinition> {
    if !path.exists() {
        return BTreeMap::new();
    }
    match std::fs::read_to_string(path) {
        Ok(content) => {
            match serde_json::from_str::<BTreeMap<String, serde_json::Value>>(&content) {
                Ok(mut raw) => {
                    let migrated = raw.values_mut().fold(false, |acc, v| {
                        migrate_legacy_workspace_settings(v)
                            | migrate_stale_summary_max_tokens(v)
                            | acc
                    });
                    let overrides: BTreeMap<String, AgentDefinition> = raw
                        .into_iter()
                        .filter_map(
                            |(id, delta)| match compose_builtin_with_delta(&id, &delta) {
                                Some(agent) => Some((id, agent)),
                                None => {
                                    warn!(
                                        "[builtin-overrides] Skipping overlay '{}' in {} \
                                     (unknown builtin or unparsable delta)",
                                        id,
                                        path.display()
                                    );
                                    None
                                }
                            },
                        )
                        .collect();
                    if migrated {
                        if let Err(err) = save_overrides_to_disk(path, &overrides) {
                            error!(
                                "[builtin-overrides] migration: failed to persist \
                             loadWorkspaceSettings removal: {err}"
                            );
                        }
                    }
                    info!(
                        "[builtin-overrides] Loaded {} overrides from {}",
                        overrides.len(),
                        path.display()
                    );
                    overrides
                }
                Err(err) => {
                    warn!(
                        "[builtin-overrides] Failed to parse {}: {} — ignoring overlay",
                        path.display(),
                        err
                    );
                    BTreeMap::new()
                }
            }
        }
        Err(err) => {
            warn!(
                "[builtin-overrides] Failed to read {}: {} — ignoring overlay",
                path.display(),
                err
            );
            BTreeMap::new()
        }
    }
}

/// Compose `compiled builtin + on-disk delta` into an effective definition.
///
/// The delta is a JSON object holding only the top-level fields the user
/// changed. Unknown builtin ids return `None` (e.g. a builtin retired in a
/// newer release). Legacy full-snapshot entries compose identically —
/// every field overwrites the compiled value — and are reduced to true
/// deltas on the next write.
fn compose_builtin_with_delta(id: &str, delta: &serde_json::Value) -> Option<AgentDefinition> {
    let builtin = super::builtin::get_builtin_agent(id)?;
    let mut base = serde_json::to_value(&builtin).ok()?;
    let (Some(base_obj), Some(delta_obj)) = (base.as_object_mut(), delta.as_object()) else {
        return None;
    };
    for (key, value) in delta_obj {
        // Identity/structural keys never come from the overlay.
        if key == "id" || key == "builtIn" {
            continue;
        }
        base_obj.insert(key.clone(), value.clone());
    }
    serde_json::from_value(base).ok()
}

/// Reduce an effective builtin definition back to the top-level field
/// delta against the compiled-in builtin. Fields whose serialized value
/// equals the compiled value are dropped; an explicit `null` is written
/// when the user cleared a field the builtin sets.
fn delta_against_builtin(id: &str, effective: &AgentDefinition) -> Option<serde_json::Value> {
    let builtin = super::builtin::get_builtin_agent(id)?;
    let base = serde_json::to_value(&builtin).ok()?;
    let full = serde_json::to_value(effective).ok()?;
    let (Some(base_obj), Some(full_obj)) = (base.as_object(), full.as_object()) else {
        return None;
    };
    let mut delta = serde_json::Map::new();
    for (key, value) in full_obj {
        if key == "id" || key == "builtIn" {
            continue;
        }
        if base_obj.get(key) != Some(value) {
            delta.insert(key.clone(), value.clone());
        }
    }
    // Fields present on the compiled builtin but absent from the effective
    // serialization were cleared by the user — record explicit null.
    for key in base_obj.keys() {
        if key == "id" || key == "builtIn" {
            continue;
        }
        if !full_obj.contains_key(key) {
            delta.insert(key.clone(), serde_json::Value::Null);
        }
    }
    Some(serde_json::Value::Object(delta))
}

fn save_overrides_to_disk(
    path: &std::path::Path,
    overrides: &BTreeMap<String, AgentDefinition>,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create directory: {}", err))?;
    }
    let deltas: BTreeMap<&String, serde_json::Value> = overrides
        .iter()
        .filter_map(|(id, agent)| delta_against_builtin(id, agent).map(|d| (id, d)))
        .collect();
    let content = serde_json::to_string_pretty(&deltas)
        .map_err(|err| format!("Failed to serialize overrides: {}", err))?;
    std::fs::write(path, content).map_err(|err| format!("Failed to write overrides: {}", err))?;
    info!(
        "[builtin-overrides] Saved {} override delta(s) to {}",
        deltas.len(),
        path.display()
    );
    Ok(())
}

#[cfg(test)]
mod overlay_tests {
    use super::*;

    #[test]
    fn compose_applies_delta_field_over_builtin() {
        let delta = serde_json::json!({"name": "My SDE"});
        let agent = compose_builtin_with_delta("builtin:sde", &delta).expect("composes");
        assert_eq!(agent.name, "My SDE");
        // Untouched fields keep compiled-in values.
        let compiled = crate::definitions::builtin::get_builtin_agent("builtin:sde").unwrap();
        assert_eq!(agent.tools.excluded_tools, compiled.tools.excluded_tools);
    }

    #[test]
    fn compose_legacy_full_snapshot_still_composes() {
        let compiled = crate::definitions::builtin::get_builtin_agent("builtin:os").unwrap();
        let mut snapshot = serde_json::to_value(&compiled).unwrap();
        snapshot["name"] = serde_json::json!("Renamed OS");
        let agent = compose_builtin_with_delta("builtin:os", &snapshot).expect("composes");
        assert_eq!(agent.name, "Renamed OS");
    }

    #[test]
    fn delta_round_trip_keeps_only_changed_fields() {
        let mut effective = crate::definitions::builtin::get_builtin_agent("builtin:sde").unwrap();
        effective.name = "Custom SDE".to_string();
        effective.temperature = Some(0.3);

        let delta = delta_against_builtin("builtin:sde", &effective).expect("delta");
        let obj = delta.as_object().expect("object");
        assert!(obj.contains_key("name"));
        assert!(obj.contains_key("temperature"));
        assert!(
            !obj.contains_key("soulContent"),
            "untouched field must not be in the delta"
        );

        let recomposed = compose_builtin_with_delta("builtin:sde", &delta).expect("recompose");
        assert_eq!(recomposed.name, "Custom SDE");
        assert_eq!(recomposed.temperature, Some(0.3));
    }

    #[test]
    fn delta_records_cleared_field_as_null() {
        let mut effective = crate::definitions::builtin::get_builtin_agent("builtin:sde").unwrap();
        // SDE ships a soul; the user clears it.
        assert!(effective.soul_content.is_some());
        effective.soul_content = None;

        let delta = delta_against_builtin("builtin:sde", &effective).expect("delta");
        assert!(delta.get("soulContent").is_some_and(|v| v.is_null()));

        let recomposed = compose_builtin_with_delta("builtin:sde", &delta).expect("recompose");
        assert!(recomposed.soul_content.is_none());
    }

    #[test]
    fn compose_unknown_builtin_returns_none() {
        let delta = serde_json::json!({"name": "ghost"});
        assert!(compose_builtin_with_delta("builtin:retired-agent", &delta).is_none());
    }

    #[test]
    fn stale_summary_max_tokens_4096_is_migrated_to_current_default() {
        let mut value = serde_json::json!({
            "sessionModel": { "compaction": { "summaryMaxTokens": 4096 } }
        });
        assert!(migrate_stale_summary_max_tokens(&mut value));
        assert_eq!(
            value["sessionModel"]["compaction"]["summaryMaxTokens"].as_u64(),
            Some(u64::from(
                super::super::schema::CompactionConfig::default().summary_max_tokens
            ))
        );
    }

    #[test]
    fn user_chosen_summary_max_tokens_is_left_alone() {
        let mut value = serde_json::json!({
            "sessionModel": { "compaction": { "summaryMaxTokens": 8000 } }
        });
        assert!(!migrate_stale_summary_max_tokens(&mut value));
        assert_eq!(
            value["sessionModel"]["compaction"]["summaryMaxTokens"].as_u64(),
            Some(8000)
        );
    }

    #[test]
    fn missing_summary_max_tokens_is_no_op() {
        let mut value = serde_json::json!({ "name": "no compaction override" });
        assert!(!migrate_stale_summary_max_tokens(&mut value));
    }
}
