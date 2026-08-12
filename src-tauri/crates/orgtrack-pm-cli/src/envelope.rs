//! `orgtrack/v1` CLI response envelopes and stable error codes.
//!
//! Byte-for-byte contract lives in `docs/orgtrack-pm-protocol/`
//! (envelope.schema.json + golden fixtures). stdout carries exactly one
//! JSON envelope; diagnostics go to stderr; exit codes follow the frozen
//! error-to-exit table (decisions.md §3).

use serde::Serialize;

pub const API_VERSION: &str = "orgtrack/v1";

/// Stable wire error codes (envelope.schema.json enum, frozen Phase 0).
/// The full enum ships from day one even though some codes only fire in
/// later slices (idempotency, providers) — the vocabulary is the contract.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    InvalidArgument,
    ContextRequired,
    ActorRequired,
    ProjectModeRequired,
    NotFound,
    AlreadyExists,
    RevisionConflict,
    IdempotencyConflict,
    NotReady,
    AlreadyClaimed,
    InvalidTransition,
    ResultSchemaMismatch,
    DependencyCycle,
    ScopeViolation,
    PermissionDenied,
    ProviderUnavailable,
    UnsupportedCapability,
    StoreUnavailable,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::InvalidArgument => "INVALID_ARGUMENT",
            ErrorCode::ContextRequired => "CONTEXT_REQUIRED",
            ErrorCode::ActorRequired => "ACTOR_REQUIRED",
            ErrorCode::ProjectModeRequired => "PROJECT_MODE_REQUIRED",
            ErrorCode::NotFound => "NOT_FOUND",
            ErrorCode::AlreadyExists => "ALREADY_EXISTS",
            ErrorCode::RevisionConflict => "REVISION_CONFLICT",
            ErrorCode::IdempotencyConflict => "IDEMPOTENCY_CONFLICT",
            ErrorCode::NotReady => "NOT_READY",
            ErrorCode::AlreadyClaimed => "ALREADY_CLAIMED",
            ErrorCode::InvalidTransition => "INVALID_TRANSITION",
            ErrorCode::ResultSchemaMismatch => "RESULT_SCHEMA_MISMATCH",
            ErrorCode::DependencyCycle => "DEPENDENCY_CYCLE",
            ErrorCode::ScopeViolation => "SCOPE_VIOLATION",
            ErrorCode::PermissionDenied => "PERMISSION_DENIED",
            ErrorCode::ProviderUnavailable => "PROVIDER_UNAVAILABLE",
            ErrorCode::UnsupportedCapability => "UNSUPPORTED_CAPABILITY",
            ErrorCode::StoreUnavailable => "STORE_UNAVAILABLE",
        }
    }

    /// Frozen error-to-exit mapping (decisions.md §3). PROJECT_MODE_REQUIRED
    /// (5) and PERMISSION_DENIED (8) stay separate so a harness can tell
    /// "switch the mode" from "this actor may never do this".
    pub fn exit_code(self) -> i32 {
        match self {
            ErrorCode::InvalidArgument
            | ErrorCode::ResultSchemaMismatch
            | ErrorCode::DependencyCycle => 2,
            ErrorCode::NotFound | ErrorCode::ContextRequired | ErrorCode::ActorRequired => 3,
            ErrorCode::RevisionConflict
            | ErrorCode::IdempotencyConflict
            | ErrorCode::AlreadyClaimed
            | ErrorCode::AlreadyExists
            | ErrorCode::NotReady
            | ErrorCode::InvalidTransition => 4,
            ErrorCode::ProjectModeRequired => 5,
            ErrorCode::ProviderUnavailable | ErrorCode::StoreUnavailable => 6,
            ErrorCode::UnsupportedCapability => 7,
            ErrorCode::PermissionDenied | ErrorCode::ScopeViolation => 8,
        }
    }

    pub fn retryable(self) -> bool {
        matches!(
            self,
            ErrorCode::RevisionConflict
                | ErrorCode::NotReady
                | ErrorCode::ProviderUnavailable
                | ErrorCode::StoreUnavailable
        )
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

pub struct CliError {
    pub code: ErrorCode,
    pub message: String,
    pub details: serde_json::Value,
}

impl CliError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        CliError {
            code,
            message: message.into(),
            details: serde_json::Value::Null,
        }
    }

    pub fn with_details(mut self, details: serde_json::Value) -> Self {
        self.details = details;
        self
    }

    /// Map the work-service `PM_ERR:` sentinels and common store errors
    /// onto stable wire codes. Everything unrecognized is a store error —
    /// the CLI never invents new codes.
    pub fn from_service(err: String) -> Self {
        use project_management::work_service::error as pm;
        if let Some(rest) = err.strip_prefix(pm::REVISION_CONFLICT) {
            let mut parts = rest.trim_start_matches(':').split(':');
            let expected = parts.next().and_then(|v| v.parse::<i64>().ok());
            let current = parts.next().and_then(|v| v.parse::<i64>().ok());
            return CliError::new(
                ErrorCode::RevisionConflict,
                format!(
                    "resource changed after revision {}",
                    expected.unwrap_or_default()
                ),
            )
            .with_details(serde_json::json!({
                "expectedRevision": expected,
                "currentRevision": current,
            }));
        }
        if let Some(rest) = err.strip_prefix(pm::IDEMPOTENCY_CONFLICT) {
            let mut parts = rest.trim_start_matches(':').split(':');
            let operation = parts.next().unwrap_or_default().to_string();
            let key = parts.next().unwrap_or_default().to_string();
            return CliError::new(
                ErrorCode::IdempotencyConflict,
                format!(
                    "Idempotency key '{}' was already used with a different canonical request",
                    key
                ),
            )
            .with_details(serde_json::json!({
                "idempotencyKey": key,
                "operation": operation,
            }));
        }
        if let Some(rest) = err.strip_prefix(pm::INVALID_TRANSITION) {
            let mut parts = rest.trim_start_matches(':').split(':');
            let from = parts.next().unwrap_or_default().to_string();
            let to = parts.next().unwrap_or_default().to_string();
            return CliError::new(
                ErrorCode::InvalidTransition,
                format!("{} -> {} is not an allowed transition", from, to),
            )
            .with_details(serde_json::json!({ "from": from, "to": to }));
        }
        if let Some(rest) = err.strip_prefix(pm::ALREADY_EXISTS) {
            let short_id = rest.trim_start_matches(':').to_string();
            return CliError::new(
                ErrorCode::AlreadyExists,
                format!(
                    "Work item '{}' already exists; creation refuses to overwrite",
                    short_id
                ),
            )
            .with_details(serde_json::json!({ "shortId": short_id }));
        }
        if err.contains("not found") || err.contains("Not found") {
            return CliError::new(ErrorCode::NotFound, err);
        }
        if err.contains("already has an active execution session")
            || err.contains("already has a running linked session")
            || err.contains("is claimed by another session")
            || err.contains("has no active claim to release")
        {
            return CliError::new(ErrorCode::AlreadyClaimed, err);
        }
        CliError::new(ErrorCode::StoreUnavailable, err)
    }
}

fn request_id() -> String {
    // Monotonic-ish opaque id; not a ULID but unique enough per process.
    format!(
        "req_{}{:04}",
        chrono::Utc::now().format("%Y%m%dT%H%M%S%3f"),
        std::process::id() % 10_000
    )
}

/// Print the success envelope to stdout and return exit code 0.
pub fn emit_success(
    data: serde_json::Value,
    revision: Option<i64>,
    next_cursor: Option<String>,
) -> i32 {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Success {
        api_version: &'static str,
        ok: bool,
        data: serde_json::Value,
        meta: Meta,
    }
    let envelope = Success {
        api_version: API_VERSION,
        ok: true,
        data,
        meta: Meta {
            request_id: request_id(),
            revision,
            next_cursor,
        },
    };
    println!(
        "{}",
        serde_json::to_string_pretty(&envelope).expect("envelope serializes")
    );
    0
}

/// Print the error envelope to stdout and return its mapped exit code.
pub fn emit_error(error: CliError) -> i32 {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct ErrorBody {
        code: &'static str,
        message: String,
        retryable: bool,
        #[serde(skip_serializing_if = "serde_json::Value::is_null")]
        details: serde_json::Value,
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct ErrorEnvelope {
        api_version: &'static str,
        ok: bool,
        error: ErrorBody,
        meta: Meta,
    }
    let exit = error.code.exit_code();
    let envelope = ErrorEnvelope {
        api_version: API_VERSION,
        ok: false,
        error: ErrorBody {
            code: error.code.as_str(),
            message: error.message,
            retryable: error.code.retryable(),
            details: error.details,
        },
        meta: Meta {
            request_id: request_id(),
            revision: None,
            next_cursor: None,
        },
    };
    println!(
        "{}",
        serde_json::to_string_pretty(&envelope).expect("envelope serializes")
    );
    exit
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exit_codes_match_frozen_table() {
        assert_eq!(ErrorCode::InvalidArgument.exit_code(), 2);
        assert_eq!(ErrorCode::ResultSchemaMismatch.exit_code(), 2);
        assert_eq!(ErrorCode::NotFound.exit_code(), 3);
        assert_eq!(ErrorCode::ContextRequired.exit_code(), 3);
        assert_eq!(ErrorCode::RevisionConflict.exit_code(), 4);
        assert_eq!(ErrorCode::AlreadyClaimed.exit_code(), 4);
        assert_eq!(ErrorCode::ProjectModeRequired.exit_code(), 5);
        assert_eq!(ErrorCode::StoreUnavailable.exit_code(), 6);
        assert_eq!(ErrorCode::UnsupportedCapability.exit_code(), 7);
        assert_eq!(ErrorCode::PermissionDenied.exit_code(), 8);
        assert_eq!(ErrorCode::ScopeViolation.exit_code(), 8);
    }

    #[test]
    fn service_sentinels_map_to_wire_codes() {
        let err = CliError::from_service("PM_ERR:REVISION_CONFLICT:7:8".to_string());
        assert_eq!(err.code, ErrorCode::RevisionConflict);
        assert_eq!(err.details["expectedRevision"], 7);
        assert_eq!(err.details["currentRevision"], 8);

        let err = CliError::from_service("PM_ERR:INVALID_TRANSITION:completed:in_progress".into());
        assert_eq!(err.code, ErrorCode::InvalidTransition);

        let err = CliError::from_service("Work item 'X' not found".into());
        assert_eq!(err.code, ErrorCode::NotFound);

        let err = CliError::from_service("PM_ERR:ALREADY_EXISTS:AAA-0001".into());
        assert_eq!(err.code, ErrorCode::AlreadyExists);
        assert_eq!(err.details["shortId"], "AAA-0001");
    }
}
