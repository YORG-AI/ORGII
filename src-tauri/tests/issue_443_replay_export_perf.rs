//! Ignored real-path acceptance harness for issue #443 streamed exports.
//!
//! The regular replay unit suite proves individual range limits. This test
//! exercises the public Tauri command against a production-shaped sessions DB
//! and a deterministic source whose exported JSON is at least 300 MiB. Keep it
//! ignored in normal CI: it intentionally performs several hundred MiB of
//! disk I/O and samples process peak RSS.

#![cfg(unix)]

use std::fs::{File, OpenOptions};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::Path;

use app_lib::agent_sessions::event_pipeline::commands::external_replay::{
    external_replay_stream_export, ReplayExportFormat,
};
use orgtrack_core::sources::imported_history::replay::{
    open_window, scan_window_after, scan_window_after_generation, ImportedHistorySourceId,
    ReplayLimits,
};
use orgtrack_core::store::sqlite::SqliteRecordStore;
use sha2::{Digest, Sha256};

const MIB: usize = 1024 * 1024;
const SOURCE_BYTES: u64 = 160 * MIB as u64;
const MIN_EXPORT_BYTES: u64 = 300 * MIB as u64;
const HASH_BUFFER_BYTES: usize = MIB;
const MAX_EXPORT_RSS_GROWTH_BYTES: usize = 64 * MIB;

fn assistant_line(turn: u64, padding: &str) -> Vec<u8> {
    let body = format!("export-turn-{turn:08}:{padding}");
    let mut line = serde_json::json!({
        "timestamp": "2026-07-23T00:00:01Z",
        "type": "event_msg",
        "payload": { "type": "agent_message", "message": body },
    })
    .to_string()
    .into_bytes();
    line.push(b'\n');
    line
}

fn write_source(path: &Path) {
    let file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .expect("create deterministic export source");
    let mut writer = BufWriter::with_capacity(MIB, file);
    let padding = "e".repeat(32 * 1024);
    let mut written = 0_u64;
    let mut turn = 0_u64;
    while written < SOURCE_BYTES {
        // Keep the fixture production-shaped: a user row starts each turn,
        // followed by one complete assistant message. Thousands of adjacent
        // assistant rows in one synthetic turn are streaming snapshots and
        // are intentionally consolidated by normal ingestion.
        let user = serde_json::json!({
            "timestamp": "2026-07-23T00:00:00Z",
            "type": "event_msg",
            "payload": {
                "type": "user_message",
                "message": format!("next export turn {turn:08}"),
            },
        })
        .to_string();
        let line = assistant_line(turn, &padding);
        writer.write_all(user.as_bytes()).expect("write user row");
        writer.write_all(b"\n").expect("finish user row");
        writer.write_all(&line).expect("write assistant row");
        written = written.saturating_add((user.len() + 1 + line.len()) as u64);
        turn = turn.saturating_add(1);
    }
    writer.flush().expect("flush deterministic export source");
}

fn peak_rss_bytes() -> usize {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
    let result = unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) };
    assert_eq!(result, 0, "getrusage failed");
    let peak = unsafe { usage.assume_init() }.ru_maxrss as usize;
    #[cfg(target_os = "macos")]
    {
        peak
    }
    #[cfg(not(target_os = "macos"))]
    {
        peak.saturating_mul(1024)
    }
}

fn file_sha256(path: &Path) -> (u64, String) {
    let file = File::open(path).expect("open streamed export");
    let mut reader = BufReader::with_capacity(HASH_BUFFER_BYTES, file);
    let mut buffer = vec![0_u8; HASH_BUFFER_BYTES];
    let mut bytes = 0_u64;
    let mut digest = Sha256::new();
    loop {
        let read = reader.read(&mut buffer).expect("hash streamed export");
        if read == 0 {
            break;
        }
        bytes = bytes.saturating_add(read as u64);
        digest.update(&buffer[..read]);
    }
    (bytes, format!("{:x}", digest.finalize()))
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "#443 serial 300 MiB streamed-export/RSS acceptance"]
async fn production_export_streams_three_hundred_mib_with_exact_hash_and_bounded_rss() {
    let sandbox = test_helpers::test_env::sandbox();
    let source_path = sandbox.path().join("codex-export.jsonl");
    let destination = sandbox.path().join("codex-export.json");
    write_source(&source_path);

    let mut conn = database::db::get_connection().expect("open sandbox sessions DB");
    SqliteRecordStore::init_tables(&conn).expect("initialize orgtrack tables");
    SqliteRecordStore::init_source_cache_tables(&conn).expect("initialize imported replay cache");
    conn.execute(
        "INSERT INTO imported_history_session_cache (
             source, source_session_id, session_id, source_path
         ) VALUES ('codex_app', 'issue-443-export', 'codexapp-issue-443-export', ?1)",
        [source_path.to_string_lossy().as_ref()],
    )
    .expect("register deterministic Codex source");
    let opened = open_window(
        &mut conn,
        ImportedHistorySourceId::CodexApp,
        "codexapp-issue-443-export",
        ReplayLimits::default(),
    )
    .expect("pre-index deterministic export source");
    let expected_event_count = opened.total_event_count;
    let source_bytes = std::fs::metadata(&source_path)
        .expect("stat deterministic export source")
        .len();
    let (indexed_events, indexed_max_sequence): (u64, i64) = conn
        .query_row(
            "SELECT COUNT(*), COALESCE(MAX(sequence), -1)
             FROM imported_replay_events
             WHERE source='codex_app' AND source_session_id='issue-443-export'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("inspect deterministic replay index");
    eprintln!(
        "#443 export setup: source={:.1} MiB, parsed={:.1} MiB/{} rows, indexed={} events through sequence {}",
        source_bytes as f64 / MIB as f64,
        opened.stats.parsed_bytes as f64 / MIB as f64,
        opened.stats.parsed_rows,
        indexed_events,
        indexed_max_sequence,
    );
    assert_eq!(indexed_events, expected_event_count);
    let scan_limits = ReplayLimits {
        max_turns: 10,
        max_events: 200,
        max_ipc_bytes: 256 * 1024,
    };
    let first_scan = scan_window_after(
        &mut conn,
        ImportedHistorySourceId::CodexApp,
        "codexapp-issue-443-export",
        -1,
        scan_limits,
    )
    .expect("probe first production export scan");
    eprintln!(
        "#443 export scan 0: chunks={}, through={}, has_more={}",
        first_scan.chunks.len(),
        first_scan.cursor.through_sequence,
        first_scan.has_more,
    );
    let second_scan = scan_window_after_generation(
        &mut conn,
        ImportedHistorySourceId::CodexApp,
        "codexapp-issue-443-export",
        &first_scan.cursor.generation,
        first_scan.cursor.revision,
        first_scan.cursor.through_sequence,
        scan_limits,
    )
    .expect("probe second production export scan");
    eprintln!(
        "#443 export scan 1: chunks={}, through={}, has_more={}",
        second_scan.chunks.len(),
        second_scan.cursor.through_sequence,
        second_scan.has_more,
    );
    drop(conn);

    let rss_before_export = peak_rss_bytes();
    let result = external_replay_stream_export(
        "codex_app".to_string(),
        "codexapp-issue-443-export".to_string(),
        destination.to_string_lossy().into_owned(),
        ReplayExportFormat::Json,
        None,
    )
    .await
    .expect("run production streamed export command");
    let rss_after_export = peak_rss_bytes();
    let export_rss_growth = rss_after_export.saturating_sub(rss_before_export);

    let (bytes, hash) = file_sha256(&destination);
    eprintln!(
        "#443 export: bytes={:.1} MiB, events={}, sha256={}, export-only peak RSS growth={:.1} MiB",
        bytes as f64 / MIB as f64,
        result.event_count,
        hash,
        export_rss_growth as f64 / MIB as f64,
    );
    assert!(
        bytes >= MIN_EXPORT_BYTES,
        "acceptance export must be at least 300 MiB, got {bytes} bytes"
    );
    assert_eq!(result.bytes_written, bytes);
    assert_eq!(result.sha256, hash);
    assert_eq!(result.event_count, expected_event_count);
    assert!(
        export_rss_growth <= MAX_EXPORT_RSS_GROWTH_BYTES,
        "300 MiB streamed export grew peak RSS by {export_rss_growth} bytes"
    );
}
