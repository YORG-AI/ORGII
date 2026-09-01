//! Flat Agent Team definitions with validated, atomic JSON persistence.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::Write;
use std::path::Path;
#[cfg(not(test))]
use std::sync::OnceLock;
use std::sync::{Arc, Mutex};
use tracing::{error, info, warn};

use app_paths::agent_org_definitions as storage_path;
use key_vault::ModelType;

#[cfg(not(test))]
static PROCESS_STORE: OnceLock<Arc<AgentOrgsStore>> = OnceLock::new();

pub const CLI_AGENT_ORG_REFERENCE_PREFIX: &str = "cli:";
pub const MAX_AGENT_ORG_MEMBERS: usize = 50;
pub const MAX_AGENT_ORG_DEFINITION_BYTES: usize = 256 * 1024;
const AGENT_ORGS_FILE_SCHEMA_VERSION: u32 = 2;
const COORDINATOR_MEMBER_ID: &str = "coordinator";

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
    pub fn member_count(&self) -> usize {
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

    let encoded = serde_json::to_vec(snapshot)
        .map_err(|err| format!("failed to serialize Agent Org launch snapshot: {err}"))?;
    if encoded.len() > MAX_AGENT_ORG_DEFINITION_BYTES {
        return Err(format!(
            "Agent Org launch snapshot exceeds {} bytes",
            MAX_AGENT_ORG_DEFINITION_BYTES
        ));
    }
    Ok(())
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
    definitions: Vec<OrgDefinition>,
}

enum LoadOutcome {
    Missing,
    Loaded(Vec<OrgDefinition>),
    Blocked(String),
}

pub struct AgentOrgsStore {
    pub(crate) orgs: Mutex<Vec<OrgDefinition>>,
    persistence_blocked: Option<String>,
}

impl Default for AgentOrgsStore {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentOrgsStore {
    pub fn new() -> Self {
        retire_legacy_definitions_file();
        let path = storage_path();
        let (mut orgs, persistence_blocked, should_persist) = match load_from_disk(&path) {
            LoadOutcome::Missing => (Vec::new(), None, true),
            LoadOutcome::Loaded(orgs) => (orgs, None, false),
            LoadOutcome::Blocked(message) => {
                error!("[agent-orgs] {}", message);
                (Vec::new(), Some(message), false)
            }
        };

        let defaults_changed =
            persistence_blocked.is_none() && ensure_default_template_team(&mut orgs);
        if persistence_blocked.is_none() && (should_persist || defaults_changed) {
            if let Err(err) = validate_definitions(&orgs).and_then(|_| save_to_disk(&path, &orgs)) {
                error!(
                    "[agent-orgs] Failed to persist canonical definitions: {}",
                    err
                );
                return Self {
                    orgs: Mutex::new(Vec::new()),
                    persistence_blocked: Some(err),
                };
            }
        }

        Self {
            orgs: Mutex::new(orgs),
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
            .ok_or_else(|| format!("Agent Org '{}' not found", org_id))
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

    pub fn org_names_referencing_agent(&self, agent_id: &str) -> Vec<String> {
        let Ok(orgs) = self.orgs.lock() else {
            return Vec::new();
        };
        orgs.iter()
            .filter(|org| {
                org.agent_id == agent_id
                    || org.members.iter().any(|member| member.agent_id == agent_id)
            })
            .map(|org| org.name.clone())
            .collect()
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
        let saved = org.clone();
        self.commit_candidate(|orgs| {
            if let Some(index) = orgs.iter().position(|existing| existing.id == org.id) {
                if orgs.iter().enumerate().any(|(candidate_index, existing)| {
                    candidate_index != index && existing.name.eq_ignore_ascii_case(&org.name)
                }) {
                    return Err(format!("An org named '{}' already exists", org.name));
                }
                orgs[index] = org;
            } else {
                if orgs
                    .iter()
                    .any(|existing| existing.name.eq_ignore_ascii_case(&org.name))
                {
                    return Err(format!("An org named '{}' already exists", org.name));
                }
                orgs.push(org);
            }
            Ok(())
        })?;
        self.get(&saved.id)
    }

    pub fn remove(&self, org_id: &str) -> Result<bool, String> {
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
                "Agent Org definitions are unavailable until the on-disk error is resolved: {}",
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
        save_to_disk(&storage_path(), &candidate)?;
        *guard = candidate;
        Ok(())
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

fn ensure_default_template_team(orgs: &mut Vec<OrgDefinition>) -> bool {
    let mut changed = reconcile_default_org(orgs, default_sde_template_team());
    changed |= reconcile_default_org(orgs, default_ds_template_team());
    changed
}

fn reconcile_default_org(orgs: &mut Vec<OrgDefinition>, mut canonical: OrgDefinition) -> bool {
    let Some(index) = orgs.iter().position(|org| org.id == canonical.id) else {
        orgs.push(canonical);
        return true;
    };
    let existing = &orgs[index];
    let canonical_ids: HashSet<&str> = canonical
        .members
        .iter()
        .map(|member| member.member_id.as_str())
        .collect();
    canonical.additional_task_graph_writer_member_ids = existing
        .additional_task_graph_writer_member_ids
        .iter()
        .filter(|member_id| canonical_ids.contains(member_id.as_str()))
        .cloned()
        .collect();
    let existing_ids: HashSet<&str> = existing
        .members
        .iter()
        .map(|member| member.member_id.as_str())
        .collect();
    let existing_links: HashSet<(String, String)> = existing
        .member_communication_links
        .iter()
        .map(|link| {
            let canonical = MemberCommunicationLink::canonical(
                link.member_a_id.clone(),
                link.member_b_id.clone(),
            );
            (canonical.member_a_id, canonical.member_b_id)
        })
        .collect();
    canonical.member_communication_links = all_member_links(&canonical.members)
        .into_iter()
        .filter(|link| {
            let both_survived = existing_ids.contains(link.member_a_id.as_str())
                && existing_ids.contains(link.member_b_id.as_str());
            !both_survived
                || existing_links.contains(&(link.member_a_id.clone(), link.member_b_id.clone()))
        })
        .collect();

    if orgs[index] == canonical {
        false
    } else {
        orgs[index] = canonical;
        true
    }
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
    let definitions = match parse_definitions_content(&bytes, path) {
        Ok(definitions) => definitions,
        Err(err) => return LoadOutcome::Blocked(err),
    };
    info!(
        "[agent-orgs] Loaded {} definitions from {}",
        definitions.len(),
        path.display()
    );
    LoadOutcome::Loaded(definitions)
}

pub(crate) fn parse_definitions_content(
    bytes: &[u8],
    path: &Path,
) -> Result<Vec<OrgDefinition>, String> {
    let value: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|err| format!("Failed to parse {}: {}", path.display(), err))?;
    let mut file: AgentOrgDefinitionsFile = serde_json::from_value(value).map_err(|err| {
        format!(
            "Unrecognized Agent Org definitions file {}: {}",
            path.display(),
            err
        )
    })?;
    if file.schema_version != AGENT_ORGS_FILE_SCHEMA_VERSION {
        return Err(format!(
            "Unsupported Agent Org definitions schema version {} in {}",
            file.schema_version,
            path.display()
        ));
    }
    canonicalize_and_validate_definitions(&mut file.definitions).map_err(|err| {
        format!(
            "Invalid Agent Org definitions in {}: {}",
            path.display(),
            err
        )
    })?;
    Ok(file.definitions)
}

fn retire_legacy_definitions_file() {
    let legacy_path = app_paths::agent_orgs();
    match std::fs::remove_file(&legacy_path) {
        Ok(()) => info!(
            event = "agent_org_legacy_definitions_retired",
            path = %legacy_path.display(),
            "removed retired Agent Org definitions file"
        ),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => warn!(
            event = "agent_org_legacy_definitions_retirement_failed",
            path = %legacy_path.display(),
            error = %err,
            "could not remove retired Agent Org definitions file; canonical store remains isolated"
        ),
    }
}

fn save_to_disk(path: &Path, orgs: &[OrgDefinition]) -> Result<(), String> {
    let file = AgentOrgDefinitionsFile {
        schema_version: AGENT_ORGS_FILE_SCHEMA_VERSION,
        definitions: orgs.to_vec(),
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
        "[agent-orgs] Saved {} definitions to {}",
        orgs.len(),
        path.display()
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
    fn validator_enforces_definition_byte_limit() {
        let mut org = custom_org(&["alice"]);
        org.description = Some("x".repeat(MAX_AGENT_ORG_DEFINITION_BYTES));
        assert!(canonicalize_and_validate_definition(&mut org)
            .unwrap_err()
            .contains("definition limit"));
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
    fn legacy_live_file_is_deleted_without_parsing_and_new_builtins_are_created() {
        let _sandbox = test_helpers::test_env::sandbox();
        let new_path = storage_path();
        let legacy_path = app_paths::agent_orgs();
        let unrelated_path = legacy_path.parent().unwrap().join("agent-definitions.json");
        std::fs::create_dir_all(new_path.parent().unwrap()).unwrap();
        std::fs::write(&legacy_path, b"not even JSON").unwrap();
        std::fs::write(&unrelated_path, b"unrelated sentinel").unwrap();

        let store = AgentOrgsStore::new();

        assert!(store.get(DEFAULT_SDE_TEMPLATE_TEAM_ID).is_ok());
        assert!(!legacy_path.exists());
        assert!(new_path.exists());
        assert_eq!(
            std::fs::read(unrelated_path).unwrap(),
            b"unrelated sentinel"
        );
    }

    #[test]
    fn downgrade_recreated_legacy_file_is_deleted_without_changing_new_bytes() {
        let _sandbox = test_helpers::test_env::sandbox();
        let store = AgentOrgsStore::new();
        let mut org = custom_org(&["alice", "bob"]);
        org.id = "preserved-org".to_string();
        org.name = "Preserved Org".to_string();
        org.additional_task_graph_writer_member_ids = vec!["alice".to_string()];
        org.member_communication_links = vec![MemberCommunicationLink::canonical("alice", "bob")];
        store.insert(org.clone()).expect("persist canonical Team");
        let new_path = storage_path();
        let new_bytes = std::fs::read(&new_path).expect("canonical bytes");
        let legacy_path = app_paths::agent_orgs();
        let settings_path = app_paths::settings();
        let settings_bytes = br#"{"general":{"theme":"dark"}}"#;
        std::fs::write(&settings_path, settings_bytes).expect("settings sentinel");
        std::fs::write(&legacy_path, br#"[{"id":"downgrade-team"}]"#)
            .expect("downgrade legacy file");

        let restarted = AgentOrgsStore::new();

        assert!(!legacy_path.exists());
        assert_eq!(
            std::fs::read(&new_path).expect("new bytes after cleanup"),
            new_bytes
        );
        assert_eq!(
            std::fs::read(settings_path).expect("settings after Team cleanup"),
            settings_bytes
        );
        assert_eq!(restarted.get(&org.id).expect("preserved Team"), org);
    }

    #[test]
    fn legacy_cleanup_failure_never_redirects_the_store_to_the_old_path() {
        let _sandbox = test_helpers::test_env::sandbox();
        let legacy_path = app_paths::agent_orgs();
        std::fs::create_dir_all(&legacy_path).expect("directory blocks file cleanup");

        let store = AgentOrgsStore::new();

        assert!(legacy_path.is_dir());
        assert!(storage_path().is_file());
        assert!(store.get(DEFAULT_SDE_TEMPLATE_TEAM_ID).is_ok());
    }

    #[test]
    fn invalid_canonical_file_fails_closed_without_overwrite() {
        let _sandbox = test_helpers::test_env::sandbox();
        let path = storage_path();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let invalid = br#"{"schemaVersion":2,"definitions":[{"id":"bad"}]}"#;
        std::fs::write(&path, invalid).unwrap();
        let store = AgentOrgsStore::new();
        assert!(store.list().is_err());
        assert_eq!(std::fs::read(&path).unwrap(), invalid);
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

        let bytes_before = std::fs::read(storage_path()).expect("canonical bytes before restart");
        let restarted = AgentOrgsStore::new();
        assert_eq!(restarted.get(&org.id).expect("reloaded Team"), org);
        assert_eq!(
            std::fs::read(storage_path()).expect("canonical bytes after restart"),
            bytes_before
        );
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
