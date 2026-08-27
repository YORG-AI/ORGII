//! Schema DDL for the centralized project store.
//!
//! Local-truth tables:
//! - `project_orgs`       — ORG containers for projects and work items
//! - `projects`          — project metadata
//! - `workitems`        — work item core columns (hot path: title, status, priority, body)
//! - `workitem_extras`  — JSON blob for low-cardinality fields (todos, comments, delegation, …)
//! - `workitem_labels`  — label association (m:n)
//! - `labels`           — global label catalog (per-project, scoped via `project_id`)
//! - `milestones`       — milestone catalog (per-project)
//! - `members`          — known project members / assignees
//! - `routine_definitions` — durable automation definitions that launch agent runs
//! - `routine_fires`    — provenance for each routine occurrence
//! - `pm_work_item_runs` — durable execution episodes for Work Items
//! - `pm_dispatch_outbox` — lease-based delivery queue for Work Item Runs
//!
//! Sync tables:
//! - `outbox_entries`   — durable replay log for external sync adapters
//! - `webhook_secrets`  — per-(slug, adapter) HMAC secrets for inbound
//!   webhook signature verification
//! - `import_progress`  — per-(slug, adapter) bulk historical import
//!   cursor + state, written by the worker's import task.
//!   One row per attached adapter; NULL row means "no import has run
//!   yet" so first attach kicks one off.
//! - `outbox_conflicts` — per-(slug, work_item) snapshot of inbound
//!   `merge_external` rows where the resolver kept-local at least
//!   one writable field whose `FieldRevision.source = "local"` lost
//!   to a fresher remote write. The resolver still applies its
//!   verdict; the conflict row is the audit + fix-up handle.
//!
//! All DDL uses `IF NOT EXISTS` so re-running is idempotent. The single
//! entry point is `init_project_tables(conn)`, called from
//! `database::db::connection::init_all_schemas`.

use rusqlite::{Connection, Result as SqliteResult};

/// Initialize all project-store tables and indexes.
///
/// Called once per physical DB path per process via the shared
/// connection pool. Safe to invoke against an existing DB.
pub fn init_project_tables(conn: &Connection) -> SqliteResult<()> {
    init_local_tables(conn)?;
    crate::team_inbox::schema::init_team_inbox_tables(conn)?;
    init_outbox_table(conn)?;
    init_webhook_secrets_table(conn)?;
    init_import_progress_table(conn)?;
    init_outbox_conflicts_table(conn)?;
    init_linear_metadata_cache_table(conn)?;
    init_pm_service_tables(conn)?;
    Ok(())
}

/// Work application service tables (`orgtrack/v1` Phase 2a).
///
/// - `pm_change_seq`: single-row cross-process change watermark. Every PM
///   mutation bumps it in the same transaction; desktop hosts poll it (or
///   watch the db file) to detect commits from other processes such as
///   the PM CLI, then reconcile incrementally.
/// - `pm_audit_events`: append-only audit stream. NOT the legacy
///   `extras_json.history` array (which is rewritten wholesale per
///   mutation) — this table is insert-only and queryable.
/// - `pm_idempotency`: idempotency records scoped by
///   `(actor, operation, scope, key)` per the frozen wire contract §14.4.
/// - `pm_work_item_runs`: execution truth kept separate from both Work Item
///   lifecycle and Session lifecycle. A terminal Run never implies a terminal
///   Work Item; a successful Run may only request human review.
/// - `pm_dispatch_outbox`: lease-based at-least-once delivery. The Run service
///   and outbox row are always mutated in one transaction.
pub fn init_pm_service_tables(conn: &Connection) -> SqliteResult<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS pm_change_seq (
            id  INTEGER PRIMARY KEY CHECK (id = 1),
            seq INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO pm_change_seq (id, seq) VALUES (1, 0);

        CREATE TABLE IF NOT EXISTS pm_audit_events (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            occurred_at  INTEGER NOT NULL,          -- unix ms
            actor_kind   TEXT,                      -- protocol ActorRef.kind (Phase 3+)
            actor_id     TEXT,
            actor_name   TEXT,
            operation    TEXT NOT NULL,             -- canonical op, e.g. work.transition
            entity_type  TEXT NOT NULL,             -- work_item | routine | routine_run
            entity_id    TEXT NOT NULL,
            project_slug TEXT,
            org_id       TEXT,
            revision     INTEGER,                   -- entity revision after the mutation
            seq          INTEGER,                   -- pm_change_seq value at commit
            payload_json TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_pm_audit_entity
            ON pm_audit_events(entity_type, entity_id);
        CREATE INDEX IF NOT EXISTS idx_pm_audit_seq
            ON pm_audit_events(seq);

        CREATE TABLE IF NOT EXISTS pm_routines (
            name        TEXT PRIMARY KEY,            -- portable unique name
            routine_id  TEXT NOT NULL,               -- metadata.id (stable)
            spec_json   TEXT NOT NULL,               -- canonical portable spec
            spec_hash   TEXT NOT NULL,
            revision    INTEGER NOT NULL,
            enabled     INTEGER NOT NULL DEFAULT 1,  -- gates automatic activations only
            -- Host-local execution binding (NOT part of the portable spec
            -- or its hash): the project scope scheduled invokes run in.
            default_scope     TEXT,
            -- Scheduler watermarks (unix ms).
            last_evaluated_at INTEGER,
            next_fire_at      INTEGER,
            created_at  INTEGER NOT NULL,            -- unix ms
            updated_at  INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS pm_routine_runs (
            id               TEXT PRIMARY KEY,        -- run_<ulid-ish>
            routine_name     TEXT NOT NULL,
            routine_revision INTEGER NOT NULL,
            snapshot_json    TEXT NOT NULL,           -- immutable canonical spec
            snapshot_hash    TEXT NOT NULL,
            scope_id         TEXT NOT NULL,           -- project slug (v1 local)
            status           TEXT NOT NULL,           -- ordered projection, design §11
            inputs_json      TEXT,
            root_work_item_id TEXT,
            created_by       TEXT,
            created_at       INTEGER NOT NULL,
            updated_at       INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_pm_routine_runs_routine
            ON pm_routine_runs(routine_name);

        CREATE TABLE IF NOT EXISTS pm_provider_bindings (
            work_item_id      TEXT NOT NULL,          -- workitems.id
            provider          TEXT NOT NULL,          -- adapter id (linear/github/...)
            external_id       TEXT NOT NULL,
            role              TEXT NOT NULL DEFAULT 'primary',
            authority         TEXT NOT NULL DEFAULT 'provider',
            provider_revision TEXT,
            sync_state        TEXT NOT NULL DEFAULT 'clean',
            created_at        INTEGER NOT NULL,       -- unix ms
            updated_at        INTEGER NOT NULL,
            PRIMARY KEY (work_item_id, provider)
        );
        CREATE INDEX IF NOT EXISTS idx_pm_bindings_external
            ON pm_provider_bindings(provider, external_id);

        CREATE TABLE IF NOT EXISTS pm_relations (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            entity_type TEXT NOT NULL,               -- work_item
            entity_id   TEXT NOT NULL,               -- store id (short_id scoped)
            kind        TEXT NOT NULL,               -- portable relation kind
            target_ref  TEXT NOT NULL,               -- e.g. session://codex_app/abc
            created_at  INTEGER NOT NULL,            -- unix ms
            actor_id    TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_pm_relations_entity
            ON pm_relations(entity_type, entity_id);

        CREATE TABLE IF NOT EXISTS pm_idempotency (
            actor_id      TEXT NOT NULL,
            operation     TEXT NOT NULL,
            scope_id      TEXT NOT NULL,
            idem_key      TEXT NOT NULL,
            request_hash  TEXT NOT NULL,
            response_json TEXT,
            created_at    INTEGER NOT NULL,          -- unix ms
            PRIMARY KEY (actor_id, operation, scope_id, idem_key)
        );

        CREATE TABLE IF NOT EXISTS pm_work_item_runs (
            id                 TEXT PRIMARY KEY,
            scope_key          TEXT NOT NULL,
            project_slug       TEXT,
            org_id             TEXT NOT NULL,
            work_item_id       TEXT NOT NULL,
            work_item_revision INTEGER NOT NULL,
            trigger_kind       TEXT NOT NULL,
            trigger_json       TEXT NOT NULL,
            target_json        TEXT NOT NULL,
            input_json         TEXT NOT NULL,
            status             TEXT NOT NULL,
            attempt            INTEGER NOT NULL,
            max_attempts       INTEGER NOT NULL,
            parent_run_id      TEXT,
            session_id         TEXT,
            failure_json       TEXT,
            usage_json         TEXT,
            idempotency_key    TEXT NOT NULL,
            request_hash       TEXT NOT NULL,
            generation         INTEGER NOT NULL DEFAULT 1,
            created_at         INTEGER NOT NULL,
            updated_at         INTEGER NOT NULL,
            started_at         INTEGER,
            completed_at       INTEGER
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_pm_work_item_runs_idempotency
            ON pm_work_item_runs(scope_key, work_item_id, idempotency_key);
        CREATE INDEX IF NOT EXISTS idx_pm_work_item_runs_session
            ON pm_work_item_runs(session_id)
            WHERE session_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_pm_work_item_runs_item
            ON pm_work_item_runs(scope_key, work_item_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_pm_work_item_runs_status
            ON pm_work_item_runs(status, updated_at);

        CREATE TABLE IF NOT EXISTS pm_dispatch_outbox (
            id                TEXT PRIMARY KEY,
            run_id            TEXT NOT NULL,
            generation        INTEGER NOT NULL,
            status            TEXT NOT NULL,
            delivery_attempt  INTEGER NOT NULL DEFAULT 0,
            available_at      INTEGER NOT NULL,
            lease_token       TEXT,
            lease_owner       TEXT,
            lease_expires_at  INTEGER,
            delivered_at      INTEGER,
            last_error_json   TEXT,
            created_at        INTEGER NOT NULL,
            updated_at        INTEGER NOT NULL,
            UNIQUE(run_id, generation)
        );
        CREATE INDEX IF NOT EXISTS idx_pm_dispatch_outbox_ready
            ON pm_dispatch_outbox(status, available_at, created_at);
        CREATE INDEX IF NOT EXISTS idx_pm_dispatch_outbox_lease
            ON pm_dispatch_outbox(status, lease_expires_at);

        CREATE TABLE IF NOT EXISTS pm_event_consumers (
            consumer_id TEXT PRIMARY KEY,
            last_seq    INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS pm_work_item_path_locks (
            workspace_path   TEXT PRIMARY KEY,
            run_id           TEXT NOT NULL UNIQUE,
            work_item_id     TEXT NOT NULL,
            acquired_at      INTEGER NOT NULL,
            lease_expires_at INTEGER NOT NULL,
            updated_at       INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_pm_work_item_path_locks_expiry
            ON pm_work_item_path_locks(lease_expires_at);

        CREATE TABLE IF NOT EXISTS pm_work_item_subscriptions (
            scope_key       TEXT NOT NULL,
            work_item_id    TEXT NOT NULL,
            subscriber_id   TEXT NOT NULL,
            reason          TEXT NOT NULL,
            created_at      INTEGER NOT NULL,
            muted_at        INTEGER,
            PRIMARY KEY (scope_key, work_item_id, subscriber_id)
        );
        CREATE INDEX IF NOT EXISTS idx_pm_work_item_subscriptions_subscriber
            ON pm_work_item_subscriptions(subscriber_id, muted_at);

        CREATE TABLE IF NOT EXISTS pm_work_item_inbox_events (
            id            TEXT PRIMARY KEY,
            scope_key     TEXT NOT NULL,
            work_item_id  TEXT NOT NULL,
            recipient_id  TEXT NOT NULL,
            kind          TEXT NOT NULL,
            actor_id      TEXT,
            payload_json  TEXT NOT NULL,
            coalesce_key  TEXT NOT NULL,
            occurred_at   INTEGER NOT NULL,
            archived_at   INTEGER,
            UNIQUE(recipient_id, coalesce_key)
        );
        CREATE INDEX IF NOT EXISTS idx_pm_work_item_inbox_recipient
            ON pm_work_item_inbox_events(recipient_id, archived_at, occurred_at DESC);

        CREATE TABLE IF NOT EXISTS pm_routine_webhooks (
            routine_name         TEXT PRIMARY KEY,
            secret_hash          TEXT NOT NULL,
            secret_hint          TEXT NOT NULL,
            enabled              INTEGER NOT NULL DEFAULT 1,
            consecutive_failures INTEGER NOT NULL DEFAULT 0,
            paused_at            INTEGER,
            created_at           INTEGER NOT NULL,
            updated_at           INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS pm_routine_webhook_deliveries (
            id              TEXT PRIMARY KEY,
            routine_name    TEXT NOT NULL,
            provider        TEXT NOT NULL,
            event_kind      TEXT NOT NULL,
            idempotency_key TEXT NOT NULL,
            payload_json    TEXT NOT NULL,
            status          TEXT NOT NULL,
            reason          TEXT,
            routine_run_id  TEXT,
            created_at      INTEGER NOT NULL,
            updated_at      INTEGER NOT NULL,
            UNIQUE(routine_name, idempotency_key)
        );
        CREATE INDEX IF NOT EXISTS idx_pm_routine_webhook_deliveries_routine
            ON pm_routine_webhook_deliveries(routine_name, created_at DESC);

        CREATE TABLE IF NOT EXISTS pm_property_definitions (
            id            TEXT PRIMARY KEY,
            org_id        TEXT NOT NULL,
            name          TEXT NOT NULL,
            property_type TEXT NOT NULL,
            description   TEXT,
            config_json   TEXT NOT NULL DEFAULT '{}',
            position      INTEGER NOT NULL DEFAULT 0,
            archived_at   INTEGER,
            created_at    INTEGER NOT NULL,
            updated_at    INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_pm_property_definitions_name
            ON pm_property_definitions(org_id, name) WHERE archived_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_pm_property_definitions_org
            ON pm_property_definitions(org_id, archived_at, position);
        CREATE TABLE IF NOT EXISTS pm_work_item_property_values (
            property_id TEXT NOT NULL,
            scope_key   TEXT NOT NULL,
            work_item_id TEXT NOT NULL,
            value_json  TEXT NOT NULL,
            updated_at  INTEGER NOT NULL,
            PRIMARY KEY (property_id, scope_key, work_item_id)
        );
        CREATE INDEX IF NOT EXISTS idx_pm_work_item_property_values_item
            ON pm_work_item_property_values(scope_key, work_item_id);
        "#,
    )?;
    Ok(())
}

/// HMAC secrets table for inbound webhook verification.
///
/// One row per `(project_slug, adapter_id)` pair. The secret is
/// generated locally (CSPRNG, 32 bytes hex-encoded) when the user
/// installs a webhook from the UI; the install command surfaces it
/// once for the user to paste into the remote provider's webhook
/// configuration. Subsequent inbound deliveries are verified by the
/// listener using the per-adapter signature scheme (HMAC-SHA256 over
/// the raw body), so a leaked secret only compromises that one
/// project's webhook ingestion — not the auth token, not other
/// projects.
///
/// Public so the sync layer's tests can target the table in
/// isolation. Production code calls [`init_project_tables`] which
/// includes this.
pub fn init_webhook_secrets_table(conn: &Connection) -> SqliteResult<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS webhook_secrets (
            project_slug    TEXT NOT NULL,
            adapter_id      TEXT NOT NULL,
            secret_hex      TEXT NOT NULL,           -- 64 hex chars (32 bytes)
            last_rotated_at INTEGER NOT NULL,        -- unix ms
            PRIMARY KEY (project_slug, adapter_id)
        );
        "#,
    )?;
    Ok(())
}

/// Bulk historical import progress.
///
/// One row per `(project_slug, adapter_id)` capturing where the
/// background import task is in its paginated walk of the remote
/// system's full history. The row is created when an adapter is
/// attached to a project that doesn't already have a finished
/// import; the worker's import loop advances `page_cursor` after
/// each successfully applied page, stamps `imported_count`, and
/// flips `state` to `'completed'` when the adapter signals
/// pagination exhausted.
///
/// `state` values (kept as a TEXT enum mirroring the typed
/// [`super::super::sync::types::ImportState`] in Rust):
/// - `'pending'`    — row exists, no page fetched yet (between
///   attach and the worker picking it up).
/// - `'running'`    — at least one page applied; cursor points
///   at the next page to fetch.
/// - `'completed'`  — adapter returned `next_page_cursor = None`;
///   `imported_count` is final.
/// - `'cancelled'`  — user clicked Cancel from the UI; the row
///   sticks around so we don't re-import on detach/re-attach.
/// - `'failed'`     — terminal failure (`SyncError::Permanent`).
///   `last_error` carries the message; the row is **not** deleted
///   so the UI can surface "import stopped, click retry."
///
/// `total_hint` is `NULL` until the adapter supplies a count
/// (Linear's GraphQL response carries `totalCount`; GitHub's
/// `Link: …rel="last"` header gives the same signal). Surfaced
/// to the UI for the "47 / 200" progress label; the absence of
/// a hint just shows the running counter.
///
/// Public so the sync layer's tests can target the table in
/// isolation.
pub fn init_import_progress_table(conn: &Connection) -> SqliteResult<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS import_progress (
            project_slug    TEXT NOT NULL,
            adapter_id      TEXT NOT NULL,
            state           TEXT NOT NULL,           -- pending|running|completed|cancelled|failed
            page_cursor     TEXT,                    -- adapter-defined opaque cursor (NULL on first page)
            imported_count  INTEGER NOT NULL DEFAULT 0,
            total_hint      INTEGER,                 -- NULL when the adapter can't supply a count
            started_at      INTEGER NOT NULL,        -- unix ms (when the row was first created)
            updated_at      INTEGER NOT NULL,        -- unix ms (when last advanced)
            last_error      TEXT,                    -- non-NULL only when state='failed'
            PRIMARY KEY (project_slug, adapter_id)
        );
        CREATE INDEX IF NOT EXISTS idx_import_progress_state
            ON import_progress(state);
        "#,
    )?;
    Ok(())
}

/// Conflict audit log for inbound merges.
///
/// One row per `merge_external` row where the resolver decided to keep
/// **local** for at least one writable field whose existing
/// `FieldRevision.source = "local"` —— meaning the user had written
/// that field locally after the last successful merge, and the inbound
/// remote update is racing against an unsynced local edit.
///
/// The resolver's per-field verdict is still applied (some fields may
/// adopt remote, others keep local). The conflict row is captured so
/// the user can:
/// - **Use local**  — re-push the local value for the conflicting
///   fields (overrides the previously-applied remote-side adoption,
///   if any), via fresh `OutboxOp::Update` rows;
/// - **Use remote** — overwrite the local value with the remote one
///   the resolver kept-local on, stamping the remote revision so the
///   next merge cycle does not re-flag this as a conflict;
/// - **Dismiss**    — accept the resolver's verdict as-is. State
///   remains whatever the resolver wrote.
///
/// Schema notes:
/// - `fields_json` is the canonical conflict payload; see
///   [`super::super::sync::conflict_log::ConflictFieldsPayload`] for
///   the typed shape.
/// - `resolved_at IS NULL` partitions open vs resolved rows; the index
///   is anchored on that fact for the "list open conflicts" query.
/// - `resolution` is `NULL` while open and one of
///   `'use_local' | 'use_remote' | 'dismissed'` afterward.
/// - `source_outbox_id` is the merge_external row that produced this
///   conflict — kept for forensics; the row is GC'd on its own
///   schedule (7d) regardless of conflict resolution status.
pub fn init_outbox_conflicts_table(conn: &Connection) -> SqliteResult<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS outbox_conflicts (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            project_slug      TEXT NOT NULL,
            adapter_id        TEXT NOT NULL,
            entity_type       TEXT NOT NULL,        -- mirrors EntityType enum (work_item|...)
            entity_id         TEXT NOT NULL,        -- short_id of the local row
            external_id       TEXT NOT NULL,        -- adapter's identifier for the remote row
            fields_json       TEXT NOT NULL,        -- ConflictFieldsPayload (typed)
            detected_at       INTEGER NOT NULL,     -- unix ms when the resolver flagged it
            resolved_at       INTEGER,              -- unix ms; NULL while open
            resolution        TEXT,                 -- use_local|use_remote|dismissed when set
            source_outbox_id  INTEGER               -- merge_external row id; NULL after that row is GC'd
        );
        CREATE INDEX IF NOT EXISTS idx_outbox_conflicts_open
            ON outbox_conflicts(project_slug, resolved_at);
        CREATE INDEX IF NOT EXISTS idx_outbox_conflicts_entity
            ON outbox_conflicts(project_slug, entity_id);
        "#,
    )?;
    Ok(())
}

pub fn init_linear_metadata_cache_table(conn: &Connection) -> SqliteResult<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS linear_metadata_cache (
            connection_id TEXT NOT NULL,
            scope         TEXT NOT NULL,
            scope_id      TEXT NOT NULL,
            payload_json  TEXT NOT NULL,
            fetched_at    INTEGER NOT NULL,
            expires_at    INTEGER NOT NULL,
            PRIMARY KEY (connection_id, scope, scope_id)
        );
        CREATE INDEX IF NOT EXISTS idx_linear_metadata_cache_expires
            ON linear_metadata_cache(expires_at);
        "#,
    )?;
    Ok(())
}

/// DDL for the six local-truth tables (projects, workitems, …, members).
///
/// Split out so the sync layer's tests can target the outbox in isolation
/// without dragging in the full project schema.
fn init_local_tables(conn: &Connection) -> SqliteResult<()> {
    conn.execute_batch(
        r#"
        -- ============================================
        -- project_orgs
        -- ============================================
        CREATE TABLE IF NOT EXISTS project_orgs (
            id                  TEXT PRIMARY KEY,
            name                TEXT NOT NULL,
            slug                TEXT NOT NULL,
            org_key             TEXT NOT NULL,
            source              TEXT NOT NULL DEFAULT 'local',
            sync_provider       TEXT NOT NULL DEFAULT 'none',
            sync_config_json    TEXT,
            sync_connection_id  TEXT,
            external_org_id     TEXT,
            created_at          INTEGER NOT NULL,
            updated_at          INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_project_orgs_slug ON project_orgs(slug);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_project_orgs_key ON project_orgs(org_key);
        CREATE INDEX IF NOT EXISTS idx_project_orgs_source ON project_orgs(source);

        INSERT OR IGNORE INTO project_orgs (
            id, name, slug, org_key, source, sync_provider, created_at, updated_at
        ) VALUES (
            'personal-org', 'Personal Org', 'personal-org', 'ORG', 'local', 'none', 0, 0
        );

        -- ============================================
        -- projects
        -- ============================================
        CREATE TABLE IF NOT EXISTS projects (
            id                  TEXT PRIMARY KEY,
            org_id              TEXT NOT NULL DEFAULT 'personal-org' REFERENCES project_orgs(id) ON DELETE RESTRICT,
            name                TEXT NOT NULL,
            slug                TEXT NOT NULL,
            status              TEXT NOT NULL DEFAULT 'active',
            priority            TEXT NOT NULL DEFAULT 'none',
            health              TEXT NOT NULL DEFAULT 'on_track',
            lead                TEXT,
            description         TEXT,
            short_id_prefix     TEXT NOT NULL,
            next_work_item_id   INTEGER NOT NULL DEFAULT 1,
            start_date          TEXT,
            target_date         TEXT,
            linked_repos_json   TEXT NOT NULL DEFAULT '[]',
            agent_defaults_json TEXT,
            created_at          INTEGER NOT NULL,
            updated_at          INTEGER NOT NULL,
            local_version       INTEGER NOT NULL DEFAULT 0,
            sync_kind           TEXT NOT NULL DEFAULT 'none',
            sync_config_json    TEXT,
            sync_connection_id  TEXT,
            sync_last_pull_at   INTEGER,
            sync_cursor_blob    TEXT,
            sync_last_webhook_at INTEGER
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_slug ON projects(slug);
        CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(org_id);
        CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

        -- ============================================
        -- workitems  (hot columns: indexed and queried directly)
        -- ============================================
        CREATE TABLE IF NOT EXISTS workitems (
            id                TEXT PRIMARY KEY,
            org_id            TEXT NOT NULL DEFAULT 'personal-org' REFERENCES project_orgs(id) ON DELETE RESTRICT,
            project_id          TEXT REFERENCES projects(id) ON DELETE SET NULL,
            short_id          TEXT NOT NULL,
            title             TEXT NOT NULL,
            body              TEXT NOT NULL DEFAULT '',
            status            TEXT NOT NULL DEFAULT 'backlog',
            priority          TEXT NOT NULL DEFAULT 'none',
            assigned_human_id TEXT,
            assignee          TEXT,
            assignee_type     TEXT,
            milestone         TEXT,
            parent            TEXT,
            start_date        TEXT,
            target_date       TEXT,
            estimate          REAL,
            order_index       INTEGER NOT NULL DEFAULT 0,
            created_at        INTEGER NOT NULL,
            updated_at        INTEGER NOT NULL,
            completed_at      INTEGER,
            deleted_at         INTEGER,
            local_version     INTEGER NOT NULL DEFAULT 0
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_workitems_project_short_id
            ON workitems(project_id, short_id)
            WHERE project_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_workitems_standalone_short_id
            ON workitems(org_id, short_id)
            WHERE project_id IS NULL;
        CREATE INDEX IF NOT EXISTS idx_workitems_org ON workitems(org_id);
        CREATE INDEX IF NOT EXISTS idx_workitems_org_status
            ON workitems(org_id, status);
        CREATE INDEX IF NOT EXISTS idx_workitems_project_status
            ON workitems(project_id, status);
        CREATE INDEX IF NOT EXISTS idx_workitems_assigned_human ON workitems(assigned_human_id);
        CREATE INDEX IF NOT EXISTS idx_workitems_assignee ON workitems(assignee);
        CREATE INDEX IF NOT EXISTS idx_workitems_parent ON workitems(parent);
        CREATE INDEX IF NOT EXISTS idx_workitems_milestone ON workitems(milestone);
        CREATE INDEX IF NOT EXISTS idx_workitems_updated_at ON workitems(updated_at);

        -- ============================================
        -- workitem_extras  (low-cardinality JSON blob: todos, comments,
        -- delegation, orchestrator config/state, follow_ups, proof_of_work,
        -- linked_sessions, custom fields)
        -- ============================================
        CREATE TABLE IF NOT EXISTS workitem_extras (
            work_item_id  TEXT PRIMARY KEY REFERENCES workitems(id) ON DELETE CASCADE,
            extras_json   TEXT NOT NULL DEFAULT '{}'
        );
        -- ============================================
        -- workitem_labels  (m:n)
        -- ============================================
        CREATE TABLE IF NOT EXISTS workitem_labels (
            work_item_id  TEXT NOT NULL REFERENCES workitems(id) ON DELETE CASCADE,
            label_id      TEXT NOT NULL,
            PRIMARY KEY (work_item_id, label_id)
        );
        CREATE INDEX IF NOT EXISTS idx_workitem_labels_label ON workitem_labels(label_id);

        -- ============================================
        -- labels (per-project)
        -- ============================================
        CREATE TABLE IF NOT EXISTS labels (
            id            TEXT NOT NULL,
            project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            name          TEXT NOT NULL,
            color         TEXT,
            description   TEXT,
            created_at    INTEGER NOT NULL,
            PRIMARY KEY (project_id, id)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_labels_project_name
            ON labels(project_id, name);

        -- ============================================
        -- milestones (per-project)
        -- ============================================
        CREATE TABLE IF NOT EXISTS milestones (
            id            TEXT NOT NULL,
            project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            name          TEXT NOT NULL,
            description   TEXT,
            target_date   TEXT,
            status        TEXT NOT NULL DEFAULT 'open',
            created_at    INTEGER NOT NULL,
            PRIMARY KEY (project_id, id)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_milestones_project_name
            ON milestones(project_id, name);

        -- ============================================
        -- members (per-project)
        -- ============================================
        CREATE TABLE IF NOT EXISTS members (
            id            TEXT NOT NULL,
            project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            display_name  TEXT NOT NULL,
            email         TEXT,
            avatar_url    TEXT,
            kind          TEXT NOT NULL DEFAULT 'member', -- member | agent | org
            extras_json   TEXT,
            created_at    INTEGER NOT NULL,
            PRIMARY KEY (project_id, id)
        );
        CREATE INDEX IF NOT EXISTS idx_members_project ON members(project_id);

        -- ============================================
        -- routine_definitions / routine_fires
        -- ============================================
        CREATE TABLE IF NOT EXISTS routine_definitions (
            id                       TEXT PRIMARY KEY,
            name                     TEXT NOT NULL,
            description              TEXT NOT NULL DEFAULT '',
            enabled                  INTEGER NOT NULL DEFAULT 1,
            trigger_json             TEXT NOT NULL,
            run_template_json        TEXT NOT NULL,
            output_policy_json       TEXT NOT NULL DEFAULT '{}',
            created_at               INTEGER NOT NULL,
            updated_at               INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_routine_definitions_enabled
            ON routine_definitions(enabled);
        CREATE INDEX IF NOT EXISTS idx_routine_definitions_updated_at
            ON routine_definitions(updated_at);

        CREATE TABLE IF NOT EXISTS routine_fires (
            id                  TEXT PRIMARY KEY,
            routine_id          TEXT NOT NULL REFERENCES routine_definitions(id) ON DELETE CASCADE,
            fired_at            INTEGER NOT NULL,
            status              TEXT NOT NULL,
            session_id          TEXT,
            agent_org_run_id    TEXT,
            work_item_id        TEXT,
            coalesced_into_fire_id TEXT,
            idempotency_key     TEXT,
            started_at          INTEGER,
            completed_at        INTEGER,
            error               TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_routine_fires_routine_id
            ON routine_fires(routine_id, fired_at DESC);
        CREATE INDEX IF NOT EXISTS idx_routine_fires_session
            ON routine_fires(session_id);
        "#,
    )?;
    ensure_workitems_deleted_at_column(conn)?;
    ensure_projects_sync_columns(conn)?;
    ensure_collab_sync_columns(conn)?;
    ensure_workitems_allow_standalone_scope(conn)?;
    ensure_routine_definitions_durable_columns(conn)?;
    ensure_routine_fires_durable_columns(conn)?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_workitems_deleted_at ON workitems(deleted_at)",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_routine_fires_work_item ON routine_fires(work_item_id)",
        [],
    )?;
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_routine_fires_idempotency ON routine_fires(idempotency_key) WHERE idempotency_key IS NOT NULL",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_routine_fires_status ON routine_fires(routine_id, status, fired_at DESC)",
        [],
    )?;
    // Drop the never-wired multi-assignee tables. Zero read/write paths ever
    // existed; rebuild the schema when multi-agent assignment actually ships.
    conn.execute("DROP TABLE IF EXISTS workitem_assigned_agents", [])?;
    conn.execute("DROP TABLE IF EXISTS workitem_reviewers", [])?;
    Ok(())
}

fn ensure_workitems_deleted_at_column(conn: &Connection) -> SqliteResult<()> {
    ensure_column(conn, "workitems", "deleted_at", "INTEGER")
}

/// Rebuild legacy `workitems` tables whose `project_id` still requires a
/// project. Org-level Work Items intentionally have no project, so the
/// authoritative storage invariant is `(org_id, project_id = NULL)`.
///
/// SQLite cannot remove a `NOT NULL` constraint or change a foreign-key
/// action in place. The migration therefore copies the rows into the current
/// table shape while foreign-key enforcement is temporarily suspended, then
/// restores the indexes and verifies the resulting graph before returning.
fn ensure_workitems_allow_standalone_scope(conn: &Connection) -> SqliteResult<()> {
    let project_id_is_required = {
        let mut statement = conn.prepare("PRAGMA table_info(workitems)")?;
        let columns = statement.query_map([], |row| {
            Ok((row.get::<_, String>(1)?, row.get::<_, i64>(3)?))
        })?;
        let mut required = false;
        for column in columns {
            let (name, not_null) = column?;
            if name == "project_id" {
                required = not_null != 0;
                break;
            }
        }
        required
    };

    let project_delete_sets_null = {
        let mut statement = conn.prepare("PRAGMA foreign_key_list(workitems)")?;
        let foreign_keys = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(6)?,
            ))
        })?;
        let mut sets_null = false;
        for foreign_key in foreign_keys {
            let (table, from, on_delete) = foreign_key?;
            if table == "projects" && from == "project_id" {
                sets_null = on_delete.eq_ignore_ascii_case("SET NULL");
                break;
            }
        }
        sets_null
    };

    if !project_id_is_required && project_delete_sets_null {
        return Ok(());
    }

    conn.execute_batch("PRAGMA foreign_keys = OFF;")?;
    let migration = (|| -> SqliteResult<()> {
        let transaction = conn.unchecked_transaction()?;
        transaction.execute_batch(
            r#"
            CREATE TABLE workitems_standalone_migration (
                id                    TEXT PRIMARY KEY,
                org_id                TEXT NOT NULL DEFAULT 'personal-org' REFERENCES project_orgs(id) ON DELETE RESTRICT,
                project_id            TEXT REFERENCES projects(id) ON DELETE SET NULL,
                short_id              TEXT NOT NULL,
                title                 TEXT NOT NULL,
                body                  TEXT NOT NULL DEFAULT '',
                status                TEXT NOT NULL DEFAULT 'backlog',
                priority              TEXT NOT NULL DEFAULT 'none',
                assigned_human_id     TEXT,
                assignee              TEXT,
                assignee_type         TEXT,
                milestone             TEXT,
                parent                TEXT,
                start_date            TEXT,
                target_date           TEXT,
                estimate              REAL,
                order_index           INTEGER NOT NULL DEFAULT 0,
                created_at            INTEGER NOT NULL,
                updated_at            INTEGER NOT NULL,
                completed_at          INTEGER,
                deleted_at            INTEGER,
                local_version         INTEGER NOT NULL DEFAULT 0,
                collab_remote_version INTEGER
            );

            INSERT INTO workitems_standalone_migration (
                id, org_id, project_id, short_id, title, body, status, priority,
                assigned_human_id, assignee, assignee_type, milestone, parent,
                start_date, target_date, estimate, order_index, created_at,
                updated_at, completed_at, deleted_at, local_version,
                collab_remote_version
            )
            SELECT
                id, org_id, project_id, short_id, title, body, status, priority,
                assigned_human_id, assignee, assignee_type, milestone, parent,
                start_date, target_date, estimate, order_index, created_at,
                updated_at, completed_at, deleted_at, local_version,
                collab_remote_version
            FROM workitems;

            DROP TABLE workitems;
            ALTER TABLE workitems_standalone_migration RENAME TO workitems;

            CREATE UNIQUE INDEX idx_workitems_project_short_id
                ON workitems(project_id, short_id)
                WHERE project_id IS NOT NULL;
            CREATE UNIQUE INDEX idx_workitems_standalone_short_id
                ON workitems(org_id, short_id)
                WHERE project_id IS NULL;
            CREATE INDEX idx_workitems_org ON workitems(org_id);
            CREATE INDEX idx_workitems_org_status ON workitems(org_id, status);
            CREATE INDEX idx_workitems_project_status ON workitems(project_id, status);
            CREATE INDEX idx_workitems_assigned_human ON workitems(assigned_human_id);
            CREATE INDEX idx_workitems_assignee ON workitems(assignee);
            CREATE INDEX idx_workitems_parent ON workitems(parent);
            CREATE INDEX idx_workitems_milestone ON workitems(milestone);
            CREATE INDEX idx_workitems_updated_at ON workitems(updated_at);
            CREATE INDEX idx_workitems_deleted_at ON workitems(deleted_at);
            "#,
        )?;
        transaction.commit()
    })();

    if migration.is_err() {
        let _ = conn.execute_batch("ROLLBACK;");
    }
    let foreign_keys_result = conn.execute_batch("PRAGMA foreign_keys = ON;");
    migration?;
    foreign_keys_result?;

    let foreign_key_violation: i64 =
        conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })?;
    if foreign_key_violation != 0 {
        return Err(rusqlite::Error::ExecuteReturnedResults);
    }
    Ok(())
}

/// Backfill the project-sync columns on DBs created before they were
/// added to the `projects` CREATE TABLE.
///
/// Fresh DBs already carry these columns from the DDL above, so
/// [`ensure_column`] is a no-op for them. Older DBs that created
/// `projects` without the sync surface get the columns added here —
/// without this, the worker's pull-cycle binding query fails with
/// `no such column: sync_connection_id`.
fn ensure_projects_sync_columns(conn: &Connection) -> SqliteResult<()> {
    for (column, definition) in [
        ("sync_kind", "TEXT NOT NULL DEFAULT 'none'"),
        ("sync_config_json", "TEXT"),
        ("sync_connection_id", "TEXT"),
        ("sync_last_pull_at", "INTEGER"),
        ("sync_cursor_blob", "TEXT"),
        ("sync_last_webhook_at", "INTEGER"),
    ] {
        ensure_column(conn, "projects", column, definition)?;
    }
    Ok(())
}

/// Last server row version applied/acknowledged for the `orgii_collab`
/// provider (design §16.4). NULL for rows that never synced. Kept as a
/// dedicated column because `local_version` is the local OCC counter
/// (bumped on every local write) and `sync_cursor_blob` is the
/// project-bound adapter's pull cursor — both have incompatible
/// semantics with a remote row version.
///
/// `projects.field_revisions_json` is the project counterpart of
/// `workitem_extras.field_revisions`: a JSON map of
/// `local field name → { mtime, source }` watermarks stamped on local
/// edits and on remote-adopted fields, consumed by the collab bridge's
/// per-field project merge. NULL / absent = never stamped (whole-row
/// fallback semantics).
fn ensure_collab_sync_columns(conn: &Connection) -> SqliteResult<()> {
    ensure_column(conn, "projects", "collab_remote_version", "INTEGER")?;
    ensure_column(conn, "projects", "field_revisions_json", "TEXT")?;
    ensure_column(conn, "workitems", "collab_remote_version", "INTEGER")
}

fn ensure_routine_definitions_durable_columns(conn: &Connection) -> SqliteResult<()> {
    ensure_column(
        conn,
        "routine_definitions",
        "output_policy_json",
        "TEXT NOT NULL DEFAULT '{}'",
    )?;
    ensure_column(conn, "routine_definitions", "last_evaluated_at", "INTEGER")?;
    ensure_column(conn, "routine_definitions", "next_fire_at", "INTEGER")
}

fn ensure_routine_fires_durable_columns(conn: &Connection) -> SqliteResult<()> {
    for (column, definition) in [
        ("work_item_id", "TEXT"),
        ("coalesced_into_fire_id", "TEXT"),
        ("idempotency_key", "TEXT"),
        ("started_at", "INTEGER"),
        ("completed_at", "INTEGER"),
        ("error", "TEXT"),
    ] {
        ensure_column(conn, "routine_fires", column, definition)?;
    }
    Ok(())
}

fn ensure_column(
    conn: &Connection,
    table_name: &str,
    column_name: &str,
    column_definition: &str,
) -> SqliteResult<()> {
    let mut statement = conn.prepare(&format!("PRAGMA table_info({table_name})"))?;
    let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
    for column in columns {
        if column? == column_name {
            return Ok(());
        }
    }
    conn.execute(
        &format!("ALTER TABLE {table_name} ADD COLUMN {column_name} {column_definition}"),
        [],
    )?;
    Ok(())
}

/// DDL for the sync outbox.
///
/// The outbox is a durable replay log: every local mutation that needs
/// to reach an external system (Linear, GitHub, …) appends a row
/// here, and the worker loop in `project_management::sync::worker`
/// drains pending rows by calling the matching `SyncAdapter::push`.
///
/// Public so the sync layer's unit tests can target an in-memory DB
/// without paying for the full project schema. Production code goes
/// through [`init_project_tables`].
pub fn init_outbox_table(conn: &Connection) -> SqliteResult<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS outbox_entries (
            id                 INTEGER PRIMARY KEY AUTOINCREMENT,
            project_slug       TEXT NOT NULL,
            entity_type        TEXT NOT NULL,                  -- work_item | project | label | milestone | member
            entity_id          TEXT NOT NULL,                  -- short_id for work items, slug for projects, …
            op                 TEXT NOT NULL,                  -- create | update | delete | merge_external
            field_path         TEXT,                           -- dotted path within entity (NULL for create/delete)
            payload_json       TEXT NOT NULL DEFAULT '{}',
            created_at         INTEGER NOT NULL,               -- unix ms
            retry_count        INTEGER NOT NULL DEFAULT 0,
            last_attempted_at  INTEGER,
            last_error         TEXT,
            status             TEXT NOT NULL DEFAULT 'pending' -- pending | in_flight | succeeded | failed | abandoned
        );
        CREATE INDEX IF NOT EXISTS idx_outbox_status_created
            ON outbox_entries(status, created_at);
        CREATE INDEX IF NOT EXISTS idx_outbox_project_entity
            ON outbox_entries(project_slug, entity_type, entity_id);
        "#,
    )?;
    // `org_id` discriminates orgii_collab bridge rows (design §16.8): a
    // non-NULL org_id means the row is drained/acked by the TS
    // CollabSyncEngine through the `project_collab_outbox_*` commands,
    // never by the in-process worker — both worker claim paths filter
    // `org_id IS NULL`. Legacy rows (adapter-bound projects) keep NULL.
    ensure_column(conn, "outbox_entries", "org_id", "TEXT")?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_outbox_org_status
             ON outbox_entries(org_id, status, created_at)",
        [],
    )?;
    Ok(())
}

#[cfg(test)]
#[path = "schema_tests.rs"]
mod tests;
