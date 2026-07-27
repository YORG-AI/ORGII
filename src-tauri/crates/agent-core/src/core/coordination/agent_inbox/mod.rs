//! Typed Agent Org messaging primitives + persistent inbox.
//!
//! Substrate for inter-agent communication inside an `AgentOrgRun`. Uses
//! a typed enum (`AgentMessage`) persisted to a SQLite table
//! (`agent_inbox`). An in-process delivery channel layers on top of the
//! same store, and the sidechain-resume drain path consumes it.
//!
//! ## NOT to be confused with the `inbox` crate
//!
//! The `inbox` crate is the **user-facing** inbox: notifications and summaries
//! that an agent posts to the human via `send_to_inbox`. This module is the
//! **agent-to-agent** inbox: typed messages exchanged between sibling agents
//! inside the same `AgentOrgRun`. Different audience, different lifecycle,
//! different schema — they intentionally do not share storage or types.
//!
//! ## Design notes
//! - `AgentMessage` is a discriminated union. `Plain` is the only free-form
//!   text variant; the rest are typed RPCs that downstream code can pattern
//!   match on without re-parsing strings.
//! - Persistence stores the variant tag (`payload_kind`) alongside the
//!   serialised payload so debug / migration paths can introspect without a
//!   full JSON walk. The `payload_kind` column MUST stay in sync with the
//!   serde `tag = "kind"` on `AgentMessage` — see the `kind_tag_matches_serde_tag`
//!   regression test below.
//!
//! ## Module layout
//! - [`message`] — the typed `AgentMessage` payloads and their validation.
//! - [`record`] — persisted row DTOs, insertion params, and row mappers.
//! - [`schema`] — table DDL, column back-fills, and receipt self-heal.
//! - [`store_write`] / [`store_read`] / [`store_drain`] — the `AgentInboxStore`
//!   write, read/projection, and drain/acknowledgement method groups.

mod message;
mod record;
mod schema;
mod store_drain;
mod store_read;
mod store_write;

#[cfg(test)]
mod tests;

pub use message::{
    is_supported_agent_org_remote_mode, AgentMessage, MemberIdleReason, MemberTerminationReason,
    RequestId, TaskDependencyOutput,
};
pub(crate) use record::AgentInboxUnreadRecipientCounts;
pub use record::{
    AgentInboxBatch, AgentInboxDeliveryResolution, AgentInboxDeliveryResolutionKind,
    AgentInboxPage, AgentInboxPreviewRecord, AgentInboxRecipientCounts, AgentInboxRecord,
    InsertInboxParams, ResolveInboxDeliveryError, ResolveInboxDeliveryParams,
};
pub use schema::init_schema;

/// Reserved sender id for system-generated agent inbox rows.
///
/// Used by:
/// - [`AgentMessage::MemberTerminated`] — inbox-drain side-effect path
///   stamps it after observing a `ShutdownResponse{accepted=true}` and
///   cancelling the member's session.
/// - [`AgentMessage::MemberIdle`] — coordinator-side idle hook stamps
///   it when a member session transitions to idle / interrupted /
///   failed at the turn-finalize boundary.
///
/// These are out-of-band notifications — no LLM originated them — so the
/// sender field gets a marker that cannot collide with any real
/// `agent_id` (those are UUIDs / human-chosen names).
pub const SYSTEM_SENDER_ID: &str = "_system";
pub const USER_SENDER_ID: &str = "_user";

/// Hard ceiling for a single bounded Run View inbox snapshot. Explicit
/// history/debug callers use cursor pages; production projections must never
/// materialize an unbounded run history.
pub const MAX_RUN_INBOX_SNAPSHOT_ROWS: usize = 500;
pub const MAX_RUN_INBOX_PREVIEW_CHARS: usize = 512;
pub const MAX_INBOX_DRAIN_ROWS: usize = 128;
pub const MAX_INBOX_DRAIN_PAYLOAD_BYTES: usize = 1024 * 1024;
pub const MAX_INBOX_HISTORY_PAGE_ROWS: usize = 100;
pub const MAX_INBOX_HISTORY_PAGE_BYTES: usize = 1024 * 1024;

/// Persistent inbox accessor. Its inherent methods are split across the
/// `store_write`, `store_read`, and `store_drain` submodules by concern.
pub struct AgentInboxStore;
