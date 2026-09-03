-- Exact private Agent Org schema created by official ORGII v1.3.0.
-- Keep this fixture release-shaped: it must not contain unpublished intermediate tables.

CREATE TABLE agent_org_runs (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    coordinator_agent_id TEXT NOT NULL,
    root_session_id TEXT,
    org_snapshot_json TEXT,
    entry_mode TEXT NOT NULL,
    status TEXT NOT NULL,
    work_item_id TEXT,
    project_slug TEXT,
    routine_fire_id TEXT,
    summary TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
);
CREATE INDEX idx_agent_org_runs_org_updated
    ON agent_org_runs(org_id, updated_at);
CREATE INDEX idx_agent_org_runs_root_session
    ON agent_org_runs(root_session_id);
CREATE INDEX idx_agent_org_runs_work_item
    ON agent_org_runs(work_item_id);
CREATE INDEX idx_agent_org_runs_status
    ON agent_org_runs(status);

CREATE TABLE agent_org_run_progress (
    org_run_id TEXT PRIMARY KEY,
    work_revision INTEGER NOT NULL DEFAULT 0 CHECK(work_revision >= 0),
    coordinator_presented_work_revision INTEGER,
    coordinator_observed_work_revision INTEGER,
    completion_requested INTEGER NOT NULL DEFAULT 0,
    completion_requested_at TEXT,
    completion_requested_work_revision INTEGER,
    completion_summary TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(org_run_id) REFERENCES agent_org_runs(id) ON DELETE CASCADE
);

CREATE TABLE agent_org_plan_approvals (
    approval_id TEXT PRIMARY KEY,
    plan_revision_id TEXT NOT NULL UNIQUE,
    request_id TEXT NOT NULL UNIQUE,
    org_run_id TEXT NOT NULL,
    source_task_id TEXT NOT NULL,
    source_member_id TEXT NOT NULL,
    source_session_id TEXT NOT NULL,
    root_session_id TEXT NOT NULL,
    policy TEXT NOT NULL,
    status TEXT NOT NULL,
    plan_title TEXT NOT NULL,
    plan_path TEXT NOT NULL,
    plan_content TEXT NOT NULL,
    decision_by TEXT,
    feedback TEXT,
    created_at TEXT NOT NULL,
    resolved_at TEXT
);
CREATE INDEX idx_agent_org_plan_approvals_run_status
    ON agent_org_plan_approvals(org_run_id, status, created_at);
CREATE INDEX idx_agent_org_plan_approvals_task
    ON agent_org_plan_approvals(org_run_id, source_task_id, created_at);

CREATE TABLE agent_org_recovery_attempts (
    org_run_id TEXT NOT NULL,
    action_kind TEXT NOT NULL,
    target_key TEXT NOT NULL,
    reason_fingerprint TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_allowed_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    reservation_token TEXT,
    PRIMARY KEY (org_run_id, action_kind, target_key)
);
CREATE INDEX idx_agent_org_recovery_attempts_run
    ON agent_org_recovery_attempts(org_run_id);

CREATE TABLE agent_org_tasks (
    id TEXT NOT NULL,
    org_run_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    active_form TEXT,
    owner TEXT,
    status TEXT NOT NULL,
    blocks_json TEXT NOT NULL DEFAULT '[]',
    blocked_by_json TEXT NOT NULL DEFAULT '[]',
    metadata_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (org_run_id, id)
);
CREATE INDEX idx_agent_org_tasks_status
    ON agent_org_tasks(org_run_id, status, owner);
CREATE INDEX idx_agent_org_tasks_owner
    ON agent_org_tasks(org_run_id, owner);

CREATE TABLE agent_org_task_events (
    id TEXT PRIMARY KEY,
    org_run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    previous_owner TEXT,
    next_owner TEXT,
    previous_status TEXT,
    next_status TEXT,
    actor_member_id TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_agent_org_task_events_run
    ON agent_org_task_events(org_run_id, created_at, id);
CREATE INDEX idx_agent_org_task_events_task
    ON agent_org_task_events(org_run_id, task_id, created_at, id);

CREATE TABLE agent_org_task_run_schema_migrations (
    name TEXT NOT NULL,
    org_run_id TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    PRIMARY KEY (name, org_run_id)
);

CREATE TABLE agent_inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient_agent_id TEXT NOT NULL,
    recipient_member_id TEXT,
    sender_agent_id TEXT NOT NULL,
    sender_member_id TEXT,
    org_run_id TEXT,
    payload_kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    request_id TEXT,
    created_at TEXT NOT NULL,
    read_at TEXT,
    causation_inbox_id INTEGER,
    display_text TEXT
);
CREATE INDEX idx_agent_inbox_recipient_member_unread
    ON agent_inbox(recipient_member_id, read_at, created_at);
CREATE INDEX idx_agent_inbox_recipient_unread
    ON agent_inbox(recipient_agent_id, read_at, created_at);
CREATE INDEX idx_agent_inbox_org_run
    ON agent_inbox(org_run_id, created_at);
CREATE INDEX idx_agent_inbox_org_run_id
    ON agent_inbox(org_run_id, id);
CREATE INDEX idx_agent_inbox_run_unread_recipient
    ON agent_inbox(org_run_id, recipient_member_id, recipient_agent_id, id)
    WHERE read_at IS NULL;
CREATE INDEX idx_agent_inbox_run_kind_id
    ON agent_inbox(org_run_id, payload_kind, id);
CREATE INDEX idx_agent_inbox_run_task_assignment_v4
    ON agent_inbox(
        org_run_id,
        recipient_member_id,
        json_extract(
            CASE WHEN length(CAST(payload_json AS BLOB))<=262144
                           AND json_valid(payload_json)
                 THEN payload_json ELSE '{}' END,
            '$.task_id'
        )
    )
    WHERE payload_kind='task_assigned'
      AND CASE WHEN length(CAST(payload_json AS BLOB))<=262144
               THEN json_valid(payload_json) ELSE 0 END
      AND json_type(
            CASE WHEN length(CAST(payload_json AS BLOB))<=262144
                           AND json_valid(payload_json)
                 THEN payload_json ELSE '{}' END,
            '$.task_id'
          )='text';
CREATE INDEX idx_agent_inbox_request_id
    ON agent_inbox(request_id);
CREATE UNIQUE INDEX idx_agent_inbox_causation_recipient_once
    ON agent_inbox(
        causation_inbox_id,
        payload_kind,
        recipient_agent_id,
        COALESCE(recipient_member_id, '')
    )
    WHERE causation_inbox_id IS NOT NULL;

CREATE TABLE agent_inbox_materializations (
    inbox_id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    transcript_message_id TEXT NOT NULL,
    transcript_intent_id TEXT NOT NULL,
    materialized_at TEXT NOT NULL
);
CREATE INDEX idx_agent_inbox_materializations_session
    ON agent_inbox_materializations(session_id, inbox_id);

CREATE TABLE agent_inbox_delivery_resolutions (
    inbox_id INTEGER PRIMARY KEY,
    org_run_id TEXT NOT NULL,
    resolution_kind TEXT NOT NULL
        CHECK(resolution_kind IN ('cancelled', 'superseded')),
    resolved_by_member_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    replacement_inbox_id INTEGER,
    replacement_task_id TEXT,
    created_at TEXT NOT NULL,
    CHECK(
        (resolution_kind='cancelled'
            AND replacement_inbox_id IS NULL
            AND replacement_task_id IS NULL)
        OR
        (resolution_kind='superseded'
            AND ((replacement_inbox_id IS NOT NULL)
                 <> (replacement_task_id IS NOT NULL)))
    )
);
CREATE INDEX idx_agent_inbox_delivery_resolutions_run
    ON agent_inbox_delivery_resolutions(org_run_id, inbox_id);

CREATE TABLE agent_member_interventions (
    org_run_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    entered_at TEXT NOT NULL,
    last_user_activity_at TEXT NOT NULL,
    resume_after TEXT NOT NULL,
    cleared_at TEXT,
    PRIMARY KEY (org_run_id, member_id)
);
CREATE INDEX idx_agent_member_interventions_session
    ON agent_member_interventions(session_id);
CREATE INDEX idx_agent_member_interventions_active
    ON agent_member_interventions(org_run_id, cleared_at, resume_after);

INSERT INTO agent_org_runs (
    id, org_id, coordinator_agent_id, root_session_id, org_snapshot_json,
    entry_mode, status, created_at, updated_at
) VALUES (
    'official-run', 'official-org', 'official-coordinator', 'ordinary-session',
    '{"id":"official-org","children":[]}', 'standalone_session', 'idle',
    '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'
);
INSERT INTO agent_org_run_progress (org_run_id, updated_at)
VALUES ('official-run', '2026-08-01T00:00:00Z');
INSERT INTO agent_org_plan_approvals (
    approval_id, plan_revision_id, request_id, org_run_id, source_task_id,
    source_member_id, source_session_id, root_session_id, policy, status,
    plan_title, plan_path, plan_content, created_at
) VALUES (
    'official-approval', 'official-revision', 'official-request', 'official-run',
    'official-task', 'official-member', 'ordinary-session', 'ordinary-session',
    'coordinator', 'pending', 'Official plan', '/tmp/official-plan', '# Plan',
    '2026-08-01T00:00:00Z'
);
INSERT INTO agent_org_recovery_attempts (
    org_run_id, action_kind, target_key, reason_fingerprint, next_allowed_at, updated_at
) VALUES (
    'official-run', 'member_rewake', 'official-member', 'official-fingerprint',
    '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'
);
INSERT INTO agent_org_tasks (
    id, org_run_id, subject, status, created_at, updated_at
) VALUES (
    'official-task', 'official-run', 'Official task', 'pending',
    '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'
);
INSERT INTO agent_org_task_events (
    id, org_run_id, task_id, event_type, actor_member_id, created_at
) VALUES (
    'official-event', 'official-run', 'official-task', 'created', 'official-member',
    '2026-08-01T00:00:00Z'
);
INSERT INTO agent_org_task_run_schema_migrations (name, org_run_id, applied_at)
VALUES ('canonical_blocked_by_v1', 'official-run', '2026-08-01T00:00:00Z');
INSERT INTO agent_inbox (
    recipient_agent_id, recipient_member_id, sender_agent_id, sender_member_id,
    org_run_id, payload_kind, payload_json, request_id, created_at
) VALUES (
    'official-agent', 'official-member', 'official-coordinator', 'coordinator',
    'official-run', 'plain', '{"kind":"plain","text":"official"}',
    'official-inbox-request', '2026-08-01T00:00:00Z'
);
INSERT INTO agent_inbox_materializations (
    inbox_id, session_id, transcript_message_id, transcript_intent_id, materialized_at
) VALUES (
    1, 'ordinary-session', 'ordinary-message', 'ordinary-intent',
    '2026-08-01T00:00:00Z'
);
INSERT INTO agent_inbox_delivery_resolutions (
    inbox_id, org_run_id, resolution_kind, resolved_by_member_id, reason, created_at
) VALUES (
    2, 'official-run', 'cancelled', 'official-member', 'official fixture',
    '2026-08-01T00:00:00Z'
);
INSERT INTO agent_member_interventions (
    org_run_id, member_id, agent_id, session_id, status, entered_at,
    last_user_activity_at, resume_after
) VALUES (
    'official-run', 'official-member', 'official-agent', 'ordinary-session', 'active',
    '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z', '2026-08-01T00:05:00Z'
);
