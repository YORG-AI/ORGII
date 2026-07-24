use std::collections::HashMap;
use std::io::Write as _;

use flate2::write::GzEncoder;
use flate2::Compression;
use tempfile::TempDir;

use super::*;
use super::{publish::*, schema::*, staging::*, wire::*};
use crate::agent_sessions::event_pipeline::types::{
    ActivityStatus, EventDisplayStatus, EventDisplayVariant, EventSource,
};

fn test_event(id: &str, source: EventSource, text: &str) -> SessionEvent {
    let (action_type, function_name) = match source {
        EventSource::User => ("user_message", "user_message"),
        EventSource::Assistant => ("assistant_message", "agent_message"),
        EventSource::System => ("tool_call", "read"),
    };
    SessionEvent {
        id: id.to_string(),
        chunk_id: Some(format!("chunk-{id}")),
        session_id: "source-session".to_string(),
        created_at: "2026-07-22T00:00:00.000Z".to_string(),
        function_name: function_name.to_string(),
        ui_canonical: function_name.to_string(),
        action_type: action_type.to_string(),
        args: serde_json::json!({ "content": text }),
        result: serde_json::json!({}),
        source,
        display_text: text.to_string(),
        display_status: EventDisplayStatus::Completed,
        display_variant: EventDisplayVariant::Message,
        activity_status: ActivityStatus::Agent,
        thread_id: None,
        process_id: None,
        call_id: None,
        file_path: None,
        command: None,
        is_delta: None,
        repo_id: None,
        repo_path: None,
        extracted: None,
        payload_refs: Vec::new(),
        shell_replay: None,
        shell_replay_bookmarks: Some(HashMap::new()),
        last_extract_at: None,
    }
}

fn gzip_base64(bytes: &[u8]) -> String {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(bytes).expect("gzip bytes");
    BASE64_STANDARD.encode(encoder.finish().expect("finish gzip"))
}

fn v1_wire(seq: u64, events: &[SessionEvent]) -> CollaborationSnapshotWire {
    let bytes = serde_json::to_vec(events).expect("serialize event segment");
    CollaborationSnapshotWire {
        seq,
        payload_gz: gzip_base64(&bytes),
        event_count: events.len() as u64,
        segment_hash: sha256_hex(&bytes),
    }
}

fn page_bytes(segments: &[CollaborationSnapshotWire]) -> u64 {
    segments
        .iter()
        .map(|wire| serde_json::to_vec(wire).expect("measure wire").len() as u64)
        .sum()
}

fn backward_page(
    token: &str,
    epoch: i64,
    frozen_seq: u64,
    count: u64,
    before_seq: Option<u64>,
    next_before_seq: Option<u64>,
    segments: Vec<CollaborationSnapshotWire>,
) -> CollaborationSnapshotIngestPageRequest {
    let has_more = next_before_seq.is_some();
    CollaborationSnapshotIngestPageRequest {
        token: token.to_string(),
        epoch,
        frozen_seq,
        count,
        tail_hash: None,
        cursor: CollaborationSnapshotWireCursor::Backward { before_seq },
        next_cursor: next_before_seq.map(|before_seq| CollaborationSnapshotWireCursor::Backward {
            before_seq: Some(before_seq),
        }),
        tail_included: false,
        has_more,
        returned_wire_bytes: page_bytes(&segments),
        segments,
    }
}

fn forward_page(
    token: &str,
    epoch: i64,
    frozen_seq: u64,
    count: u64,
    after_seq: u64,
    segments: Vec<CollaborationSnapshotWire>,
    has_more: bool,
) -> CollaborationSnapshotIngestPageRequest {
    let last = segments
        .iter()
        .map(|wire| wire.seq)
        .max()
        .unwrap_or(after_seq);
    CollaborationSnapshotIngestPageRequest {
        token: token.to_string(),
        epoch,
        frozen_seq,
        count,
        tail_hash: None,
        cursor: CollaborationSnapshotWireCursor::Forward {
            after_seq,
            through_seq: Some(frozen_seq),
        },
        next_cursor: has_more.then_some(CollaborationSnapshotWireCursor::Forward {
            after_seq: last,
            through_seq: Some(frozen_seq),
        }),
        tail_included: false,
        has_more,
        returned_wire_bytes: page_bytes(&segments),
        segments,
    }
}

fn destination() -> Connection {
    let conn = Connection::open_in_memory().expect("destination db");
    session_persistence::init_session_tables(&conn).expect("session schema");
    conn
}

fn begin_replace(root: &Path, session_id: &str, epoch: i64, count: u64, frozen_seq: u64) -> String {
    begin_at_root(
        root,
        CollaborationSnapshotIngestBeginRequest {
            local_session_id: session_id.to_string(),
            epoch,
            expected_count: count,
            expected_frozen_seq: frozen_seq,
            tail_hash: None,
            replace: true,
            previous: None,
        },
    )
    .expect("begin ingest")
    .token
}

#[test]
fn v1_backward_pages_publish_atomically_and_namespace_ids() {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path();
    let destination = destination();
    let session_id = "imported-session-v1-pages";
    let first = test_event("first", EventSource::User, "hello");
    let second = test_event("second", EventSource::Assistant, "world");
    let token = begin_replace(root, session_id, 4, 2, 2);
    let second_wire = v1_wire(2, std::slice::from_ref(&second));
    apply_page_at_root(
        root,
        backward_page(&token, 4, 2, 2, None, Some(2), vec![second_wire]),
    )
    .expect("newest page");
    let first_wire = v1_wire(1, std::slice::from_ref(&first));
    apply_page_at_root(
        root,
        backward_page(&token, 4, 2, 2, Some(2), None, vec![first_wire]),
    )
    .expect("oldest page");

    let result =
        commit_at_root_with_connection(root, &token, &destination).expect("publish snapshot");
    assert_eq!(result.event_count, 2);
    assert_eq!(result.frozen_event_count, 2);
    assert_eq!(
        result.handoff_items,
        vec!["User: hello", "Assistant: world"]
    );
    let ids = destination
        .prepare("SELECT id FROM events WHERE session_id=?1 ORDER BY history_sequence")
        .expect("prepare ids")
        .query_map([session_id], |row| row.get::<_, String>(0))
        .expect("query ids")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("collect ids");
    assert_eq!(
        ids,
        vec![
            format!("{session_id}~first"),
            format!("{session_id}~second")
        ]
    );
    assert!(!staging_path(root, &token).expect("stage path").exists());
}

#[test]
fn native_fork_snapshot_publishes_without_external_replay_accounting() {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path();
    let destination = destination();
    let session_id = "agentsession-cloud-fork";
    let event = test_event("source-event", EventSource::User, "fork context");
    let token = begin_replace(root, session_id, 9, 1, 1);
    let wire = v1_wire(1, std::slice::from_ref(&event));
    apply_page_at_root(root, backward_page(&token, 9, 1, 1, None, None, vec![wire]))
        .expect("stage native fork snapshot");
    let result = commit_at_root_with_connection(root, &token, &destination)
        .expect("publish native fork snapshot");
    assert_eq!(result.local_session_id, session_id);
    assert_eq!(result.handoff_items, vec!["User: fork context"]);
    let event_id: String = destination
        .query_row(
            "SELECT id FROM events WHERE session_id=?1",
            [session_id],
            |row| row.get(0),
        )
        .expect("native fork event");
    assert_eq!(event_id, format!("{session_id}~source-event"));
    let replay_state_table: i64 = destination
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
                 WHERE type='table' AND name='collaboration_replay_state'",
            [],
            |row| row.get(0),
        )
        .expect("replay state table count");
    assert_eq!(replay_state_table, 0);
    assert!(has_snapshot_backed_native_fork(&destination, session_id)
        .expect("probe intact native fork"));
    assert!(has_native_snapshot_marker(&destination, session_id)
        .expect("read native fork origin marker"));
    let initial_state = collaboration_snapshot_secondary_state(&destination, session_id)
        .expect("read initial native fork secondary state")
        .expect("native fork has secondary state");
    assert_eq!(initial_state.revision, 0);
    assert_eq!(initial_state.reset_revision, 0);
    assert_eq!(initial_state.max_sequence, 0);
    assert_eq!(initial_state.event_count, 1);

    let replacement = test_event("source-event", EventSource::User, "new fork context");
    let replacement_token = begin_replace(root, session_id, 10, 1, 1);
    let replacement_wire = v1_wire(1, std::slice::from_ref(&replacement));
    apply_page_at_root(
        root,
        backward_page(
            &replacement_token,
            10,
            1,
            1,
            None,
            None,
            vec![replacement_wire],
        ),
    )
    .expect("stage replacement native fork snapshot");
    commit_at_root_with_connection(root, &replacement_token, &destination)
        .expect("replace native fork snapshot");
    let replaced_state = collaboration_snapshot_secondary_state(&destination, session_id)
        .expect("read replaced native fork secondary state")
        .expect("replaced native fork remains snapshot-backed");
    assert_ne!(replaced_state.generation, initial_state.generation);
    assert_eq!(replaced_state.revision, initial_state.revision + 1);
    assert_eq!(replaced_state.reset_revision, replaced_state.revision);
    assert_eq!(replaced_state.max_sequence, 0);
    assert_eq!(replaced_state.event_count, 1);

    destination
        .execute(
            "INSERT INTO events(
                   id,session_id,event_type,function_name,args_json,result_json,
                   content,created_at,history_sequence
                 ) VALUES(?1,?2,'assistant_message','agent_message','{}','{}',
                          'native suffix','2026-07-22T00:00:01.000Z',1)",
            params![format!("{session_id}~native-suffix"), session_id],
        )
        .expect("append native suffix event");
    destination
        .execute(
            "UPDATE sessions SET event_count=2 WHERE session_id=?1",
            [session_id],
        )
        .expect("publish native suffix count");
    assert!(has_snapshot_backed_native_fork(&destination, session_id)
        .expect("probe native fork with suffix"));
    let appended_state = collaboration_snapshot_secondary_state(&destination, session_id)
        .expect("read appended native fork secondary state")
        .expect("native fork remains snapshot-backed");
    assert_eq!(appended_state.generation, replaced_state.generation);
    assert_eq!(appended_state.revision, replaced_state.revision + 1);
    assert_eq!(appended_state.reset_revision, replaced_state.reset_revision);
    assert_eq!(appended_state.max_sequence, 1);
    assert_eq!(appended_state.event_count, 2);

    destination
        .execute(
            "UPDATE events SET result_json='{\"content\":\"updated suffix\"}'
                 WHERE id=?1",
            [format!("{session_id}~native-suffix")],
        )
        .expect("update native suffix event");
    let updated_state = collaboration_snapshot_secondary_state(&destination, session_id)
        .expect("read updated native fork secondary state")
        .expect("updated native fork remains snapshot-backed");
    assert_eq!(updated_state.generation, appended_state.generation);
    assert_eq!(updated_state.revision, appended_state.revision + 1);
    assert_eq!(updated_state.reset_revision, updated_state.revision);
    assert_eq!(updated_state.max_sequence, 1);
    assert_eq!(updated_state.event_count, 2);

    destination
        .execute(
            "DELETE FROM events WHERE id=?1",
            [format!("{session_id}~source-event")],
        )
        .expect("remove inherited sentinel");
    assert!(!has_snapshot_backed_native_fork(&destination, session_id)
        .expect("reject hollow native fork"));
    assert!(has_native_snapshot_marker(&destination, session_id)
        .expect("damaged snapshot still fails closed for background consumers"));
    assert!(
        !has_snapshot_backed_native_fork(&destination, "agentsession-native")
            .expect("ordinary native session has no snapshot")
    );
    assert!(
        !has_snapshot_backed_native_fork(&destination, "sdeagent-native")
            .expect("SDE session is never snapshot-backed")
    );
}

#[test]
fn cursor_query_returns_only_an_intact_imported_snapshot() {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path();
    let destination = destination();
    let session_id = "imported-session-cursor";
    let event = test_event("cursor-event", EventSource::User, "cursor payload");
    let token = begin_replace(root, session_id, 12, 1, 1);
    let wire = v1_wire(1, std::slice::from_ref(&event));
    apply_page_at_root(
        root,
        backward_page(&token, 12, 1, 1, None, None, vec![wire]),
    )
    .expect("stage cursor snapshot");
    commit_at_root_with_connection(root, &token, &destination).expect("publish cursor snapshot");

    let intact_cursor = get_cursor_from_connection(&destination, session_id)
        .expect("read intact cursor")
        .expect("intact cursor exists");
    assert_eq!(
        intact_cursor,
        CollaborationSnapshotCursor {
            epoch: 12,
            frozen_seq: 1,
            count: 1,
            frozen_count: 1,
            tail_hash: None,
        }
    );
    assert_eq!(
        serde_json::to_value(&intact_cursor).expect("serialize cursor wire value"),
        serde_json::json!({
            "epoch": 12,
            "frozenSeq": 1,
            "count": 1,
            "frozenCount": 1,
            "tailHash": null,
        })
    );

    let trigger_count: i64 = destination
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
                 WHERE type='trigger' AND name LIKE 'collaboration_snapshot_%_invalidate'",
            [],
            |row| row.get(0),
        )
        .expect("snapshot invalidation trigger count");
    assert_eq!(trigger_count, SNAPSHOT_INVALIDATION_TRIGGER_COUNT);
    let query_plan = destination
        .prepare(&format!("EXPLAIN QUERY PLAN {CURSOR_SENTINEL_SQL}"))
        .expect("prepare sentinel query plan")
        .query_map(params![session_id, 0_i64], |row| row.get::<_, String>(3))
        .expect("query sentinel plan")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("collect sentinel plan");
    assert!(query_plan
        .iter()
        .any(|detail| detail.contains("idx_collaboration_snapshot_event_order")));
    assert!(!query_plan
        .iter()
        .any(|detail| detail.contains("SCAN m") || detail.contains("SCAN e")));

    destination
        .execute("DELETE FROM events WHERE session_id=?1", [session_id])
        .expect("make snapshot hollow");
    let state_rows: i64 = destination
        .query_row(
            "SELECT COUNT(*) FROM collaboration_snapshot_ingest_state
                 WHERE session_id=?1",
            [session_id],
            |row| row.get(0),
        )
        .expect("count invalidated state");
    assert_eq!(state_rows, 0);
    assert_eq!(
        get_cursor_from_connection(&destination, session_id).expect("read hollow cursor"),
        None
    );

    destination
        .execute(
            "INSERT INTO collaboration_snapshot_ingest_state(
                   session_id,epoch,frozen_seq,event_count,frozen_event_count,tail_hash,updated_at
                 ) VALUES(?1,12,1,1,1,NULL,0)",
            [session_id],
        )
        .expect("restore stale cursor state");
    assert_eq!(
        get_cursor_from_connection(&destination, session_id)
            .expect("sentinel rejects hollow cursor"),
        None
    );
    destination
        .execute(
            "UPDATE collaboration_snapshot_ingest_state SET event_count=-1
                 WHERE session_id=?1",
            [session_id],
        )
        .expect("corrupt cursor state");
    assert_eq!(
        get_cursor_from_connection(&destination, session_id).expect("read invalid cursor"),
        None
    );

    let repair_event = test_event("repair-event", EventSource::Assistant, "repaired");
    let repair_token = begin_replace(root, session_id, 13, 1, 1);
    let repair_wire = v1_wire(1, std::slice::from_ref(&repair_event));
    apply_page_at_root(
        root,
        backward_page(&repair_token, 13, 1, 1, None, None, vec![repair_wire]),
    )
    .expect("stage repaired cursor snapshot");
    commit_at_root_with_connection(root, &repair_token, &destination)
        .expect("full replacement repairs an invalid cursor");
    assert_eq!(
        get_cursor_from_connection(&destination, session_id).expect("read repaired cursor"),
        Some(CollaborationSnapshotCursor {
            epoch: 13,
            frozen_seq: 1,
            count: 1,
            frozen_count: 1,
            tail_hash: None,
        })
    );
}

#[test]
fn cursor_query_rejects_native_agent_sessions() {
    let destination = destination();
    let error = get_cursor_from_connection(&destination, "agentsession-native-fork")
        .expect_err("native sessions must not expose external snapshot cursors");
    assert!(error.contains("only imported-session"));
}

#[test]
fn incremental_destination_queries_use_indexes_on_a_large_map() {
    let mut destination = destination();
    let session_id = "imported-session-large-cursor-map";
    let tx = destination.transaction().expect("large map transaction");
    ensure_destination_schema(&tx).expect("snapshot schema");
    create_destination_indexes(&tx).expect("snapshot indexes");
    tx.execute_batch(
        "WITH digits(n) AS (
               VALUES(0),(1),(2),(3),(4),(5),(6),(7),(8),(9)
             ), sequence(i) AS (
               SELECT a.n + 10*b.n + 100*c.n + 1000*d.n
               FROM digits a CROSS JOIN digits b CROSS JOIN digits c CROSS JOIN digits d
             )
             INSERT INTO events(
               id,session_id,event_type,function_name,args_json,result_json,
               content,created_at,history_sequence
             )
             SELECT printf('imported-session-large-cursor-map~event-%d',i),
                    'imported-session-large-cursor-map','user_message','user_message',
                    '{}','{}','','2026-07-22T00:00:00.000Z',i
             FROM sequence;

             WITH digits(n) AS (
               VALUES(0),(1),(2),(3),(4),(5),(6),(7),(8),(9)
             ), sequence(i) AS (
               SELECT a.n + 10*b.n + 100*c.n + 1000*d.n
               FROM digits a CROSS JOIN digits b CROSS JOIN digits c CROSS JOIN digits d
             )
             INSERT INTO collaboration_snapshot_event_map(
               session_id,event_id,original_id,physical_seq,event_index,logical_index,is_tail
             )
             SELECT 'imported-session-large-cursor-map',
                    printf('imported-session-large-cursor-map~event-%d',i),
                    printf('event-%d',i),i+1,0,i,0
             FROM sequence;

             INSERT INTO sessions(session_id,event_count,cached_at)
             VALUES('imported-session-large-cursor-map',10000,0);
             INSERT INTO collaboration_snapshot_ingest_state(
               session_id,epoch,frozen_seq,event_count,frozen_event_count,tail_hash,updated_at
             ) VALUES('imported-session-large-cursor-map',1,10000,10000,10000,NULL,0);",
    )
    .expect("seed large cursor map");
    tx.commit().expect("commit large cursor map");

    let cursor = get_cursor_from_connection(&destination, session_id)
        .expect("read large cursor map")
        .expect("large cursor remains healthy");
    assert_eq!(cursor.count, 10_000);
    let query_plan = destination
        .prepare(&format!("EXPLAIN QUERY PLAN {CURSOR_SENTINEL_SQL}"))
        .expect("prepare large sentinel query plan")
        .query_map(params![session_id, 9_999_i64], |row| {
            row.get::<_, String>(3)
        })
        .expect("query large sentinel plan")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("collect large sentinel plan");
    assert!(query_plan
        .iter()
        .any(|detail| detail.contains("idx_collaboration_snapshot_event_order")));
    assert!(!query_plan
        .iter()
        .any(|detail| detail.contains("SCAN m") || detail.contains("SCAN e")));

    let delete_tail_plan = destination
        .prepare(&format!("EXPLAIN QUERY PLAN {DELETE_TAIL_EVENTS_SQL}"))
        .expect("prepare indexed tail delete plan")
        .query_map([session_id], |row| row.get::<_, String>(3))
        .expect("query indexed tail delete plan")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("collect indexed tail delete plan");
    assert!(delete_tail_plan
        .iter()
        .any(|detail| detail.contains("idx_collaboration_snapshot_event_tail")));
    assert!(!delete_tail_plan.iter().any(|detail| {
        let detail = detail.to_ascii_uppercase();
        detail.contains("SCAN EVENTS") || detail.contains("SCAN COLLABORATION_SNAPSHOT_EVENT_MAP")
    }));
    let delete_tail_map_plan = destination
        .prepare(&format!("EXPLAIN QUERY PLAN {DELETE_TAIL_MAP_SQL}"))
        .expect("prepare indexed tail map delete plan")
        .query_map([session_id], |row| row.get::<_, String>(3))
        .expect("query indexed tail map delete plan")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("collect indexed tail map delete plan");
    assert!(delete_tail_map_plan
        .iter()
        .any(|detail| detail.contains("idx_collaboration_snapshot_event_tail")));
    assert!(!delete_tail_map_plan.iter().any(|detail| {
        detail
            .to_ascii_uppercase()
            .contains("SCAN COLLABORATION_SNAPSHOT_EVENT_MAP")
    }));

    let handoff_plan = destination
        .prepare(
            "EXPLAIN QUERY PLAN
                 SELECT id FROM events
                 WHERE session_id=?1 AND history_sequence IS NOT NULL
                 ORDER BY history_sequence DESC LIMIT 400",
        )
        .expect("prepare bounded handoff plan")
        .query_map([session_id], |row| row.get::<_, String>(3))
        .expect("query bounded handoff plan")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("collect bounded handoff plan");
    assert!(handoff_plan
        .iter()
        .any(|detail| detail.contains("idx_events_session_sequence")));
    assert!(!handoff_plan
        .iter()
        .any(|detail| { detail.to_ascii_uppercase().contains("SCAN EVENTS") }));

    let replay_sql = PUBLISH_REPLAY_ACCOUNTING_SQL.to_ascii_uppercase();
    assert!(!replay_sql.contains("SELECT"));
    assert!(!replay_sql.contains("FROM EVENTS"));
    assert!(!replay_sql.contains("COUNT("));
    assert!(!replay_sql.contains("MAX("));
}

#[test]
fn commit_handoff_is_last_80_bounded_items_and_skips_thinking() {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path();
    let destination = destination();
    let session_id = "agentsession-bounded-handoff";
    let mut events = (0..82)
        .map(|index| {
            test_event(
                &format!("user-{index}"),
                EventSource::User,
                &format!("{index}-{}", "x".repeat(2_000)),
            )
        })
        .collect::<Vec<_>>();
    let mut thinking = test_event("thinking", EventSource::Assistant, "private reasoning");
    thinking.action_type = "thinking".to_string();
    thinking.function_name = "reasoning".to_string();
    thinking.display_variant = EventDisplayVariant::Thinking;
    events.push(thinking);
    let token = begin_replace(root, session_id, 1, events.len() as u64, 1);
    let wire = v1_wire(1, &events);
    apply_page_at_root(
        root,
        backward_page(&token, 1, 1, events.len() as u64, None, None, vec![wire]),
    )
    .expect("stage handoff events");
    let result =
        commit_at_root_with_connection(root, &token, &destination).expect("publish handoff events");
    assert_eq!(result.handoff_items.len(), HANDOFF_MAX_ITEMS);
    assert!(result
        .handoff_items
        .iter()
        .all(|item| item.encode_utf16().count() <= HANDOFF_MAX_ITEM_UTF16));
    assert!(result
        .handoff_items
        .iter()
        .all(|item| !item.contains("private reasoning")));
    assert!(result.handoff_scanned_bytes <= HANDOFF_SCAN_BYTES as u64);
}

#[test]
fn incremental_publish_preserves_frozen_prefix_and_replaces_tail() {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path();
    let destination = destination();
    let session_id = "imported-session-incremental";
    let mut first = test_event("first", EventSource::User, "first");
    first.created_at = "2026-07-20T00:00:00.000Z".to_string();
    let mut old_tail = test_event("old-tail", EventSource::Assistant, "old tail");
    old_tail.created_at = "2026-07-21T00:00:00.000Z".to_string();
    let first_wire = v1_wire(1, std::slice::from_ref(&first));
    let old_tail_wire = v1_wire(0, std::slice::from_ref(&old_tail));
    let old_tail_hash = old_tail_wire.segment_hash.clone();
    let token = begin_at_root(
        root,
        CollaborationSnapshotIngestBeginRequest {
            local_session_id: session_id.to_string(),
            epoch: 1,
            expected_count: 2,
            expected_frozen_seq: 1,
            tail_hash: Some(old_tail_hash.clone()),
            replace: true,
            previous: None,
        },
    )
    .expect("begin initial snapshot")
    .token;
    let segments = vec![first_wire, old_tail_wire];
    apply_page_at_root(
        root,
        CollaborationSnapshotIngestPageRequest {
            token: token.clone(),
            epoch: 1,
            frozen_seq: 1,
            count: 2,
            tail_hash: Some(old_tail_hash.clone()),
            cursor: CollaborationSnapshotWireCursor::Backward { before_seq: None },
            next_cursor: None,
            tail_included: true,
            has_more: false,
            returned_wire_bytes: page_bytes(&segments),
            segments,
        },
    )
    .expect("stage initial snapshot");
    commit_at_root_with_connection(root, &token, &destination).expect("publish initial snapshot");

    let previous = CollaborationSnapshotCursor {
        epoch: 1,
        frozen_seq: 1,
        count: 2,
        frozen_count: 1,
        tail_hash: Some(old_tail_hash),
    };
    let mut second = test_event("second", EventSource::User, "second");
    second.created_at = "2026-07-22T00:00:00.000Z".to_string();
    let mut new_tail = test_event("new-tail", EventSource::Assistant, "new tail");
    new_tail.created_at = "2026-07-23T00:00:00.000Z".to_string();
    let second_wire = v1_wire(2, std::slice::from_ref(&second));
    let new_tail_wire = v1_wire(0, std::slice::from_ref(&new_tail));
    let new_tail_hash = new_tail_wire.segment_hash.clone();
    let token = begin_at_root(
        root,
        CollaborationSnapshotIngestBeginRequest {
            local_session_id: session_id.to_string(),
            epoch: 1,
            expected_count: 3,
            expected_frozen_seq: 2,
            tail_hash: Some(new_tail_hash.clone()),
            replace: false,
            previous: Some(previous),
        },
    )
    .expect("begin incremental snapshot")
    .token;
    let segments = vec![second_wire, new_tail_wire];
    apply_page_at_root(
        root,
        CollaborationSnapshotIngestPageRequest {
            token: token.clone(),
            epoch: 1,
            frozen_seq: 2,
            count: 3,
            tail_hash: Some(new_tail_hash.clone()),
            cursor: CollaborationSnapshotWireCursor::Forward {
                after_seq: 1,
                through_seq: Some(2),
            },
            next_cursor: None,
            tail_included: true,
            has_more: false,
            returned_wire_bytes: page_bytes(&segments),
            segments,
        },
    )
    .expect("stage incremental snapshot");
    let result = commit_at_root_with_connection(root, &token, &destination)
        .expect("publish incremental snapshot");
    assert_eq!(result.event_count, 3);
    assert_eq!(result.frozen_event_count, 2);
    assert_eq!(result.tail_hash.as_deref(), Some(new_tail_hash.as_str()));
    let ids = destination
        .prepare("SELECT id FROM events WHERE session_id=?1 ORDER BY history_sequence")
        .expect("prepare ids")
        .query_map([session_id], |row| row.get::<_, String>(0))
        .expect("query ids")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("collect ids");
    assert_eq!(
        ids,
        vec![
            format!("{session_id}~first"),
            format!("{session_id}~second"),
            format!("{session_id}~new-tail"),
        ]
    );
    let session_time_range: (Option<String>, Option<String>) = destination
        .query_row(
            "SELECT time_range_start,time_range_end FROM sessions WHERE session_id=?1",
            [session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("incremental session time range");
    assert_eq!(
        session_time_range,
        (
            Some("2026-07-20T00:00:00.000Z".to_string()),
            Some("2026-07-23T00:00:00.000Z".to_string()),
        )
    );

    let replay_accounting_before: (i64, i64, i64, i64) = destination
        .query_row(
            "SELECT generation,revision,max_sequence,event_count
                 FROM collaboration_replay_state WHERE session_id=?1",
            [session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("replay accounting before no-op");
    assert_eq!(replay_accounting_before, (1, 3, 2, 3));
    let unchanged_cursor = CollaborationSnapshotCursor {
        epoch: 1,
        frozen_seq: 2,
        count: 3,
        frozen_count: 2,
        tail_hash: Some(new_tail_hash.clone()),
    };
    let unchanged_tail_wire = v1_wire(0, std::slice::from_ref(&new_tail));
    let token = begin_at_root(
        root,
        CollaborationSnapshotIngestBeginRequest {
            local_session_id: session_id.to_string(),
            epoch: 1,
            expected_count: 3,
            expected_frozen_seq: 2,
            tail_hash: Some(new_tail_hash.clone()),
            replace: false,
            previous: Some(unchanged_cursor),
        },
    )
    .expect("begin unchanged snapshot")
    .token;
    let segments = vec![unchanged_tail_wire];
    apply_page_at_root(
        root,
        CollaborationSnapshotIngestPageRequest {
            token: token.clone(),
            epoch: 1,
            frozen_seq: 2,
            count: 3,
            tail_hash: Some(new_tail_hash),
            cursor: CollaborationSnapshotWireCursor::Forward {
                after_seq: 2,
                through_seq: Some(2),
            },
            next_cursor: None,
            tail_included: true,
            has_more: false,
            returned_wire_bytes: page_bytes(&segments),
            segments,
        },
    )
    .expect("stage unchanged snapshot");
    commit_at_root_with_connection(root, &token, &destination).expect("commit unchanged snapshot");
    let replay_accounting_after: (i64, i64, i64, i64) = destination
        .query_row(
            "SELECT generation,revision,max_sequence,event_count
                 FROM collaboration_replay_state WHERE session_id=?1",
            [session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("replay accounting after no-op");
    assert_eq!(replay_accounting_after, replay_accounting_before);
}

fn v2_wires(event: &SessionEvent) -> Vec<CollaborationSnapshotWire> {
    let event_bytes = serde_json::to_vec(event).expect("serialize attachment event");
    let attachment_hash = sha256_hex(&event_bytes);
    let attachment_id = sha256_hex(event.id.as_bytes());
    let chunk_bytes = 176 * 1024;
    event_bytes
        .chunks(chunk_bytes)
        .enumerate()
        .map(|(part_index, chunk)| {
            let chunk_offset = part_index * chunk_bytes;
            let final_part = chunk_offset + chunk.len() == event_bytes.len();
            let header = serde_json::json!({
                "kind": "event",
                "attachmentId": attachment_id,
                "partIndex": part_index,
                "chunkOffset": chunk_offset,
                "chunkBytes": chunk.len(),
                "finalPart": final_part,
                "eventBytes": final_part.then_some(event_bytes.len()),
                "attachmentHash": final_part.then_some(attachment_hash.clone()),
            });
            let header_bytes = serde_json::to_vec(&header).expect("serialize frame header");
            let mut frame =
                Vec::with_capacity(FRAME_MAGIC.len() + 4 + header_bytes.len() + chunk.len());
            frame.extend_from_slice(FRAME_MAGIC);
            frame.extend_from_slice(&(header_bytes.len() as u32).to_be_bytes());
            frame.extend_from_slice(&header_bytes);
            frame.extend_from_slice(chunk);
            CollaborationSnapshotWire {
                seq: part_index as u64 + 1,
                payload_gz: gzip_base64(&frame),
                event_count: u64::from(final_part),
                segment_hash: sha256_hex(&frame),
            }
        })
        .collect()
}

#[test]
fn v2_ten_mib_event_stages_parts_and_restores_exact_payload() {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path();
    let destination = destination();
    let session_id = "imported-session-v2-large";
    let payload = "x".repeat(10 * 1024 * 1024);
    let mut event = test_event("large", EventSource::Assistant, "large result");
    event.result = serde_json::json!({ "content": payload.clone() });
    let wires = v2_wires(&event);
    assert!(wires.iter().all(|wire| {
        serde_json::to_vec(wire).expect("measure v2 wire").len() <= MAX_WIRE_BYTES
    }));
    let frozen_seq = wires.len() as u64;
    let token = begin_replace(root, session_id, 7, 1, frozen_seq);
    let mut after_seq = 0_u64;
    for (index, chunk) in wires.chunks(12).enumerate() {
        let has_more = (index + 1) * 12 < wires.len();
        let page = forward_page(
            &token,
            7,
            frozen_seq,
            1,
            after_seq,
            chunk.to_vec(),
            has_more,
        );
        after_seq = chunk.last().expect("wire chunk").seq;
        apply_page_at_root(root, page).expect("stage v2 page");
    }
    let result =
        commit_at_root_with_connection(root, &token, &destination).expect("publish v2 snapshot");
    assert_eq!(result.event_count, 1);
    let result_json: String = destination
        .query_row(
            "SELECT result_json FROM events WHERE session_id=?1",
            [session_id],
            |row| row.get(0),
        )
        .expect("load large result");
    let restored: serde_json::Value = serde_json::from_str(&result_json).expect("parse result");
    let restored_payload = restored
        .get("content")
        .and_then(serde_json::Value::as_str)
        .expect("content");
    assert_eq!(restored_payload.len(), 10 * 1024 * 1024);
    assert_eq!(
        sha256_hex(restored_payload.as_bytes()),
        sha256_hex(payload.as_bytes())
    );
}

#[test]
fn hash_gap_and_abort_fail_closed() {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path();
    let destination = destination();
    let session_id = "imported-session-fail-closed";
    let event = test_event("event", EventSource::User, "payload");

    let bad_token = begin_replace(root, session_id, 1, 1, 1);
    let mut bad_wire = v1_wire(1, std::slice::from_ref(&event));
    bad_wire.segment_hash = "0".repeat(64);
    let error = apply_page_at_root(
        root,
        backward_page(&bad_token, 1, 1, 1, None, None, vec![bad_wire]),
    )
    .expect_err("hash mismatch must fail");
    assert!(error.contains("hash mismatch"));
    abort_at_root(root, &bad_token).expect("abort bad token");
    assert!(!staging_path(root, &bad_token)
        .expect("bad stage path")
        .exists());

    let gap_token = begin_replace(root, session_id, 2, 1, 2);
    let wire = v1_wire(2, std::slice::from_ref(&event));
    apply_page_at_root(
        root,
        backward_page(&gap_token, 2, 2, 1, None, None, vec![wire]),
    )
    .expect("stage gapped page");
    let error = commit_at_root_with_connection(root, &gap_token, &destination)
        .expect_err("missing physical row must fail");
    assert!(error.contains("incomplete"));
    assert_eq!(
        destination
            .query_row("SELECT COUNT(*) FROM events", [], |row| row
                .get::<_, i64>(0))
            .expect("count destination"),
        0
    );
    assert!(!staging_path(root, &gap_token)
        .expect("gap stage path")
        .exists());
}

#[test]
fn commit_failure_rolls_back_old_snapshot_and_cleans_staging() {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path();
    let destination = destination();
    let session_id = "imported-session-rollback";
    destination
            .execute(
                "INSERT INTO events(
                   id,session_id,event_type,args_json,result_json,content,created_at,history_sequence
                 ) VALUES('old',?1,'user_message','{}','{}','old','2026-01-01',0)",
                [session_id],
            )
            .expect("seed old event");
    destination
        .execute_batch(
            "CREATE TRIGGER reject_new_snapshot BEFORE INSERT ON events
                 WHEN NEW.id LIKE '%~new'
                 BEGIN SELECT RAISE(ABORT,'forced commit failure'); END;",
        )
        .expect("failure trigger");
    let token = begin_replace(root, session_id, 3, 1, 1);
    let wire = v1_wire(
        1,
        &[test_event("new", EventSource::Assistant, "replacement")],
    );
    apply_page_at_root(root, backward_page(&token, 3, 1, 1, None, None, vec![wire]))
        .expect("stage replacement");
    let error = commit_at_root_with_connection(root, &token, &destination)
        .expect_err("forced publish failure");
    assert!(error.contains("forced commit failure"));
    let ids = destination
        .prepare("SELECT id FROM events WHERE session_id=?1")
        .expect("prepare retained ids")
        .query_map([session_id], |row| row.get::<_, String>(0))
        .expect("query retained ids")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("collect retained ids");
    assert_eq!(ids, vec!["old"]);
    assert!(!staging_path(root, &token).expect("stage path").exists());
}
