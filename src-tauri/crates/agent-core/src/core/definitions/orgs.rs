//! Flat Agent Team definitions with validated, atomic JSON persistence.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
#[cfg(not(test))]
use std::sync::OnceLock;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::{error, info, warn};

use app_paths::agent_orgs as storage_path;
use key_vault::ModelType;

#[cfg(not(test))]
static PROCESS_STORE: OnceLock<Arc<AgentOrgsStore>> = OnceLock::new();

pub const CLI_AGENT_ORG_REFERENCE_PREFIX: &str = "cli:";
pub const MAX_AGENT_ORG_MEMBERS: usize = 50;
pub const MAX_AGENT_ORG_DEFINITION_BYTES: usize = 256 * 1024;
const AGENT_ORGS_FILE_SCHEMA_VERSION: u32 = 2;
use core_types::agent_org::COORDINATOR_MEMBER_ID;

pub fn orgs_store() -> Arc<AgentOrgsStore> {
    #[cfg(test)]
    {
        Arc::new(AgentOrgsStore::new())
    }
    #[cfg(not(test))]
    {
        PROCESS_STORE
            .get_or_init(|| Arc::new(AgentOrgsStore::new()))
            .clone()
    }
}

pub fn parse_cli_agent_org_reference(agent_id: &str) -> Option<ModelType> {
    let raw = agent_id
        .trim()
        .strip_prefix(CLI_AGENT_ORG_REFERENCE_PREFIX)?
        .trim();
    let model_type = ModelType::from_str(raw)?;
    model_type.is_cli_agent().then_some(model_type)
}

pub fn is_cli_agent_org_reference(agent_id: &str) -> bool {
    parse_cli_agent_org_reference(agent_id).is_some()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum PlanApprovalPolicy {
    #[default]
    Coordinator,
    User,
    Automatic,
}

impl PlanApprovalPolicy {
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Coordinator => "coordinator",
            Self::User => "user",
            Self::Automatic => "automatic",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgMemberRuntimeConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_harness_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub listing_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub listing_model_display: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub listing_model_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_source_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_source_model_type: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgMemberLaunchOverride {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_config: Option<OrgMemberRuntimeConfig>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlatOrgMember {
    pub member_id: String,
    pub name: String,
    pub role: String,
    pub agent_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_config: Option<OrgMemberRuntimeConfig>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemberCommunicationLink {
    pub member_a_id: String,
    pub member_b_id: String,
}

impl MemberCommunicationLink {
    pub fn canonical(member_a_id: impl Into<String>, member_b_id: impl Into<String>) -> Self {
        let member_a_id = member_a_id.into();
        let member_b_id = member_b_id.into();
        if member_a_id <= member_b_id {
            Self {
                member_a_id,
                member_b_id,
            }
        } else {
            Self {
                member_a_id: member_b_id,
                member_b_id: member_a_id,
            }
        }
    }

    pub fn key(&self) -> (&str, &str) {
        (&self.member_a_id, &self.member_b_id)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OrgDefinition {
    pub id: String,
    pub name: String,
    pub role: String,
    pub agent_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub plan_approval_policy: PlanApprovalPolicy,
    pub members: Vec<FlatOrgMember>,
    pub additional_task_graph_writer_member_ids: Vec<String>,
    pub member_communication_links: Vec<MemberCommunicationLink>,
}

impl OrgDefinition {
    /// Total number of participants in the Team: the coordinator plus
    /// every `members` entry. Coordinator-inclusive by design — use
    /// `members.len()` for the member roster size.
    pub fn participant_count(&self) -> usize {
        1 + self.members.len()
    }

    pub fn with_all_member_links(mut self) -> Self {
        self.member_communication_links = all_member_links(&self.members);
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentOrgLaunchSnapshot {
    pub schema_version: u32,
    pub org_id: String,
    pub org_name: String,
    pub coordinator_role: String,
    pub coordinator_agent_id: String,
    pub plan_approval_policy: PlanApprovalPolicy,
    pub members: Vec<FlatOrgMember>,
    pub additional_task_graph_writer_member_ids: Vec<String>,
    pub member_communication_links: Vec<MemberCommunicationLink>,
}

impl From<&OrgDefinition> for AgentOrgLaunchSnapshot {
    fn from(org: &OrgDefinition) -> Self {
        Self {
            schema_version: 1,
            org_id: org.id.clone(),
            org_name: org.name.clone(),
            coordinator_role: org.role.clone(),
            coordinator_agent_id: org.agent_id.clone(),
            plan_approval_policy: org.plan_approval_policy,
            members: org.members.clone(),
            additional_task_graph_writer_member_ids: org
                .additional_task_graph_writer_member_ids
                .clone(),
            member_communication_links: org.member_communication_links.clone(),
        }
    }
}

/// Validate the frozen, self-contained Team contract without consulting the
/// mutable definition store. Runtime recovery must never reinterpret a launch
/// snapshot using a template that may have changed after the run started.
///
/// Structural validation only — no serialization. Read/context/task-persist
/// paths call this on every access; the byte-size cap is enforced where
/// snapshots are written, in [`serialize_launch_snapshot`].
pub fn validate_launch_snapshot(snapshot: &AgentOrgLaunchSnapshot) -> Result<(), String> {
    if snapshot.schema_version != 1 {
        return Err(format!(
            "unsupported Agent Org launch snapshot version {}",
            snapshot.schema_version
        ));
    }
    if snapshot.org_id.trim().is_empty()
        || snapshot.org_name.trim().is_empty()
        || snapshot.coordinator_agent_id.trim().is_empty()
    {
        return Err("Agent Org launch snapshot has an empty Team or Coordinator identity".into());
    }
    if snapshot.members.is_empty() || snapshot.members.len() > MAX_AGENT_ORG_MEMBERS {
        return Err(format!(
            "Agent Org launch snapshot must contain between 1 and {} members",
            MAX_AGENT_ORG_MEMBERS
        ));
    }

    let mut member_ids = HashSet::with_capacity(snapshot.members.len());
    for member in &snapshot.members {
        let member_id = member.member_id.trim();
        if member.member_id != member_id {
            return Err(format!(
                "Agent Org launch snapshot member id '{}' has leading or trailing whitespace",
                member.member_id
            ));
        }
        if member_id.is_empty() || member_id.eq_ignore_ascii_case(COORDINATOR_MEMBER_ID) {
            return Err("Agent Org launch snapshot has an empty or reserved member id".into());
        }
        if member.agent_id.trim().is_empty() {
            return Err(format!(
                "Agent Org launch snapshot member '{}' has no agent definition",
                member.member_id
            ));
        }
        if !member_ids.insert(member_id.to_string()) {
            return Err(format!(
                "Agent Org launch snapshot has duplicate member id '{}'",
                member.member_id
            ));
        }
    }

    let mut writer_ids = HashSet::new();
    for writer_id in &snapshot.additional_task_graph_writer_member_ids {
        if !member_ids.contains(writer_id) {
            return Err(format!(
                "Agent Org launch snapshot references unknown Writer member '{}'",
                writer_id
            ));
        }
        if !writer_ids.insert(writer_id.as_str()) {
            return Err(format!(
                "Agent Org launch snapshot has duplicate Writer member '{}'",
                writer_id
            ));
        }
    }

    let mut link_keys = HashSet::new();
    for link in &snapshot.member_communication_links {
        if link.member_a_id == link.member_b_id {
            return Err(format!(
                "Agent Org launch snapshot has self communication link '{}'",
                link.member_a_id
            ));
        }
        if !member_ids.contains(&link.member_a_id) || !member_ids.contains(&link.member_b_id) {
            return Err("Agent Org launch snapshot has a link with an unknown member".into());
        }
        let canonical =
            MemberCommunicationLink::canonical(link.member_a_id.clone(), link.member_b_id.clone());
        if canonical != *link {
            return Err(format!(
                "Agent Org launch snapshot has non-canonical communication link '{} ↔ {}'",
                link.member_a_id, link.member_b_id
            ));
        }
        if !link_keys.insert((link.member_a_id.as_str(), link.member_b_id.as_str())) {
            return Err(format!(
                "Agent Org launch snapshot has duplicate communication link '{} ↔ {}'",
                link.member_a_id, link.member_b_id
            ));
        }
    }

    Ok(())
}

/// Validate and encode a launch snapshot for persistence. The byte-size cap
/// lives here — on the write path — so read paths can validate structure
/// without paying for a full serialization on every access.
pub fn serialize_launch_snapshot(snapshot: &AgentOrgLaunchSnapshot) -> Result<String, String> {
    validate_launch_snapshot(snapshot)?;
    let encoded = serde_json::to_string(snapshot)
        .map_err(|err| format!("failed to serialize Agent Org launch snapshot: {err}"))?;
    if encoded.len() > MAX_AGENT_ORG_DEFINITION_BYTES {
        return Err(format!(
            "Agent Org launch snapshot exceeds {} bytes",
            MAX_AGENT_ORG_DEFINITION_BYTES
        ));
    }
    Ok(encoded)
}

#[derive(Debug, Clone, Default)]
pub struct AgentOrgCapabilityIndex {
    writer_member_ids: HashSet<String>,
    communication_pairs: HashSet<(String, String)>,
}

impl AgentOrgCapabilityIndex {
    pub fn from_snapshot(snapshot: &AgentOrgLaunchSnapshot) -> Self {
        Self {
            writer_member_ids: snapshot
                .additional_task_graph_writer_member_ids
                .iter()
                .cloned()
                .collect(),
            communication_pairs: snapshot
                .member_communication_links
                .iter()
                .map(|link| (link.member_a_id.clone(), link.member_b_id.clone()))
                .collect(),
        }
    }

    pub fn is_additional_writer(&self, member_id: &str) -> bool {
        self.writer_member_ids.contains(member_id)
    }

    pub fn members_can_communicate(&self, member_a_id: &str, member_b_id: &str) -> bool {
        let link = MemberCommunicationLink::canonical(member_a_id, member_b_id);
        self.communication_pairs
            .contains(&(link.member_a_id, link.member_b_id))
    }
}

pub fn all_member_links(members: &[FlatOrgMember]) -> Vec<MemberCommunicationLink> {
    let mut links = Vec::with_capacity(members.len().saturating_mul(members.len()) / 2);
    for (index, member_a) in members.iter().enumerate() {
        for member_b in members.iter().skip(index + 1) {
            links.push(MemberCommunicationLink::canonical(
                member_a.member_id.clone(),
                member_b.member_id.clone(),
            ));
        }
    }
    links.sort_by(|left, right| left.key().cmp(&right.key()));
    links
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentOrgDefinitionsFile {
    schema_version: u32,
    /// Raw definition entries. Kept as JSON values so a single invalid
    /// definition can be quarantined (and round-tripped back to disk
    /// verbatim) without blocking the valid ones.
    definitions: Vec<serde_json::Value>,
}

/// One on-disk definition that failed to parse or validate at load time.
///
/// Quarantined entries are preserved verbatim in the definitions file on
/// every save, are excluded from reads, and block only writes that would
/// touch their id or name. Fixing the entry on disk requires an app
/// restart to be picked up; the diagnostics say so.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuarantinedOrgDefinition {
    pub id: Option<String>,
    pub name: Option<String>,
    pub error: String,
    #[serde(skip)]
    raw: serde_json::Value,
}

enum LoadOutcome {
    Missing,
    Loaded {
        orgs: Vec<OrgDefinition>,
        quarantined: Vec<QuarantinedOrgDefinition>,
    },
    LegacyReset,
    Blocked(String),
}

pub struct AgentOrgsStore {
    pub(crate) orgs: Mutex<Vec<OrgDefinition>>,
    /// Definitions held back at load time. Immutable for the lifetime of
    /// the store: repairing one requires editing the file and restarting.
    quarantined: Vec<QuarantinedOrgDefinition>,
    persistence_blocked: Option<String>,
}

impl Default for AgentOrgsStore {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentOrgsStore {
    pub fn new() -> Self {
        let path = storage_path();
        let (mut orgs, quarantined, persistence_blocked, should_persist) =
            match load_from_disk(&path) {
                LoadOutcome::Missing => (Vec::new(), Vec::new(), None, true),
                LoadOutcome::Loaded { orgs, quarantined } => (orgs, quarantined, None, false),
                LoadOutcome::LegacyReset => (Vec::new(), Vec::new(), None, true),
                LoadOutcome::Blocked(message) => {
                    error!("[agent-orgs] {}", message);
                    (Vec::new(), Vec::new(), Some(message), false)
                }
            };
        for entry in &quarantined {
            error!(
                "[agent-orgs] Quarantined Agent Org definition (id: {}, name: {}): {}",
                entry.id.as_deref().unwrap_or("<unknown>"),
                entry.name.as_deref().unwrap_or("<unknown>"),
                entry.error
            );
        }

        let defaults_changed = persistence_blocked.is_none()
            && ensure_default_template_team(&mut orgs, &quarantined);
        if persistence_blocked.is_none() && (should_persist || defaults_changed) {
            if let Err(err) =
                validate_definitions(&orgs).and_then(|_| save_to_disk(&path, &orgs, &quarantined))
            {
                error!(
                    "[agent-orgs] Failed to persist canonical definitions: {}",
                    err
                );
                return Self {
                    orgs: Mutex::new(Vec::new()),
                    quarantined,
                    persistence_blocked: Some(err),
                };
            }
        }

        Self {
            orgs: Mutex::new(orgs),
            quarantined,
            persistence_blocked,
        }
    }

    pub fn list(&self) -> Result<Vec<OrgDefinition>, String> {
        self.ensure_writable()?;
        self.orgs
            .lock()
            .map(|orgs| orgs.clone())
            .map_err(|err| format!("Lock error: {}", err))
    }

    pub fn get(&self, org_id: &str) -> Result<OrgDefinition, String> {
        self.ensure_writable()?;
        let orgs = self
            .orgs
            .lock()
            .map_err(|err| format!("Lock error: {}", err))?;
        orgs.iter()
            .find(|org| org.id == org_id)
            .cloned()
            .ok_or_else(|| {
                self.quarantine_error(org_id)
                    .unwrap_or_else(|| format!("Agent Org '{}' not found", org_id))
            })
    }

    /// Definitions that were held back at load time because they failed to
    /// parse or validate. Surfaced for diagnostics; each entry carries the
    /// load error and the remediation (fix the file, restart the app).
    pub fn quarantined_definitions(&self) -> &[QuarantinedOrgDefinition] {
        &self.quarantined
    }

    fn quarantine_error(&self, org_id: &str) -> Option<String> {
        self.quarantined
            .iter()
            .find(|entry| entry.id.as_deref() == Some(org_id))
            .map(|entry| {
                format!(
                    "Agent Org '{}' is quarantined and cannot be read or modified: {}",
                    org_id, entry.error
                )
            })
    }

    pub fn coordinator_agent_id(&self, org_id: &str) -> Result<String, String> {
        let org = self.get(org_id)?;
        if org.agent_id.trim().is_empty() {
            return Err(format!(
                "Agent Org '{}' has no coordinator agent configured",
                org.name
            ));
        }
        Ok(org.agent_id)
    }

    /// Names of every org that references `agent_id`, used as the
    /// agent-deletion guard. Fails safe: definitions the store could not
    /// interpret (quarantined entries, or a fully blocked file) are scanned
    /// best-effort as raw text so an unreadable reference still blocks
    /// deletion instead of letting it silently invalidate the file.
    pub fn org_names_referencing_agent(&self, agent_id: &str) -> Vec<String> {
        let mut names: Vec<String> = match self.orgs.lock() {
            Ok(orgs) => orgs
                .iter()
                .filter(|org| {
                    org.agent_id == agent_id
                        || org.members.iter().any(|member| member.agent_id == agent_id)
                })
                .map(|org| org.name.clone())
                .collect(),
            Err(_) => Vec::new(),
        };
        for entry in &self.quarantined {
            if entry.raw.to_string().contains(agent_id) {
                names.push(
                    entry
                        .name
                        .clone()
                        .or_else(|| entry.id.clone())
                        .unwrap_or_else(|| "<quarantined Agent Org definition>".to_string()),
                );
            }
        }
        if self.persistence_blocked.is_some() {
            match std::fs::read_to_string(storage_path()) {
                Ok(text) if text.contains(agent_id) => {
                    names.push("<unreadable Agent Org definitions file>".to_string());
                }
                Ok(_) => {}
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => {
                    // Cannot verify: fail safe and report a reference.
                    names.push("<unreadable Agent Org definitions file>".to_string());
                }
            }
        }
        names
    }

    pub fn insert(&self, org: OrgDefinition) -> Result<String, String> {
        let id = org.id.clone();
        self.commit_candidate(|orgs| {
            if orgs.iter().any(|existing| existing.id == id) {
                return Err(format!("Org with id '{}' already exists", id));
            }
            if orgs
                .iter()
                .any(|existing| existing.name.eq_ignore_ascii_case(&org.name))
            {
                return Err(format!(
                    "An org named '{}' already exists. Use update to modify it.",
                    org.name
                ));
            }
            orgs.push(org);
            Ok(())
        })?;
        Ok(id)
    }

    pub fn replace(&self, org: OrgDefinition) -> Result<(), String> {
        if let Some(message) = self.quarantine_error(&org.id) {
            return Err(message);
        }
        self.commit_candidate(|orgs| {
            let index = orgs
                .iter()
                .position(|existing| existing.id == org.id)
                .ok_or_else(|| format!("Org '{}' not found", org.id))?;
            if orgs.iter().enumerate().any(|(candidate_index, existing)| {
                candidate_index != index && existing.name.eq_ignore_ascii_case(&org.name)
            }) {
                return Err(format!("An org named '{}' already exists", org.name));
            }
            orgs[index] = org;
            Ok(())
        })
    }

    pub(in crate::core::definitions) fn save_trusted_settings(
        &self,
        org: OrgDefinition,
        _actor: super::commands::TrustedAgentOrgSettingsActor,
    ) -> Result<OrgDefinition, String> {
        let saved_id = org.id.clone();
        self.commit_candidate(|orgs| {
            if let Some(index) = orgs.iter().position(|existing| existing.id == org.id) {
                if orgs.iter().enumerate().any(|(candidate_index, existing)| {
                    candidate_index != index && existing.name.eq_ignore_ascii_case(&org.name)
                }) {
                    return Err(format!("An org named '{}' already exists", org.name));
                }
                // Updates keep the caller's links verbatim: a deliberately
                // deleted communication link must survive a settings save.
                orgs[index] = org;
            } else {
                if orgs
                    .iter()
                    .any(|existing| existing.name.eq_ignore_ascii_case(&org.name))
                {
                    return Err(format!("An org named '{}' already exists", org.name));
                }
                // Rust owns default connectivity for NEW teams: inserting a
                // multi-member team with no links materializes the full
                // canonical link set instead of trusting every caller to.
                let org = if org.member_communication_links.is_empty() {
                    org.with_all_member_links()
                } else {
                    org
                };
                orgs.push(org);
            }
            Ok(())
        })?;
        self.get(&saved_id)
    }

    pub fn remove(&self, org_id: &str) -> Result<bool, String> {
        if let Some(message) = self.quarantine_error(org_id) {
            return Err(message);
        }
        let mut removed = false;
        self.commit_candidate(|orgs| {
            let before = orgs.len();
            orgs.retain(|org| org.id != org_id);
            removed = orgs.len() != before;
            Ok(())
        })?;
        Ok(removed)
    }

    pub fn apply_member_launch_overrides(
        &self,
        org_id: &str,
        overrides: &HashMap<String, OrgMemberLaunchOverride>,
    ) -> Result<(), String> {
        if overrides.is_empty() {
            return Ok(());
        }
        if let Some(message) = self.quarantine_error(org_id) {
            return Err(message);
        }
        self.commit_candidate(|orgs| {
            let org = orgs
                .iter_mut()
                .find(|existing| existing.id == org_id)
                .ok_or_else(|| format!("Agent Org '{}' not found", org_id))?;
            let context = format!("Agent Org '{}'", org.name);
            apply_overrides_to_members(&mut org.members, overrides, &context)
        })
    }

    #[cfg(debug_assertions)]
    pub fn seed_for_test(&self, def: OrgDefinition) -> Result<(), String> {
        self.commit_candidate(|orgs| {
            if let Some(slot) = orgs.iter_mut().find(|existing| existing.id == def.id) {
                *slot = def;
            } else {
                orgs.push(def);
            }
            Ok(())
        })
    }

    fn ensure_writable(&self) -> Result<(), String> {
        match &self.persistence_blocked {
            Some(message) => Err(format!(
                "Agent Org definitions are unavailable until the on-disk error is resolved \
                 (fix the file, then restart the app): {}",
                message
            )),
            None => Ok(()),
        }
    }

    fn commit_candidate<F>(&self, mutate: F) -> Result<(), String>
    where
        F: FnOnce(&mut Vec<OrgDefinition>) -> Result<(), String>,
    {
        self.ensure_writable()?;
        let mut guard = self
            .orgs
            .lock()
            .map_err(|err| format!("Lock error: {}", err))?;
        let mut candidate = guard.clone();
        mutate(&mut candidate)?;
        canonicalize_and_validate_definitions(&mut candidate)?;
        for org in &candidate {
            let collision = self.quarantined.iter().find(|entry| {
                entry.id.as_deref() == Some(org.id.as_str())
                    || entry
                        .name
                        .as_deref()
                        .is_some_and(|name| name.eq_ignore_ascii_case(&org.name))
            });
            if let Some(entry) = collision {
                return Err(format!(
                    "Agent Org '{}' collides with a quarantined definition \
                     (fix the file, then restart the app): {}",
                    org.name, entry.error
                ));
            }
        }
        save_to_disk(&storage_path(), &candidate, &self.quarantined)?;
        *guard = candidate;
        Ok(())
    }
}

/// Async wrappers for every mutating store entry point.
///
/// Store mutations fsync under the store mutex; calling them directly from
/// an async context stalls the executor. These wrappers are the single
/// spawn_blocking owner — async callers (Tauri commands, model tools,
/// launch) go through here instead of hand-rolling their own offloading.
impl AgentOrgsStore {
    async fn run_blocking<T, F>(self: &Arc<Self>, task: F) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce(&AgentOrgsStore) -> Result<T, String> + Send + 'static,
    {
        let store = Arc::clone(self);
        tokio::task::spawn_blocking(move || task(&store))
            .await
            .map_err(|err| format!("Agent Org store task failed: {err}"))?
    }

    pub async fn insert_async(self: &Arc<Self>, org: OrgDefinition) -> Result<String, String> {
        self.run_blocking(move |store| store.insert(org)).await
    }

    pub async fn replace_async(self: &Arc<Self>, org: OrgDefinition) -> Result<(), String> {
        self.run_blocking(move |store| store.replace(org)).await
    }

    pub async fn remove_async(self: &Arc<Self>, org_id: String) -> Result<bool, String> {
        self.run_blocking(move |store| store.remove(&org_id)).await
    }

    pub async fn apply_member_launch_overrides_async(
        self: &Arc<Self>,
        org_id: String,
        overrides: HashMap<String, OrgMemberLaunchOverride>,
    ) -> Result<(), String> {
        self.run_blocking(move |store| store.apply_member_launch_overrides(&org_id, &overrides))
            .await
    }

    pub(in crate::core::definitions) async fn save_trusted_settings_async(
        self: &Arc<Self>,
        org: OrgDefinition,
        actor: super::commands::TrustedAgentOrgSettingsActor,
    ) -> Result<OrgDefinition, String> {
        self.run_blocking(move |store| store.save_trusted_settings(org, actor))
            .await
    }
}

pub fn apply_overrides_to_members(
    members: &mut [FlatOrgMember],
    overrides: &HashMap<String, OrgMemberLaunchOverride>,
    context_label: &str,
) -> Result<(), String> {
    let known_ids: HashSet<&str> = members
        .iter()
        .map(|member| member.member_id.as_str())
        .collect();
    let mut unknown_ids = overrides
        .keys()
        .filter(|member_id| !known_ids.contains(member_id.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    unknown_ids.sort();
    if !unknown_ids.is_empty() {
        return Err(format!(
            "{} has no member id(s) for override: {}",
            context_label,
            unknown_ids.join(", ")
        ));
    }
    for member in members {
        let Some(member_override) = overrides.get(&member.member_id) else {
            continue;
        };
        if let Some(agent_id) = member_override
            .agent_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            member.agent_id = agent_id.to_string();
        }
        if let Some(runtime_config) = member_override.runtime_config.clone() {
            member.runtime_config = Some(runtime_config);
        }
    }
    Ok(())
}

pub fn canonicalize_and_validate_definition(org: &mut OrgDefinition) -> Result<(), String> {
    if org.id.trim().is_empty() || org.name.trim().is_empty() {
        return Err("Agent Org id and name must not be empty".to_string());
    }
    if org.members.is_empty() || org.members.len() > MAX_AGENT_ORG_MEMBERS {
        return Err(format!(
            "Agent Org '{}' must contain between 1 and {} members",
            org.name, MAX_AGENT_ORG_MEMBERS
        ));
    }

    let mut member_ids = HashSet::with_capacity(org.members.len());
    for member in &org.members {
        let member_id = member.member_id.trim();
        if member.member_id != member_id {
            return Err(format!(
                "Agent Org '{}' member id '{}' has leading or trailing whitespace",
                org.name, member.member_id
            ));
        }
        if member_id.is_empty() || member_id.eq_ignore_ascii_case(COORDINATOR_MEMBER_ID) {
            return Err(format!(
                "Agent Org '{}' contains an empty or reserved member id",
                org.name
            ));
        }
        if !member_ids.insert(member_id.to_string()) {
            return Err(format!(
                "Agent Org '{}' contains duplicate member id '{}'",
                org.name, member_id
            ));
        }
    }

    let mut writer_ids = HashSet::new();
    for writer_id in &org.additional_task_graph_writer_member_ids {
        if !member_ids.contains(writer_id) {
            return Err(format!(
                "Agent Org '{}' references unknown Writer member '{}'",
                org.name, writer_id
            ));
        }
        if !writer_ids.insert(writer_id.clone()) {
            return Err(format!(
                "Agent Org '{}' contains duplicate Writer member '{}'",
                org.name, writer_id
            ));
        }
    }
    org.additional_task_graph_writer_member_ids.sort();

    let mut link_keys = HashSet::new();
    let mut canonical_links = Vec::with_capacity(org.member_communication_links.len());
    for link in &org.member_communication_links {
        if link.member_a_id == link.member_b_id {
            return Err(format!(
                "Agent Org '{}' contains self communication link '{}'",
                org.name, link.member_a_id
            ));
        }
        if !member_ids.contains(&link.member_a_id) || !member_ids.contains(&link.member_b_id) {
            return Err(format!(
                "Agent Org '{}' contains a communication link with an unknown member",
                org.name
            ));
        }
        let canonical =
            MemberCommunicationLink::canonical(link.member_a_id.clone(), link.member_b_id.clone());
        if !link_keys.insert((canonical.member_a_id.clone(), canonical.member_b_id.clone())) {
            return Err(format!(
                "Agent Org '{}' contains a duplicate communication link '{} ↔ {}'",
                org.name, canonical.member_a_id, canonical.member_b_id
            ));
        }
        canonical_links.push(canonical);
    }
    canonical_links.sort_by(|left, right| left.key().cmp(&right.key()));
    org.member_communication_links = canonical_links;

    validate_agent_references(org)?;
    let encoded = serde_json::to_vec(org)
        .map_err(|err| format!("Failed to encode Agent Org '{}': {}", org.name, err))?;
    if encoded.len() > MAX_AGENT_ORG_DEFINITION_BYTES {
        return Err(format!(
            "Agent Org '{}' exceeds the {} byte definition limit",
            org.name, MAX_AGENT_ORG_DEFINITION_BYTES
        ));
    }
    Ok(())
}

fn canonicalize_and_validate_definitions(orgs: &mut [OrgDefinition]) -> Result<(), String> {
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    for org in orgs {
        canonicalize_and_validate_definition(org)?;
        if !ids.insert(org.id.clone()) {
            return Err(format!("Duplicate Agent Org id '{}'", org.id));
        }
        if !names.insert(org.name.to_lowercase()) {
            return Err(format!("Duplicate Agent Org name '{}'", org.name));
        }
    }
    Ok(())
}

fn validate_definitions(orgs: &[OrgDefinition]) -> Result<(), String> {
    let mut candidate = orgs.to_vec();
    canonicalize_and_validate_definitions(&mut candidate)
}

fn validate_agent_references(org: &OrgDefinition) -> Result<(), String> {
    let mut missing = Vec::new();
    let mut unsupported_cli = Vec::new();
    let mut check = |agent_id: &str, location: String| {
        let id = agent_id.trim();
        if id.is_empty() {
            missing.push(format!("<empty> ({})", location));
        } else if parse_cli_agent_org_reference(id).is_some() {
            unsupported_cli.push(format!("{} ({})", id, location));
        } else if super::definitions_store().get(id).is_none() {
            missing.push(format!("{} ({})", id, location));
        }
    };
    check(&org.agent_id, "coordinator".to_string());
    for member in &org.members {
        check(
            &member.agent_id,
            format!("member_id={} name={}", member.member_id, member.name),
        );
    }
    if !unsupported_cli.is_empty() {
        return Err(format!(
            "CLI Agent Org participants are not supported: {}",
            unsupported_cli.join(", ")
        ));
    }
    if !missing.is_empty() {
        return Err(format!(
            "Org '{}' references unknown agent definition(s): {}",
            org.name,
            missing.join(", ")
        ));
    }
    Ok(())
}

const DEFAULT_SDE_TEMPLATE_TEAM_ID: &str = "default:sde-feature-team";
const DEFAULT_DS_TEMPLATE_TEAM_ID: &str = "default:ds-analysis-team";
const BUILTIN_SDE_AGENT_ID: &str = "builtin:sde";
const BUILTIN_DS_AGENT_ID: &str = "builtin:ds";

fn ensure_default_template_team(
    orgs: &mut Vec<OrgDefinition>,
    quarantined: &[QuarantinedOrgDefinition],
) -> bool {
    let mut changed = false;
    for canonical in [default_sde_template_team(), default_ds_template_team()] {
        // Never materialize a default next to a quarantined entry that
        // holds its id or name: the file would end up with duplicates.
        let conflicts_with_quarantine = quarantined.iter().any(|entry| {
            entry.id.as_deref() == Some(canonical.id.as_str())
                || entry
                    .name
                    .as_deref()
                    .is_some_and(|name| name.eq_ignore_ascii_case(&canonical.name))
        });
        if conflicts_with_quarantine {
            continue;
        }
        changed |= reconcile_default_org(orgs, canonical);
    }
    changed
}

/// Boot-time reconcile of one built-in template Team against its canonical
/// definition. Reconciles ONLY structural identity:
///
/// - the Team exists (a missing Team is materialized from the template),
/// - every canonical member id exists (user-removed canonical members are
///   re-added from the template and linked to every current member, the same
///   way a newly added member joins fully connected),
/// - canonical members reference the canonical agent id (template drift is
///   restored).
///
/// Everything else the user can edit through trusted settings survives a
/// boot: member name/role/runtime_config edits on surviving members,
/// user-added members, Team description, plan approval policy, Writer
/// grants, and deliberate communication-link deletions.
fn reconcile_default_org(orgs: &mut Vec<OrgDefinition>, canonical: OrgDefinition) -> bool {
    let Some(index) = orgs.iter().position(|org| org.id == canonical.id) else {
        orgs.push(canonical);
        return true;
    };
    let mut reconciled = orgs[index].clone();
    let mut changed = false;
    for canonical_member in &canonical.members {
        if let Some(existing) = reconciled
            .members
            .iter_mut()
            .find(|member| member.member_id == canonical_member.member_id)
        {
            if existing.agent_id != canonical_member.agent_id {
                existing.agent_id = canonical_member.agent_id.clone();
                changed = true;
            }
        } else {
            for member in &reconciled.members {
                reconciled
                    .member_communication_links
                    .push(MemberCommunicationLink::canonical(
                        member.member_id.clone(),
                        canonical_member.member_id.clone(),
                    ));
            }
            reconciled.members.push(canonical_member.clone());
            changed = true;
        }
    }
    if changed {
        reconciled
            .member_communication_links
            .sort_by(|left, right| left.key().cmp(&right.key()));
        orgs[index] = reconciled;
    }
    changed
}

fn flat_member(member_id: &str, name: &str, role: &str, agent_id: &str) -> FlatOrgMember {
    FlatOrgMember {
        member_id: member_id.to_string(),
        name: name.to_string(),
        role: role.to_string(),
        agent_id: agent_id.to_string(),
        runtime_config: None,
    }
}

fn default_sde_template_team() -> OrgDefinition {
    OrgDefinition {
        id: DEFAULT_SDE_TEMPLATE_TEAM_ID.to_string(),
        name: "Default Agent Org".to_string(),
        role: "Coordinator".to_string(),
        agent_id: BUILTIN_SDE_AGENT_ID.to_string(),
        description: Some(
            "Stable built-in Agent Org for cross-repo UI reproduction and teammate testing."
                .to_string(),
        ),
        plan_approval_policy: PlanApprovalPolicy::Coordinator,
        members: vec![
            flat_member(
                "sde-planner",
                "Planner",
                "Breaks down the request and tracks execution state",
                BUILTIN_SDE_AGENT_ID,
            ),
            flat_member(
                "sde-implementer",
                "Implementer",
                "Makes the code changes",
                BUILTIN_SDE_AGENT_ID,
            ),
            flat_member(
                "sde-reviewer",
                "Reviewer",
                "Reviews correctness, naming, and maintainability",
                BUILTIN_SDE_AGENT_ID,
            ),
            flat_member(
                "sde-tester",
                "Tester",
                "Runs verification and reports failures",
                BUILTIN_SDE_AGENT_ID,
            ),
        ],
        additional_task_graph_writer_member_ids: Vec::new(),
        member_communication_links: Vec::new(),
    }
    .with_all_member_links()
}

fn default_ds_template_team() -> OrgDefinition {
    OrgDefinition {
        id: DEFAULT_DS_TEMPLATE_TEAM_ID.to_string(),
        name: "Data Science Agent Org".to_string(),
        role: "Analytics Coordinator".to_string(),
        agent_id: BUILTIN_DS_AGENT_ID.to_string(),
        description: Some(
            "Built-in Agent Org for SQL analysis, metrics review, data validation, and reporting."
                .to_string(),
        ),
        plan_approval_policy: PlanApprovalPolicy::Coordinator,
        members: vec![
            flat_member(
                "ds-analyst",
                "Analyst",
                "Explores datasets, defines metrics, and answers analytical questions",
                BUILTIN_DS_AGENT_ID,
            ),
            flat_member(
                "ds-engineer",
                "Data Engineer",
                "Checks data quality, joins, schemas, and reproducibility",
                BUILTIN_DS_AGENT_ID,
            ),
            flat_member(
                "ds-visualizer",
                "Visualizer",
                "Turns findings into concise tables, charts, and decision-ready summaries",
                BUILTIN_DS_AGENT_ID,
            ),
        ],
        additional_task_graph_writer_member_ids: Vec::new(),
        member_communication_links: Vec::new(),
    }
    .with_all_member_links()
}

fn load_from_disk(path: &Path) -> LoadOutcome {
    if !path.exists() {
        return LoadOutcome::Missing;
    }
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) => {
            return LoadOutcome::Blocked(format!("Failed to read {}: {}", path.display(), err));
        }
    };
    let value: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(err) => {
            return LoadOutcome::Blocked(format!("Failed to parse {}: {}", path.display(), err));
        }
    };

    // The legacy sniff only runs on version-less/array files. A file that
    // declares the current schema version is authoritative: nested
    // `children`/`hierarchyMode` keys inside field values must never
    // trigger a destructive backup-and-reset of a valid v2 file.
    let declared_current_version = value
        .as_object()
        .and_then(|object| object.get("schemaVersion"))
        .and_then(serde_json::Value::as_u64)
        == Some(u64::from(AGENT_ORGS_FILE_SCHEMA_VERSION));
    if !declared_current_version && (value.is_array() || contains_legacy_hierarchy(&value)) {
        match backup_legacy_file(path, &bytes) {
            Ok(backup_path) => {
                warn!(
                    "[agent-orgs] Backed up legacy recursive definitions to {} before reset",
                    backup_path.display()
                );
                return LoadOutcome::LegacyReset;
            }
            Err(err) => return LoadOutcome::Blocked(err),
        }
    }

    let file: AgentOrgDefinitionsFile = match serde_json::from_value(value) {
        Ok(file) => file,
        Err(err) => {
            return LoadOutcome::Blocked(format!(
                "Unrecognized Agent Org definitions file {}: {}",
                path.display(),
                err
            ));
        }
    };
    if file.schema_version != AGENT_ORGS_FILE_SCHEMA_VERSION {
        return LoadOutcome::Blocked(format!(
            "Unsupported Agent Org definitions schema version {} in {}",
            file.schema_version,
            path.display()
        ));
    }

    // Per-definition quarantine: one invalid definition must not block
    // reads and writes of every other org until restart. Invalid entries
    // are preserved verbatim and block only writes touching them.
    let mut orgs: Vec<OrgDefinition> = Vec::with_capacity(file.definitions.len());
    let mut quarantined: Vec<QuarantinedOrgDefinition> = Vec::new();
    let mut seen_ids: HashSet<String> = HashSet::new();
    let mut seen_names: HashSet<String> = HashSet::new();
    for (index, raw) in file.definitions.into_iter().enumerate() {
        let raw_id = raw
            .get("id")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        let raw_name = raw
            .get("name")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        let attempt = serde_json::from_value::<OrgDefinition>(raw.clone())
            .map_err(|err| format!("definitions[{index}] is not a valid Agent Org: {err}"))
            .and_then(|mut org| {
                canonicalize_and_validate_definition(&mut org)?;
                if seen_ids.contains(&org.id) {
                    return Err(format!("Duplicate Agent Org id '{}'", org.id));
                }
                if seen_names.contains(&org.name.to_lowercase()) {
                    return Err(format!("Duplicate Agent Org name '{}'", org.name));
                }
                Ok(org)
            });
        match attempt {
            Ok(org) => {
                seen_ids.insert(org.id.clone());
                seen_names.insert(org.name.to_lowercase());
                orgs.push(org);
            }
            Err(error) => quarantined.push(QuarantinedOrgDefinition {
                id: raw_id,
                name: raw_name,
                error: format!(
                    "{error}. Fix the entry in {} and restart the app to restore it.",
                    path.display()
                ),
                raw,
            }),
        }
    }
    info!(
        "[agent-orgs] Loaded {} definitions from {} ({} quarantined)",
        orgs.len(),
        path.display(),
        quarantined.len()
    );
    LoadOutcome::Loaded { orgs, quarantined }
}

fn contains_legacy_hierarchy(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Object(object) => {
            object.contains_key("children")
                || object.contains_key("hierarchyMode")
                || object.values().any(contains_legacy_hierarchy)
        }
        serde_json::Value::Array(values) => values.iter().any(contains_legacy_hierarchy),
        _ => false,
    }
}

fn backup_legacy_file(path: &Path, bytes: &[u8]) -> Result<PathBuf, String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| {
            format!(
                "System clock error while backing up legacy definitions: {}",
                err
            )
        })?
        .as_millis();
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("agent-orgs.json");
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    for suffix in 0..1000u16 {
        let suffix_text = if suffix == 0 {
            String::new()
        } else {
            format!("-{}", suffix)
        };
        let backup_path = parent.join(format!(
            "{}.legacy-{}{}.bak",
            file_name, timestamp, suffix_text
        ));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&backup_path)
        {
            Ok(mut file) => {
                file.write_all(bytes)
                    .and_then(|_| file.sync_all())
                    .map_err(|err| {
                        format!(
                            "Failed to write legacy Agent Org backup {}: {}",
                            backup_path.display(),
                            err
                        )
                    })?;
                return Ok(backup_path);
            }
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => {
                return Err(format!(
                    "Failed to create legacy Agent Org backup {}: {}",
                    backup_path.display(),
                    err
                ));
            }
        }
    }
    Err("Could not allocate a unique legacy Agent Org backup path".to_string())
}

fn save_to_disk(
    path: &Path,
    orgs: &[OrgDefinition],
    quarantined: &[QuarantinedOrgDefinition],
) -> Result<(), String> {
    let mut definitions = Vec::with_capacity(orgs.len() + quarantined.len());
    for org in orgs {
        definitions.push(
            serde_json::to_value(org)
                .map_err(|err| format!("Failed to encode Agent Org '{}': {}", org.name, err))?,
        );
    }
    // Quarantined definitions round-trip verbatim: a save of the valid
    // orgs must never destroy an entry the user still needs to repair.
    for entry in quarantined {
        definitions.push(entry.raw.clone());
    }
    let file = AgentOrgDefinitionsFile {
        schema_version: AGENT_ORGS_FILE_SCHEMA_VERSION,
        definitions,
    };
    let content = serde_json::to_vec_pretty(&file)
        .map_err(|err| format!("Failed to serialize Agent Org definitions: {}", err))?;
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)
        .map_err(|err| format!("Failed to create Agent Org directory: {}", err))?;
    let mut temp = tempfile::Builder::new()
        .prefix(".agent-orgs-")
        .suffix(".tmp")
        .tempfile_in(parent)
        .map_err(|err| {
            format!(
                "Failed to create temp file in {}: {}",
                parent.display(),
                err
            )
        })?;
    let temp_path = temp.path().to_path_buf();
    let write_result = (|| -> Result<(), String> {
        temp.write_all(&content)
            .and_then(|_| temp.as_file().sync_all())
            .map_err(|err| format!("Failed to sync {}: {}", temp_path.display(), err))?;
        temp.persist(path).map_err(|err| {
            format!(
                "Failed to atomically replace {}: {}",
                path.display(),
                err.error
            )
        })?;
        if let Ok(directory) = File::open(parent) {
            let _ = directory.sync_all();
        }
        Ok(())
    })();
    write_result?;
    info!(
        "[agent-orgs] Saved {} definitions to {} ({} quarantined preserved)",
        orgs.len(),
        path.display(),
        quarantined.len()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_member(member_id: &str) -> FlatOrgMember {
        flat_member(member_id, member_id, "member", BUILTIN_SDE_AGENT_ID)
    }

    fn custom_org(member_ids: &[&str]) -> OrgDefinition {
        OrgDefinition {
            id: "custom-org".to_string(),
            name: "Custom Org".to_string(),
            role: "Coordinator".to_string(),
            agent_id: BUILTIN_SDE_AGENT_ID.to_string(),
            description: None,
            plan_approval_policy: PlanApprovalPolicy::Coordinator,
            members: member_ids.iter().map(|id| test_member(id)).collect(),
            additional_task_graph_writer_member_ids: Vec::new(),
            member_communication_links: Vec::new(),
        }
        .with_all_member_links()
    }

    #[test]
    fn all_member_links_materializes_every_canonical_pair() {
        let members = (0..50)
            .map(|index| test_member(&format!("member-{index:02}")))
            .collect::<Vec<_>>();
        let links = all_member_links(&members);
        assert_eq!(links.len(), 1_225);
        assert!(links
            .windows(2)
            .all(|window| window[0].key() < window[1].key()));
    }

    #[test]
    fn validator_canonicalizes_links_and_keeps_writer_independent() {
        let mut org = custom_org(&["alice", "bob", "carol"]);
        org.additional_task_graph_writer_member_ids = vec!["bob".to_string()];
        org.member_communication_links = vec![MemberCommunicationLink {
            member_a_id: "bob".to_string(),
            member_b_id: "alice".to_string(),
        }];
        canonicalize_and_validate_definition(&mut org).expect("valid definition");
        assert_eq!(
            org.member_communication_links,
            vec![MemberCommunicationLink::canonical("alice", "bob")]
        );
        assert_eq!(
            org.additional_task_graph_writer_member_ids,
            vec!["bob".to_string()]
        );
    }

    #[test]
    fn validator_rejects_unknown_self_duplicate_and_too_many_members() {
        let mut org = custom_org(&["alice", "bob"]);
        org.member_communication_links = vec![MemberCommunicationLink::canonical("alice", "alice")];
        assert!(canonicalize_and_validate_definition(&mut org)
            .unwrap_err()
            .contains("self communication"));

        let mut org = custom_org(&["alice", "bob"]);
        org.member_communication_links = vec![
            MemberCommunicationLink::canonical("alice", "bob"),
            MemberCommunicationLink::canonical("bob", "alice"),
        ];
        assert!(canonicalize_and_validate_definition(&mut org)
            .unwrap_err()
            .contains("duplicate communication"));

        let ids = (0..=MAX_AGENT_ORG_MEMBERS)
            .map(|index| format!("member-{index}"))
            .collect::<Vec<_>>();
        let refs = ids.iter().map(String::as_str).collect::<Vec<_>>();
        let mut org = custom_org(&refs);
        assert!(canonicalize_and_validate_definition(&mut org)
            .unwrap_err()
            .contains("between 1 and 50"));

        let mut org = custom_org(&["alice", "bob"]);
        org.additional_task_graph_writer_member_ids = vec!["unknown".to_string()];
        assert!(canonicalize_and_validate_definition(&mut org)
            .unwrap_err()
            .contains("unknown Writer"));

        let mut org = custom_org(&["alice", "bob"]);
        org.member_communication_links =
            vec![MemberCommunicationLink::canonical("alice", "unknown")];
        assert!(canonicalize_and_validate_definition(&mut org)
            .unwrap_err()
            .contains("unknown member"));
    }

    #[test]
    fn validators_reject_untrimmed_member_ids() {
        let mut org = custom_org(&["alice", "bob"]);
        org.members[0].member_id = " alice ".to_string();
        org.member_communication_links.clear();
        assert!(canonicalize_and_validate_definition(&mut org)
            .unwrap_err()
            .contains("whitespace"));

        let org = custom_org(&["alice", "bob"]);
        let mut snapshot = AgentOrgLaunchSnapshot::from(&org);
        snapshot.members[1].member_id = "bob\n".to_string();
        snapshot.member_communication_links.clear();
        assert!(validate_launch_snapshot(&snapshot)
            .unwrap_err()
            .contains("whitespace"));
    }

    #[test]
    fn validator_enforces_definition_byte_limit() {
        let mut org = custom_org(&["alice"]);
        org.description = Some("x".repeat(MAX_AGENT_ORG_DEFINITION_BYTES));
        assert!(canonicalize_and_validate_definition(&mut org)
            .unwrap_err()
            .contains("definition limit"));
    }

    #[test]
    fn snapshot_size_cap_is_enforced_at_serialization_not_structural_validation() {
        let org = custom_org(&["alice"]);
        let mut snapshot = AgentOrgLaunchSnapshot::from(&org);
        snapshot.members[0].role = "x".repeat(MAX_AGENT_ORG_DEFINITION_BYTES);
        validate_launch_snapshot(&snapshot).expect("structural validation has no size cap");
        assert!(serialize_launch_snapshot(&snapshot)
            .unwrap_err()
            .contains("exceeds"));

        let snapshot = AgentOrgLaunchSnapshot::from(&custom_org(&["alice", "bob"]));
        serialize_launch_snapshot(&snapshot).expect("valid snapshot serializes at the write path");
    }

    #[test]
    fn capability_index_uses_canonical_undirected_pairs() {
        let org = custom_org(&["alice", "bob", "carol"]);
        let snapshot = AgentOrgLaunchSnapshot::from(&org);
        let index = AgentOrgCapabilityIndex::from_snapshot(&snapshot);
        assert!(index.members_can_communicate("alice", "bob"));
        assert!(index.members_can_communicate("bob", "alice"));
        assert!(!index.is_additional_writer("alice"));
    }

    #[test]
    fn fifty_member_snapshot_validates_and_compiles_full_capability_index() {
        let ids = (0..50)
            .map(|index| format!("member-{index:02}"))
            .collect::<Vec<_>>();
        let refs = ids.iter().map(String::as_str).collect::<Vec<_>>();
        let mut org = custom_org(&refs);
        org.additional_task_graph_writer_member_ids = vec!["member-49".to_string()];
        let snapshot = AgentOrgLaunchSnapshot::from(&org);
        validate_launch_snapshot(&snapshot).expect("valid frozen 50-Member snapshot");
        assert_eq!(snapshot.member_communication_links.len(), 1_225);

        let index = AgentOrgCapabilityIndex::from_snapshot(&snapshot);
        assert!(index.members_can_communicate("member-00", "member-49"));
        assert!(index.members_can_communicate("member-49", "member-00"));
        assert!(index.is_additional_writer("member-49"));
        assert!(!index.is_additional_writer("member-00"));
    }

    #[test]
    fn launch_snapshot_validator_rejects_noncanonical_or_unknown_capabilities() {
        let org = custom_org(&["alice", "bob"]);
        let mut snapshot = AgentOrgLaunchSnapshot::from(&org);
        snapshot.member_communication_links = vec![MemberCommunicationLink {
            member_a_id: "bob".to_string(),
            member_b_id: "alice".to_string(),
        }];
        assert!(validate_launch_snapshot(&snapshot)
            .unwrap_err()
            .contains("non-canonical"));

        let mut snapshot = AgentOrgLaunchSnapshot::from(&org);
        snapshot.additional_task_graph_writer_member_ids = vec!["unknown".to_string()];
        assert!(validate_launch_snapshot(&snapshot)
            .unwrap_err()
            .contains("unknown Writer"));

        let mut snapshot = AgentOrgLaunchSnapshot::from(&org);
        snapshot.member_communication_links.clear();
        snapshot.additional_task_graph_writer_member_ids = vec!["alice".to_string()];
        validate_launch_snapshot(&snapshot).expect("Writer does not imply a communication link");
        let index = AgentOrgCapabilityIndex::from_snapshot(&snapshot);
        assert!(index.is_additional_writer("alice"));
        assert!(!index.members_can_communicate("alice", "bob"));
    }

    #[test]
    fn trusted_settings_insert_materializes_default_connectivity_updates_keep_links() {
        let _sandbox = test_helpers::test_env::sandbox();
        let actor = crate::definitions::commands::TrustedAgentOrgSettingsActor::for_test;
        let store = AgentOrgsStore::new();
        let mut org = custom_org(&["alice", "bob", "carol"]);
        org.id = "trusted-org".to_string();
        org.name = "Trusted Org".to_string();
        org.member_communication_links.clear();

        let saved = store
            .save_trusted_settings(org, actor())
            .expect("insert new team");
        assert_eq!(
            saved.member_communication_links.len(),
            3,
            "a new multi-member team with no links gets full connectivity"
        );

        let mut updated = saved.clone();
        let removed_link = MemberCommunicationLink::canonical("alice", "bob");
        updated
            .member_communication_links
            .retain(|link| *link != removed_link);
        let saved = store
            .save_trusted_settings(updated, actor())
            .expect("update team");
        assert_eq!(
            saved.member_communication_links.len(),
            2,
            "an update keeps the caller's links verbatim"
        );
        assert!(!saved.member_communication_links.contains(&removed_link));

        let restarted = AgentOrgsStore::new();
        assert!(
            !restarted
                .get("trusted-org")
                .expect("team after boot")
                .member_communication_links
                .contains(&removed_link),
            "a deliberate link deletion survives restart"
        );
    }

    #[test]
    fn boot_reconcile_preserves_user_edits_on_default_teams() {
        let _sandbox = test_helpers::test_env::sandbox();
        let store = AgentOrgsStore::new();
        let mut org = store
            .get(DEFAULT_SDE_TEMPLATE_TEAM_ID)
            .expect("default SDE team");
        org.description = Some("My customized description".to_string());
        org.plan_approval_policy = PlanApprovalPolicy::User;
        org.members[0].name = "Custom Planner".to_string();
        org.members[0].role = "My custom role".to_string();
        org.members[0].runtime_config = Some(OrgMemberRuntimeConfig {
            model: Some("custom-model".to_string()),
            ..Default::default()
        });
        let added = flat_member("my-added", "Added", "member", BUILTIN_SDE_AGENT_ID);
        for member in org.members.clone() {
            org.member_communication_links
                .push(MemberCommunicationLink::canonical(
                    member.member_id,
                    "my-added".to_string(),
                ));
        }
        org.members.push(added);
        org.additional_task_graph_writer_member_ids = vec!["my-added".to_string()];
        store.replace(org).expect("persist user edits");

        let restarted = AgentOrgsStore::new();
        let reloaded = restarted
            .get(DEFAULT_SDE_TEMPLATE_TEAM_ID)
            .expect("default SDE team after boot");
        assert_eq!(
            reloaded.description.as_deref(),
            Some("My customized description")
        );
        assert_eq!(reloaded.plan_approval_policy, PlanApprovalPolicy::User);
        assert_eq!(reloaded.members[0].name, "Custom Planner");
        assert_eq!(reloaded.members[0].role, "My custom role");
        assert_eq!(
            reloaded.members[0]
                .runtime_config
                .as_ref()
                .and_then(|config| config.model.as_deref()),
            Some("custom-model")
        );
        assert!(reloaded
            .members
            .iter()
            .any(|member| member.member_id == "my-added"));
        assert_eq!(
            reloaded.additional_task_graph_writer_member_ids,
            vec!["my-added".to_string()]
        );
    }

    #[test]
    fn boot_reconcile_restores_drifted_agent_id_and_readds_removed_canonical_member() {
        let _sandbox = test_helpers::test_env::sandbox();
        let store = AgentOrgsStore::new();
        let mut org = store
            .get(DEFAULT_SDE_TEMPLATE_TEAM_ID)
            .expect("default SDE team");
        let removed_id = org.members[1].member_id.clone();
        org.members[0].agent_id = BUILTIN_DS_AGENT_ID.to_string();
        org.members.remove(1);
        org.member_communication_links
            .retain(|link| link.member_a_id != removed_id && link.member_b_id != removed_id);
        // A deliberate deletion among surviving members must not be revived.
        let deleted_link = MemberCommunicationLink::canonical(
            org.members[0].member_id.clone(),
            org.members[1].member_id.clone(),
        );
        org.member_communication_links
            .retain(|link| *link != deleted_link);
        store.replace(org.clone()).expect("persist template drift");

        let restarted = AgentOrgsStore::new();
        let reloaded = restarted
            .get(DEFAULT_SDE_TEMPLATE_TEAM_ID)
            .expect("default SDE team after boot");
        assert_eq!(reloaded.members[0].agent_id, BUILTIN_SDE_AGENT_ID);
        let readded = reloaded
            .members
            .iter()
            .find(|member| member.member_id == removed_id)
            .expect("removed canonical member re-added");
        assert_eq!(readded.agent_id, BUILTIN_SDE_AGENT_ID);
        // The re-added member is linked to every other member.
        for member in reloaded
            .members
            .iter()
            .filter(|member| member.member_id != removed_id)
        {
            let link =
                MemberCommunicationLink::canonical(member.member_id.clone(), removed_id.clone());
            assert!(
                reloaded.member_communication_links.contains(&link),
                "re-added member should be linked to '{}'",
                member.member_id
            );
        }
        assert!(
            !reloaded.member_communication_links.contains(&deleted_link),
            "deliberate link deletion among survivors must survive reconcile"
        );
    }

    #[test]
    fn legacy_array_is_backed_up_before_reset() {
        let _sandbox = test_helpers::test_env::sandbox();
        let path = storage_path();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let legacy = br#"[{"id":"old","children":[]}]"#;
        std::fs::write(&path, legacy).unwrap();
        let store = AgentOrgsStore::new();
        assert!(store.get(DEFAULT_SDE_TEMPLATE_TEAM_ID).is_ok());
        let backups = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains("legacy-"))
            .collect::<Vec<_>>();
        assert_eq!(backups.len(), 1);
        assert_eq!(std::fs::read(backups[0].path()).unwrap(), legacy);
    }

    #[test]
    fn corrupt_file_blocks_store_without_overwrite() {
        let _sandbox = test_helpers::test_env::sandbox();
        let path = storage_path();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let invalid = b"{this is not json";
        std::fs::write(&path, invalid).unwrap();
        let store = AgentOrgsStore::new();
        assert!(store.list().is_err());
        assert!(store
            .insert(custom_org(&["alice"]))
            .unwrap_err()
            .contains("restart"));
        assert_eq!(std::fs::read(&path).unwrap(), invalid);
    }

    fn quarantine_fixture_file() -> String {
        // Valid custom org next to a definition that parses as JSON but
        // references an agent definition that does not exist.
        format!(
            r#"{{"schemaVersion":2,"definitions":[
                {{"id":"good-org","name":"Good Org","role":"Coordinator","agentId":"{sde}",
                  "planApprovalPolicy":"coordinator",
                  "members":[{{"memberId":"alice","name":"Alice","role":"member","agentId":"{sde}"}}],
                  "additionalTaskGraphWriterMemberIds":[],"memberCommunicationLinks":[]}},
                {{"id":"quarantined-org","name":"Quarantined Org","role":"Coordinator",
                  "agentId":"user:missing-agent-xyz","planApprovalPolicy":"coordinator",
                  "members":[{{"memberId":"bob","name":"Bob","role":"member","agentId":"user:missing-agent-xyz"}}],
                  "additionalTaskGraphWriterMemberIds":[],"memberCommunicationLinks":[]}}
            ]}}"#,
            sde = BUILTIN_SDE_AGENT_ID
        )
    }

    #[test]
    fn single_invalid_definition_is_quarantined_without_blocking_the_store() {
        let _sandbox = test_helpers::test_env::sandbox();
        let path = storage_path();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, quarantine_fixture_file()).unwrap();

        let store = AgentOrgsStore::new();
        let listed = store.list().expect("valid orgs stay readable");
        assert!(listed.iter().any(|org| org.id == "good-org"));
        assert!(listed.iter().all(|org| org.id != "quarantined-org"));
        assert!(store.get("good-org").is_ok());
        assert!(store
            .get("quarantined-org")
            .unwrap_err()
            .contains("quarantined"));
        let quarantined = store.quarantined_definitions();
        assert_eq!(quarantined.len(), 1);
        assert_eq!(quarantined[0].id.as_deref(), Some("quarantined-org"));
        assert!(quarantined[0].error.contains("missing-agent-xyz"));

        // Writes not touching the quarantined entry work...
        let mut org = custom_org(&["carol"]);
        org.id = "new-org".to_string();
        org.name = "New Org".to_string();
        store.insert(org).expect("unrelated insert succeeds");
        // ...and the quarantined raw definition survives the rewrite.
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("quarantined-org"));
        assert!(text.contains("user:missing-agent-xyz"));

        // Writes touching the quarantined entry are blocked.
        assert!(store
            .remove("quarantined-org")
            .unwrap_err()
            .contains("quarantined"));
        let mut collides = custom_org(&["dave"]);
        collides.id = "another-id".to_string();
        collides.name = "Quarantined Org".to_string();
        assert!(store.insert(collides).unwrap_err().contains("quarantined"));

        // A restart re-quarantines the preserved entry instead of losing it.
        let restarted = AgentOrgsStore::new();
        assert_eq!(restarted.quarantined_definitions().len(), 1);
        assert!(restarted.get("good-org").is_ok());
        assert!(restarted.get("new-org").is_ok());
    }

    #[test]
    fn deletion_guard_fails_safe_for_quarantined_and_blocked_definitions() {
        let _sandbox = test_helpers::test_env::sandbox();
        let path = storage_path();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, quarantine_fixture_file()).unwrap();
        let store = AgentOrgsStore::new();
        let names = store.org_names_referencing_agent("user:missing-agent-xyz");
        assert_eq!(names, vec!["Quarantined Org".to_string()]);
        assert!(store
            .org_names_referencing_agent(BUILTIN_SDE_AGENT_ID)
            .iter()
            .any(|name| name == "Good Org"));

        // A fully unparseable file must also keep the guard fail-safe.
        std::fs::write(&path, b"{corrupt but mentions user:blocked-agent-abc").unwrap();
        let blocked = AgentOrgsStore::new();
        assert!(blocked.list().is_err());
        assert!(!blocked
            .org_names_referencing_agent("user:blocked-agent-abc")
            .is_empty());
        assert!(blocked
            .org_names_referencing_agent("user:agent-not-in-file")
            .is_empty());
    }

    #[test]
    fn v2_file_with_nested_children_key_is_never_legacy_reset() {
        let _sandbox = test_helpers::test_env::sandbox();
        let path = storage_path();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        // A v2 envelope whose definition carries a nested `children` key
        // (e.g. hostile or drifted data). The legacy sniff must not
        // back up and reset the file; the entry is quarantined instead.
        let file = format!(
            r#"{{"schemaVersion":2,"definitions":[
                {{"id":"odd-org","name":"Odd Org","role":"c","agentId":"{sde}",
                  "planApprovalPolicy":"coordinator",
                  "members":[{{"memberId":"m1","name":"M","role":"r","agentId":"{sde}",
                              "children":[{{"id":"nested"}}]}}],
                  "additionalTaskGraphWriterMemberIds":[],"memberCommunicationLinks":[]}}
            ]}}"#,
            sde = BUILTIN_SDE_AGENT_ID
        );
        std::fs::write(&path, &file).unwrap();
        let store = AgentOrgsStore::new();
        assert!(store.list().is_ok(), "v2 file must not be treated as legacy");
        assert_eq!(store.quarantined_definitions().len(), 1);
        let backups = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains("legacy-"))
            .count();
        assert_eq!(backups, 0, "a valid v2 envelope must never be reset");
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(
            text.contains("odd-org"),
            "quarantined definition must survive on disk"
        );
    }

    #[test]
    fn canonical_file_round_trips_stable_ids_grants_and_links() {
        let _sandbox = test_helpers::test_env::sandbox();
        let store = AgentOrgsStore::new();
        let mut org = custom_org(&["alice", "bob", "carol"]);
        org.id = "round-trip-org".to_string();
        org.name = "Round Trip Org".to_string();
        org.additional_task_graph_writer_member_ids = vec!["bob".to_string()];
        org.member_communication_links = vec![MemberCommunicationLink::canonical("alice", "carol")];
        store.insert(org.clone()).expect("persist custom Team");

        let restarted = AgentOrgsStore::new();
        assert_eq!(restarted.get(&org.id).expect("reloaded Team"), org);
    }

    #[test]
    fn failed_disk_commit_does_not_swap_candidate_into_memory() {
        let _sandbox = test_helpers::test_env::sandbox();
        let store = AgentOrgsStore::new();
        let before = store.list().expect("initial definitions");
        let path = storage_path();
        std::fs::remove_file(&path).expect("replace canonical file with failure fixture");
        std::fs::create_dir(&path).expect("directory blocks atomic file rename");

        let mut org = custom_org(&["alice"]);
        org.id = "must-not-commit".to_string();
        org.name = "Must Not Commit".to_string();
        assert!(store.insert(org).is_err());
        assert_eq!(store.list().expect("memory remains readable"), before);
        assert!(
            path.is_dir(),
            "failed save must not replace the disk fixture"
        );
    }
}
