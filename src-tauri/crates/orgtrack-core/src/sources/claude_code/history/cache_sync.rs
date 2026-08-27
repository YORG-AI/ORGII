use rusqlite::Connection;

use crate::sources::imported_history::{
    self, cache as imported_cache, managed_mirror,
    metadata::{ImportedHistoryDiscoveredRecord, SOURCE_CLAUDE_CODE},
    scan_snapshot,
};

use super::discovery::{
    claude_projects_dirs, discover_claude_code_history_records, ClaudeCodeDiscovery,
};
use super::metadata::{parse_claude_session_meta_with_title, session_meta_to_cache_input};
use super::{ClaudeCodeHistorySessionPage, ClaudeCodeRecentPath};

pub fn list_claude_code_history_sessions_paginated(
    conn: &mut Connection,
    limit: usize,
    offset: usize,
) -> Result<ClaudeCodeHistorySessionPage, String> {
    sync_claude_code_history_cache(conn)?;
    imported_cache::query_imported_session_page_from_conn(conn, SOURCE_CLAUDE_CODE, limit, offset)
}

pub fn list_claude_code_recent_paths(
    conn: &mut Connection,
    limit: usize,
) -> Result<Vec<ClaudeCodeRecentPath>, String> {
    sync_claude_code_history_cache(conn)?;
    imported_cache::query_imported_recent_paths_from_conn(conn, SOURCE_CLAUDE_CODE, limit)
}

fn sync_claude_code_history_cache(conn: &mut Connection) -> Result<(), String> {
    let previous_snapshots = scan_snapshot::read_dir_snapshots_from_conn(conn, SOURCE_CLAUDE_CODE);
    let mut walker = scan_snapshot::SnapshotDirWalker::new(&previous_snapshots, "jsonl", "Claude");
    let discovery = discover_claude_code_history_records(&claude_projects_dirs()?, &mut walker)?;
    let next_snapshots = walker.into_snapshots();
    scan_snapshot::persist_dir_snapshots_if_changed(
        conn,
        SOURCE_CLAUDE_CODE,
        &previous_snapshots,
        &next_snapshots,
    )?;
    let ClaudeCodeDiscovery {
        records: mut discovered,
        external_titles,
    } = discovery;
    // Managed (GUI-launched) sessions surface through their code_sessions
    // row; the imported twin goes unlistable. Folding the verdict into the
    // fingerprint re-parses a session whose managed status flips.
    let managed_ids = managed_mirror::managed_source_session_ids_from_conn(
        conn,
        SOURCE_CLAUDE_CODE,
        SOURCE_CLAUDE_CODE,
    )?;
    for record in &mut discovered {
        managed_mirror::append_managed_fingerprint(
            &mut record.source_fingerprint,
            managed_ids.contains(&record.source_session_id),
        );
    }
    let signatures = discovered
        .iter()
        .map(ImportedHistoryDiscoveredRecord::signature)
        .collect::<Vec<_>>();
    let changed = imported_cache::changed_records_from_conn(
        conn,
        SOURCE_CLAUDE_CODE,
        &discovered,
        |record| record.signature(),
    )?;
    let mut inputs = Vec::new();
    let mut rounds = Vec::new();
    let mut reparsed_ids = Vec::new();
    for record in changed {
        let stored_watermark = imported_history::watermark::read_parse_watermark_from_conn(
            conn,
            SOURCE_CLAUDE_CODE,
            &record.source_session_id,
        )?;
        let external_title = external_titles
            .get(&record.source_session_id)
            .cloned()
            .unwrap_or_default();
        let Some(parse) = imported_history::skip_unparsable_record(
            SOURCE_CLAUDE_CODE,
            &record.source_session_id,
            parse_claude_session_meta_with_title(record, stored_watermark.as_ref(), external_title),
        ) else {
            continue;
        };
        imported_history::watermark::write_parse_watermark_from_conn(
            conn,
            SOURCE_CLAUDE_CODE,
            &record.source_session_id,
            &parse.watermark,
        )?;
        if let Some(mut meta) = parse.meta {
            let is_managed_history_mirror = managed_ids.contains(&meta.source_session_id);
            reparsed_ids.push(meta.session_id.clone());
            rounds.append(&mut meta.rounds);
            let mut input = session_meta_to_cache_input(meta);
            input.listable = input.listable && !is_managed_history_mirror;
            inputs.push(input);
        }
    }
    imported_cache::sync_source_cache_from_conn(
        conn,
        SOURCE_CLAUDE_CODE,
        imported_cache::live_ids_from_signatures(&signatures),
        inputs,
    )?;
    imported_cache::write_session_rounds_from_conn(conn, &reparsed_ids, &rounds)?;
    // Context-window continuations rewrite the conversation into a new
    // session file with the same first-user-message uuid; keep only the
    // newest sibling of each family listable.
    imported_cache::demote_superseded_continuations_from_conn(conn, SOURCE_CLAUDE_CODE)?;
    Ok(())
}
