//! Agent org definitions — CRUD + JSON file persistence.
//!
//! Stores agent organizations (team hierarchies) in `~/.orgii/agent-orgs.json`.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
#[cfg(not(test))]
use std::sync::OnceLock;
use std::sync::{Arc, Mutex};
use tracing::{error, info};

use key_vault::ModelType;

use app_paths::agent_orgs as storage_path;

#[cfg(not(test))]
static PROCESS_STORE: OnceLock<Arc<AgentOrgsStore>> = OnceLock::new();

/// Process-wide shared `AgentOrgsStore` — same singleton contract as
/// `definitions_store()`. Tauri manages this `Arc`; library callers use
/// this accessor instead of constructing ad-hoc stores that re-read the
/// JSON file per call. Test builds return a fresh store per call for
/// `ORGII_HOME` tempdir isolation.
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

// ── Types ──

pub const CLI_AGENT_ORG_REFERENCE_PREFIX: &str = "cli:";

pub fn parse_cli_agent_org_reference(agent_id: &str) -> Option<ModelType> {
    let raw = agent_id
        .trim()
        .strip_prefix(CLI_AGENT_ORG_REFERENCE_PREFIX)?
        .trim();
    let model_type = ModelType::from_str(raw)?;
    if model_type.is_cli_agent() {
        Some(model_type)
    } else {
        None
    }
}

pub fn is_cli_agent_org_reference(agent_id: &str) -> bool {
    parse_cli_agent_org_reference(agent_id).is_some()
}

/// How the hierarchy implied by `OrgMember.children` is interpreted at
/// runtime. Wired through to the Agent Org runtime + LLM system prompt.
///
/// - `Flat`: hierarchy is dropped entirely. Agents see no reports-to
///   structure in their system prompt; routing is unrestricted.
/// - `Soft` (default): hierarchy is shown to agents as an *organizational
///   hint* — they are encouraged to coordinate through their manager but
///   may message any peer directly when appropriate. Routing is unrestricted.
/// - `Strict`: hierarchy is enforced at the routing layer. A member may
///   only message its manager, its direct reports, or the coordinator
///   (always reachable as escape hatch). Sibling-to-sibling sends are
///   rejected with a structured error suggesting escalation.
///
/// Task authority is intentionally stricter than message reachability:
/// the coordinator may manage all tasks; a member may manage itself and its
/// direct reports in `Soft`/`Strict`; a `Flat` member may manage only itself.
/// Therefore Soft peer discussion never implies Soft peer delegation.
///
/// Default is `Soft` for both new orgs and orgs migrated from the
/// previous schema (no `hierarchy_mode` field on disk) — this is the
/// closest match to the prior runtime behaviour, where the LLM saw the
/// indented tree in its prompt but routing was already flat.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum HierarchyMode {
    Flat,
    #[default]
    Soft,
    Strict,
}

/// Who reviews an Agent Org member's submitted planning task.
///
/// The value is snapshotted into each run through `OrgDefinition`, so editing
/// a team never changes the policy of work that is already in progress.
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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgMember {
    pub id: String,
    pub name: String,
    pub role: String,
    pub agent_id: String,
    /// User-editable operating instructions for this participant. These are
    /// captured in the run snapshot so an active run is not changed by later
    /// edits to the saved Agent Org template.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_config: Option<OrgMemberRuntimeConfig>,
    #[serde(default)]
    pub children: Vec<OrgMember>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgDefinition {
    pub id: String,
    pub name: String,
    pub role: String,
    #[serde(default)]
    pub agent_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// User-editable operating instructions for the coordinator participant.
    /// Kept distinct from `role` (a short capability label) and `description`
    /// (a human-facing summary of the team).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    /// How `children` is interpreted at runtime. See `HierarchyMode` doc.
    #[serde(default)]
    pub hierarchy_mode: HierarchyMode,
    /// Who approves plans submitted by members during an Agent Org run.
    #[serde(default)]
    pub plan_approval_policy: PlanApprovalPolicy,
    #[serde(default)]
    pub children: Vec<OrgMember>,
}

impl OrgDefinition {
    /// Count total members (recursive, including root).
    pub fn member_count(&self) -> usize {
        1 + Self::count_recursive(&self.children)
    }

    fn count_recursive(members: &[OrgMember]) -> usize {
        members
            .iter()
            .map(|m| 1 + Self::count_recursive(&m.children))
            .sum()
    }
}

// ── In-memory store ──

pub struct AgentOrgsStore {
    pub(crate) orgs: Mutex<Vec<OrgDefinition>>,
}

impl Default for AgentOrgsStore {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentOrgsStore {
    pub fn new() -> Self {
        let path = storage_path();
        let mut orgs = load_from_disk(&path);
        if ensure_default_template_team(&mut orgs) {
            if let Err(err) = save_to_disk(&path, &orgs) {
                error!("[agent-orgs] Failed to persist default orgs: {}", err);
            }
        }
        Self {
            orgs: Mutex::new(orgs),
        }
    }

    pub fn get(&self, org_id: &str) -> Result<OrgDefinition, String> {
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
        let coordinator_agent_id = org.agent_id.trim();
        if coordinator_agent_id.is_empty() {
            return Err(format!(
                "Agent Org '{}' has no coordinator agent configured",
                org.name
            ));
        }
        Ok(coordinator_agent_id.to_string())
    }

    pub(crate) fn persist(&self, orgs: &[OrgDefinition]) {
        let path = storage_path();
        if let Err(err) = save_to_disk(&path, orgs) {
            error!("[agent-orgs] Failed to persist: {}", err);
        }
    }

    /// Names of orgs that reference `agent_id` (as coordinator or any
    /// member, recursively). Used by `AgentDefinitionsStore::remove` to
    /// refuse deleting agents with dangling org references.
    pub fn org_names_referencing_agent(&self, agent_id: &str) -> Vec<String> {
        fn members_reference(members: &[OrgMember], agent_id: &str) -> bool {
            members
                .iter()
                .any(|m| m.agent_id == agent_id || members_reference(&m.children, agent_id))
        }
        let Ok(orgs) = self.orgs.lock() else {
            return Vec::new();
        };
        orgs.iter()
            .filter(|org| org.agent_id == agent_id || members_reference(&org.children, agent_id))
            .map(|org| org.name.clone())
            .collect()
    }

    /// Validate that every agent referenced by `org` (coordinator + all
    /// members) resolves to a known agent definition or a valid `cli:*`
    /// reference. Write-time enforcement so dangling references fail at
    /// save instead of at launch.
    fn validate_agent_references(org: &OrgDefinition) -> Result<(), String> {
        fn check(
            agent_id: &str,
            where_: &str,
            missing: &mut Vec<String>,
            unsupported_cli: &mut Vec<String>,
        ) {
            let id = agent_id.trim();
            if id.is_empty() {
                return;
            }
            if parse_cli_agent_org_reference(id).is_some() {
                unsupported_cli.push(format!("{} ({})", id, where_));
                return;
            }
            if super::definitions_store().get(id).is_none() {
                missing.push(format!("{} ({})", id, where_));
            }
        }
        fn walk(
            members: &[OrgMember],
            missing: &mut Vec<String>,
            unsupported_cli: &mut Vec<String>,
        ) {
            for member in members {
                let location = format!("member_id={} name={}", member.id, member.name);
                check(&member.agent_id, &location, missing, unsupported_cli);
                walk(&member.children, missing, unsupported_cli);
            }
        }
        let mut missing = Vec::new();
        let mut unsupported_cli = Vec::new();
        check(
            &org.agent_id,
            "coordinator",
            &mut missing,
            &mut unsupported_cli,
        );
        walk(&org.children, &mut missing, &mut unsupported_cli);
        if !unsupported_cli.is_empty() {
            return Err(format!(
                "CLI Agent Org participants are not supported yet because they cannot drain the Agent Org inbox or use task tools: {}",
                unsupported_cli.join(", ")
            ));
        }
        if missing.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "Org '{}' references unknown agent definition(s): {}",
                org.name,
                missing.join(", ")
            ))
        }
    }

    /// Insert a new org. The single creation chokepoint: validates agent
    /// references, rejects duplicate ids AND duplicate names
    /// (case-insensitive — the LLM tool path and RPC path previously used
    /// different uniqueness rules).
    pub fn insert(&self, org: OrgDefinition) -> Result<String, String> {
        Self::validate_agent_references(&org)?;
        let id = org.id.clone();
        let snapshot = {
            let mut guard = self
                .orgs
                .lock()
                .map_err(|err| format!("Lock error: {}", err))?;
            if guard.iter().any(|existing| existing.id == id) {
                return Err(format!("Org with id '{}' already exists", id));
            }
            if guard
                .iter()
                .any(|existing| existing.name.eq_ignore_ascii_case(&org.name))
            {
                return Err(format!(
                    "An org named '{}' already exists. Use update to modify it.",
                    org.name
                ));
            }
            guard.push(org);
            guard.clone()
        };
        self.persist(&snapshot);
        Ok(id)
    }

    /// Replace an existing org by id. Validates agent references.
    pub fn replace(&self, org: OrgDefinition) -> Result<(), String> {
        Self::validate_agent_references(&org)?;
        let snapshot = {
            let mut guard = self
                .orgs
                .lock()
                .map_err(|err| format!("Lock error: {}", err))?;
            let idx = guard
                .iter()
                .position(|existing| existing.id == org.id)
                .ok_or_else(|| format!("Org '{}' not found", org.id))?;
            guard[idx] = org;
            guard.clone()
        };
        self.persist(&snapshot);
        Ok(())
    }

    /// Remove an org by id. Returns `true` when an org was removed.
    pub fn remove(&self, org_id: &str) -> Result<bool, String> {
        let (removed, snapshot) = {
            let mut guard = self
                .orgs
                .lock()
                .map_err(|err| format!("Lock error: {}", err))?;
            let len_before = guard.len();
            guard.retain(|org| org.id != org_id);
            (guard.len() < len_before, guard.clone())
        };
        if removed {
            self.persist(&snapshot);
        }
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

        let mut orgs = self
            .orgs
            .lock()
            .map_err(|err| format!("Lock error: {}", err))?;
        let org = orgs
            .iter_mut()
            .find(|existing| existing.id == org_id)
            .ok_or_else(|| format!("Agent Org '{}' not found", org_id))?;

        let context = format!("Agent Org '{}'", org.name);
        apply_overrides_to_member_tree(&mut org.children, overrides, &context)?;
        let snapshot = orgs.clone();
        drop(orgs);
        self.persist(&snapshot);
        Ok(())
    }

    /// Insert (or replace by id) a single `OrgDefinition` into the in-memory
    /// store and flush to disk. Used exclusively by the debug-only
    /// `/agent/test/agent-org/seed` endpoint to set up an Agent Org for E2E
    /// tests without going through the rendered Agent Org wizard.
    ///
    /// Gated behind `cfg(debug_assertions)` so release builds do not
    /// accidentally expose a write surface that bypasses validation done
    /// elsewhere (e.g. agent-existence checks, role uniqueness). Tests are
    /// responsible for handing in a self-consistent definition; this method
    /// is a thin store mutation, not a validator.
    #[cfg(debug_assertions)]
    pub fn seed_for_test(&self, def: OrgDefinition) -> Result<(), String> {
        let mut orgs = self
            .orgs
            .lock()
            .map_err(|err| format!("Lock error: {}", err))?;
        if let Some(slot) = orgs.iter_mut().find(|existing| existing.id == def.id) {
            *slot = def;
        } else {
            orgs.push(def);
        }
        let snapshot = orgs.clone();
        drop(orgs);
        self.persist(&snapshot);
        Ok(())
    }
}

/// Apply member launch overrides to an org member tree, erroring on any
/// override that references an unknown member id. SHARED implementation —
/// both the persisted-org path (`apply_member_launch_overrides`) and the
/// run-snapshot path (`session::launch`) call this; they previously held
/// line-for-line copies that could drift.
pub fn apply_overrides_to_member_tree(
    members: &mut [OrgMember],
    overrides: &HashMap<String, OrgMemberLaunchOverride>,
    context_label: &str,
) -> Result<(), String> {
    let mut applied_member_ids = HashSet::new();
    apply_overrides_to_members(members, overrides, &mut applied_member_ids)?;
    let mut unknown_member_ids = overrides
        .keys()
        .filter(|member_id| !applied_member_ids.contains(*member_id))
        .cloned()
        .collect::<Vec<_>>();
    unknown_member_ids.sort();
    if unknown_member_ids.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "{} has no member id(s) for override: {}",
            context_label,
            unknown_member_ids.join(", ")
        ))
    }
}

fn apply_overrides_to_members(
    members: &mut [OrgMember],
    overrides: &HashMap<String, OrgMemberLaunchOverride>,
    applied_member_ids: &mut HashSet<String>,
) -> Result<(), String> {
    for member in members {
        if let Some(member_override) = overrides.get(&member.id) {
            applied_member_ids.insert(member.id.clone());
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
        apply_overrides_to_members(&mut member.children, overrides, applied_member_ids)?;
    }
    Ok(())
}

// ── Built-in default templates ──

const DEFAULT_SDE_TEMPLATE_TEAM_ID: &str = "default:sde-feature-team";
const DEFAULT_DS_TEMPLATE_TEAM_ID: &str = "default:ds-analysis-team";
const BUILTIN_SDE_AGENT_ID: &str = "builtin:sde";
const BUILTIN_DS_AGENT_ID: &str = "builtin:ds";

const LEGACY_DEFAULT_SDE_DESCRIPTION: &str =
    "Stable built-in Agent Org for cross-repo UI reproduction and teammate testing.";
const DEFAULT_SDE_DESCRIPTION: &str = "Adaptive software-delivery team for complex coding work. The Coordinator chooses the smallest useful workflow across repository analysis and planning, implementation, independent review, and risk-based verification.";
const DEFAULT_SDE_COORDINATOR_ROLE: &str =
    "Engineering lead who owns scope, task design, integration, replanning, and final delivery";
const DEFAULT_SDE_COORDINATOR_INSTRUCTIONS: &str = "You are the engineering delivery coordinator. Turn the user's request into the smallest useful, evidence-driven workflow. First understand the repository, constraints, acceptance criteria, and risk. Do not create work for every roster member by habit: use planning for real uncertainty or cross-cutting work, implementation for concrete artifacts, independent review for meaningful correctness risk, and testing proportional to the change. Dependencies must represent real output consumption, not a fixed role order. Keep the task graph adaptable: new evidence may justify a repair task, reassignment, cancellation, or revised dependency. Monitor the durable task board and inbox, resolve blockers, and integrate the final answer only when the run reports completion_ready=true. Coordinate the work; do not impersonate a member or complete its task on its behalf.";
const DEFAULT_SDE_PLANNER_ROLE: &str =
    "Analyzes the repository, constraints, and risks; produces decision-ready implementation plans";
const DEFAULT_SDE_PLANNER_INSTRUCTIONS: &str = "Work only on the planning task assigned to you. Inspect the relevant repository state and turn ambiguity into a decision-ready plan: scope, constraints, acceptance criteria, ordered stages, real dependencies, risks, and verification. Submit the plan through the plan workflow. Do not implement, review, or test adjacent work. Send missing information, blockers, and proposed follow-up work to the coordinator.";
const DEFAULT_SDE_IMPLEMENTER_ROLE: &str =
    "Implements scoped code changes with focused tests and concrete artifacts";
const DEFAULT_SDE_IMPLEMENTER_INSTRUCTIONS: &str = "Own only the implementation task assigned to you. Read its dependencies and approved plan when present, inspect the relevant code, preserve unrelated user changes, and make the smallest complete change that satisfies the acceptance criteria. Add focused tests where useful and report concrete artifacts and verification evidence. Do not review your own work as an independent gate or start adjacent tasks; send discoveries and follow-up proposals to the coordinator.";
const DEFAULT_SDE_REVIEWER_ROLE: &str =
    "Independently reviews actual diffs for correctness, regressions, security, and maintainability";
const DEFAULT_SDE_REVIEWER_INSTRUCTIONS: &str = "Independently review the actual diff or artifact named by your assigned task against the user request, accepted plan, and repository conventions. Prioritize correctness, regressions, security, concurrency, and data-boundary risks before style. Cite concrete files, lines, or behaviors and distinguish blocking findings from suggestions; explicitly say when no actionable issue is found. Do not silently implement fixes unless the coordinator assigns a separate repair task.";
const DEFAULT_SDE_TESTER_ROLE: &str =
    "Runs risk-based tests, builds, lint, and reproductions; reports exact evidence";
const DEFAULT_SDE_TESTER_INSTRUCTIONS: &str = "Verify only the scope assigned to you and consume the upstream artifacts it depends on. Choose focused tests first, then broader build, lint, typecheck, or end-to-end checks in proportion to risk. Reproduce failures and report exact commands, evidence, and whether a failure is caused by the change, the environment, or a known baseline. Do not silently patch defects; return them to the coordinator unless you receive a separate repair task.";

fn ensure_default_template_team(orgs: &mut Vec<OrgDefinition>) -> bool {
    let mut changed = ensure_default_org(
        orgs,
        DEFAULT_SDE_TEMPLATE_TEAM_ID,
        default_sde_template_team,
        should_upgrade_default_sde_template,
    );
    changed |= ensure_default_org(
        orgs,
        DEFAULT_DS_TEMPLATE_TEAM_ID,
        default_ds_template_team,
        should_upgrade_default_ds_template,
    );
    changed
}

fn ensure_default_org(
    orgs: &mut Vec<OrgDefinition>,
    org_id: &str,
    build: fn() -> OrgDefinition,
    should_upgrade: fn(&OrgDefinition) -> bool,
) -> bool {
    let default_template = build();
    if let Some(existing) = orgs.iter_mut().find(|org| org.id == org_id) {
        if !should_upgrade(existing) {
            return false;
        }
        *existing = default_template;
        return true;
    }

    orgs.push(default_template);
    true
}

fn should_upgrade_default_sde_template(org: &OrgDefinition) -> bool {
    is_legacy_default_sde_template(org) || is_previous_default_sde_template(org)
}

fn should_upgrade_default_ds_template(org: &OrgDefinition) -> bool {
    !default_ds_template_team_is_current(org)
}

fn default_ds_template_team_is_current(org: &OrgDefinition) -> bool {
    const DEFAULT_MEMBER_IDS: [&str; 3] = ["ds-analyst", "ds-engineer", "ds-visualizer"];

    org.agent_id == BUILTIN_DS_AGENT_ID
        && org.children.len() == DEFAULT_MEMBER_IDS.len()
        && DEFAULT_MEMBER_IDS.iter().all(|member_id| {
            org.children.iter().any(|member| {
                member.id == *member_id
                    && member.agent_id == BUILTIN_DS_AGENT_ID
                    && member.children.is_empty()
            })
        })
}

/// Recognize only the exact built-in template shipped immediately before
/// participant instructions were configurable. This lets us upgrade the
/// untouched default while preserving any user-customized default team.
fn is_previous_default_sde_template(org: &OrgDefinition) -> bool {
    const PREVIOUS_MEMBERS: [(&str, &str, &str); 4] = [
        ("sde-planner", "Planner", DEFAULT_SDE_PLANNER_ROLE),
        (
            "sde-implementer",
            "Implementer",
            DEFAULT_SDE_IMPLEMENTER_ROLE,
        ),
        ("sde-reviewer", "Reviewer", DEFAULT_SDE_REVIEWER_ROLE),
        ("sde-tester", "Tester", DEFAULT_SDE_TESTER_ROLE),
    ];

    org.name == "Default Agent Org"
        && org.role == DEFAULT_SDE_COORDINATOR_ROLE
        && org.agent_id == BUILTIN_SDE_AGENT_ID
        && org.description.as_deref() == Some(DEFAULT_SDE_DESCRIPTION)
        && org.instructions.is_none()
        && org.hierarchy_mode == HierarchyMode::Soft
        && org.plan_approval_policy == PlanApprovalPolicy::Coordinator
        && org.children.len() == PREVIOUS_MEMBERS.len()
        && PREVIOUS_MEMBERS.iter().all(|(id, name, role)| {
            org.children.iter().any(|member| {
                member.id == *id
                    && member.name == *name
                    && member.role == *role
                    && member.agent_id == BUILTIN_SDE_AGENT_ID
                    && member.instructions.is_none()
                    && member.runtime_config.is_none()
                    && member.children.is_empty()
            })
        })
}

fn is_legacy_default_sde_template(org: &OrgDefinition) -> bool {
    const LEGACY_MEMBERS: [(&str, &str, &str); 4] = [
        (
            "sde-planner",
            "Planner",
            "Breaks down the request and tracks execution state",
        ),
        ("sde-implementer", "Implementer", "Makes the code changes"),
        (
            "sde-reviewer",
            "Reviewer",
            "Reviews correctness, naming, and maintainability",
        ),
        (
            "sde-tester",
            "Tester",
            "Runs verification and reports failures",
        ),
    ];

    org.name == "Default Agent Org"
        && org.role == "Coordinator"
        && org.agent_id == BUILTIN_SDE_AGENT_ID
        && org.description.as_deref() == Some(LEGACY_DEFAULT_SDE_DESCRIPTION)
        && org.instructions.is_none()
        && org.hierarchy_mode == HierarchyMode::Soft
        && org.plan_approval_policy == PlanApprovalPolicy::Coordinator
        && org.children.len() == LEGACY_MEMBERS.len()
        && LEGACY_MEMBERS.iter().all(|(id, name, role)| {
            org.children.iter().any(|member| {
                member.id == *id
                    && member.name == *name
                    && member.role == *role
                    && member.agent_id == BUILTIN_SDE_AGENT_ID
                    && member.instructions.is_none()
                    && member.runtime_config.is_none()
                    && member.children.is_empty()
            })
        })
}

fn default_sde_template_team() -> OrgDefinition {
    OrgDefinition {
        id: DEFAULT_SDE_TEMPLATE_TEAM_ID.to_string(),
        name: "Default Agent Org".to_string(),
        role: DEFAULT_SDE_COORDINATOR_ROLE.to_string(),
        agent_id: BUILTIN_SDE_AGENT_ID.to_string(),
        description: Some(DEFAULT_SDE_DESCRIPTION.to_string()),
        instructions: Some(DEFAULT_SDE_COORDINATOR_INSTRUCTIONS.to_string()),
        hierarchy_mode: HierarchyMode::Soft,
        plan_approval_policy: PlanApprovalPolicy::Coordinator,
        children: vec![
            OrgMember {
                id: "sde-planner".to_string(),
                name: "Planner".to_string(),
                role: DEFAULT_SDE_PLANNER_ROLE.to_string(),
                agent_id: BUILTIN_SDE_AGENT_ID.to_string(),
                instructions: Some(DEFAULT_SDE_PLANNER_INSTRUCTIONS.to_string()),
                runtime_config: None,
                children: Vec::new(),
            },
            OrgMember {
                id: "sde-implementer".to_string(),
                name: "Implementer".to_string(),
                role: DEFAULT_SDE_IMPLEMENTER_ROLE.to_string(),
                agent_id: BUILTIN_SDE_AGENT_ID.to_string(),
                instructions: Some(DEFAULT_SDE_IMPLEMENTER_INSTRUCTIONS.to_string()),
                runtime_config: None,
                children: Vec::new(),
            },
            OrgMember {
                id: "sde-reviewer".to_string(),
                name: "Reviewer".to_string(),
                role: DEFAULT_SDE_REVIEWER_ROLE.to_string(),
                agent_id: BUILTIN_SDE_AGENT_ID.to_string(),
                instructions: Some(DEFAULT_SDE_REVIEWER_INSTRUCTIONS.to_string()),
                runtime_config: None,
                children: Vec::new(),
            },
            OrgMember {
                id: "sde-tester".to_string(),
                name: "Tester".to_string(),
                role: DEFAULT_SDE_TESTER_ROLE.to_string(),
                agent_id: BUILTIN_SDE_AGENT_ID.to_string(),
                instructions: Some(DEFAULT_SDE_TESTER_INSTRUCTIONS.to_string()),
                runtime_config: None,
                children: Vec::new(),
            },
        ],
    }
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
        instructions: None,
        hierarchy_mode: HierarchyMode::Soft,
        plan_approval_policy: PlanApprovalPolicy::Coordinator,
        children: vec![
            OrgMember {
                id: "ds-analyst".to_string(),
                name: "Analyst".to_string(),
                role: "Explores datasets, defines metrics, and answers analytical questions"
                    .to_string(),
                agent_id: BUILTIN_DS_AGENT_ID.to_string(),
                instructions: None,
                runtime_config: None,
                children: Vec::new(),
            },
            OrgMember {
                id: "ds-engineer".to_string(),
                name: "Data Engineer".to_string(),
                role: "Checks data quality, joins, schemas, and reproducibility".to_string(),
                agent_id: BUILTIN_DS_AGENT_ID.to_string(),
                instructions: None,
                runtime_config: None,
                children: Vec::new(),
            },
            OrgMember {
                id: "ds-visualizer".to_string(),
                name: "Visualizer".to_string(),
                role: "Turns findings into concise tables, charts, and decision-ready summaries"
                    .to_string(),
                agent_id: BUILTIN_DS_AGENT_ID.to_string(),
                instructions: None,
                runtime_config: None,
                children: Vec::new(),
            },
        ],
    }
}

// ── File I/O ──

fn load_from_disk(path: &std::path::Path) -> Vec<OrgDefinition> {
    if !path.exists() {
        return Vec::new();
    }
    match std::fs::read_to_string(path) {
        Ok(content) => match serde_json::from_str::<Vec<OrgDefinition>>(&content) {
            Ok(orgs) => {
                info!(
                    "[agent-orgs] Loaded {} orgs from {}",
                    orgs.len(),
                    path.display()
                );
                orgs
            }
            Err(err) => {
                error!("[agent-orgs] Failed to parse {}: {}", path.display(), err);
                Vec::new()
            }
        },
        Err(err) => {
            error!("[agent-orgs] Failed to read {}: {}", path.display(), err);
            Vec::new()
        }
    }
}

fn save_to_disk(path: &std::path::Path, orgs: &[OrgDefinition]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create directory: {}", err))?;
    }
    let content = serde_json::to_string_pretty(orgs)
        .map_err(|err| format!("Failed to serialize orgs: {}", err))?;
    std::fs::write(path, content).map_err(|err| format!("Failed to write orgs: {}", err))?;
    info!(
        "[agent-orgs] Saved {} orgs to {}",
        orgs.len(),
        path.display()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn custom_org() -> OrgDefinition {
        OrgDefinition {
            id: "custom-org".to_string(),
            name: "Custom Org".to_string(),
            role: "Coordinator".to_string(),
            agent_id: "builtin:sde".to_string(),
            description: None,
            instructions: None,
            hierarchy_mode: HierarchyMode::Soft,
            plan_approval_policy: PlanApprovalPolicy::Coordinator,
            children: Vec::new(),
        }
    }

    #[test]
    fn new_persists_default_org_when_file_is_missing() {
        let _sandbox = test_helpers::test_env::sandbox();

        let store = AgentOrgsStore::new();
        let sde_org = store
            .get(DEFAULT_SDE_TEMPLATE_TEAM_ID)
            .expect("default SDE Agent Org should be available");
        let ds_org = store
            .get(DEFAULT_DS_TEMPLATE_TEAM_ID)
            .expect("default DS Agent Org should be available");
        assert_eq!(sde_org.name, "Default Agent Org");
        assert!(sde_org.instructions.is_some());
        assert!(sde_org
            .children
            .iter()
            .all(|member| member.instructions.is_some()));
        assert_eq!(ds_org.name, "Data Science Agent Org");

        let persisted = load_from_disk(&storage_path());
        assert!(persisted
            .iter()
            .any(|org| org.id == DEFAULT_SDE_TEMPLATE_TEAM_ID));
        assert!(persisted
            .iter()
            .any(|org| org.id == DEFAULT_DS_TEMPLATE_TEAM_ID));
    }

    #[test]
    fn participant_instructions_round_trip_on_the_camel_case_wire_shape() {
        let org = default_sde_template_team();
        let wire = serde_json::to_value(&org).expect("serialize default org");
        assert_eq!(
            wire.get("instructions").and_then(serde_json::Value::as_str),
            Some(DEFAULT_SDE_COORDINATOR_INSTRUCTIONS)
        );
        assert_eq!(
            wire.pointer("/children/0/instructions")
                .and_then(serde_json::Value::as_str),
            Some(DEFAULT_SDE_PLANNER_INSTRUCTIONS)
        );

        let decoded: OrgDefinition =
            serde_json::from_value(wire).expect("deserialize org instructions");
        assert_eq!(
            decoded.instructions.as_deref(),
            Some(DEFAULT_SDE_COORDINATOR_INSTRUCTIONS)
        );
        assert_eq!(
            decoded.children[0].instructions.as_deref(),
            Some(DEFAULT_SDE_PLANNER_INSTRUCTIONS)
        );
    }

    #[test]
    fn saved_orgs_without_instructions_remain_backward_compatible() {
        let legacy_wire = serde_json::json!({
            "id": "old-org",
            "name": "Old Org",
            "role": "Coordinator",
            "agentId": "builtin:sde",
            "children": [{
                "id": "old-worker",
                "name": "Worker",
                "role": "implementer",
                "agentId": "builtin:sde",
                "children": []
            }]
        });

        let decoded: OrgDefinition =
            serde_json::from_value(legacy_wire).expect("read old org without instructions");
        assert!(decoded.instructions.is_none());
        assert!(decoded.children[0].instructions.is_none());
    }

    #[test]
    fn new_backfills_default_org_when_user_file_already_exists() {
        let _sandbox = test_helpers::test_env::sandbox();
        let path = storage_path();
        save_to_disk(&path, &[custom_org()]).expect("seed custom org file");

        let store = AgentOrgsStore::new();
        assert!(store.get("custom-org").is_ok());
        assert!(store.get(DEFAULT_SDE_TEMPLATE_TEAM_ID).is_ok());
        assert!(store.get(DEFAULT_DS_TEMPLATE_TEAM_ID).is_ok());

        let persisted = load_from_disk(&path);
        assert!(persisted.iter().any(|org| org.id == "custom-org"));
        assert!(persisted
            .iter()
            .any(|org| org.id == DEFAULT_SDE_TEMPLATE_TEAM_ID));
        assert!(persisted
            .iter()
            .any(|org| org.id == DEFAULT_DS_TEMPLATE_TEAM_ID));
    }

    #[test]
    fn new_preserves_a_user_customized_default_org_structure() {
        let _sandbox = test_helpers::test_env::sandbox();
        let path = storage_path();
        let mut customized_default = custom_org();
        customized_default.id = DEFAULT_SDE_TEMPLATE_TEAM_ID.to_string();
        customized_default.name = "My Minimal Default Org".to_string();
        save_to_disk(&path, &[customized_default]).expect("seed customized default org");

        let store = AgentOrgsStore::new();
        let org = store
            .get(DEFAULT_SDE_TEMPLATE_TEAM_ID)
            .expect("default org should remain available");
        assert_eq!(org.name, "My Minimal Default Org");
        assert!(org.children.is_empty());
    }

    #[test]
    fn new_upgrades_legacy_default_sde_template() {
        let _sandbox = test_helpers::test_env::sandbox();
        let path = storage_path();
        let mut legacy = default_sde_template_team();
        legacy.role = "Coordinator".to_string();
        legacy.description = Some(LEGACY_DEFAULT_SDE_DESCRIPTION.to_string());
        legacy.instructions = None;
        for member in &mut legacy.children {
            member.instructions = None;
            member.role = match member.id.as_str() {
                "sde-planner" => "Breaks down the request and tracks execution state",
                "sde-implementer" => "Makes the code changes",
                "sde-reviewer" => "Reviews correctness, naming, and maintainability",
                "sde-tester" => "Runs verification and reports failures",
                other => panic!("unexpected default member: {other}"),
            }
            .to_string();
        }
        assert!(is_legacy_default_sde_template(&legacy));
        save_to_disk(&path, &[legacy]).expect("seed legacy default org");

        let store = AgentOrgsStore::new();
        let org = store
            .get(DEFAULT_SDE_TEMPLATE_TEAM_ID)
            .expect("upgraded default org should remain available");

        assert_eq!(
            org.role,
            "Engineering lead who owns scope, task design, integration, replanning, and final delivery"
        );
        assert_eq!(org.description.as_deref(), Some(DEFAULT_SDE_DESCRIPTION));
        assert_eq!(
            org.children
                .iter()
                .find(|member| member.id == "sde-reviewer")
                .map(|member| member.role.as_str()),
            Some(
                "Independently reviews actual diffs for correctness, regressions, security, and maintainability"
            )
        );
        assert!(!should_upgrade_default_sde_template(&org));
    }

    #[test]
    fn new_upgrades_previous_untouched_default_to_configurable_instructions() {
        let _sandbox = test_helpers::test_env::sandbox();
        let path = storage_path();
        let mut previous = default_sde_template_team();
        previous.instructions = None;
        for member in &mut previous.children {
            member.instructions = None;
        }
        assert!(is_previous_default_sde_template(&previous));
        save_to_disk(&path, &[previous]).expect("seed previous default org");

        let store = AgentOrgsStore::new();
        let org = store
            .get(DEFAULT_SDE_TEMPLATE_TEAM_ID)
            .expect("upgraded default org should remain available");

        assert_eq!(
            org.instructions.as_deref(),
            Some(DEFAULT_SDE_COORDINATOR_INSTRUCTIONS)
        );
        assert!(org
            .children
            .iter()
            .all(|member| member.instructions.is_some()));
        assert!(!should_upgrade_default_sde_template(&org));
    }

    #[test]
    fn new_preserves_customizations_to_structurally_valid_default_org() {
        let _sandbox = test_helpers::test_env::sandbox();
        let path = storage_path();
        let mut customized = default_sde_template_team();
        customized.instructions = None;
        for member in &mut customized.children {
            member.instructions = None;
        }
        customized.name = "My Product Engineering Team".to_string();
        customized.children[0].role = "Domain-specific architecture planner".to_string();
        save_to_disk(&path, &[customized]).expect("seed customized default org");

        let store = AgentOrgsStore::new();
        let org = store
            .get(DEFAULT_SDE_TEMPLATE_TEAM_ID)
            .expect("customized default org should remain available");

        assert_eq!(org.name, "My Product Engineering Team");
        assert_eq!(org.children[0].role, "Domain-specific architecture planner");
        assert!(org.instructions.is_none());
    }

    #[test]
    fn validation_rejects_cli_member_with_member_id_and_transport() {
        let _sandbox = test_helpers::test_env::sandbox();
        let mut org = custom_org();
        org.children.push(OrgMember {
            id: "cli-worker".to_string(),
            name: "Legacy CLI Worker".to_string(),
            role: "worker".to_string(),
            agent_id: "cli:claude_code".to_string(),
            instructions: None,
            runtime_config: None,
            children: Vec::new(),
        });

        let error = AgentOrgsStore::validate_agent_references(&org)
            .expect_err("CLI Agent Org members must be rejected at save time");
        assert!(error.contains("member_id=cli-worker"), "{error}");
        assert!(error.contains("cli:claude_code"), "{error}");
    }
}
