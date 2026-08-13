//! Context resolver (`orgtrack/v1` §8.2, frozen decisions §1/§2/§7).
//!
//! Trusted-local resolution order per field: explicit CLI flags →
//! `ORGII_*` environment → the workspace manifest
//! (`.orgii/orgtrack.json` in the working directory). Nothing is ever
//! inferred from the OS username, git owner or last-used actor.
//! Capabilities are never read from flags/env/manifest — they are the
//! intersection of the mode allowlist with actor/org policy (local
//! trusted mode has no org policy service yet, so policy is the
//! identity; the remote authority classes arrive with the hosted mode).

use crate::envelope::{CliError, ErrorCode};
use serde::Serialize;

pub const ENV_MODE: &str = "ORGII_MODE";
pub const ENV_ACTOR: &str = "ORGII_ACTOR";
pub const ENV_SCOPE: &str = "ORGII_SCOPE";
pub const ENV_SESSION_REF: &str = "ORGII_SESSION_REF";
pub const ENV_ORG: &str = "ORGII_ORG";

pub const ALL_CAPABILITIES: &[&str] = &[
    "work.read",
    "work.create",
    "work.update",
    "work.claim",
    "work.transition",
    "work.note",
    "work.relate",
    "routine.read",
    "routine.apply",
    "routine.run",
    "routine.cancel",
    "routine.set_enabled",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProductMode {
    Build,
    Plan,
    Ask,
    Project,
}

impl ProductMode {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "build" => Some(ProductMode::Build),
            "plan" => Some(ProductMode::Plan),
            "ask" => Some(ProductMode::Ask),
            "project" => Some(ProductMode::Project),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            ProductMode::Build => "build",
            ProductMode::Plan => "plan",
            ProductMode::Ask => "ask",
            ProductMode::Project => "project",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActorRef {
    pub kind: String,
    pub id: String,
}

impl ActorRef {
    /// Parse `kind:rest-of-id` (the id itself may contain colons).
    pub fn parse(raw: &str) -> Option<Self> {
        let (kind, id) = raw.split_once(':')?;
        if id.is_empty() {
            return None;
        }
        match kind {
            "human" | "agent" | "service" | "team" => Some(ActorRef {
                kind: kind.to_string(),
                id: id.to_string(),
            }),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRef {
    pub provider: String,
    pub external_id: String,
}

impl SessionRef {
    /// Parse `provider:external-id`.
    pub fn parse(raw: &str) -> Option<Self> {
        let (provider, external_id) = raw.split_once(':')?;
        if provider.is_empty() || external_id.is_empty() {
            return None;
        }
        Some(SessionRef {
            provider: provider.to_string(),
            external_id: external_id.to_string(),
        })
    }
}

#[derive(Debug, serde::Deserialize)]
struct WorkspaceManifest {
    version: u32,
    #[serde(rename = "scopeId")]
    scope_id: Option<String>,
    #[serde(rename = "orgId")]
    org_id: Option<String>,
}

/// Resolved execution context for one CLI invocation.
#[derive(Debug)]
pub struct ExecutionContext {
    pub mode: ProductMode,
    /// v1 local model: the scope id IS the project slug.
    pub scope_id: Option<String>,
    pub org_id: Option<String>,
    pub actor: Option<ActorRef>,
    pub session_ref: Option<SessionRef>,
    pub capabilities: Vec<&'static str>,
}

impl ExecutionContext {
    pub fn capabilities_for(mode: ProductMode) -> Vec<&'static str> {
        // Frozen mode-capability matrix (decisions §2): only Project
        // exposes the mutation surface; every other mode is context-only.
        match mode {
            ProductMode::Project => ALL_CAPABILITIES.to_vec(),
            _ => Vec::new(),
        }
    }

    pub fn require_project_mode(&self, operation: &str) -> Result<(), CliError> {
        if self.mode != ProductMode::Project {
            return Err(CliError::new(
                ErrorCode::ProjectModeRequired,
                format!(
                    "{} is a WorkItem/Routine mutation; current mode is '{}'. Switch the session to Project mode or pass --mode project",
                    operation,
                    self.mode.as_str()
                ),
            )
            .with_details(serde_json::json!({
                "operation": operation,
                "currentMode": self.mode.as_str(),
            })));
        }
        Ok(())
    }

    pub fn require_scope(&self) -> Result<&str, CliError> {
        self.scope_id.as_deref().ok_or_else(|| {
            CliError::new(
                ErrorCode::ContextRequired,
                "No scope resolved: pass --scope, set ORGII_SCOPE, or run inside an initialized workspace (.orgii/orgtrack.json)",
            )
            .with_details(serde_json::json!({ "missing": ["scopeId"] }))
        })
    }

    pub fn require_actor(&self) -> Result<&ActorRef, CliError> {
        self.actor.as_ref().ok_or_else(|| {
            CliError::new(
                ErrorCode::ActorRequired,
                "No actor resolved: pass --actor <kind:id> or set ORGII_ACTOR (actors are never inferred from OS username or git owner)",
            )
            .with_details(serde_json::json!({ "missing": ["actor"] }))
        })
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionMarker {
    session_ref: String,
    actor: String,
    #[serde(default)]
    product_mode: Option<String>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    org: Option<String>,
}

/// Fail-closed session context (design M6): a harness-managed workspace
/// carries `.orgii/agent_session_context.json`, and inside it the CLI
/// locks its identity to the marker — the model cannot act as a human
/// or as another session no matter what flags it types.
fn read_session_marker() -> Option<SessionMarker> {
    let mut dir = std::env::current_dir().ok()?;
    loop {
        let path = dir.join(".orgii/agent_session_context.json");
        if let Ok(raw) = std::fs::read_to_string(&path) {
            return serde_json::from_str(&raw).ok();
        }
        if !dir.pop() {
            return None;
        }
    }
}

fn read_manifest() -> Option<WorkspaceManifest> {
    let path = std::env::current_dir().ok()?.join(".orgii/orgtrack.json");
    let raw = std::fs::read_to_string(path).ok()?;
    let manifest: WorkspaceManifest = serde_json::from_str(&raw).ok()?;
    // `.orgii/` existing is NOT initialization; only a readable manifest
    // with a supported version counts (decisions §7).
    if manifest.version != 1 {
        return None;
    }
    Some(manifest)
}

/// Resolve the context from flags (already extracted by the arg parser),
/// environment, and the workspace manifest — in that order, per field.
pub fn resolve(
    flag_mode: Option<&str>,
    flag_scope: Option<&str>,
    flag_actor: Option<&str>,
    flag_session_ref: Option<&str>,
) -> Result<ExecutionContext, CliError> {
    let manifest = read_manifest();

    let mode_raw = flag_mode
        .map(str::to_string)
        .or_else(|| std::env::var(ENV_MODE).ok())
        .unwrap_or_else(|| "build".to_string());
    let mode = ProductMode::parse(&mode_raw).ok_or_else(|| {
        CliError::new(
            ErrorCode::InvalidArgument,
            format!(
                "Unknown mode '{}'; expected build|plan|ask|project",
                mode_raw
            ),
        )
        .with_details(serde_json::json!({ "field": "--mode", "value": mode_raw }))
    })?;

    let scope_id = flag_scope
        .map(str::to_string)
        .or_else(|| std::env::var(ENV_SCOPE).ok())
        .or_else(|| manifest.as_ref().and_then(|m| m.scope_id.clone()));

    let actor = match flag_actor
        .map(str::to_string)
        .or_else(|| std::env::var(ENV_ACTOR).ok())
    {
        Some(raw) => Some(ActorRef::parse(&raw).ok_or_else(|| {
            CliError::new(
                ErrorCode::InvalidArgument,
                format!(
                    "Invalid actor '{}'; expected <human|agent|service|team>:<id>",
                    raw
                ),
            )
            .with_details(serde_json::json!({ "field": "--actor", "value": raw }))
        })?),
        None => None,
    };

    let session_ref = match flag_session_ref
        .map(str::to_string)
        .or_else(|| std::env::var(ENV_SESSION_REF).ok())
    {
        Some(raw) => Some(SessionRef::parse(&raw).ok_or_else(|| {
            CliError::new(
                ErrorCode::InvalidArgument,
                format!("Invalid session ref '{}'; expected <provider>:<id>", raw),
            )
            .with_details(serde_json::json!({ "field": "--session-ref", "value": raw }))
        })?),
        None => None,
    };

    let marker = read_session_marker();
    let (mode, scope_id, actor, session_ref, marker_org) = if let Some(marker) = marker {
        let marker_actor = ActorRef::parse(&marker.actor).ok_or_else(|| {
            CliError::new(
                ErrorCode::ContextRequired,
                "Session marker is unreadable; relaunch the session",
            )
        })?;
        if let Some(explicit) = &actor {
            if explicit.kind != marker_actor.kind || explicit.id != marker_actor.id {
                return Err(CliError::new(
                    ErrorCode::PermissionDenied,
                    format!(
                        "This workspace is bound to session actor '{}:{}'; --actor/{} may not override it",
                        marker_actor.kind, marker_actor.id, ENV_ACTOR
                    ),
                ));
            }
        }
        let marker_session = SessionRef::parse(&marker.session_ref).ok_or_else(|| {
            CliError::new(
                ErrorCode::ContextRequired,
                "Session marker carries an invalid session ref; relaunch the session",
            )
        })?;
        if let Some(explicit) = &session_ref {
            if explicit.provider != marker_session.provider
                || explicit.external_id != marker_session.external_id
            {
                return Err(CliError::new(
                    ErrorCode::PermissionDenied,
                    "This workspace is bound to another session; --session-ref may not override it",
                ));
            }
        }
        let mode = match marker.product_mode.as_deref().and_then(ProductMode::parse) {
            Some(marker_mode) => marker_mode,
            None => mode,
        };
        let scope_id = scope_id.or(marker.scope);
        (
            mode,
            scope_id,
            Some(marker_actor),
            Some(marker_session),
            marker.org,
        )
    } else {
        (mode, scope_id, actor, session_ref, None)
    };

    let capabilities = ExecutionContext::capabilities_for(mode);
    Ok(ExecutionContext {
        mode,
        scope_id,
        org_id: std::env::var(ENV_ORG)
            .ok()
            .filter(|value| !value.trim().is_empty())
            .or_else(|| manifest.as_ref().and_then(|m| m.org_id.clone()))
            .or(marker_org),
        actor,
        session_ref,
        capabilities,
    })
}

/// Wire shape of `org2 context` (execution-context.schema.json).
pub fn to_wire(context: &ExecutionContext) -> serde_json::Value {
    serde_json::json!({
        "apiVersion": crate::envelope::API_VERSION,
        "mode": context.mode.as_str(),
        "scopeId": context.scope_id,
        "orgId": context.org_id.clone().unwrap_or_else(|| "personal-org".to_string()),
        "actor": context.actor,
        "sessionRef": context.session_ref,
        "runtimeProvider": { "id": "org2", "profiles": ["execution", "provenance"] },
        "activeWorkItemId": serde_json::Value::Null,
        "capabilities": context.capabilities,
    })
}
