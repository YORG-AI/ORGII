//! Real-shape, redacted fixtures for every imported-history replay adapter.
//!
//! JSONL and whole-document fixtures are copied verbatim to a temporary
//! source. SQLite fixtures describe provider rows and are materialized into
//! the provider's real table layout before the public replay API is called.
//! The assertions therefore exercise source parsing, compact indexing,
//! bounded reads, lazy turn hydration, and stable event identities rather
//! than merely checking that fixture files exist.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use prost::Message as _;
use prost_reflect::{DescriptorPool, DynamicMessage};
use rusqlite::{params, Connection};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{
    open_window, poll_delta, read_payload_range, read_turn_window_at_index, scan_window_after,
    ImportedHistorySourceId, ReplayLimits, ReplayStorageFamily, HARD_MAX_EVENTS,
    HARD_MAX_IPC_BYTES, HARD_MAX_TURNS,
};
use crate::store::sqlite::SqliteRecordStore;

const MANIFEST_JSON: &str = include_str!("fixtures/manifest.json");
const WARP_FILE_DESCRIPTOR_SET: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../proto/warp_multi_agent_v1.descriptor.pb"
));
const WARP_TASK_PROTO_NAME: &str = "warp.multi_agent.v1.Task";

static NEXT_FIXTURE_ROOT: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Deserialize)]
struct FixtureManifest {
    fixtures: Vec<FixtureSpec>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureSpec {
    source_id: String,
    storage_family: ReplayStorageFamily,
    source_session_id: String,
    file: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PartFixture {
    session_id: String,
    parts: Vec<PartFixtureRow>,
}

#[derive(Debug, Deserialize)]
struct PartFixtureRow {
    role: String,
    data: Value,
}

#[derive(Debug, Deserialize)]
struct KvFixture {
    composer: Value,
    bubbles: Vec<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CursorCliFixture {
    agent_id: String,
    created_at: i64,
    messages: Vec<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WarpFixture {
    conversation_id: String,
    tasks: Vec<Value>,
}

struct FixtureRoot(PathBuf);

impl FixtureRoot {
    fn new() -> Self {
        let ordinal = NEXT_FIXTURE_ROOT.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "orgii-replay-conformance-{}-{ordinal}",
            std::process::id()
        ));
        std::fs::create_dir(&path).expect("create isolated replay fixture root");
        Self(path)
    }
}

impl Drop for FixtureRoot {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_dir_all(&self.0) {
            eprintln!(
                "failed to clean replay fixture root {}: {error}",
                self.0.display()
            );
        }
    }
}

fn manifest() -> FixtureManifest {
    serde_json::from_str(MANIFEST_JSON).expect("replay fixture manifest")
}

fn fixture_text(file: &str) -> &'static str {
    match file {
        "claude_code.jsonl" => include_str!("fixtures/claude_code.jsonl"),
        "codex_app.jsonl" => include_str!("fixtures/codex_app.jsonl"),
        "cursor_ide.json" => include_str!("fixtures/cursor_ide.json"),
        "cursor_cli.json" => include_str!("fixtures/cursor_cli.json"),
        "opencode.json" => include_str!("fixtures/opencode.json"),
        "windsurf.json" => include_str!("fixtures/windsurf.json"),
        "workbuddy.jsonl" => include_str!("fixtures/workbuddy.jsonl"),
        "trae.jsonl" => include_str!("fixtures/trae.jsonl"),
        "cline.json" => include_str!("fixtures/cline.json"),
        "warp.json" => include_str!("fixtures/warp.json"),
        "zcode.json" => include_str!("fixtures/zcode.json"),
        "qoder.jsonl" => include_str!("fixtures/qoder.jsonl"),
        "mimo_code.json" => include_str!("fixtures/mimo_code.json"),
        "omp.jsonl" => include_str!("fixtures/omp.jsonl"),
        "qoder_cli.jsonl" => include_str!("fixtures/qoder_cli.jsonl"),
        unknown => panic!("fixture manifest references an undeclared file: {unknown}"),
    }
}

fn initialize_cache(
    source: ImportedHistorySourceId,
    source_session_id: &str,
    source_path: &Path,
) -> (Connection, String) {
    let cache = Connection::open_in_memory().expect("open compact replay cache");
    SqliteRecordStore::init_tables(&cache).expect("initialize replay tables");
    SqliteRecordStore::init_source_cache_tables(&cache).expect("initialize source cache tables");
    let display_session_id = format!(
        "{}{}",
        source.descriptor().session_prefix,
        source_session_id
    );
    cache
        .execute(
            "INSERT INTO imported_history_session_cache(
                 source,source_session_id,session_id,source_path
             ) VALUES(?1,?2,?3,?4)",
            params![
                source.as_str(),
                source_session_id,
                display_session_id,
                source_path.to_string_lossy()
            ],
        )
        .expect("register replay fixture source");
    (cache, display_session_id)
}

fn materialize_source(spec: &FixtureSpec, source: ImportedHistorySourceId, root: &Path) -> PathBuf {
    let text = fixture_text(&spec.file);
    let path = match spec.storage_family {
        ReplayStorageFamily::JsonLines | ReplayStorageFamily::WholeJson => {
            let path = root.join(&spec.file);
            std::fs::write(&path, text).expect("write text replay fixture");
            path
        }
        ReplayStorageFamily::SqliteWal => materialize_part_db(spec, text, root),
        ReplayStorageFamily::SqliteKeyValue => materialize_kv_db(spec, text, root),
        ReplayStorageFamily::SqliteManifestBlob => materialize_cursor_cli_db(spec, text, root),
        ReplayStorageFamily::SqliteTaskBlob => materialize_warp_db(spec, text, root),
    };
    assert_eq!(
        source.descriptor().storage_family,
        spec.storage_family,
        "{} fixture uses the adapter's declared storage family",
        source.as_str()
    );
    assert!(path.is_file(), "materialized source {}", path.display());
    path
}

fn materialize_part_db(spec: &FixtureSpec, text: &str, root: &Path) -> PathBuf {
    let fixture: PartFixture = serde_json::from_str(text).expect("part fixture JSON");
    assert_eq!(fixture.session_id, spec.source_session_id);
    let path = root.join(format!("{}.sqlite", spec.source_id));
    let source = Connection::open(&path).expect("create SQLite/WAL fixture");
    source
        .execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE session(
               id TEXT PRIMARY KEY,time_created INTEGER,time_updated INTEGER
             );
             CREATE TABLE message(
               id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT
             );
             CREATE TABLE part(
               id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,
               time_created INTEGER,data TEXT
             );",
        )
        .expect("create SQLite/WAL provider schema");
    source
        .execute(
            "INSERT INTO session(id,time_created,time_updated) VALUES(?1,1,?2)",
            params![spec.source_session_id, fixture.parts.len() as i64 + 1],
        )
        .expect("insert provider session");
    for (ordinal, part) in fixture.parts.into_iter().enumerate() {
        let message_id = format!("message-{ordinal:04}");
        let part_id = format!("part-{ordinal:04}");
        let timestamp = ordinal as i64 + 1;
        source
            .execute(
                "INSERT INTO message(id,session_id,time_created,data) VALUES(?1,?2,?3,?4)",
                params![
                    message_id,
                    spec.source_session_id,
                    timestamp,
                    json!({"role":part.role}).to_string()
                ],
            )
            .expect("insert provider message");
        source
            .execute(
                "INSERT INTO part(id,message_id,session_id,time_created,data)
                 VALUES(?1,?2,?3,?4,?5)",
                params![
                    part_id,
                    message_id,
                    spec.source_session_id,
                    timestamp,
                    part.data.to_string()
                ],
            )
            .expect("insert provider part");
    }
    source
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .expect("checkpoint provider fixture");
    drop(source);
    path
}

fn materialize_kv_db(spec: &FixtureSpec, text: &str, root: &Path) -> PathBuf {
    let fixture: KvFixture = serde_json::from_str(text).expect("KV fixture JSON");
    assert_eq!(
        fixture.composer["composerId"].as_str(),
        Some(spec.source_session_id.as_str())
    );
    let path = root.join(format!("{}.sqlite", spec.source_id));
    let source = Connection::open(&path).expect("create SQLite/KV fixture");
    source
        .execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value TEXT);",
        )
        .expect("create SQLite/KV provider schema");
    source
        .execute(
            "INSERT INTO cursorDiskKV(key,value) VALUES(?1,?2)",
            params![
                format!("composerData:{}", spec.source_session_id),
                fixture.composer.to_string()
            ],
        )
        .expect("insert KV composer");
    for bubble in fixture.bubbles {
        let bubble_id = bubble["bubbleId"]
            .as_str()
            .expect("KV bubble has stable id");
        source
            .execute(
                "INSERT INTO cursorDiskKV(key,value) VALUES(?1,?2)",
                params![
                    format!("bubbleId:{}:{bubble_id}", spec.source_session_id),
                    bubble.to_string()
                ],
            )
            .expect("insert KV bubble");
    }
    source
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .expect("checkpoint KV fixture");
    drop(source);
    path
}

fn materialize_cursor_cli_db(spec: &FixtureSpec, text: &str, root: &Path) -> PathBuf {
    let fixture: CursorCliFixture = serde_json::from_str(text).expect("Cursor CLI fixture JSON");
    assert_eq!(fixture.agent_id, spec.source_session_id);
    let path = root.join(format!("{}.sqlite", spec.source_id));
    let source = Connection::open(&path).expect("create Cursor CLI fixture");
    source
        .execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE blobs(id TEXT PRIMARY KEY,data BLOB);
             CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);",
        )
        .expect("create Cursor CLI provider schema");
    let mut message_ids = Vec::with_capacity(fixture.messages.len());
    for (ordinal, message) in fixture.messages.into_iter().enumerate() {
        let id = hex_encode(&[(ordinal as u8).saturating_add(1); 32]);
        source
            .execute(
                "INSERT INTO blobs(id,data) VALUES(?1,?2)",
                params![
                    id,
                    serde_json::to_vec(&message).expect("Cursor message JSON")
                ],
            )
            .expect("insert Cursor message blob");
        message_ids.push(id);
    }
    let root_id = hex_encode(&[0xfe; 32]);
    source
        .execute(
            "INSERT INTO blobs(id,data) VALUES(?1,?2)",
            params![root_id, cursor_manifest(&message_ids)],
        )
        .expect("insert Cursor manifest blob");
    let meta = json!({
        "agentId":fixture.agent_id,
        "latestRootBlobId":root_id,
        "createdAt":fixture.created_at,
    })
    .to_string();
    source
        .execute(
            "INSERT INTO meta(key,value) VALUES('0',?1)",
            [hex_encode(meta.as_bytes())],
        )
        .expect("publish Cursor manifest root");
    source
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .expect("checkpoint Cursor fixture");
    drop(source);
    path
}

fn materialize_warp_db(spec: &FixtureSpec, text: &str, root: &Path) -> PathBuf {
    let fixture: WarpFixture = serde_json::from_str(text).expect("Warp fixture JSON");
    assert_eq!(fixture.conversation_id, spec.source_session_id);
    let path = root.join(format!("{}.sqlite", spec.source_id));
    let source = Connection::open(&path).expect("create Warp fixture");
    source
        .execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE agent_conversations(
               id INTEGER PRIMARY KEY,conversation_id TEXT,conversation_data TEXT,
               last_modified_at TEXT,summary TEXT
             );
             CREATE TABLE agent_tasks(
               id INTEGER PRIMARY KEY,conversation_id TEXT,task_id TEXT,
               task BLOB,last_modified_at TEXT
             );",
        )
        .expect("create Warp provider schema");
    source
        .execute(
            "INSERT INTO agent_conversations(
               id,conversation_id,conversation_data,last_modified_at,summary
             ) VALUES(1,?1,'{}','2026-07-22 00:00:04','{}')",
            [spec.source_session_id.as_str()],
        )
        .expect("insert Warp conversation");
    for (ordinal, task) in fixture.tasks.into_iter().enumerate() {
        let task_id = task["id"]
            .as_str()
            .expect("Warp task has stable id")
            .to_string();
        source
            .execute(
                "INSERT INTO agent_tasks(
                   id,conversation_id,task_id,task,last_modified_at
                 ) VALUES(?1,?2,?3,?4,?5)",
                params![
                    ordinal as i64 + 1,
                    spec.source_session_id,
                    task_id,
                    encode_warp_task(task),
                    format!("2026-07-22 00:00:{:02}", ordinal + 1)
                ],
            )
            .expect("insert Warp task blob");
    }
    source
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .expect("checkpoint Warp fixture");
    drop(source);
    path
}

fn cursor_manifest(ids: &[String]) -> Vec<u8> {
    let mut manifest = Vec::with_capacity(ids.len() * 34);
    for id in ids {
        let decoded = hex_decode(id).expect("Cursor fixture blob id");
        manifest.extend_from_slice(&[0x0a, 32]);
        manifest.extend_from_slice(&decoded);
    }
    manifest
}

fn encode_warp_task(task: Value) -> Vec<u8> {
    let pool = DescriptorPool::decode(WARP_FILE_DESCRIPTOR_SET)
        .expect("load Warp provider protobuf descriptor");
    let descriptor = pool
        .get_message_by_name(WARP_TASK_PROTO_NAME)
        .expect("Warp task descriptor");
    let encoded = task.to_string();
    let mut deserializer = serde_json::Deserializer::from_str(&encoded);
    DynamicMessage::deserialize(descriptor, &mut deserializer)
        .expect("real-shape Warp task JSON")
        .encode_to_vec()
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn hex_decode(text: &str) -> Option<Vec<u8>> {
    if text.len() % 2 != 0 {
        return None;
    }
    text.as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let pair = std::str::from_utf8(pair).ok()?;
            u8::from_str_radix(pair, 16).ok()
        })
        .collect()
}

fn collect_all_event_ids(
    cache: &mut Connection,
    source: ImportedHistorySourceId,
    session_id: &str,
) -> Vec<String> {
    let mut after_sequence = -1_i64;
    let mut event_ids = Vec::new();
    for page in 0..64 {
        let scan = scan_window_after(
            cache,
            source,
            session_id,
            after_sequence,
            ReplayLimits {
                max_turns: 1,
                max_events: 2,
                max_ipc_bytes: HARD_MAX_IPC_BYTES,
            },
        )
        .unwrap_or_else(|error| panic!("{} scan page {page}: {error}", source.as_str()));
        assert!(scan.chunks.len() <= 2, "{} scan event cap", source.as_str());
        assert!(
            scan.stats.ipc_bytes <= HARD_MAX_IPC_BYTES as u64,
            "{} scan wire cap",
            source.as_str()
        );
        for indexed in &scan.chunks {
            assert!(
                indexed.sequence > after_sequence,
                "{} scan sequence advances",
                source.as_str()
            );
            event_ids.push(indexed.chunk.chunk_id.clone());
        }
        if !scan.has_more {
            return event_ids;
        }
        assert!(
            !scan.chunks.is_empty(),
            "{} scan must not stall while more rows exist",
            source.as_str()
        );
        assert!(
            scan.cursor.through_sequence > after_sequence,
            "{} scan cursor advances",
            source.as_str()
        );
        after_sequence = scan.cursor.through_sequence;
    }
    panic!("{} scan exceeded fixture page budget", source.as_str());
}

fn assert_source_conformance(spec: &FixtureSpec, root: &Path) {
    let source = ImportedHistorySourceId::parse(&spec.source_id).expect("registered source id");
    let path = materialize_source(spec, source, root);
    let (mut cache, session_id) = initialize_cache(source, &spec.source_session_id, &path);

    let hard_bounded = open_window(
        &mut cache,
        source,
        &session_id,
        ReplayLimits {
            max_turns: usize::MAX,
            max_events: usize::MAX,
            max_ipc_bytes: usize::MAX,
        },
    )
    .unwrap_or_else(|error| panic!("{} fixture open: {error}", source.as_str()));
    assert!(
        hard_bounded.total_turn_count >= 2,
        "{} fixture must exercise turn pagination",
        source.as_str()
    );
    assert!(
        hard_bounded.total_event_count >= 4,
        "{} fixture must normalize multiple events",
        source.as_str()
    );
    assert!(hard_bounded.chunks.len() <= HARD_MAX_EVENTS);
    assert!(hard_bounded.turn_headers.len() <= HARD_MAX_TURNS);
    assert!(hard_bounded.stats.ipc_bytes <= HARD_MAX_IPC_BYTES as u64);
    assert_eq!(hard_bounded.cursor.source_id, source.as_str());
    assert_eq!(hard_bounded.cursor.session_id, session_id);

    let one_event = open_window(
        &mut cache,
        source,
        &session_id,
        ReplayLimits {
            max_turns: 1,
            max_events: 1,
            max_ipc_bytes: HARD_MAX_IPC_BYTES,
        },
    )
    .unwrap_or_else(|error| panic!("{} one-event window: {error}", source.as_str()));
    assert_eq!(
        one_event.turn_headers.len(),
        1,
        "{} turn cap",
        source.as_str()
    );
    assert_eq!(one_event.chunks.len(), 1, "{} event cap", source.as_str());

    for turn_index in 0..hard_bounded.total_turn_count {
        let turn = read_turn_window_at_index(
            &mut cache,
            source,
            &session_id,
            turn_index as i64,
            ReplayLimits {
                max_turns: 1,
                max_events: HARD_MAX_EVENTS,
                max_ipc_bytes: HARD_MAX_IPC_BYTES,
            },
        )
        .unwrap_or_else(|error| panic!("{} turn page {turn_index}: {error}", source.as_str()));
        assert_eq!(turn.turn_headers.len(), 1);
        assert_eq!(turn.turn_headers[0].turn_index, turn_index as i64);
        assert!(!turn.chunks.is_empty(), "{} turn body", source.as_str());
        assert!(
            turn.chunks
                .iter()
                .all(|event| event.turn_index == turn_index as i64),
            "{} turn page does not bleed into an adjacent turn",
            source.as_str()
        );
    }

    let first_ids = collect_all_event_ids(&mut cache, source, &session_id);
    assert_eq!(
        first_ids.len() as u64,
        hard_bounded.total_event_count,
        "{} compact scan covers every normalized event",
        source.as_str()
    );
    assert_eq!(
        first_ids.len(),
        first_ids.iter().collect::<BTreeSet<_>>().len(),
        "{} event ids are unique",
        source.as_str()
    );
    let second_ids = collect_all_event_ids(&mut cache, source, &session_id);
    assert_eq!(
        second_ids,
        first_ids,
        "{} event ids stay stable across reopen/rescan",
        source.as_str()
    );
}

fn assert_newline_terminated_bad_json_is_skipped(
    spec: &FixtureSpec,
    source: ImportedHistorySourceId,
    root: &Path,
) {
    let records = fixture_text(&spec.file)
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<_>>();
    assert!(records.len() >= 2, "{} JSONL fixture", source.as_str());
    // Four-line chat fixtures begin their second turn at record two; Trae's
    // summary format stores one complete turn per line and therefore has two.
    let later_record = records[records.len() / 2];
    let clean_text = format!("{}\n{}\n", records[0], later_record);
    // This malformed record is complete at the storage layer (it ends in a
    // newline) but invalid JSON. The following valid line must remain an
    // independent record and advance the persisted byte cursor to EOF.
    let bad_text = format!("{}\n{{\"malformed\":\n{}\n", records[0], later_record);
    let clean_path = root.join(format!("{}-bad-line-clean.jsonl", source.as_str()));
    let bad_path = root.join(format!("{}-bad-line.jsonl", source.as_str()));
    std::fs::write(&clean_path, &clean_text).expect("write clean JSONL control");
    std::fs::write(&bad_path, &bad_text).expect("write malformed JSONL fixture");

    let clean_source_session_id = format!("{}-bad-line-clean", spec.source_session_id);
    let bad_source_session_id = format!("{}-bad-line", spec.source_session_id);
    let (mut clean_cache, clean_session_id) =
        initialize_cache(source, &clean_source_session_id, &clean_path);
    let (mut bad_cache, bad_session_id) =
        initialize_cache(source, &bad_source_session_id, &bad_path);
    let limits = ReplayLimits {
        max_turns: HARD_MAX_TURNS,
        max_events: HARD_MAX_EVENTS,
        max_ipc_bytes: HARD_MAX_IPC_BYTES,
    };
    let clean = open_window(&mut clean_cache, source, &clean_session_id, limits)
        .unwrap_or_else(|error| panic!("{} clean control: {error}", source.as_str()));
    let bad = open_window(&mut bad_cache, source, &bad_session_id, limits)
        .unwrap_or_else(|error| panic!("{} malformed fixture: {error}", source.as_str()));

    assert_eq!(clean.stats.parsed_rows, 2, "{} clean rows", source.as_str());
    assert_eq!(
        bad.stats.parsed_rows,
        2,
        "{} bad row is skipped",
        source.as_str()
    );
    assert_eq!(
        bad.stats.parsed_bytes,
        bad_text.len() as u64,
        "{} consumes the complete bad line and continues",
        source.as_str()
    );
    assert_eq!(bad.total_event_count, clean.total_event_count);
    assert_eq!(bad.total_turn_count, clean.total_turn_count);
    assert_eq!(
        bad.total_turn_count,
        2,
        "{} reaches the later user turn",
        source.as_str()
    );
    let normalized_chunks = bad
        .chunks
        .iter()
        .map(|indexed| &indexed.chunk)
        .collect::<Vec<_>>();
    assert!(
        serde_json::to_string(&normalized_chunks)
            .expect("serialize malformed-line result")
            .contains("second"),
        "{} later valid record is normalized",
        source.as_str()
    );
    let unchanged = poll_delta(
        &mut bad_cache,
        source,
        &bad_session_id,
        &bad.cursor,
        ReplayLimits::default(),
    )
    .unwrap_or_else(|error| panic!("{} post-bad-line poll: {error}", source.as_str()));
    assert_eq!(unchanged.stats.parsed_bytes, 0);
    assert_eq!(unchanged.stats.parsed_rows, 0);
    assert!(unchanged.chunks.is_empty());
}

fn large_assistant_line(source: ImportedHistorySourceId, body: &str, timestamp: i64) -> String {
    match source {
        ImportedHistorySourceId::CodexApp => json!({
            "timestamp": "2026-07-22T00:00:00Z",
            "type": "event_msg",
            "payload": {"type":"agent_message", "message":body},
        })
        .to_string(),
        ImportedHistorySourceId::ClaudeCode => json!({
            "type":"assistant",
            "timestamp":timestamp,
            "message":{"role":"assistant","content":[{"type":"text","text":body}]},
        })
        .to_string(),
        _ => unreachable!("large append test covers Codex and the shared JSONL driver"),
    }
}

fn assert_ten_mib_utf8_append_is_incremental(source: ImportedHistorySourceId, root: &Path) {
    const MIB: usize = 1024 * 1024;
    let source_session_id = format!("{}-ten-mib-utf8-append", source.as_str());
    let path = root.join(format!("{}-ten-mib-utf8-append.jsonl", source.as_str()));
    // Make the acknowledged prefix larger than the permitted boundary
    // overhead. A regression that seeks to byte zero cannot satisfy the
    // completed append's parsedBytes bound below.
    let old_body = "old-prefix-".repeat((3 * MIB) / "old-prefix-".len() + 1);
    let old_line = large_assistant_line(source, &old_body, 1_753_142_400_000);
    let old_source_bytes = old_line.len() + 1;
    std::fs::write(&path, format!("{old_line}\n")).expect("write acknowledged JSONL prefix");
    let (mut cache, session_id) = initialize_cache(source, &source_session_id, &path);
    let opened = open_window(&mut cache, source, &session_id, ReplayLimits::default())
        .unwrap_or_else(|error| panic!("{} open large prefix: {error}", source.as_str()));

    let utf8_unit = "中🙂x";
    let appended_body = utf8_unit.repeat((10 * MIB) / utf8_unit.len() + 1);
    assert!(appended_body.len() >= 10 * MIB);
    let appended_line = large_assistant_line(source, &appended_body, 1_753_142_401_000);
    let appended_bytes = appended_line.len() + 1;
    // End the first physical write inside the final four-byte emoji. Without
    // a newline this must stay unacknowledged and must not advance parsedBytes.
    let split = appended_line
        .rfind('🙂')
        .expect("large UTF-8 fixture contains emoji")
        + 1;
    assert!(std::str::from_utf8(&appended_line.as_bytes()[..split]).is_err());
    let mut writer = std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .expect("append large UTF-8 line");
    writer
        .write_all(&appended_line.as_bytes()[..split])
        .expect("write UTF-8 torn tail");
    writer.flush().expect("flush UTF-8 torn tail");
    let partial = poll_delta(
        &mut cache,
        source,
        &session_id,
        &opened.cursor,
        ReplayLimits::default(),
    )
    .unwrap_or_else(|error| panic!("{} poll UTF-8 torn tail: {error}", source.as_str()));
    assert_eq!(partial.stats.parsed_bytes, 0);
    assert_eq!(partial.stats.parsed_rows, 0);
    assert!(partial.chunks.is_empty());

    writer
        .write_all(&appended_line.as_bytes()[split..])
        .expect("finish UTF-8 scalar and JSONL record");
    writer
        .write_all(b"\n")
        .expect("terminate large JSONL record");
    writer.flush().expect("flush completed UTF-8 append");
    drop(writer);
    let completed = poll_delta(
        &mut cache,
        source,
        &session_id,
        &opened.cursor,
        ReplayLimits::default(),
    )
    .unwrap_or_else(|error| panic!("{} poll 10 MiB append: {error}", source.as_str()));
    assert_eq!(completed.stats.parsed_rows, 1);
    assert!(completed.stats.parsed_bytes >= appended_bytes as u64);
    assert!(
        completed.stats.parsed_bytes <= appended_bytes.saturating_add(MIB) as u64,
        "{} reads only the 10 MiB append plus at most 1 MiB boundary overhead: parsed={} append={appended_bytes}",
        source.as_str(),
        completed.stats.parsed_bytes
    );
    assert!(
        completed.stats.parsed_bytes < old_source_bytes.saturating_add(appended_bytes) as u64,
        "{} must not replay the acknowledged 3 MiB prefix",
        source.as_str()
    );
    assert!(!completed.reset_required);
    assert_eq!(completed.cursor.generation, opened.cursor.generation);
    let event = completed
        .chunks
        .iter()
        .find(|event| {
            event
                .payloads
                .iter()
                .any(|payload| payload.total_bytes == appended_body.len() as u64)
        })
        .unwrap_or_else(|| panic!("{} appended payload descriptor", source.as_str()));
    let payload = event
        .payloads
        .iter()
        .find(|payload| payload.total_bytes == appended_body.len() as u64)
        .expect("large appended payload");
    let cut_range = read_payload_range(
        &mut cache,
        source,
        &session_id,
        &completed.cursor.generation,
        &event.chunk.chunk_id,
        &payload.field_path,
        1,
        Some(257),
    )
    .unwrap_or_else(|error| panic!("{} UTF-8 cut range: {error}", source.as_str()));
    assert!(cut_range.offset > 1, "range skips UTF-8 continuation bytes");
    assert!(!cut_range.text.is_empty());
    assert!(cut_range.text.len() <= 260);
    assert!(cut_range.next_offset > cut_range.offset);
}

#[test]
fn manifest_has_exactly_one_real_shape_fixture_for_every_registered_source() {
    let manifest = manifest();
    assert_eq!(manifest.fixtures.len(), ImportedHistorySourceId::ALL.len());
    let mut by_source = BTreeMap::new();
    let mut files = BTreeSet::new();
    for fixture in manifest.fixtures {
        let source = ImportedHistorySourceId::parse(&fixture.source_id)
            .unwrap_or_else(|error| panic!("fixture source: {error}"));
        assert_eq!(fixture.storage_family, source.descriptor().storage_family);
        assert!(
            by_source
                .insert(source.as_str(), fixture.file.clone())
                .is_none(),
            "duplicate fixture for {}",
            source.as_str()
        );
        assert!(
            files.insert(fixture.file.clone()),
            "fixture file must not stand in for two adapters: {}",
            fixture.file
        );
        let parsed: Value = if fixture.storage_family == ReplayStorageFamily::JsonLines {
            Value::Array(
                fixture_text(&fixture.file)
                    .lines()
                    .filter(|line| !line.trim().is_empty())
                    .map(|line| serde_json::from_str(line).expect("fixture JSONL record"))
                    .collect(),
            )
        } else {
            serde_json::from_str(fixture_text(&fixture.file)).expect("fixture JSON document")
        };
        assert!(!parsed.is_null(), "{} fixture parses", source.as_str());
    }
    let expected = ImportedHistorySourceId::ALL
        .into_iter()
        .map(ImportedHistorySourceId::as_str)
        .collect::<BTreeSet<_>>();
    assert_eq!(by_source.into_keys().collect::<BTreeSet<_>>(), expected);
}

#[test]
fn all_fifteen_fixtures_parse_index_page_and_keep_stable_ids_with_hard_limits() {
    let root = FixtureRoot::new();
    for spec in manifest().fixtures {
        let source = ImportedHistorySourceId::parse(&spec.source_id).expect("fixture source");
        if source == ImportedHistorySourceId::Qoder {
            crate::sources::qoder::log_enrichment::with_qoder_log_paths_for_test(
                Vec::new(),
                || assert_source_conformance(&spec, &root.0),
            );
        } else {
            assert_source_conformance(&spec, &root.0);
        }
    }
}

#[test]
fn codex_and_every_shared_jsonl_adapter_skip_bad_complete_lines_and_continue() {
    let root = FixtureRoot::new();
    let manifest = manifest();
    for source in [
        ImportedHistorySourceId::CodexApp,
        ImportedHistorySourceId::ClaudeCode,
        ImportedHistorySourceId::WorkBuddy,
        ImportedHistorySourceId::Trae,
        ImportedHistorySourceId::Qoder,
        ImportedHistorySourceId::Omp,
        ImportedHistorySourceId::QoderCli,
    ] {
        let spec = manifest
            .fixtures
            .iter()
            .find(|fixture| fixture.source_id == source.as_str())
            .unwrap_or_else(|| panic!("{} manifest fixture", source.as_str()));
        if source == ImportedHistorySourceId::Qoder {
            crate::sources::qoder::log_enrichment::with_qoder_log_paths_for_test(
                Vec::new(),
                || assert_newline_terminated_bad_json_is_skipped(spec, source, &root.0),
            );
        } else {
            assert_newline_terminated_bad_json_is_skipped(spec, source, &root.0);
        }
    }
}

#[test]
fn codex_and_shared_jsonl_ten_mib_utf8_append_reads_only_the_delta() {
    let root = FixtureRoot::new();
    for source in [
        ImportedHistorySourceId::CodexApp,
        ImportedHistorySourceId::ClaudeCode,
    ] {
        assert_ten_mib_utf8_append_is_incremental(source, &root.0);
    }
}
