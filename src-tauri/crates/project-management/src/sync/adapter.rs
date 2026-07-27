//! `SyncAdapter` trait + supporting types.
//!
//! Adapters implement four operations:
//! - [`SyncAdapter::push`] — flush one outbox row to the external system.
//! - [`SyncAdapter::pull`] — fetch external changes since a cursor.
//! - [`SyncAdapter::handle_conflict`] — adapter-specific tie-breaker
//!   when the generic field-mtime resolver can't decide.
//! - [`SyncAdapter::entity_field_map`] — declarative `WorkItem` ↔
//!   external API field correspondence so the resolver stays generic.
//!
//! Adapters never touch the DB directly — the worker takes care of
//! persistence around each call. This keeps adapters easy to unit-test
//! and prevents adapter-specific schema drift.

use std::collections::HashMap;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::types::OutboxEntry;

/// Headers handed to [`SyncAdapter::handle_webhook`].
///
/// Lower-cased header name → first value. We pre-fold the case so
/// adapters don't have to think about the wire-format spelling
/// (`Linear-Signature` vs `linear-signature`); collapsing to the
/// first value matches every webhook spec we ship — none of them
/// rely on header repetition. Multi-valued headers from misbehaved
/// proxies degrade silently to "first wins" which is what real-world
/// HMAC verification expects.
pub type WebhookHeaders = HashMap<String, String>;

/// Cross-call context handed to every adapter operation.
///
/// Carries the auth token resolved from the bound sync connection and
/// an adapter-specific opaque cursor blob the worker persists between
/// pull cycles.
#[derive(Debug, Clone)]
pub struct SyncContext {
    /// The adapter ID this context targets (e.g. `"linear"`, `"github"`).
    pub adapter_id: String,
    /// Auth token pulled from the connection token store for this
    /// project's bound `sync_connection_id`. `None` for adapters that
    /// declare `auth_kind = None` (`EchoAdapter`); auth-requiring
    /// adapters surface their own [`super::types::SyncError::AuthFailed`]
    /// when called with `None`.
    pub auth_token: Option<String>,
    /// Project slug whose outbox rows this context serves.
    pub project_slug: String,
    /// Adapter-defined opaque cursor blob (e.g. Linear's pagination
    /// cursor, GitHub's `If-Modified-Since` HTTP-date).
    pub cursor_blob: Option<String>,
    /// Raw `projects.sync_config_json` for this project — adapter-specific
    /// binding config (e.g. GitHub's `{ "owner", "repo" }`). `None`
    /// when the project hasn't supplied any.
    pub config_json: Option<String>,
}

/// Successful adapter push outcome.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncOutcome {
    /// External system's identifier for the entity (e.g. Linear issue ID).
    pub external_id: Option<String>,
    /// Remote `updated_at` returned by the API; used by the resolver
    /// to stamp the field-revision watermark.
    pub remote_updated_at: Option<DateTime<Utc>>,
}

/// What [`SyncAdapter::pull`] returns: the batch of changes observed
/// in this cycle plus the cursor value the worker should persist for
/// the next cycle (`None` when the adapter exhausted pagination).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PullOutcome {
    pub changes: Vec<ExternalChange>,
    /// Opaque cursor the worker writes back to `projects.sync_cursor_blob`.
    /// `None` means "pagination exhausted; next cycle re-queries from
    /// `last_pull_at` only."
    pub next_cursor: Option<String>,
}

/// What [`SyncAdapter::pull_all`] returns: one page of historical
/// changes plus the cursor for the next page (`None` ⇒ pagination
/// exhausted) and an optional total-count hint.
///
/// Distinct from [`PullOutcome`] because the import path's invariants
/// differ from the steady-state pull:
///
/// - The cursor lives in the `import_progress` table, not
///   `projects.sync_cursor_blob` (the steady-state pull and the
///   one-shot import must not stomp each other's cursors).
/// - `total_hint` is the only `pull_all`-specific field — adapters
///   that can cheaply report the total entity count (Linear's
///   `totalCount`, GitHub's `Link: …rel="last"`) populate it so the
///   UI can show "47 / 200" rather than "47 / ?". `None` keeps the
///   running counter only.
/// - `changes` carries no `since` filter — the import is unbounded in
///   time and the adapter walks the full history.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ImportPage {
    pub changes: Vec<ExternalChange>,
    /// Opaque cursor for the next page. `None` signals pagination
    /// exhausted — the worker stamps `import_progress.state =
    /// 'completed'` and stops calling `pull_all`.
    pub next_page_cursor: Option<String>,
    /// Optional total-count hint for the UI. The adapter populates
    /// this on the first page when the remote API supplies it
    /// (Linear: `totalCount`; GitHub: parsed from `Link` header).
    /// Ignored by the worker — it's purely a UI hint persisted
    /// alongside the cursor.
    pub total_hint: Option<u64>,
}

/// One change observed during [`SyncAdapter::pull`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalChange {
    pub entity_type: super::types::EntityType,
    pub external_id: String,
    /// Local-side identifier the resolver should match against, when
    /// the adapter knows the mapping; `None` for never-seen entities.
    pub local_entity_id: Option<String>,
    /// Field name → new value. Empty payload + delete flag means "the
    /// remote entity was deleted".
    pub fields: serde_json::Value,
    /// Remote `updated_at`. The resolver uses this as the field-revision
    /// mtime stamp on the merged side.
    pub remote_updated_at: DateTime<Utc>,
    pub deleted: bool,
}

/// Field on an entity. Used by both the conflict resolver and the
/// adapter's `handle_conflict` override.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Field {
    pub name: String,
    pub value: serde_json::Value,
    /// Unix-epoch milliseconds of the most recent mutation we've seen
    /// for this field on this side.
    pub mtime: i64,
    /// Where this revision came from (`"local"`, adapter name, …).
    pub source: String,
}

/// Resolver verdict for a per-field conflict.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConflictResolution {
    /// Keep the local value; push it back to remote.
    KeepLocal,
    /// Adopt the remote value; stamp the local field revision.
    UseRemote,
    /// Concatenate / merge values (rare; adapter-specific).
    Merge,
}

/// Declarative `WorkItem` ↔ external API field map.
///
/// The generic resolver walks this list instead of switching on adapter
/// type — one resolver implementation works for every adapter.
#[derive(Debug, Clone)]
pub struct FieldMap {
    pub mappings: &'static [FieldMapping],
}

/// One `WorkItem` field ↔ external field correspondence.
#[derive(Debug, Clone, Copy)]
pub struct FieldMapping {
    /// Local field name on `WorkItem` (e.g. `"title"`, `"status"`).
    pub local: EntityField,
    /// External API field path (e.g. `"title"`, `"state.id"`).
    pub remote: &'static str,
    /// Whether the field can be written upstream. Some external systems
    /// expose read-only fields (e.g. `created_at`).
    pub writable: bool,
}

/// Local-side fields that adapters may map. Typed enum so the field
/// map stays compile-checked rather than stringly-typed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntityField {
    Title,
    Body,
    Status,
    Priority,
    Assignee,
    Milestone,
    StartDate,
    TargetDate,
    Estimate,
    Labels,
}

impl EntityField {
    pub fn as_local_name(self) -> &'static str {
        match self {
            EntityField::Title => "title",
            EntityField::Body => "body",
            EntityField::Status => "status",
            EntityField::Priority => "priority",
            EntityField::Assignee => "assignee",
            EntityField::Milestone => "milestone",
            EntityField::StartDate => "start_date",
            EntityField::TargetDate => "target_date",
            EntityField::Estimate => "estimate",
            EntityField::Labels => "labels",
        }
    }
}

/// What the UI shows in the "Connect…" picker.
///
/// `auth_methods` enumerates **every** way the user can authenticate
/// to this adapter. Multiple entries mean the connection wizard can offer
/// OAuth and Personal token account creation; empty means `requires_auth =
/// false` (no credential needed).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdapterDescriptor {
    pub id: String,
    pub label: String,
    pub requires_auth: bool,
    pub auth_methods: Vec<AuthMethod>,
    /// Whether this adapter accepts inbound webhook deliveries.
    /// Mirrors `SyncAdapter::supports_webhook` and gates the
    /// "Webhook" panel in the SyncSection UI: when `false`, the
    /// panel is not rendered, the install/status/rotate commands
    /// reject, and the worker treats the project as poll-only.
    pub supports_webhook: bool,
    /// Whether this adapter implements bulk historical import via
    /// `SyncAdapter::pull_all`. Mirrors
    /// `SyncAdapter::supports_import` and gates the "Import" panel
    /// in SyncSection: when `false`, the panel is not rendered,
    /// the import-status command resolves to `not_supported`, and
    /// the worker never schedules an import for this adapter.
    pub supports_import: bool,
}

/// One supported authentication method on an adapter. Distinct from
/// `requires_auth` (which gates whether any credential is needed at
/// all); a `requires_auth = true` adapter offers one or more
/// `AuthMethod` values, never an empty list.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum AuthMethod {
    ApiKey,
    OAuth,
}

/// Per-project sync status, returned by `project_sync_status`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncStatusReport {
    pub adapter_id: Option<String>,
    pub sync_connection_id: Option<String>,
    pub last_pull_at: Option<i64>,
    pub pending_count: u64,
    pub failed_count: u64,
    pub abandoned_count: u64,
    pub last_error: Option<String>,
}

/// The pluggable adapter contract.
///
/// Every adapter is a unit-struct implementing this trait. Registration
/// goes through [`super::adapters::registry`] at boot so commands can
/// look up adapters by ID without hard-coding any.
#[async_trait]
pub trait SyncAdapter: Send + Sync {
    /// Stable identifier (snake_case). Used as the registry key and
    /// stored in `projects.sync_kind`.
    fn name(&self) -> &'static str;

    /// Return the local, user-facing work-item identifier that should be
    /// used for an externally-owned item, when the remote system already
    /// has the canonical identifier users recognize.
    ///
    /// Most adapters keep the default and let the project allocate its own
    /// short id. GitHub overrides this with the issue number so an imported
    /// `#42` does not gain a second identifier such as `ORG-0042`.
    fn preferred_work_item_short_id(&self, _external_id: &str) -> Option<String> {
        None
    }

    /// Push one outbox row. The worker calls this on the blocking pool
    /// guard already, so adapters are free to `.await` without further
    /// thread-management.
    async fn push(&self, entry: &OutboxEntry, ctx: &SyncContext) -> super::types::SyncResult;

    /// Fetch external changes since `since` (defaulting to the project's
    /// last-pull-at when `None`). The EchoAdapter returns an
    /// empty vec; real adapters page through the remote API.
    ///
    /// Returns the changes plus an opaque `next_cursor` the worker
    /// persists into `projects.sync_cursor_blob`. The pair lets an
    /// adapter that paginates across pull cycles resume mid-stream
    /// (set `next_cursor = Some(endCursor)` when `hasNextPage` was
    /// true on the last page fetched within the cycle).
    ///
    /// On transient failure mid-pagination, return
    /// [`SyncError::Transient`] / [`SyncError::RateLimited`] —
    /// the worker leaves `last_pull_at` untouched so the same
    /// window is replayed on the next cycle. Permanent failures
    /// abandon the cycle without advancing.
    async fn pull(
        &self,
        project_slug: &str,
        ctx: &SyncContext,
        since: Option<DateTime<Utc>>,
    ) -> Result<PullOutcome, super::types::SyncError>;

    /// Whether this adapter implements bulk historical import via
    /// [`Self::pull_all`]. Mirrors [`AdapterDescriptor::supports_import`]
    /// and gates the SyncSection "Import" panel + the worker's
    /// import scheduler. Default `false` keeps the path opt-in: an
    /// adapter without a real `pull_all` implementation reports
    /// `false` and the worker never calls into the default
    /// `unreachable!` body.
    fn supports_import(&self) -> bool {
        false
    }

    /// Fetch one page of the remote system's full history.
    ///
    /// Distinct from [`Self::pull`] (the steady-state, since-bounded
    /// fetch the worker runs every 5 minutes): `pull_all` walks the
    /// **entire** entity history from page 1 forward, paginated by
    /// the adapter-defined `page_cursor` blob. The worker calls it
    /// repeatedly inside the import loop until
    /// [`ImportPage::next_page_cursor`] returns `None`.
    ///
    /// Adapters that implement this MUST also flip
    /// `supports_import()` to `true`; otherwise the worker never
    /// reaches the body. Adapters that return
    /// `supports_import() = false` use the default `unreachable!`
    /// impl — there is no scenario where `pull_all` is called on
    /// such an adapter without that being a registration bug.
    ///
    /// Failure semantics:
    /// - `SyncError::Transient` / `RateLimited` — worker retries
    ///   the same page on the next loop tick (cursor unchanged).
    /// - `SyncError::Permanent` — worker stamps
    ///   `import_progress.state = 'failed'` with the error message
    ///   and stops the loop.
    /// - `SyncError::AuthFailed` — same as `Permanent` from the
    ///   import loop's POV; the user must reauthenticate before
    ///   retrying.
    async fn pull_all(
        &self,
        _project_slug: &str,
        _ctx: &SyncContext,
        _page_cursor: Option<&str>,
    ) -> Result<ImportPage, super::types::SyncError> {
        unreachable!(
            "adapter {} returned supports_import=false but worker called pull_all",
            self.name()
        );
    }

    /// Tie-breaker for the resolver. Default policy: prefer remote on
    /// equal mtime since most external trackers are the canonical truth
    /// for their bound projects.
    async fn handle_conflict(
        &self,
        _local: &Field,
        _remote: &Field,
        _base: Option<&Field>,
    ) -> ConflictResolution {
        ConflictResolution::UseRemote
    }

    /// Declarative entity-field map. Returned by reference so the value
    /// can be a `static` table — every adapter's map is stable for the
    /// process lifetime.
    fn entity_field_map(&self) -> &'static FieldMap;

    /// Whether this adapter accepts inbound webhook deliveries via
    /// [`Self::handle_webhook`]. The embedded listener checks this
    /// before routing a request — adapters that return `false` are
    /// 404'd at the listener layer with no work attempted.
    ///
    /// Default `false` keeps webhook support strictly opt-in; the
    /// `cargo check` cost of forgetting to override is "the listener
    /// returns 404 even though the secret is installed", which is
    /// correct: an adapter without a `handle_webhook` impl truly
    /// cannot consume the inbound delivery.
    fn supports_webhook(&self) -> bool {
        false
    }

    /// Parse one inbound webhook delivery into the adapter's normal
    /// [`ExternalChange`] stream.
    ///
    /// HMAC verification is the listener's job (it has the secret in
    /// hand and can decide on signature mismatch before the adapter
    /// is even called). The adapter receives only the raw body +
    /// pre-folded headers and is responsible for parsing the payload
    /// into change records — exactly the shape [`Self::pull`]
    /// produces, so the worker's apply-inbound path doesn't need to
    /// branch.
    ///
    /// Adapters that return `supports_webhook() = false` use the
    /// default `unreachable!` impl: the listener never calls them.
    /// Implementing this without flipping `supports_webhook` is a
    /// configuration bug — caught at the listener (404), not at
    /// runtime in the parser.
    async fn handle_webhook(
        &self,
        _body: &[u8],
        _headers: &WebhookHeaders,
        _ctx: &SyncContext,
    ) -> Result<Vec<ExternalChange>, super::types::SyncError> {
        unreachable!(
            "adapter {} returned supports_webhook=false but listener routed to handle_webhook",
            self.name()
        );
    }

    /// Verify the HMAC signature on an inbound webhook delivery.
    ///
    /// Each adapter overrides this to extract its own signature
    /// header (`Linear-Signature`, `X-Hub-Signature-256`, …) and
    /// compare against the expected HMAC-SHA256 of `body` keyed on
    /// `secret_hex`. Default impl rejects everything — the same
    /// `supports_webhook = false` short-circuit applies.
    ///
    /// Returns `Ok(())` on valid signature, `Err(SyncError::AuthFailed)`
    /// on mismatch / missing header / mis-formatted hex. The listener
    /// surfaces the error as HTTP 401 to the remote provider.
    fn verify_webhook(
        &self,
        _body: &[u8],
        _headers: &WebhookHeaders,
        _secret_hex: &str,
    ) -> Result<(), super::types::SyncError> {
        Err(super::types::SyncError::AuthFailed(format!(
            "adapter {} does not support webhook signature verification",
            self.name()
        )))
    }

    /// What the UI shows in the picker. Default uses the trait name +
    /// no auth requirement; real adapters override. The
    /// `supports_webhook` field is filled from
    /// `Self::supports_webhook` so adapters never need to keep two
    /// sources of truth in sync.
    fn descriptor(&self) -> AdapterDescriptor {
        AdapterDescriptor {
            id: self.name().to_string(),
            label: self.name().to_string(),
            requires_auth: false,
            auth_methods: Vec::new(),
            supports_webhook: self.supports_webhook(),
            supports_import: self.supports_import(),
        }
    }
}
