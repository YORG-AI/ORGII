use super::*;
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};

static TITLE_REPAIR_FIXTURE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn title_repair_fixture(
    current_name: &str,
    transcript_lines: &[Value],
) -> (Connection, DiscoveredCodexCatalogRecord, PathBuf) {
    let path = std::env::temp_dir().join(format!(
        "orgii-codex-title-repair-{}-{}.jsonl",
        std::process::id(),
        TITLE_REPAIR_FIXTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let body = transcript_lines
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(&path, format!("{body}\n")).expect("write Codex title fixture");
    let metadata = fs::metadata(&path).expect("Codex title fixture metadata");
    let source_session_id = "rollout-title-fixture".to_string();
    let record = ImportedHistoryDiscoveredRecord {
        source_session_id: source_session_id.clone(),
        source_path: path.clone(),
        source_record_key: source_session_id.clone(),
        source_mtime_ms: 1_774_137_600_000_000_000,
        source_size_bytes: i64::try_from(metadata.len()).expect("fixture size"),
        source_fingerprint: String::new(),
        parser_version: CODEX_APP_METADATA_PARSER_VERSION,
    };

    let conn = Connection::open_in_memory().expect("catalog DB");
    SqliteRecordStore::init_tables(&conn).expect("core schema");
    SqliteRecordStore::init_source_cache_tables(&conn).expect("catalog schema");
    conn.execute(
        "INSERT INTO imported_history_session_cache(
                source,source_session_id,session_id,source_path,source_record_key,
                source_mtime_ms,source_size_bytes,source_fingerprint,parser_version,
                name,created_at_ms,updated_at_ms,model,input_tokens,output_tokens,
                cache_read_tokens,cache_write_tokens,repo_path,branch,files_changed,
                lines_added,lines_removed,touched_files_json,listable,
                source_metadata_json,parent_session_id,updated_at
             ) VALUES(
                'codex_app',?1,'codexapp-title-fixture',?2,?1,
                ?3,?4,'',?5,?6,1,1,'',0,0,0,0,'','',0,0,0,'[]',0,
                '{\"adapterOwned\":{\"keep\":true},\"unrelated\":\"preserve-me\"}',
                'codexapp-parent','2026-07-22T00:00:00Z'
             )",
        (
            &source_session_id,
            path.to_string_lossy().to_string(),
            record.source_mtime_ms,
            record.source_size_bytes,
            record.parser_version,
            current_name,
        ),
    )
    .expect("insert cached Codex title");
    conn.execute(
        "INSERT INTO imported_replay_catalog_derivations(
                source,source_session_id,baseline_json,applied_json,updated_at
             ) VALUES('codex_app',?1,'{\"name\":\"older-tool\"}',?2,
                '2026-07-22T00:00:00Z')",
        (
            &source_session_id,
            serde_json::json!({"name": current_name}).to_string(),
        ),
    )
    .expect("insert replay title ownership");

    (
        conn,
        DiscoveredCodexCatalogRecord {
            record,
            authoritative_title: None,
        },
        path,
    )
}

fn cached_title(conn: &Connection) -> (String, i64, String) {
    conn.query_row(
        "SELECT name,listable,parent_session_id
             FROM imported_history_session_cache
             WHERE source='codex_app'
               AND source_session_id='rollout-title-fixture'",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )
    .expect("read repaired Codex title")
}

fn cached_title_verification_signature(conn: &Connection) -> Option<String> {
    cached_source_metadata(conn)
        .get(CODEX_TITLE_REPAIR_SIGNATURE_FIELD)
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn cached_source_metadata(conn: &Connection) -> Value {
    conn.query_row(
        "SELECT source_metadata_json
             FROM imported_history_session_cache
             WHERE source='codex_app'
               AND source_session_id='rollout-title-fixture'",
        [],
        |row| row.get::<_, String>(0),
    )
    .expect("read Codex source metadata")
    .parse::<Value>()
    .expect("parse Codex source metadata")
}

fn assert_unrelated_source_metadata_survives(conn: &Connection) {
    let metadata = cached_source_metadata(conn);
    assert_eq!(
        metadata.pointer("/adapterOwned/keep"),
        Some(&Value::Bool(true))
    );
    assert_eq!(
        metadata.get("unrelated").and_then(Value::as_str),
        Some("preserve-me")
    );
}

fn publish_title_fixture_projection(
    conn: &mut Connection,
    record: &ImportedHistoryDiscoveredRecord,
    model: Option<&str>,
) {
    // `title_repair_fixture` seeds the minimal legacy ownership shape used
    // by title repair itself. Replay publication expects the modern full
    // snapshot shape, so start a fresh derivation exactly as a post-prune
    // replay generation would.
    conn.execute(
        "DELETE FROM imported_replay_catalog_derivations
             WHERE source='codex_app' AND source_session_id=?1",
        [&record.source_session_id],
    )
    .expect("clear legacy title-only derivation");
    let driver_cursor = serde_json::json!({
        "catalog": crate::sources::imported_history::catalog::ReplayCatalogProjection {
            model: model.map(str::to_string),
            ..Default::default()
        }
    })
    .to_string();
    let tx = conn.transaction().expect("replay catalog transaction");
    crate::sources::imported_history::catalog::publish_from_replay_tx(
        &tx,
        crate::sources::imported_history::replay::ImportedHistorySourceId::CodexApp,
        &record.source_session_id,
        "title-fixture-generation",
        0,
        false,
        record.source_mtime_ms,
        &driver_cursor,
    )
    .expect("publish replay catalog projection");
    tx.commit().expect("commit replay catalog projection");
}

#[test]
fn authoritative_index_title_repairs_pollution_without_changing_visibility_or_parent() {
    let (mut conn, mut discovered, path) = title_repair_fixture("update_plan", &[]);
    discovered.authoritative_title = Some("Human session title".to_string());

    repair_codex_catalog_titles(&mut conn, &[discovered]).expect("repair from Codex session index");

    assert_eq!(
        cached_title(&conn),
        (
            "Human session title".to_string(),
            0,
            "codexapp-parent".to_string()
        ),
        "managed/subagent visibility and parent placement must remain adapter-owned"
    );
    fs::remove_file(path).expect("remove title fixture");
}

#[test]
fn polluted_title_without_an_index_uses_first_real_user_prompt() {
    let (mut conn, discovered, path) = title_repair_fixture(
        "update_plan",
        &[
            json!({
                "timestamp":"2026-07-22T00:00:00Z",
                "type":"response_item",
                "payload":{"type":"custom_tool_call","name":"update_plan"}
            }),
            json!({
                "timestamp":"2026-07-22T00:00:01Z",
                "type":"event_msg",
                "payload":{"type":"user_message","message":"Investigate bounded replay"}
            }),
            json!({
                "timestamp":"2026-07-22T00:00:02Z",
                "type":"response_item",
                "payload":{"type":"function_call","name":"exec"}
            }),
        ],
    );

    repair_codex_catalog_titles(&mut conn, &[discovered]).expect("repair from first user prompt");

    assert_eq!(cached_title(&conn).0, "Investigate bounded replay");
    fs::remove_file(path).expect("remove title fixture");
}

#[test]
fn verified_replay_title_does_not_reopen_unchanged_jsonl_prefix() {
    let (mut conn, discovered, path) = title_repair_fixture(
        "Investigate bounded replay",
        &[json!({
            "timestamp":"2026-07-22T00:00:01Z",
            "type":"event_msg",
            "payload":{"type":"user_message","message":"Investigate bounded replay"}
        })],
    );

    repair_codex_catalog_titles(&mut conn, std::slice::from_ref(&discovered))
        .expect("verify replay-owned title from first user prompt");
    assert_eq!(cached_title(&conn).0, "Investigate bounded replay");
    let initial_verified_signature = cached_title_verification_signature(&conn)
        .expect("verification must live with adapter metadata");

    // A logical/no-change replay publication rewrites its derivation
    // baseline/applied snapshots. Verification must not be stored in that
    // disposable lifecycle because compact-index prune deletes it.
    publish_title_fixture_projection(&mut conn, &discovered.record, None);
    assert_eq!(
        cached_title_verification_signature(&conn).as_deref(),
        Some(initial_verified_signature.as_str())
    );

    // Discovery growth advances only physical signature fields. It must
    // preserve adapter-owned metadata instead of forcing another prefix
    // read on the next unchanged refresh.
    let mut advanced_record = discovered.record.clone();
    advanced_record.source_size_bytes += 1;
    imported_cache::advance_cached_catalog_record_from_conn(
        &conn,
        SOURCE_CODEX_APP,
        &advanced_record,
        None,
    )
    .expect("advance Codex discovery signature");
    assert_eq!(
        cached_title_verification_signature(&conn).as_deref(),
        Some(initial_verified_signature.as_str())
    );

    let advanced_discovered = DiscoveredCodexCatalogRecord {
        record: advanced_record,
        authoritative_title: None,
    };
    repair_codex_catalog_titles(&mut conn, std::slice::from_ref(&advanced_discovered))
        .expect("changed discovery signature revalidates while JSONL is available");
    let advanced_verified_signature =
        cached_title_verification_signature(&conn).expect("advanced verification signature");
    assert_ne!(advanced_verified_signature, initial_verified_signature);

    fs::remove_file(&path).expect("remove title fixture before unchanged refresh");
    repair_codex_catalog_titles(&mut conn, std::slice::from_ref(&advanced_discovered))
        .expect("verified unchanged title must stay on the metadata-only path");
    assert_eq!(cached_title(&conn).0, "Investigate bounded replay");
}

#[test]
fn verified_title_survives_replay_baseline_restore_and_prune() {
    let (mut conn, discovered, path) = title_repair_fixture(
        "Investigate bounded replay",
        &[json!({
            "timestamp":"2026-07-22T00:00:01Z",
            "type":"event_msg",
            "payload":{"type":"user_message","message":"Investigate bounded replay"}
        })],
    );
    conn.execute(
        "UPDATE imported_history_session_cache SET model='adapter-model'
             WHERE source='codex_app' AND source_session_id='rollout-title-fixture'",
        [],
    )
    .expect("seed adapter-owned baseline");

    repair_codex_catalog_titles(&mut conn, std::slice::from_ref(&discovered))
        .expect("verify replay-owned title");
    let verified_signature =
        cached_title_verification_signature(&conn).expect("verification signature");
    assert_unrelated_source_metadata_survives(&conn);
    publish_title_fixture_projection(&mut conn, &discovered.record, Some("replay-model"));
    assert_unrelated_source_metadata_survives(&conn);
    let projected_model: String = conn
        .query_row(
            "SELECT model FROM imported_history_session_cache
                 WHERE source='codex_app'
                   AND source_session_id='rollout-title-fixture'",
            [],
            |row| row.get(0),
        )
        .expect("read replay-projected model");
    assert_eq!(projected_model, "replay-model");

    let tx = conn.transaction().expect("replay prune transaction");
    crate::sources::imported_history::catalog::clear_replay_projection_tx(
        &tx,
        SOURCE_CODEX_APP,
        &discovered.record.source_session_id,
    )
    .expect("prune replay catalog projection");
    tx.commit().expect("commit replay projection prune");

    let restored_model: String = conn
        .query_row(
            "SELECT model FROM imported_history_session_cache
                 WHERE source='codex_app'
                   AND source_session_id='rollout-title-fixture'",
            [],
            |row| row.get(0),
        )
        .expect("read restored adapter model");
    assert_eq!(restored_model, "adapter-model");
    assert_eq!(
        cached_title_verification_signature(&conn).as_deref(),
        Some(verified_signature.as_str()),
        "pruning replay-owned fields must not discard adapter verification"
    );
    assert_unrelated_source_metadata_survives(&conn);

    fs::remove_file(&path).expect("remove title fixture after prune");
    repair_codex_catalog_titles(&mut conn, std::slice::from_ref(&discovered))
        .expect("post-prune refresh must not reopen the unchanged JSONL");
    assert_unrelated_source_metadata_survives(&conn);
}

#[test]
fn tool_only_codex_session_uses_neutral_untitled_name() {
    let (mut conn, discovered, path) = title_repair_fixture(
        "js",
        &[json!({
            "timestamp":"2026-07-22T00:00:00Z",
            "type":"response_item",
            "payload":{"type":"custom_tool_call","name":"js"}
        })],
    );

    repair_codex_catalog_titles(&mut conn, &[discovered]).expect("repair tool-only Codex title");

    assert_eq!(cached_title(&conn).0, "Untitled");
    fs::remove_file(path).expect("remove title fixture");
}

#[test]
fn legacy_record_key_placeholder_repairs_without_a_replay_derivation() {
    let (mut conn, discovered, path) = title_repair_fixture("rollout-title-fixture", &[]);
    conn.execute(
        "DELETE FROM imported_replay_catalog_derivations
             WHERE source='codex_app'",
        [],
    )
    .expect("remove replay derivation");

    repair_codex_catalog_titles(&mut conn, &[discovered])
        .expect("repair legacy record-key placeholder");

    assert_eq!(cached_title(&conn).0, "Untitled");
    fs::remove_file(path).expect("remove title fixture");
}

#[test]
fn unchanged_untitled_session_does_not_reopen_its_transcript() {
    let (mut conn, discovered, path) = title_repair_fixture("Untitled", &[]);
    conn.execute(
        "DELETE FROM imported_replay_catalog_derivations
             WHERE source='codex_app'",
        [],
    )
    .expect("remove replay derivation");
    fs::remove_file(&path).expect("remove title fixture before refresh");

    repair_codex_catalog_titles(&mut conn, &[discovered])
        .expect("unchanged neutral title must stay on the metadata-only path");

    assert_eq!(cached_title(&conn).0, "Untitled");
}

#[test]
fn links_spawn_chunk_to_matching_codex_child_and_restores_prompt() {
    let mut chunks = vec![
        ActivityChunk::new("codexapp-parent", "tool_call", "subagent").with_args(json!({
            "task_name": "audit_todays_commits",
            "description": "audit_todays_commits",
            "codexAgentThreadId": "019f-audit"
        })),
    ];
    chunks[0].created_at = "2026-07-23T10:18:52Z".to_string();
    let mut children = vec![
        CodexChildSessionLink {
            session_id: "codexapp-wrong-nearby-child".to_string(),
            thread_id: Some("019f-wrong".to_string()),
            created_at_ms: 1_753_265_932_100,
            metadata: CodexAppSourceMetadata {
                first_prompt: Some("wrong prompt".to_string()),
                agent_path: Some("/root/other_task".to_string()),
                agent_nickname: Some("Wrong".to_string()),
            },
        },
        CodexChildSessionLink {
            session_id: "codexapp-audit-child".to_string(),
            thread_id: Some("019f-audit".to_string()),
            created_at_ms: 1_753_265_940_000,
            metadata: CodexAppSourceMetadata {
                first_prompt: Some("audit today's commit history".to_string()),
                agent_path: Some("/root/audit_todays_commits".to_string()),
                agent_nickname: Some("Peirce".to_string()),
            },
        },
    ];

    link_codex_subagent_chunks_from_children(&mut chunks, &mut children);

    assert_eq!(chunks[0].args["subagentSessionId"], "codexapp-audit-child");
    assert_eq!(chunks[0].args["prompt"], "audit today's commit history");
    assert_eq!(chunks[0].args["subagent_type"], "Peirce");
    assert_eq!(chunks[0].args["action"], "delegate");
    assert_eq!(children.len(), 1);
    assert_eq!(children[0].session_id, "codexapp-wrong-nearby-child");
}
