//! Org-level quick actions: a saved "who to call and what to say" preset
//! for existing work items.
//!
//! Invoking one posts an ordinary Discussion comment carrying a typed
//! mention of the target, so routing, coalescing, preview verdicts, audit,
//! and run enqueueing are all inherited from the comment path — there is
//! no separate dispatch engine. Ordering is `use_count DESC` everywhere;
//! actions archive instead of deleting so history stays resolvable, and
//! archival propagates through the org-entity sync carrier.
//!
//! `QuickAction::org_id` is a PM/project organization. `target_kind =
//! "agent_org"` instead addresses the separate, global Agent Org registry;
//! like global agent definitions, those targets are intentionally reusable
//! from every PM org after their registry existence is verified.

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use super::{discussion, DiscussionPostRequest, DiscussionPostResult, WorkItemScope};
use crate::projects::io::helpers::{conn, now_ms};
use crate::projects::types::MentionTarget;

const ORG_SCOPE_MISMATCH: &str = "PM_ERR:ORG_SCOPE_MISMATCH";
const QUICK_ACTION_TARGET_NOT_FOUND: &str = "PM_ERR:QUICK_ACTION_TARGET_NOT_FOUND";
// Agent definitions are global, so a known definition is intentionally
// addressable from every PM org. Keep this list aligned with agent-core's
// compiled builtin registry; user definitions are resolved from its
// authoritative JSON store below.
const BUILTIN_AGENT_IDS: [&str; 11] = [
    "builtin:agent-architect",
    "builtin:base",
    "builtin:sde",
    "builtin:ds",
    "builtin:os",
    "builtin:ai-research",
    "builtin:wingman",
    "builtin:explore",
    "builtin:general",
    "builtin:memory-extractor",
    "builtin:memory-consolidator",
];

fn org_scope_mismatch(entity: &str, id: &str) -> String {
    format!("{ORG_SCOPE_MISMATCH}:{entity}:{id}")
}

#[derive(Deserialize)]
struct AgentRegistryEntry {
    id: String,
    // `name` is required by the authoritative AgentDefinition schema. Keep it
    // in this boundary mirror so a malformed `{ "id": ... }` row is not
    // treated as a resolvable target.
    #[allow(dead_code)]
    name: String,
}

#[derive(Deserialize)]
struct AgentOrgRegistryEntry {
    id: String,
    // Both fields are required by OrgDefinition; other fields have serde
    // defaults and are irrelevant to target identity.
    #[allow(dead_code)]
    name: String,
    #[allow(dead_code)]
    role: String,
    #[serde(rename = "agentId", default)]
    agent_id: String,
}

fn registry_entries<T: serde::de::DeserializeOwned>(
    path: &std::path::Path,
    label: &str,
) -> Result<Vec<T>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(path)
        .map_err(|err| format!("quick action {label} registry read: {err}"))?;
    let raw_entries: Vec<serde_json::Value> = serde_json::from_str(&raw)
        .map_err(|err| format!("quick action {label} registry parse: {err}"))?;
    Ok(raw_entries
        .into_iter()
        .filter_map(|entry| serde_json::from_value(entry).ok())
        .collect())
}

fn target_exists(target_kind: &str, target_id: &str) -> Result<bool, String> {
    match target_kind {
        "agent" => {
            if BUILTIN_AGENT_IDS.contains(&target_id) {
                return Ok(true);
            }
            registry_entries::<AgentRegistryEntry>(
                &app_paths::agent_definitions(),
                "agent definition",
            )
            .map(|entries| entries.into_iter().any(|entry| entry.id == target_id))
        }
        "agent_org" => {
            let org =
                registry_entries::<AgentOrgRegistryEntry>(&app_paths::agent_orgs(), "agent org")?
                    .into_iter()
                    .find(|entry| entry.id == target_id);
            let Some(org) = org else {
                return Ok(false);
            };
            let coordinator_agent_id = org.agent_id.trim();
            Ok(!coordinator_agent_id.is_empty() && target_exists("agent", coordinator_agent_id)?)
        }
        _ => Ok(false),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickAction {
    pub id: String,
    pub org_id: String,
    pub name: String,
    pub description: String,
    pub target_kind: String,
    pub target_id: String,
    pub prompt: String,
    pub use_count: i64,
    pub created_by: Option<String>,
    pub archived_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertQuickActionRequest {
    pub id: Option<String>,
    pub org_id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub target_kind: String,
    pub target_id: String,
    pub prompt: String,
    pub created_by: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvokeQuickActionRequest {
    #[serde(flatten)]
    pub scope: WorkItemScope,
    pub action_id: String,
    pub actor_id: String,
    pub actor_name: String,
}

pub(crate) fn upsert_action(request: UpsertQuickActionRequest) -> Result<QuickAction, String> {
    let name = request.name.trim().to_string();
    let prompt = request.prompt.clone();
    if name.is_empty() || prompt.trim().is_empty() {
        return Err("Quick action name and prompt are required".to_string());
    }
    let target_kind = request.target_kind.trim().to_string();
    if !matches!(target_kind.as_str(), "agent" | "agent_org") {
        return Err("PM_ERR:QUICK_ACTION_TARGET_INVALID".to_string());
    }
    let target_id = request.target_id.trim().to_string();
    if target_id.is_empty() {
        return Err("Quick action target is required".to_string());
    }
    let mut connection = conn()?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| format!("quick action tx: {err}"))?;
    let now = now_ms();
    let id = request
        .id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("wiq_{}", uuid::Uuid::new_v4().simple()));
    let existing_org: Option<String> = tx
        .query_row(
            "SELECT org_id FROM pm_quick_actions WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| format!("quick action store: {err}"))?;
    if existing_org
        .as_deref()
        .is_some_and(|stored_org| stored_org != request.org_id)
    {
        return Err(org_scope_mismatch("quick_action", &id));
    }
    if !target_exists(&target_kind, &target_id)? {
        return Err(format!(
            "{QUICK_ACTION_TARGET_NOT_FOUND}:{target_kind}:{target_id}"
        ));
    }
    tx.execute(
        "INSERT INTO pm_quick_actions (
                 id, org_id, name, description, target_kind, target_id,
                 prompt, use_count, created_by, archived_at, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, NULL, ?9, ?9)
             ON CONFLICT(id) DO UPDATE SET
                 name = excluded.name,
                 description = excluded.description,
                 target_kind = excluded.target_kind,
                 target_id = excluded.target_id,
                 prompt = excluded.prompt,
                 archived_at = NULL,
                 updated_at = excluded.updated_at
             WHERE pm_quick_actions.org_id = excluded.org_id",
        params![
            id,
            request.org_id,
            name,
            request.description.trim(),
            target_kind,
            target_id,
            prompt,
            request.created_by,
            now
        ],
    )
    .map_err(|err| format!("quick action store: {err}"))?;
    crate::sync::collab_bridge::record_quick_actions_touch(&tx, &request.org_id, &id)?;
    let action = read_action(&tx, &request.org_id, &id)?;
    tx.commit()
        .map_err(|err| format!("quick action commit: {err}"))?;
    Ok(action)
}

pub(crate) fn archive_action(org_id: &str, id: &str) -> Result<QuickAction, String> {
    let mut connection = conn()?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| format!("quick action tx: {err}"))?;
    let now = now_ms();
    let changed = tx
        .execute(
            "UPDATE pm_quick_actions
                SET archived_at = COALESCE(archived_at, ?3), updated_at = ?3
              WHERE org_id = ?1 AND id = ?2",
            params![org_id, id, now],
        )
        .map_err(|err| format!("quick action store: {err}"))?;
    if changed == 0 {
        return Err(format!("Quick action '{id}' not found"));
    }
    crate::sync::collab_bridge::record_quick_actions_touch(&tx, org_id, id)?;
    let action = read_action(&tx, org_id, id)?;
    tx.commit()
        .map_err(|err| format!("quick action commit: {err}"))?;
    Ok(action)
}

pub(crate) fn list_actions(org_id: &str) -> Result<Vec<QuickAction>, String> {
    let connection = conn()?;
    let mut statement = connection
        .prepare(
            "SELECT id, org_id, name, description, target_kind, target_id,
                    prompt, use_count, created_by, archived_at, created_at, updated_at
               FROM pm_quick_actions
              WHERE org_id = ?1 AND archived_at IS NULL
              ORDER BY use_count DESC, created_at ASC, id ASC",
        )
        .map_err(|err| format!("quick action store: {err}"))?;
    let actions = statement
        .query_map(params![org_id], decode_action)
        .map_err(|err| format!("quick action store: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("quick action store: {err}"))?;
    Ok(actions)
}

/// Invoke the saved target through the ordinary Discussion persistence and
/// enqueue path. The comment, Run/outbox row, use count, and collaboration
/// touches share one transaction so a failure cannot leave a phantom use or
/// a comment without its dispatch.
pub(crate) fn invoke_action(
    request: InvokeQuickActionRequest,
) -> Result<DiscussionPostResult, String> {
    if request.actor_id.trim().is_empty() {
        return Err("actorId is required".to_string());
    }
    let mut connection = conn()?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| format!("quick action tx: {err}"))?;
    let action = read_action(&tx, &request.scope.org_id, &request.action_id)?;
    if action.archived_at.is_some() {
        return Err(format!("Quick action '{}' is archived", request.action_id));
    }
    if !target_exists(&action.target_kind, action.target_id.trim())? {
        return Err(format!(
            "{QUICK_ACTION_TARGET_NOT_FOUND}:{}:{}",
            action.target_kind, action.target_id
        ));
    }
    let (mention, target) = match action.target_kind.as_str() {
        "agent" => (
            MentionTarget::Agent {
                id: action.target_id.clone(),
            },
            discussion::StartTargetOverride::AgentDefinition(action.target_id.clone()),
        ),
        "agent_org" => (
            MentionTarget::AgentOrg {
                id: action.target_id.clone(),
            },
            discussion::StartTargetOverride::AgentOrg(action.target_id.clone()),
        ),
        other => return Err(format!("unknown quick action target kind '{other}'")),
    };
    let (result, dispatch_ready) = discussion::post_for_quick_action_in_transaction(
        &tx,
        DiscussionPostRequest {
            scope: request.scope,
            comment_id: format!("qa-{}-{}", action.id, uuid::Uuid::new_v4().simple()),
            author_id: request.actor_id,
            author_name: request.actor_name,
            content: action.prompt.clone(),
            mentioned_user_ids: Vec::new(),
            mentions: vec![mention],
            parent_id: None,
            target_session_id: None,
        },
        &target,
    )?;
    tx.execute(
        "UPDATE pm_quick_actions SET use_count = use_count + 1, updated_at = ?3
          WHERE org_id = ?1 AND id = ?2",
        params![action.org_id, action.id, now_ms()],
    )
    .map_err(|err| format!("quick action store: {err}"))?;
    crate::sync::collab_bridge::record_quick_actions_touch(&tx, &action.org_id, &action.id)?;
    tx.commit()
        .map_err(|err| format!("quick action commit: {err}"))?;
    if dispatch_ready {
        crate::projects::events::notify_work_item_dispatch_ready();
    }
    Ok(result)
}

fn read_action(connection: &Connection, org_id: &str, id: &str) -> Result<QuickAction, String> {
    connection
        .query_row(
            "SELECT id, org_id, name, description, target_kind, target_id,
                    prompt, use_count, created_by, archived_at, created_at, updated_at
               FROM pm_quick_actions
              WHERE org_id = ?1 AND id = ?2",
            params![org_id, id],
            decode_action,
        )
        .map_err(|err| format!("quick action store: {err}"))
}

fn decode_action(row: &rusqlite::Row<'_>) -> rusqlite::Result<QuickAction> {
    Ok(QuickAction {
        id: row.get(0)?,
        org_id: row.get(1)?,
        name: row.get(2)?,
        description: row.get(3)?,
        target_kind: row.get(4)?,
        target_id: row.get(5)?,
        prompt: row.get(6)?,
        use_count: row.get(7)?,
        created_by: row.get(8)?,
        archived_at: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

/// Every action (archived included) so removals propagate.
pub(crate) fn export_actions(
    connection: &Connection,
    org_id: &str,
) -> Result<Vec<QuickAction>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, org_id, name, description, target_kind, target_id,
                    prompt, use_count, created_by, archived_at, created_at, updated_at
               FROM pm_quick_actions
              WHERE org_id = ?1
              ORDER BY created_at ASC, id ASC",
        )
        .map_err(|err| format!("quick action export: {err}"))?;
    let actions = statement
        .query_map(params![org_id], decode_action)
        .map_err(|err| format!("quick action export: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("quick action export: {err}"))?;
    Ok(actions)
}

/// Apply org-wide quick actions carried on a pulled entity snapshot.
/// `use_count` merges by MAX so popularity ordering survives both sides.
pub(crate) fn validate_wire_actions(
    connection: &Connection,
    org_id: &str,
    payload: &serde_json::Value,
) -> Result<Vec<QuickAction>, String> {
    let Some(raw) = payload.get("quickActions") else {
        return Ok(Vec::new());
    };
    let actions: Vec<QuickAction> =
        serde_json::from_value(raw.clone()).map_err(|err| format!("quick action wire: {err}"))?;
    let mut owned = Vec::new();
    for action in actions {
        if action.org_id != org_id {
            return Err(org_scope_mismatch("quick_action", &action.id));
        }
        if action.name.trim().is_empty() || action.prompt.trim().is_empty() {
            return Err(format!("PM_ERR:QUICK_ACTION_INVALID:{}", action.id));
        }
        if !matches!(action.target_kind.as_str(), "agent" | "agent_org")
            || action.target_id.trim().is_empty()
        {
            return Err(format!("PM_ERR:QUICK_ACTION_TARGET_INVALID:{}", action.id));
        }
        let stored_org: Option<String> = connection
            .query_row(
                "SELECT org_id FROM pm_quick_actions WHERE id = ?1",
                params![action.id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|err| format!("quick action watermark: {err}"))?;
        if stored_org.as_deref().is_some_and(|stored| stored != org_id) {
            continue;
        }
        owned.push(action);
    }
    Ok(owned)
}

pub(crate) fn apply_wire_actions(
    connection: &Connection,
    org_id: &str,
    payload: &serde_json::Value,
) -> Result<(), String> {
    let actions = validate_wire_actions(connection, org_id, payload)?;
    for action in actions {
        if !target_exists(&action.target_kind, action.target_id.trim())? {
            continue;
        }
        let local_updated_at: Option<i64> = connection
            .query_row(
                "SELECT updated_at FROM pm_quick_actions WHERE id = ?1",
                params![action.id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|err| format!("quick action watermark: {err}"))?;
        if local_updated_at.is_some_and(|local| local >= action.updated_at) {
            continue;
        }
        if crate::sync::collab_bridge::has_pending_collab_field_path(
            connection,
            org_id,
            &format!("quickActions.{}", action.id),
            "quick action pending-path probe",
        )? {
            continue;
        }
        connection
            .execute(
                "INSERT INTO pm_quick_actions (
                     id, org_id, name, description, target_kind, target_id,
                     prompt, use_count, created_by, archived_at, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                 ON CONFLICT(id) DO UPDATE SET
                     name = excluded.name,
                     description = excluded.description,
                     target_kind = excluded.target_kind,
                     target_id = excluded.target_id,
                     prompt = excluded.prompt,
                     use_count = MAX(pm_quick_actions.use_count, excluded.use_count),
                     archived_at = excluded.archived_at,
                     updated_at = excluded.updated_at
                 WHERE pm_quick_actions.org_id = excluded.org_id
                   AND excluded.updated_at >= pm_quick_actions.updated_at",
                params![
                    action.id,
                    action.org_id,
                    action.name,
                    action.description,
                    action.target_kind,
                    action.target_id,
                    action.prompt,
                    action.use_count,
                    action.created_by,
                    action.archived_at,
                    action.created_at,
                    action.updated_at,
                ],
            )
            .map_err(|err| format!("quick action apply: {err}"))?;
    }
    Ok(())
}
