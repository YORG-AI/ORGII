# Session Provenance

The standalone protocol/extraction boundary is specified in
[`orgtrack-protocol-rfc.md`](./orgtrack-protocol-rfc.md).

Session Provenance answers: “Which agent session interacted with this resource,
when, how, and with what attribution precision?” It is intentionally broader
than “file touches” so future resource types (symbols, URLs, database objects,
issues, artifacts) can reuse the same interaction model.

## Storage

Canonical data stays in the existing local Orgtrack database:

- Database: `~/.orgii/sessions.db`
- Common resources: `orgtrack_core_resources`
- Typed file resources: `orgtrack_core_file_resources`
- Immutable interaction facts: `orgtrack_core_resource_interactions`
- Historical reconciliation checkpoints:
  `orgtrack_core_interaction_import_checkpoints`
- Sessions: `orgtrack_core_sessions`

The repo-shareable `.orgtrack/` export remains separate. Session interaction
metadata is local-only in schema version 1 and is not added to Git by default.

## Data flow

```text
ORG2 native events ─────────────────────────────┐
Historical vendor transcripts and ORG2 cache ──┤
Claude / Codex / Cursor hooks                   ├─> canonical resource interactions
  -> vendor adapter                             │       in sessions.db
  -> privacy-filtered versioned envelope        │
  -> ~/.orgii/session-provenance/inbox/*.json ──┘
                                                        |
                                                        v
                                              My Station / Session Blame
```

External hooks never open SQLite. A hook invokes the ORG2 executable with
`--session-provenance-hook <source>`, writes one or more small envelopes using
an atomic rename, and exits successfully even if capture fails. The desktop
process owns schema initialization, inbox draining, idempotency, and queries.

## Historical reconciliation

Opening Session Blame returns already indexed facts immediately and schedules
one idempotent, repository-scoped background job. Claude Code, Codex, and
Cursor source indexes are updated incrementally; only sessions whose effective
workspace matches the open repository are considered. Sessions whose cached
write summary mentions the selected file are processed first, then the
remaining repository sessions are scanned for historical reads. ORG2's native
event cache follows the same normalized activity path.

Each source/session pair has a durable checkpoint containing the source
fingerprint and interaction-parser version. Unchanged transcripts are skipped;
changed transcripts replace only their previous reconciled observations. This
checkpoint table is also the durable work queue: a restart simply discovers
the same repository sessions and resumes the non-current fingerprints.

The RPC reports `queued`, `discovering`, `indexing`, `complete`, `partial`, or
`failed` coverage plus indexed/total/failed counts. My Station polls only while
the job is active. Concurrent file views join the same repository job, and a
30-second completed-job window prevents source rescans during one UI burst.
Source discovery or parsing failures produce an explicit partial/failed state
without hiding already available history.

The original transcript or vendor database path remains importer-local cache
metadata (`imported_history_session_cache.source_path`). It is used to load a
transcript but is deliberately absent from the protocol envelope and canonical
interaction fact. This preserves local replay without leaking deployment paths
into portable metadata.

## Canonical model

`ResourceInteractionRecord` is the atomic fact. It includes:

- canonical and source session IDs;
- optional turn, source event, and actor/subagent IDs;
- resource ID and action (`read`, `write`, `create`, `delete`, `rename`, or
  `search`);
- outcome and occurrence time;
- capture method (`native`, `hook`, or `reconciled`);
- attribution precision (`unknown`, `session_only`, `correlated`, or `exact`).

`FileResourceRecord` is a typed projection of a generic resource. A file is
identified by the Git common-directory identity plus repo-relative path when
available, so linked worktrees resolve to the same file resource. A normalized
workspace path is the fallback outside Git repositories.

Interaction IDs and resource IDs are deterministic hashes. Repeated inbox
drains are idempotent by interaction ID. A live hook and a transcript parser
may intentionally preserve two immutable observations of the same source
event when the latter has stronger actor attribution. The read model
correlates observations by source event, resource, and action and counts only
the strongest precision (then actor-bearing and native/reconciled evidence),
so session-only data never blocks or double-counts a later exact child fact.

## Privacy boundary

The canonical record and hook envelope deliberately have no fields for:

- prompts or assistant messages;
- shell commands;
- tool responses;
- file contents or diffs;
- environment variables or credentials.

Only source/session identifiers, paths, actions, timestamps, outcomes, and
attribution metadata cross the hook boundary. Inbox files use owner-only
permissions where the platform supports them.

## Attribution by source

| Source      | Session                | Turn                         | Subagent / actor                                                                 | Precision                                                       |
| ----------- | ---------------------- | ---------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| ORG2 native | Native session ID      | Event thread ID when present | Member or child-session ID when present                                          | Exact when actor is present; otherwise session-only             |
| Claude Code | Hook `session_id`      | When supplied                | Hook `agent_id`                                                                  | Exact when `agent_id` is present                                |
| Codex       | Hook `session_id`      | Hook `turn_id`               | PostToolUse currently has no stable actor field                                  | Session-only; the schema can accept later correlation           |
| Cursor      | Hook `conversation_id` | Hook `generation_id`         | Current `postToolUse` / `subagentStop` payloads do not provide a stable actor ID | Session-only; `subagentStop.modified_files` is a write fallback |

The model stores precision explicitly instead of presenting inferred ownership
as exact. Later transcript reconciliation can append or reconcile higher
precision records without changing the version-1 hook contract.

## My Station projection and transcript navigation

Session Blame projects a hierarchy instead of a flat list:

```text
file (implicit: the currently open history)
└── root session
    ├── main-session interactions
    └── subagent participant → loadable child session when available
```

Each root contains aggregate actions/times plus participants with a stable
entry ID, navigable session, optional parent session, actor identity, capture
methods, and attribution precision. When an actor ID resolves to a real cached
child session (for example Claude Code `agent_id` to
`claudecodeapp-agent-{agent_id}`), the participant uses the child session as
its navigation target and displays the child title. Clicking it runs the same
production session loader used elsewhere in My Station, so the child
transcript—not only an ID change—is loaded and rendered.

The root aggregate already includes every interaction in the group. A
participant whose effective replay target resolves to the same canonical
session/transcript as the root is therefore folded into the root row instead
of being rendered as a duplicate main-agent or subagent row. A distinct child
identity may remain visible without navigation when its transcript is not yet
proven; ORG2 never falls back to opening the root as if it were that child.

Cursor's installed `subagentStart` lifecycle hook preserves `subagent_id`,
`subagent_type`, and `parent_conversation_id`. Its file-bearing `postToolUse`
and `subagentStop` payloads do not currently provide a stable actor key that
can be joined without transcript evidence; some current Cursor releases also
self-reference the parent conversation fields. Version 1 therefore keeps those
file facts at session precision instead of guessing exact subagent ownership.

## Hook installation and customization

ORG2 manages only hook entries containing `--session-provenance-hook`; existing
user hooks are preserved. The supported user-level files are:

- Claude Code: `~/.claude/settings.json`
- Codex: `~/.codex/hooks.json`
- Cursor: `~/.cursor/hooks.json`

All supported platforms default to enabled on first launch. The CLI detail page
offers one switch per platform. Preferences live in
`~/.orgii/session-provenance/hooks.json`, so an explicit opt-out survives app
restarts. Codex may separately require the user to trust a newly installed
non-managed hook through its `/hooks` flow.

Version 1 intentionally exposes only platform enablement. Action filters,
workspace include/exclude rules, retention, and export policy are separate
future preference dimensions; they should not be encoded into vendor-specific
hook JSON.

All Session Provenance settings, hierarchy, action, precision, and
backfill-status copy is defined in every shipped locale: English, French,
Simplified Chinese, Traditional Chinese, Spanish, Russian, Portuguese, German,
Japanese, Korean, Turkish, Vietnamese, and Polish. Stable semantic `data-*`
attributes, rather than English labels, are used by rendered tests so
localization cannot weaken the interaction assertions.

## Upgrade rules

1. Additive canonical fields remain optional within the current schema version.
2. A breaking hook-envelope change increments
   `RESOURCE_INTERACTION_SCHEMA_VERSION` and adds an adapter before changing the
   inbox reader.
3. Vendor payload changes are isolated in `orgtrack_core::hook_adapter`; they
   do not change SQLite or UI types unless the canonical contract changes.
4. New resource kinds add a typed resource table and reuse the common resource
   and interaction tables.
5. My Station reads a grouped projection, not vendor payloads or raw event
   tables.
