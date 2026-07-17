//! Orgtrack Protocol
//!
//! Stable, versioned contracts shared by producers, hook adapters,
//! collectors, stores, and host applications. This crate intentionally has
//! no filesystem, database, Tauri, or vendor-agent dependencies.
//!
//! Deployment details such as original source-database paths and destination
//! store paths are collector configuration. They must never be embedded in a
//! resource-interaction envelope.

use serde::{Deserialize, Serialize};
use std::fmt;

/// Wire/storage version of the resource-interaction contract.
///
/// This version is independent from ORG2's repo-shareable `.orgtrack` export
/// schema and from any collector configuration schema.
pub const RESOURCE_INTERACTION_SCHEMA_VERSION: u32 = 1;

/// Wire/storage version of the session-actor lifecycle contract.
pub const SESSION_ACTOR_SCHEMA_VERSION: u32 = 1;

/// A concrete file resource referenced by one or more interactions.
///
/// `repository_id` is the preferred cross-worktree identity. When a producer
/// cannot provide one, `workspace_path` keeps the resource locally queryable.
/// `repo_relative_path` is slash-normalized and never starts with `/`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileResourceRecord {
    pub schema_version: u32,
    pub resource_id: String,
    pub repository_id: Option<String>,
    pub workspace_path: String,
    pub repo_relative_path: String,
    pub display_path: String,
    pub path_hash: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceAction {
    Read,
    Write,
    Create,
    Delete,
    Rename,
    Search,
}

impl ResourceAction {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
            Self::Create => "create",
            Self::Delete => "delete",
            Self::Rename => "rename",
            Self::Search => "search",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceInteractionOutcome {
    Succeeded,
    Failed,
    Unknown,
}

impl ResourceInteractionOutcome {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceInteractionCaptureMethod {
    Native,
    Hook,
    Reconciled,
}

impl ResourceInteractionCaptureMethod {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Native => "native",
            Self::Hook => "hook",
            Self::Reconciled => "reconciled",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttributionPrecision {
    Unknown,
    SessionOnly,
    Correlated,
    Exact,
}

impl AttributionPrecision {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Unknown => "unknown",
            Self::SessionOnly => "session_only",
            Self::Correlated => "correlated",
            Self::Exact => "exact",
        }
    }
}

/// An immutable fact that a session interacted with a resource.
///
/// Raw prompts, tool output, commands, file contents, and local database paths
/// are deliberately absent. Vendor payloads are normalized before they reach
/// this canonical record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceInteractionRecord {
    pub schema_version: u32,
    pub interaction_id: String,
    pub source: String,
    pub source_session_id: Option<String>,
    pub source_event_id: Option<String>,
    pub session_id: String,
    pub turn_id: Option<String>,
    pub actor_id: Option<String>,
    pub resource_id: String,
    pub action: ResourceAction,
    pub outcome: ResourceInteractionOutcome,
    pub occurred_at: String,
    pub capture_method: ResourceInteractionCaptureMethod,
    pub attribution_precision: AttributionPrecision,
}

/// Versioned, privacy-filtered envelope emitted by producers and hook
/// adapters and accepted by an Orgtrack collector.
///
/// `cwd` is the event's path-resolution base, not an original source DB path
/// and not a destination store path. Unknown fields are rejected so a raw
/// vendor payload cannot silently cross this boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceInteractionEnvelopeV1 {
    pub schema_version: u32,
    pub source: String,
    pub source_session_id: String,
    pub session_id: String,
    pub source_event_id: Option<String>,
    pub turn_id: Option<String>,
    pub actor_id: Option<String>,
    pub cwd: String,
    pub file_path: String,
    pub action: ResourceAction,
    pub outcome: ResourceInteractionOutcome,
    pub occurred_at: String,
    pub attribution_precision: AttributionPrecision,
}

impl ResourceInteractionEnvelopeV1 {
    /// Validate invariants not expressible through Serde alone.
    pub fn validate(&self) -> Result<(), ProtocolValidationError> {
        if self.schema_version != RESOURCE_INTERACTION_SCHEMA_VERSION {
            return Err(ProtocolValidationError::UnsupportedSchemaVersion(
                self.schema_version,
            ));
        }
        for (field, value) in [
            ("source", self.source.as_str()),
            ("sourceSessionId", self.source_session_id.as_str()),
            ("sessionId", self.session_id.as_str()),
            ("cwd", self.cwd.as_str()),
            ("filePath", self.file_path.as_str()),
            ("occurredAt", self.occurred_at.as_str()),
        ] {
            if value.trim().is_empty() {
                return Err(ProtocolValidationError::EmptyRequiredField(field));
            }
        }
        Ok(())
    }
}

/// Lifecycle edge emitted when a session starts or stops a child actor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionActorLifecyclePhase {
    Started,
    Stopped,
}

impl SessionActorLifecyclePhase {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Started => "started",
            Self::Stopped => "stopped",
        }
    }
}

/// Privacy-filtered lifecycle metadata accepted by an Orgtrack collector.
///
/// `transcript_path` is the child actor's local transcript locator. It is
/// needed to open the child transcript, but is local-only metadata: exporters
/// must not include it in a repo-shareable Orgtrack bundle. Prompts, assistant
/// output, commands, and file contents are deliberately absent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionActorLifecycleEnvelopeV1 {
    pub schema_version: u32,
    pub source: String,
    /// Stable vendor root-thread identifier used to merge lifecycle events.
    pub source_session_id: String,
    /// Producer's best-known canonical root session. A local collector may
    /// upgrade a provisional vendor ID to a concrete transcript session ID.
    pub session_id: String,
    pub turn_id: Option<String>,
    pub actor_id: String,
    pub actor_type: Option<String>,
    pub phase: SessionActorLifecyclePhase,
    pub occurred_at: String,
    pub cwd: String,
    pub transcript_path: Option<String>,
}

impl SessionActorLifecycleEnvelopeV1 {
    pub fn validate(&self) -> Result<(), ProtocolValidationError> {
        if self.schema_version != SESSION_ACTOR_SCHEMA_VERSION {
            return Err(ProtocolValidationError::UnsupportedSchemaVersion(
                self.schema_version,
            ));
        }
        for (field, value) in [
            ("source", self.source.as_str()),
            ("sourceSessionId", self.source_session_id.as_str()),
            ("sessionId", self.session_id.as_str()),
            ("actorId", self.actor_id.as_str()),
            ("occurredAt", self.occurred_at.as_str()),
            ("cwd", self.cwd.as_str()),
        ] {
            if value.trim().is_empty() {
                return Err(ProtocolValidationError::EmptyRequiredField(field));
            }
        }
        if self
            .transcript_path
            .as_deref()
            .is_some_and(|path| path.trim().is_empty())
        {
            return Err(ProtocolValidationError::EmptyRequiredField(
                "transcriptPath",
            ));
        }
        Ok(())
    }
}

/// Durable, merged view of one child actor within a root session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionActorRecord {
    pub schema_version: u32,
    pub actor_record_id: String,
    pub source: String,
    /// Stable vendor root-thread identifier used as part of merge identity.
    pub source_session_id: String,
    /// Canonical root session that owns this actor.
    pub session_id: String,
    pub turn_id: Option<String>,
    /// Vendor child-actor identifier.
    pub actor_id: String,
    pub actor_type: Option<String>,
    pub started_at: Option<String>,
    pub stopped_at: Option<String>,
    /// Independently replayable child transcript session, when proven.
    pub transcript_session_id: Option<String>,
    /// Local-only source locator. Never included in repo-shareable exports.
    pub transcript_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtocolValidationError {
    UnsupportedSchemaVersion(u32),
    EmptyRequiredField(&'static str),
}

impl fmt::Display for ProtocolValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedSchemaVersion(version) => {
                write!(
                    formatter,
                    "unsupported Orgtrack protocol schema version: {version}"
                )
            }
            Self::EmptyRequiredField(field) => {
                write!(
                    formatter,
                    "Orgtrack protocol field `{field}` must not be empty"
                )
            }
        }
    }
}

impl std::error::Error for ProtocolValidationError {}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::collections::BTreeSet;

    const FIXTURE: &str = include_str!("../fixtures/resource-interaction-envelope-v1.json");
    const SCHEMA: &str = include_str!("../schemas/resource-interaction-envelope-v1.schema.json");
    const ACTOR_FIXTURE: &str =
        include_str!("../fixtures/session-actor-lifecycle-envelope-v1.json");
    const ACTOR_SCHEMA: &str =
        include_str!("../schemas/session-actor-lifecycle-envelope-v1.schema.json");

    #[test]
    fn checked_in_fixture_round_trips_exactly() {
        let fixture_value: Value = serde_json::from_str(FIXTURE).expect("fixture JSON");
        let envelope: ResourceInteractionEnvelopeV1 =
            serde_json::from_value(fixture_value.clone()).expect("fixture envelope");
        envelope.validate().expect("valid fixture");
        assert_eq!(serde_json::to_value(envelope).unwrap(), fixture_value);
    }

    #[test]
    fn schema_matches_the_serialized_wire_surface() {
        let schema: Value = serde_json::from_str(SCHEMA).expect("schema JSON");
        let properties = schema["properties"]
            .as_object()
            .expect("schema properties")
            .keys()
            .cloned()
            .collect::<BTreeSet<_>>();
        let expected = [
            "schemaVersion",
            "source",
            "sourceSessionId",
            "sessionId",
            "sourceEventId",
            "turnId",
            "actorId",
            "cwd",
            "filePath",
            "action",
            "outcome",
            "occurredAt",
            "attributionPrecision",
        ]
        .into_iter()
        .map(str::to_string)
        .collect::<BTreeSet<_>>();
        assert_eq!(properties, expected);
        assert_eq!(schema["additionalProperties"], json!(false));
        assert_eq!(
            schema["properties"]["action"]["enum"],
            json!(["read", "write", "create", "delete", "rename", "search"])
        );
        assert_eq!(
            schema["properties"]["outcome"]["enum"],
            json!(["succeeded", "failed", "unknown"])
        );
        assert_eq!(
            schema["properties"]["attributionPrecision"]["enum"],
            json!(["unknown", "session_only", "correlated", "exact"])
        );
    }

    #[test]
    fn raw_or_deployment_fields_are_rejected() {
        for forbidden in [
            "prompt",
            "command",
            "toolOutput",
            "fileContent",
            "diff",
            "userEmail",
            "sourceDbPath",
            "storePath",
            "databasePath",
        ] {
            let mut value: Value = serde_json::from_str(FIXTURE).unwrap();
            value
                .as_object_mut()
                .unwrap()
                .insert(forbidden.to_string(), json!("private-sentinel"));
            assert!(
                serde_json::from_value::<ResourceInteractionEnvelopeV1>(value).is_err(),
                "{forbidden} must not cross the protocol boundary"
            );
        }
    }

    #[test]
    fn validation_rejects_wrong_versions_and_blank_identifiers() {
        let mut envelope: ResourceInteractionEnvelopeV1 =
            serde_json::from_str(FIXTURE).expect("fixture envelope");
        envelope.schema_version += 1;
        assert!(matches!(
            envelope.validate(),
            Err(ProtocolValidationError::UnsupportedSchemaVersion(2))
        ));
        envelope.schema_version = RESOURCE_INTERACTION_SCHEMA_VERSION;
        envelope.file_path = "  ".to_string();
        assert_eq!(
            envelope.validate(),
            Err(ProtocolValidationError::EmptyRequiredField("filePath"))
        );
    }

    #[test]
    fn actor_lifecycle_fixture_round_trips_without_private_content() {
        let fixture_value: Value = serde_json::from_str(ACTOR_FIXTURE).expect("fixture JSON");
        let envelope: SessionActorLifecycleEnvelopeV1 =
            serde_json::from_value(fixture_value.clone()).expect("actor lifecycle envelope");
        envelope.validate().expect("valid actor lifecycle fixture");
        assert_eq!(serde_json::to_value(envelope).unwrap(), fixture_value);

        let serialized = fixture_value.to_string();
        for forbidden in [
            "prompt",
            "lastAssistantMessage",
            "toolOutput",
            "fileContent",
        ] {
            assert!(!serialized.contains(forbidden));
        }
    }

    #[test]
    fn actor_lifecycle_schema_matches_the_serialized_wire_surface() {
        let schema: Value = serde_json::from_str(ACTOR_SCHEMA).expect("schema JSON");
        let properties = schema["properties"]
            .as_object()
            .expect("schema properties")
            .keys()
            .cloned()
            .collect::<BTreeSet<_>>();
        let expected = [
            "schemaVersion",
            "source",
            "sourceSessionId",
            "sessionId",
            "turnId",
            "actorId",
            "actorType",
            "phase",
            "occurredAt",
            "cwd",
            "transcriptPath",
        ]
        .into_iter()
        .map(str::to_string)
        .collect::<BTreeSet<_>>();
        assert_eq!(properties, expected);
        assert_eq!(schema["additionalProperties"], json!(false));
    }
}
