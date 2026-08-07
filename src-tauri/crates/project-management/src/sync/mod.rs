//! Pluggable sync framework for the centralized project store.
//!
//! Modules:
//! - [`types`] — `OutboxEntry`, `OutboxOp`, `OutboxStatus`, `SyncResult`,
//!   `SyncError`, the wire shapes used by every adapter.
//! - [`io`] — durable CRUD on `outbox_entries` (append, atomic claim,
//!   mark succeeded / failed-with-backoff, list, count, GC).
//! - [`adapter`] — the `SyncAdapter` async trait + `SyncContext` +
//!   `FieldMap` declarative entity-field mapping.
//! - [`adapters`] — built-in adapters keyed by `adapter_id`.
//! - [`worker`] — the tokio task that drains the outbox + runs pull
//!   cycles, with the documented retry/backoff schedule.
//!
//! The worker is spawned once at app boot (see `crate::lib::run`) and
//! lives for the process lifetime. Every IO mutation site that needs
//! external sync writes a row through [`io::append`]; the worker picks
//! it up within the configured push interval.
//!
//! # No string literals for status / op
//!
//! `OutboxOp` and `OutboxStatus` are typed enums with `as_db_str` /
//! `from_db_str` round-trip helpers. SQL parameters always come from
//! `OutboxStatus::Pending.as_db_str()` etc., never raw strings.

pub mod adapter;
pub mod adapters;
pub mod collab_bridge;
pub mod conflict;
pub mod conflict_log;
pub mod connection_store;
pub mod connection_token_store;
pub mod events;
pub mod git_credentials;
pub mod import;
pub mod io;
pub mod linear_native;
pub mod metrics;
pub mod oauth;
pub mod types;
pub mod webhook_listener;
pub mod webhook_secrets;
pub mod worker;

pub use adapter::{
    AdapterDescriptor, AuthMethod, ConflictResolution, EntityField, ExternalChange, Field,
    FieldMap, FieldMapping, ImportPage, SyncAdapter, SyncContext, SyncOutcome, SyncStatusReport,
    WebhookHeaders,
};
pub use adapters::{registry, EchoAdapter, GitHubAdapter, LinearAdapter};
pub use conflict::{resolve, resolve_with_policy, ResolverDecision};
pub use conflict_log::{
    ConflictFieldDelta, ConflictFieldsPayload, ConflictResolution as ConflictRowResolution,
    ConflictRow,
};
pub use events::{emit_status, init_emitter, SyncEventTrigger, SyncStatusEvent, SYNC_STATUS_EVENT};
pub use io::SyncCursor;
pub use metrics::{MetricKind, MetricOutcome, SyncMetric};
pub use types::{
    EntityType, ImportState, OutboxEntry, OutboxOp, OutboxProblemRow, OutboxStatus, SyncError,
    SyncResult,
};
pub use worker::start_worker;
