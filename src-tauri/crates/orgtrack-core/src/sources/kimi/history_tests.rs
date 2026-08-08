use std::ffi::OsStr;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;

use super::*;

struct TestHome(PathBuf);

impl TestHome {
    fn new(tag: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "orgii-kimi-history-{tag}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("create test home");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestHome {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).ok();
    }
}

fn fixture_conn() -> Connection {
    let conn = Connection::open_in_memory().expect("open in-memory db");
    crate::store::sqlite::SqliteRecordStore::init_tables(&conn).expect("init core tables");
    crate::store::sqlite::SqliteRecordStore::init_source_cache_tables(&conn)
        .expect("init source cache tables");
    conn
}

fn write_file(path: &Path, content: &str) {
    fs::create_dir_all(path.parent().expect("fixture parent")).expect("create fixture parent");
    fs::write(path, content).expect("write fixture");
}

fn cached_usage(
    conn: &Connection,
    source_session_id: &str,
) -> (String, i64, i64, i64, i64, String) {
    conn.query_row(
        "SELECT model, input_tokens, output_tokens, cache_read_tokens,
                cache_write_tokens, name
         FROM imported_history_session_cache
         WHERE source = ?1 AND source_session_id = ?2",
        [SOURCE_KIMI, source_session_id],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
            ))
        },
    )
    .expect("cached Kimi usage")
}

#[test]
fn legacy_usage_dedupes_status_updates_and_config_invalidates_model() {
    let home = TestHome::new("legacy");
    let wire = home
        .path()
        .join(".kimi/sessions/project-a/session-a/wire.jsonl");
    write_file(
        &home.path().join(".kimi/config.toml"),
        "default_model = \"kimi-k3\"\n",
    );
    write_file(
        &wire,
        concat!(
            "{\"type\":\"metadata\",\"protocol_version\":\"1.3\"}\n",
            "{\"timestamp\":1770983400.0,\"message\":{\"type\":\"TurnBegin\",\"payload\":{\"user_input\":\"hello Kimi\"}}}\n",
            "{\"timestamp\":1770983410.0,\"message\":{\"type\":\"StatusUpdate\",\"payload\":{\"token_usage\":{\"input_other\":100,\"output\":20,\"input_cache_read\":50,\"input_cache_creation\":10},\"message_id\":\"msg-1\"}}}\n",
            "{\"timestamp\":1770983411.0,\"message\":{\"type\":\"StatusUpdate\",\"payload\":{\"token_usage\":{\"input_other\":200,\"output\":30,\"input_cache_read\":20,\"input_cache_creation\":0},\"message_id\":\"msg-1\"}}}\n",
            "{\"timestamp\":1770983412.0,\"message\":{\"type\":\"ContentPart\",\"payload\":{\"type\":\"text\",\"text\":\"hello back\"}}}\n",
        ),
    );
    let mut conn = fixture_conn();

    sync_kimi_history_cache_in(&mut conn, home.path(), None).expect("first sync");
    assert_eq!(
        cached_usage(&conn, "cli/project-a/session-a"),
        (
            "kimi-k3".to_string(),
            220,
            30,
            20,
            0,
            "hello Kimi".to_string()
        )
    );
    let round_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM imported_history_round_usage
             WHERE source = ?1 AND source_session_id = ?2",
            [SOURCE_KIMI, "cli/project-a/session-a"],
            |row| row.get(0),
        )
        .expect("round count");
    assert_eq!(round_count, 1);

    let session_id = format!("{KIMI_SESSION_PREFIX}cli/project-a/session-a");
    let replay = load_kimi_history_for_session_in(&conn, &session_id, home.path(), None)
        .expect("legacy replay");
    assert_eq!(replay.len(), 2);
    assert_eq!(replay[0].function, imported_history::FUNCTION_USER_MESSAGE);
    assert_eq!(replay[1].function, imported_history::FUNCTION_ASSISTANT);

    write_file(
        &home.path().join(".kimi/config.toml"),
        "default_model = 'kimi-k3.1'\n",
    );
    sync_kimi_history_cache_in(&mut conn, home.path(), None).expect("config refresh");
    assert_eq!(
        cached_usage(&conn, "cli/project-a/session-a").0,
        "kimi-k3.1"
    );

    #[cfg(unix)]
    {
        let outside = TestHome::new("legacy-replay-outside");
        let replacement = outside.path().join("project-a/session-a/wire.jsonl");
        write_file(&replacement, "foreign\n");
        fs::remove_dir_all(home.path().join(".kimi/sessions/project-a"))
            .expect("remove original project");
        std::os::unix::fs::symlink(
            outside.path().join("project-a"),
            home.path().join(".kimi/sessions/project-a"),
        )
        .expect("replace parent with symlink");
        let error = load_kimi_history_for_session_in(&conn, &session_id, home.path(), None)
            .expect_err("replay must reject replaced parent");
        assert!(error.contains("unsafe Kimi history path"));
    }
}

#[test]
fn legacy_config_supports_current_toml_and_old_json_fields() {
    assert_eq!(
        model_from_toml(b"# comment\ndefault_model = \"kimi-current\"\n").as_deref(),
        Some("kimi-current")
    );
    assert_eq!(
        model_from_json(br#"{"default_model":"kimi-json-current"}"#).as_deref(),
        Some("kimi-json-current")
    );
    assert_eq!(
        model_from_json(br#"{"model":"kimi-json-legacy"}"#).as_deref(),
        Some("kimi-json-legacy")
    );
}

#[test]
fn kimi_code_counts_every_incremental_usage_record_and_tracks_concrete_models() {
    let home = TestHome::new("code");
    let wire = home
        .path()
        .join(".kimi-code/sessions/work/session/agents/main/wire.jsonl");
    write_file(
        &wire,
        concat!(
            "{\"type\":\"llm.request\",\"model\":\"k3\",\"time\":1780319377000}\n",
            "{\"type\":\"usage.record\",\"model\":\"__runtime_model__\",\"usage\":{\"inputOther\":100,\"output\":50,\"inputCacheRead\":25,\"inputCacheCreation\":0},\"usageScope\":\"turn\",\"time\":1780319377010}\n",
            "{\"type\":\"usage.record\",\"model\":\"kimi-code/kimi-for-coding\",\"usage\":{\"inputOther\":200,\"output\":75,\"inputCacheRead\":0,\"inputCacheCreation\":10},\"usageScope\":\"turn\",\"time\":1780319377020}\n",
            "{\"type\":\"usage.record\",\"model\":\"compactor\",\"usage\":{\"inputOther\":7,\"output\":3},\"usageScope\":\"session\",\"time\":1780319377030}\n",
            "{\"type\":\"usage.record\",\"model\":\"background\",\"usage\":{\"inputOther\":11,\"output\":5},\"time\":1780319377035}\n",
            "{\"type\":\"step.end\",\"model\":\"ignored\",\"usage\":{\"inputOther\":888,\"output\":888},\"usageScope\":\"turn\",\"time\":1780319377040}\n",
        ),
    );
    let mut conn = fixture_conn();

    sync_kimi_history_cache_in(&mut conn, home.path(), None).expect("Kimi Code sync");

    assert_eq!(
        cached_usage(&conn, "code/work/session/main"),
        (
            "background".to_string(),
            353,
            133,
            25,
            10,
            "code/work/session/main".to_string()
        )
    );
    let mut stmt = conn
        .prepare(
            "SELECT model FROM imported_history_round_usage
             WHERE source = ?1 ORDER BY seq",
        )
        .expect("prepare models");
    let models = stmt
        .query_map([SOURCE_KIMI], |row| row.get::<_, String>(0))
        .expect("query models")
        .collect::<Result<Vec<_>, _>>()
        .expect("models");
    assert_eq!(
        models,
        vec!["k3", "kimi-for-coding", "compactor", "background"]
    );
    let listable: i64 = conn
        .query_row(
            "SELECT listable FROM imported_history_session_cache
             WHERE source = ?1 AND source_session_id = ?2",
            [SOURCE_KIMI, "code/work/session/main"],
            |row| row.get(0),
        )
        .expect("Kimi Code visibility");
    assert_eq!(listable, 0, "metadata-only Kimi Code rows stay hidden");
    let session_id = format!("{KIMI_SESSION_PREFIX}code/work/session/main");
    assert!(
        load_kimi_history_for_session_in(&conn, &session_id, home.path(), None)
            .expect("Kimi Code metadata-only replay")
            .is_empty()
    );
}

#[test]
fn kimi_code_replays_official_context_shape_without_duplicating_turn_prompt() {
    let home = TestHome::new("code-replay");
    let main = home
        .path()
        .join(".kimi-code/sessions/work/session/agents/main/wire.jsonl");
    write_file(
        &main,
        concat!(
            "{\"type\":\"metadata\",\"protocol_version\":\"1.1\",\"created_at\":1779256791085}\n",
            "{\"type\":\"config.update\",\"cwd\":\"/tmp/work\",\"profileName\":\"agent\",\"time\":1779256791100}\n",
            "{\"type\":\"turn.prompt\",\"input\":[{\"type\":\"text\",\"text\":\"hi\"}],\"origin\":{\"kind\":\"user\"},\"time\":1779256800000}\n",
            "{\"type\":\"context.append_message\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"hi\"}],\"toolCalls\":[]},\"time\":1779256800001}\n",
            "{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.begin\",\"uuid\":\"s1\",\"turnId\":\"t1\",\"step\":0},\"time\":1779256800100}\n",
            "{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"content.part\",\"uuid\":\"c1\",\"turnId\":\"t1\",\"step\":0,\"stepUuid\":\"s1\",\"part\":{\"type\":\"text\",\"text\":\"hello\"}},\"time\":1779256800200}\n",
            "{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.end\",\"uuid\":\"s1\",\"turnId\":\"t1\",\"step\":0},\"time\":1779256800300}\n",
        ),
    );
    write_file(
        &home
            .path()
            .join(".kimi-code/sessions/work/session/agents/agent-0/wire.jsonl"),
        concat!(
            "{\"type\":\"metadata\",\"protocol_version\":\"1.1\",\"created_at\":1779256900000}\n",
            "{\"type\":\"config.update\",\"cwd\":\"/tmp/work\",\"profileName\":\"sub\",\"time\":1779256900001}\n",
        ),
    );
    let mut conn = fixture_conn();
    sync_kimi_history_cache_in(&mut conn, home.path(), None).expect("sync code replay");

    let placement = conn
        .query_row(
            "SELECT listable, repo_path, name FROM imported_history_session_cache
             WHERE source = ?1 AND source_session_id = ?2",
            [SOURCE_KIMI, "code/work/session/main"],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .expect("main replay placement");
    assert_eq!(placement, (1, "/tmp/work".to_string(), "hi".to_string()));
    let metadata_only_listable: i64 = conn
        .query_row(
            "SELECT listable FROM imported_history_session_cache
             WHERE source = ?1 AND source_session_id = ?2",
            [SOURCE_KIMI, "code/work/session/agent-0"],
            |row| row.get(0),
        )
        .expect("metadata-only placement");
    assert_eq!(metadata_only_listable, 0);

    let session_id = format!("{KIMI_SESSION_PREFIX}code/work/session/main");
    let replay = load_kimi_history_for_session_in(&conn, &session_id, home.path(), None)
        .expect("load code replay");
    assert_eq!(replay.len(), 2, "turn.prompt must not duplicate the user");
    assert_eq!(replay[0].result["message"]["content"], "hi");
    assert_eq!(replay[1].result["content"], "hello");

    let recent = imported_cache::query_imported_recent_paths_from_conn(&conn, SOURCE_KIMI, 10)
        .expect("Kimi recent paths");
    assert_eq!(recent.len(), 1);
    assert_eq!(recent[0].path, "/tmp/work");
}

#[test]
fn append_refresh_reuses_persisted_state_and_advances_watermark() {
    let home = TestHome::new("append");
    let wire = home
        .path()
        .join(".kimi/sessions/project/session/wire.jsonl");
    write_file(
        &wire,
        "{\"timestamp\":1770983410.0,\"message\":{\"type\":\"StatusUpdate\",\"payload\":{\"token_usage\":{\"input_other\":10,\"output\":2},\"message_id\":\"msg-1\"}}}\n",
    );
    let mut conn = fixture_conn();
    sync_kimi_history_cache_in(&mut conn, home.path(), None).expect("cold sync");
    let first = imported_history::watermark::read_parse_watermark_from_conn(
        &conn,
        SOURCE_KIMI,
        "cli/project/session",
    )
    .expect("read watermark")
    .expect("watermark");

    let changes_before_noop = conn.total_changes();
    sync_kimi_history_cache_in(&mut conn, home.path(), None).expect("unchanged warm sync");
    assert_eq!(
        conn.total_changes(),
        changes_before_noop,
        "unchanged warm sync should reuse snapshots/cache without writes"
    );

    let mut file = OpenOptions::new()
        .append(true)
        .open(&wire)
        .expect("open append");
    writeln!(
        file,
        "{{\"timestamp\":1770983420.0,\"message\":{{\"type\":\"StatusUpdate\",\"payload\":{{\"token_usage\":{{\"input_other\":20,\"output\":3,\"input_cache_read\":4}},\"message_id\":\"msg-2\"}}}}}}"
    )
    .expect("append usage");
    file.flush().expect("flush append");

    sync_kimi_history_cache_in(&mut conn, home.path(), None).expect("warm sync");
    let second = imported_history::watermark::read_parse_watermark_from_conn(
        &conn,
        SOURCE_KIMI,
        "cli/project/session",
    )
    .expect("read watermark")
    .expect("watermark");
    assert!(second.byte_offset > first.byte_offset);
    assert_eq!(
        cached_usage(&conn, "cli/project/session"),
        (
            DEFAULT_MODEL.to_string(),
            34,
            5,
            4,
            0,
            "cli/project/session".to_string()
        )
    );
}

#[test]
fn discovery_accepts_only_exact_layouts_and_rejects_symlink_escape() {
    let home = TestHome::new("discovery");
    write_file(
        &home.path().join(".kimi/sessions/group/session/wire.jsonl"),
        "{}\n",
    );
    write_file(&home.path().join(".kimi/sessions/wire.jsonl"), "{}\n");
    write_file(
        &home
            .path()
            .join(".kimi/sessions/group/session/deeper/wire.jsonl"),
        "{}\n",
    );
    write_file(
        &home
            .path()
            .join(".kimi-code/sessions/work/session/agents/main/wire.jsonl"),
        "{}\n",
    );
    write_file(
        &home
            .path()
            .join(".kimi-code/sessions/work/session/not-agents/main/wire.jsonl"),
        "{}\n",
    );
    #[cfg(unix)]
    {
        let outside = home.path().join("outside/group/session");
        fs::create_dir_all(&outside).expect("create outside");
        write_file(&outside.join("wire.jsonl"), "{}\n");
        std::os::unix::fs::symlink(
            home.path().join("outside"),
            home.path().join(".kimi/sessions/link"),
        )
        .expect("create symlink");
    }

    let conn = fixture_conn();
    let discovery = discover_kimi_records_in(&conn, home.path(), None).expect("discover");
    let ids = discovery
        .records
        .iter()
        .map(|record| record.source_session_id.as_str())
        .collect::<Vec<_>>();
    assert_eq!(ids, vec!["cli/group/session", "code/work/session/main"]);
}

#[cfg(unix)]
#[test]
fn discovery_rejects_a_symlinked_provider_root() {
    let home = TestHome::new("root-symlink");
    let outside = TestHome::new("root-symlink-outside");
    write_file(
        &outside
            .path()
            .join(".kimi/sessions/group/session/wire.jsonl"),
        "{}\n",
    );
    std::os::unix::fs::symlink(outside.path().join(".kimi"), home.path().join(".kimi"))
        .expect("link provider root");

    let conn = fixture_conn();
    let error = discover_kimi_records_in(&conn, home.path(), None)
        .expect_err("provider-root symlink must fail closed");
    assert!(error.contains("unsafe Kimi path"));
}

#[test]
fn replay_coalesces_streamed_content_parts_into_one_assistant_message() {
    let home = TestHome::new("streamed-content");
    write_file(
        &home
            .path()
            .join(".kimi/sessions/project/session/wire.jsonl"),
        concat!(
            "{\"timestamp\":1770983400.0,\"message\":{\"type\":\"TurnBegin\",\"payload\":{\"user_input\":\"hello\"}}}\n",
            "{\"timestamp\":1770983401.0,\"message\":{\"type\":\"ContentPart\",\"payload\":{\"text\":\"hello \"}}}\n",
            "{\"timestamp\":1770983402.0,\"message\":{\"type\":\"ContentPart\",\"payload\":{\"text\":\"back\"}}}\n",
        ),
    );
    let mut conn = fixture_conn();
    sync_kimi_history_cache_in(&mut conn, home.path(), None).expect("sync replay fixture");
    let session_id = format!("{KIMI_SESSION_PREFIX}cli/project/session");
    let replay = load_kimi_history_for_session_in(&conn, &session_id, home.path(), None)
        .expect("load replay");

    assert_eq!(replay.len(), 2);
    assert_eq!(replay[1].function, imported_history::FUNCTION_ASSISTANT);
    assert_eq!(replay[1].result["content"], "hello back");
}

#[test]
fn kimi_code_subagents_are_hidden_and_linked_to_the_hidden_main_row() {
    let home = TestHome::new("subagent-placement");
    for agent in ["main", "worker-1"] {
        write_file(
            &home.path().join(format!(
                ".kimi-code/sessions/work/session/agents/{agent}/wire.jsonl"
            )),
            "{\"type\":\"usage.record\",\"model\":\"k3\",\"usage\":{\"inputOther\":1,\"output\":1},\"usageScope\":\"turn\",\"time\":1780319377010}\n",
        );
    }
    let mut conn = fixture_conn();
    sync_kimi_history_cache_in(&mut conn, home.path(), None).expect("sync subagents");

    let main = conn
        .query_row(
            "SELECT listable, parent_session_id
             FROM imported_history_session_cache
             WHERE source = ?1 AND source_session_id = ?2",
            [SOURCE_KIMI, "code/work/session/main"],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .expect("main placement");
    let worker = conn
        .query_row(
            "SELECT listable, parent_session_id
             FROM imported_history_session_cache
             WHERE source = ?1 AND source_session_id = ?2",
            [SOURCE_KIMI, "code/work/session/worker-1"],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .expect("worker placement");
    assert_eq!(main, (0, String::new()));
    assert_eq!(
        worker,
        (0, format!("{KIMI_SESSION_PREFIX}code/work/session/main"))
    );
}

#[test]
fn failed_core_projection_keeps_the_record_retry_eligible() {
    let home = TestHome::new("projection-retry");
    write_file(
        &home
            .path()
            .join(".kimi/sessions/project/session/wire.jsonl"),
        "{\"timestamp\":1770983410.0,\"message\":{\"type\":\"StatusUpdate\",\"payload\":{\"token_usage\":{\"input_other\":10,\"output\":2},\"message_id\":\"msg-1\"}}}\n",
    );
    let mut conn = fixture_conn();
    conn.execute("DROP TABLE orgtrack_core_sessions", [])
        .expect("drop core projection table");

    sync_kimi_history_cache_in(&mut conn, home.path(), None)
        .expect_err("core projection failure must surface");
    let parser_version: i64 = conn
        .query_row(
            "SELECT parser_version FROM imported_history_session_cache
             WHERE source = ?1 AND source_session_id = ?2",
            [SOURCE_KIMI, "cli/project/session"],
            |row| row.get(0),
        )
        .expect("retry marker");
    assert_eq!(parser_version, -1);

    crate::store::sqlite::SqliteRecordStore::init_tables(&conn)
        .expect("restore core projection table");
    sync_kimi_history_cache_in(&mut conn, home.path(), None).expect("retry succeeds");
    assert_eq!(
        cached_usage(&conn, "cli/project/session").1,
        10,
        "retry restores the imported usage"
    );
}

#[test]
fn kimi_code_home_override_stays_inside_external_history_identity() {
    // Absolute fixtures must be platform-absolute: a unix-rooted "/x" is not
    // absolute on Windows (`is_absolute` needs a drive prefix there), which
    // silently routed the inside-home case through the fallback branch.
    let base = std::env::temp_dir().join("orgii-kimi-home-identity-test");
    let home = base.join("history-home");
    assert_eq!(kimi_code_home_for(&home, None), home.join(".kimi-code"));
    assert_eq!(
        kimi_code_home_for(&home, Some(OsStr::new("custom-kimi"))),
        home.join("custom-kimi")
    );
    let inside = home.join("custom-kimi");
    assert_eq!(
        kimi_code_home_for(&home, Some(inside.as_os_str())),
        home.join("custom-kimi")
    );
    let outside = base.join("primary-user").join(".kimi-code");
    assert_eq!(
        kimi_code_home_for(&home, Some(outside.as_os_str())),
        home.join(".kimi-code")
    );
    assert_eq!(
        kimi_code_home_for(&home, Some(OsStr::new("../escape"))),
        home.join(".kimi-code")
    );
}

#[test]
fn changed_session_batch_cap_leaves_unprocessed_records_eligible() {
    let home = TestHome::new("batch-cap");
    for index in 0..=MAX_CHANGED_SESSIONS_PER_SYNC {
        write_file(
            &home.path().join(format!(
                ".kimi/sessions/group/session-{index:03}/wire.jsonl"
            )),
            &format!(
                "{{\"timestamp\":1770983410.0,\"message\":{{\"type\":\"StatusUpdate\",\"payload\":{{\"token_usage\":{{\"input_other\":1,\"output\":1}},\"message_id\":\"msg-{index}\"}}}}}}\n"
            ),
        );
    }
    let mut conn = fixture_conn();

    sync_kimi_history_cache_in(&mut conn, home.path(), None).expect("first bounded sync");
    let first_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM imported_history_session_cache WHERE source = ?1",
            [SOURCE_KIMI],
            |row| row.get(0),
        )
        .expect("first cache count");
    assert_eq!(first_count, MAX_CHANGED_SESSIONS_PER_SYNC as i64);

    sync_kimi_history_cache_in(&mut conn, home.path(), None).expect("second bounded sync");
    let second_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM imported_history_session_cache WHERE source = ?1",
            [SOURCE_KIMI],
            |row| row.get(0),
        )
        .expect("second cache count");
    assert_eq!(second_count, (MAX_CHANGED_SESSIONS_PER_SYNC + 1) as i64);
}
