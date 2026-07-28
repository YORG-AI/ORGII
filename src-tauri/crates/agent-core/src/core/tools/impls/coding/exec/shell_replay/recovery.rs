//! Startup recovery for shell replay artifacts that were still `running`
//! when the application last exited: torn frames are truncated, page
//! indexes are rebuilt, and the replay is marked `incomplete`.

use std::collections::VecDeque;
use std::fs::OpenOptions;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};

use chrono::Utc;
use rusqlite::params;

use super::active::{append_tail, remove_active, ShellReplayStream, ShellReplayTarget};
use super::text::decode_utf8_tail_bounded;
use super::{
    byte_line_count, is_safe_relative_path, resolve_replay_root, ReplayPageState, FILE_MAGIC,
    FRAME_HEADER_BYTES, SHELL_REPLAY_FRAME_MAX_BYTES, SHELL_REPLAY_PAGE_BYTES,
    SHELL_REPLAY_PREVIEW_BYTES,
};

/// Repair artifacts whose manifest was still `running` when the application
/// last exited. Valid complete frames are retained, a torn final frame is
/// truncated, page indexes are rebuilt, and the replay is made explicitly
/// `incomplete` so it can never be presented as complete/successful.
pub fn recover_incomplete_replays() -> Result<usize, String> {
    recover_incomplete_replays_at(&resolve_replay_root())
}

pub(super) fn recover_incomplete_replays_at(replay_root: &Path) -> Result<usize, String> {
    let rows: Vec<(String, String, PathBuf)> = {
        let conn = database::db::get_connection().map_err(|err| err.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT session_id, call_id, relative_path
                 FROM shell_replays WHERE status = 'running'",
            )
            .map_err(|err| err.to_string())?;
        let mapped = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    PathBuf::from(row.get::<_, String>(2)?),
                ))
            })
            .map_err(|err| err.to_string())?;
        mapped.filter_map(Result::ok).collect()
    };

    let mut recovered = 0usize;
    for (session_id, call_id, relative_path) in rows {
        let target = ShellReplayTarget::new(session_id, call_id);
        recover_one_replay(replay_root, &target, &relative_path)?;
        remove_active(&target);
        recovered = recovered.saturating_add(1);
    }
    Ok(recovered)
}

fn recover_one_replay(
    replay_root: &Path,
    target: &ShellReplayTarget,
    relative_path: &Path,
) -> Result<(), String> {
    if !is_safe_relative_path(relative_path) {
        return mark_recovered_manifest(
            target,
            0,
            0,
            "",
            &[],
            "invalid replay path found during startup recovery",
        );
    }

    let path = replay_root.join(relative_path);
    let file = match OpenOptions::new().read(true).write(true).open(&path) {
        Ok(file) => file,
        Err(err) => {
            return mark_recovered_manifest(
                target,
                0,
                0,
                "",
                &[],
                &format!("replay artifact unavailable after restart: {err}"),
            )
        }
    };
    let mut reader = BufReader::new(
        file.try_clone()
            .map_err(|err| format!("clone replay for recovery: {err}"))?,
    );
    let mut magic = vec![0u8; FILE_MAGIC.len()];
    if reader.read_exact(&mut magic).is_err() || magic != FILE_MAGIC {
        file.set_len(0)
            .map_err(|err| format!("truncate corrupt replay {}: {err}", path.display()))?;
        file.sync_all()
            .map_err(|err| format!("sync corrupt replay {}: {err}", path.display()))?;
        return mark_recovered_manifest(
            target,
            0,
            0,
            "",
            &[],
            "replay header was corrupt after restart",
        );
    }

    let mut file_offset = FILE_MAGIC.len() as u64;
    let mut total_bytes = 0u64;
    let mut last_sequence = 0u64;
    let mut preview = VecDeque::with_capacity(SHELL_REPLAY_PREVIEW_BYTES);
    let mut pages: Vec<ReplayPageState> = Vec::new();
    let mut recovery_note = "application exited before replay finalized".to_string();

    loop {
        let frame_offset = file_offset;
        let mut header = [0u8; FRAME_HEADER_BYTES];
        match reader.read_exact(&mut header) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::UnexpectedEof => {
                if reader
                    .get_ref()
                    .metadata()
                    .map(|meta| meta.len() > frame_offset)
                    .unwrap_or(false)
                {
                    recovery_note = "truncated incomplete replay frame after restart".to_string();
                }
                break;
            }
            Err(err) => {
                recovery_note = format!("failed to scan replay after restart: {err}");
                break;
            }
        }
        let sequence = u64::from_le_bytes(header[0..8].try_into().expect("sequence bytes"));
        let stream = match ShellReplayStream::from_byte(header[16]) {
            Ok(stream) => stream,
            Err(err) => {
                recovery_note = err;
                break;
            }
        };
        let length = u32::from_le_bytes(header[17..21].try_into().expect("length bytes")) as usize;
        if length == 0 || length > SHELL_REPLAY_FRAME_MAX_BYTES {
            recovery_note = format!("invalid replay frame length {length} found after restart");
            break;
        }
        if sequence != last_sequence.saturating_add(1) {
            recovery_note = "invalid replay frame sequence found after restart".to_string();
            break;
        }
        let mut payload = vec![0u8; length];
        if reader.read_exact(&mut payload).is_err() {
            recovery_note = "truncated incomplete replay payload after restart".to_string();
            break;
        }

        let frame_byte_start = total_bytes;
        let page_index = frame_byte_start / SHELL_REPLAY_PAGE_BYTES;
        if pages
            .last()
            .is_none_or(|page| page.page_index != page_index)
        {
            pages.push(ReplayPageState {
                page_index,
                file_offset: frame_offset,
                output_byte_start: frame_byte_start,
                first_sequence: sequence,
                last_sequence: sequence,
                line_count: 0,
                dirty: false,
            });
        }
        let page = pages.last_mut().expect("page was inserted");
        page.last_sequence = sequence;
        page.line_count = page.line_count.saturating_add(byte_line_count(&payload));
        append_tail(&mut preview, stream, &payload, SHELL_REPLAY_PREVIEW_BYTES);
        total_bytes = total_bytes.saturating_add(length as u64);
        last_sequence = sequence;
        file_offset = frame_offset
            .saturating_add(FRAME_HEADER_BYTES as u64)
            .saturating_add(length as u64);
    }

    file.set_len(file_offset)
        .and_then(|_| file.sync_all())
        .map_err(|err| format!("truncate recovered replay {}: {err}", path.display()))?;
    let preview_text = decode_utf8_tail_bounded(
        &preview.iter().copied().collect::<Vec<_>>(),
        SHELL_REPLAY_PREVIEW_BYTES,
    );
    mark_recovered_manifest(
        target,
        total_bytes,
        last_sequence,
        &preview_text,
        &pages,
        &recovery_note,
    )
}

fn mark_recovered_manifest(
    target: &ShellReplayTarget,
    total_bytes: u64,
    last_sequence: u64,
    preview: &str,
    pages: &[ReplayPageState],
    error: &str,
) -> Result<(), String> {
    let completed_at = Utc::now().to_rfc3339();
    database::db::with_sessions_writer(|| -> rusqlite::Result<()> {
        let conn = database::db::get_connection()?;
        let tx = database::db::begin_immediate(&conn)?;
        tx.execute(
            "DELETE FROM shell_replay_pages WHERE session_id = ?1 AND call_id = ?2",
            params![target.session_id, target.call_id],
        )?;
        for page in pages {
            tx.execute(
                "INSERT INTO shell_replay_pages (
                    session_id, call_id, page_index, file_offset,
                    output_byte_start, first_sequence, last_sequence, line_count
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    target.session_id,
                    target.call_id,
                    page.page_index,
                    page.file_offset,
                    page.output_byte_start,
                    page.first_sequence,
                    page.last_sequence,
                    page.line_count,
                ],
            )?;
        }
        tx.execute(
            "UPDATE shell_replays SET status = 'incomplete', total_bytes = ?3,
                last_sequence = ?4, terminal_preview = ?5, error = ?6,
                completed_at = ?7, updated_at = ?7
             WHERE session_id = ?1 AND call_id = ?2",
            params![
                target.session_id,
                target.call_id,
                total_bytes,
                last_sequence,
                preview,
                error,
                completed_at,
            ],
        )?;
        tx.commit()
    })
    .map_err(|err| format!("persist recovered shell replay: {err}"))
}
