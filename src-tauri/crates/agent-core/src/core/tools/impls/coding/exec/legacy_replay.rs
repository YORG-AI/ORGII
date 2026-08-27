//! One-time, bounded migration of legacy `.txt` terminal logs.
//!
//! Historical terminal logs predate Snapshot watermarks. We therefore attach
//! an imported artifact only as mutable terminal state on the shell tool row;
//! this module never manufactures `shell_replay_bookmarks` for old timeline
//! events. The frontend may use the final state at the live edge (or after its
//! trustworthy completion timestamp), while an earlier Snapshot keeps its own
//! legacy preview and cannot see future output.

use std::fs::{self, File};
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use core_types::session_event::{
    EventDisplayStatus, SessionEvent, ShellReplayBookmark, ShellReplayRef, ShellReplayState,
    ShellReplayStatus,
};

use super::shell_replay::{
    complete_terminal_prefix_len, load_replay_state, resolve_replay_root, ShellReplayStream,
    ShellReplayTarget, ShellReplayWriter, SHELL_REPLAY_FORMAT_VERSION,
    SHELL_REPLAY_FRAME_MAX_BYTES, SHELL_REPLAY_PREVIEW_BYTES,
};

const LEGACY_SCAN_BYTES: usize = 64 * 1024;
const LEGACY_IMPORT_BUFFER_BYTES: usize = 16 * 1024;
pub const HISTORICAL_OUTPUT_UNAVAILABLE: &str = "历史预览，完整输出不可恢复";

#[derive(Debug)]
struct LegacyLayout {
    path: PathBuf,
    body_start: u64,
    body_end: u64,
    command: String,
    cwd: String,
    completed_at: String,
}

/// Attach durable final states to terminal historical shell rows when their
/// legacy file is still trustworthy and available. This function deliberately
/// does not modify `shell_replay_bookmarks`.
pub fn hydrate_legacy_shell_replays(events: &mut [SessionEvent]) {
    for event in events {
        if event.shell_replay.is_some() {
            reconcile_cached_replay_with_manifest(event);
            continue;
        }
        if !is_terminal_legacy_shell(event) {
            continue;
        }
        let Some(call_id) = event.call_id.clone().filter(|value| !value.is_empty()) else {
            // Exact session + call ownership is mandatory. The ordinary
            // hydration fallback will retain a bounded preview without
            // pretending that an artifact can be addressed safely.
            continue;
        };

        match ensure_legacy_replay(event, &call_id) {
            Ok(Some(state)) => event.shell_replay = Some(state),
            Ok(None) => {
                event.shell_replay = Some(unavailable_state(event, call_id));
            }
            Err(err) => {
                tracing::warn!(
                    session_id = %event.session_id,
                    call_id,
                    error = %err,
                    "failed to migrate historical shell replay"
                );
                event.shell_replay = load_replay_state(&event.session_id, &call_id)
                    .ok()
                    .flatten()
                    .map(|mut state| {
                        state.status = ShellReplayStatus::Incomplete;
                        state.error = Some(format!("{HISTORICAL_OUTPUT_UNAVAILABLE}: {err}"));
                        state
                    })
                    .or_else(|| Some(unavailable_state(event, call_id)));
            }
        }
    }
}

/// Crash recovery repairs the artifact/manifest before EventStore hydration,
/// but the cached event meta may still say `running`. The manifest is the
/// durable source of truth once it is terminal. Never copy this mutable repair
/// into an immutable historical bookmark.
fn reconcile_cached_replay_with_manifest(event: &mut SessionEvent) {
    let Some(existing) = event.shell_replay.as_ref() else {
        return;
    };
    let Some(call_id) = event.call_id.as_deref() else {
        return;
    };
    if existing.replay_ref.session_id != event.session_id || existing.replay_ref.call_id != call_id
    {
        return;
    }

    let manifest = match load_replay_state(&event.session_id, call_id) {
        Ok(Some(state)) => state,
        Ok(None) => return,
        Err(err) => {
            tracing::warn!(
                session_id = %event.session_id,
                call_id,
                error = %err,
                "failed to reconcile cached shell replay with durable manifest"
            );
            return;
        }
    };
    if manifest.replay_ref != existing.replay_ref {
        return;
    }

    let manifest_is_terminal = manifest.status != ShellReplayStatus::Running;
    let manifest_is_not_older = manifest.bookmark.visible_through_sequence
        >= existing.bookmark.visible_through_sequence
        && manifest.bookmark.visible_bytes >= existing.bookmark.visible_bytes;
    if manifest_is_terminal || manifest_is_not_older {
        event.shell_replay = Some(manifest);
    }
}

fn ensure_legacy_replay(
    event: &SessionEvent,
    call_id: &str,
) -> Result<Option<ShellReplayState>, String> {
    if let Some(state) = load_replay_state(&event.session_id, call_id)? {
        return Ok(Some(state));
    }

    let Some(path) = legacy_log_path(event) else {
        return Ok(None);
    };
    let layout = match inspect_legacy_log(&path, event) {
        Ok(layout) => layout,
        Err(err) => {
            tracing::info!(path = %path.display(), reason = %err, "legacy shell log is unavailable or untrusted");
            return Ok(None);
        }
    };

    import_legacy_log(event, call_id, layout)?;
    load_replay_state(&event.session_id, call_id)?
        .ok_or_else(|| {
            format!(
                "legacy replay manifest missing after import for {}/{}",
                event.session_id, call_id
            )
        })
        .map(Some)
}

fn import_legacy_log(
    event: &SessionEvent,
    call_id: &str,
    layout: LegacyLayout,
) -> Result<(), String> {
    let target = ShellReplayTarget::new(event.session_id.clone(), call_id.to_string());
    let mut writer = ShellReplayWriter::create_detached(
        &resolve_replay_root(),
        target,
        &layout.command,
        Path::new(&layout.cwd),
    )?;

    let import_result = (|| -> Result<(), String> {
        let file = File::open(&layout.path)
            .map_err(|err| format!("open legacy log {}: {err}", layout.path.display()))?;
        let mut reader = BufReader::with_capacity(LEGACY_IMPORT_BUFFER_BYTES, file);
        reader
            .seek(SeekFrom::Start(layout.body_start))
            .map_err(|err| format!("seek legacy log {}: {err}", layout.path.display()))?;

        let mut remaining = layout.body_end.saturating_sub(layout.body_start);
        let mut read_buffer = [0u8; LEGACY_IMPORT_BUFFER_BYTES];
        let mut utf8_carry = Vec::with_capacity(LEGACY_IMPORT_BUFFER_BYTES + 4);
        while remaining > 0 {
            let frame_room = SHELL_REPLAY_FRAME_MAX_BYTES.saturating_sub(utf8_carry.len());
            let wanted = remaining
                .min(LEGACY_IMPORT_BUFFER_BYTES as u64)
                .min(frame_room as u64) as usize;
            let read = reader
                .read(&mut read_buffer[..wanted])
                .map_err(|err| format!("read legacy log {}: {err}", layout.path.display()))?;
            if read == 0 {
                return Err(format!(
                    "legacy log {} ended before its inspected body boundary",
                    layout.path.display()
                ));
            }
            remaining = remaining.saturating_sub(read as u64);
            utf8_carry.extend_from_slice(&read_buffer[..read]);
            let complete = complete_terminal_prefix_len(&utf8_carry);
            if complete > 0 {
                writer.append(ShellReplayStream::Stdout, &utf8_carry[..complete])?;
                utf8_carry.drain(..complete);
            }
        }
        if !utf8_carry.is_empty() {
            writer.append(ShellReplayStream::Stdout, &utf8_carry)?;
        }
        Ok(())
    })();

    if let Err(err) = import_result {
        writer.mark_incomplete(format!("{HISTORICAL_OUTPUT_UNAVAILABLE}: {err}"));
        return Err(err);
    }
    writer.finalize_at(ShellReplayStatus::Complete, None, layout.completed_at)?;
    Ok(())
}

fn is_terminal_legacy_shell(event: &SessionEvent) -> bool {
    if event.action_type != "tool_call"
        || !matches!(
            event.display_status,
            EventDisplayStatus::Completed | EventDisplayStatus::Failed
        )
    {
        return false;
    }
    event.ui_canonical == core_types::tool_names::RUN_SHELL
        || matches!(
            event.function_name.as_str(),
            "run_shell"
                | "bash"
                | "shell"
                | "execute_command"
                | "run_terminal_command"
                | "terminal"
                | "terminal_command"
        )
}

fn legacy_log_path(event: &SessionEvent) -> Option<PathBuf> {
    if let Some(core_types::extracted::ExtractedData::Shell(shell)) = event.extracted.as_ref() {
        if let Some(path) = shell.shell_log_path.as_deref() {
            return Some(PathBuf::from(path));
        }
    }
    ["shellLogPath", "shell_log_path"]
        .iter()
        .find_map(|key| event.args.get(*key).and_then(|value| value.as_str()))
        .map(PathBuf::from)
}

fn inspect_legacy_log(candidate: &Path, event: &SessionEvent) -> Result<LegacyLayout, String> {
    let link_meta = fs::symlink_metadata(candidate)
        .map_err(|err| format!("legacy log metadata is unavailable: {err}"))?;
    if link_meta.file_type().is_symlink() {
        return Err("legacy log symlinks are not trusted".to_string());
    }
    let path = fs::canonicalize(candidate)
        .map_err(|err| format!("legacy log path cannot be resolved: {err}"))?;
    let metadata =
        fs::metadata(&path).map_err(|err| format!("legacy log metadata is unavailable: {err}"))?;
    if !metadata.is_file() {
        return Err("legacy log is not a regular file".to_string());
    }
    if path.extension().and_then(|value| value.to_str()) != Some("txt")
        || !legacy_filename_is_trusted(&path)
        || !legacy_location_is_trusted(&path, event)
    {
        return Err("legacy log name or extension is not recognized".to_string());
    }

    let file_len = metadata.len();
    let mut file =
        File::open(&path).map_err(|err| format!("legacy log cannot be opened: {err}"))?;
    let prefix_len = file_len.min(LEGACY_SCAN_BYTES as u64) as usize;
    let mut prefix = vec![0u8; prefix_len];
    file.read_exact(&mut prefix)
        .map_err(|err| format!("legacy log header cannot be read: {err}"))?;
    let header_end = find_bytes(&prefix, b"\n---\n")
        .ok_or_else(|| "legacy log header terminator is missing".to_string())?;
    let header = std::str::from_utf8(&prefix[..header_end + 1])
        .map_err(|_| "legacy log header is not UTF-8".to_string())?;
    let (command, cwd) = validate_header(header)?;
    let body_start = (header_end + 5) as u64;

    let tail_start = file_len.saturating_sub(LEGACY_SCAN_BYTES as u64);
    file.seek(SeekFrom::Start(tail_start))
        .map_err(|err| format!("legacy log footer cannot be sought: {err}"))?;
    let mut tail = vec![0u8; (file_len - tail_start) as usize];
    file.read_exact(&mut tail)
        .map_err(|err| format!("legacy log footer cannot be read: {err}"))?;

    let (body_end, completed_at) = match find_valid_footer(&tail, tail_start, body_start) {
        Some(footer) => footer,
        None => {
            let modified = metadata
                .modified()
                .map_err(|err| format!("legacy log modification time is unavailable: {err}"))?;
            (file_len, DateTime::<Utc>::from(modified).to_rfc3339())
        }
    };
    if body_end < body_start {
        return Err("legacy log body boundaries are invalid".to_string());
    }

    Ok(LegacyLayout {
        path,
        body_start,
        body_end,
        command,
        cwd,
        completed_at,
    })
}

fn legacy_filename_is_trusted(path: &Path) -> bool {
    let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
        return false;
    };
    let Some((timestamp, counter)) = stem.split_once('_') else {
        return false;
    };
    !timestamp.is_empty()
        && !counter.is_empty()
        && timestamp.bytes().all(|byte| byte.is_ascii_digit())
        && counter.bytes().all(|byte| byte.is_ascii_digit())
}

fn legacy_location_is_trusted(path: &Path, event: &SessionEvent) -> bool {
    let mut roots = vec![app_paths::orgii_root().join("agent-terminal-logs")];
    if let Some(repo_path) = event.repo_path.as_deref() {
        roots.push(PathBuf::from(repo_path).join(".orgii").join("terminals"));
    }

    roots
        .into_iter()
        .filter_map(|root| fs::canonicalize(root).ok())
        .any(|canonical_root| path.starts_with(canonical_root))
}

fn validate_header(header: &str) -> Result<(String, String), String> {
    if !header.starts_with("---\n") {
        return Err("legacy log header marker is missing".to_string());
    }
    header_value(header, "pid")
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|pid| *pid > 0)
        .ok_or_else(|| "legacy log pid is invalid".to_string())?;
    let cwd = header_value(header, "cwd")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "legacy log cwd is missing".to_string())?
        .to_string();
    let command = header_value(header, "command")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "legacy log command is missing".to_string())?
        .to_string();
    let started_at = header_value(header, "started_at")
        .ok_or_else(|| "legacy log started_at is missing".to_string())?;
    DateTime::parse_from_rfc3339(started_at)
        .map_err(|_| "legacy log started_at is invalid".to_string())?;
    Ok((command, cwd))
}

fn find_valid_footer(tail: &[u8], tail_start: u64, body_start: u64) -> Option<(u64, String)> {
    let relative = rfind_bytes(tail, b"\n---\n")?;
    let footer_start = tail_start.saturating_add(relative as u64);
    if footer_start < body_start {
        return None;
    }
    let footer = std::str::from_utf8(&tail[relative + 5..]).ok()?;
    let ended_at = header_value(footer, "ended_at")?;
    let completed_at = DateTime::parse_from_rfc3339(ended_at).ok()?.to_rfc3339();
    let terminal_status = header_value(footer, "exit_code")
        .and_then(|value| value.parse::<i32>().ok())
        .is_some()
        || header_value(footer, "status") == Some("killed");
    let elapsed_valid = header_value(footer, "elapsed_ms")
        .and_then(|value| value.parse::<u64>().ok())
        .is_some();
    (terminal_status && elapsed_valid).then_some((footer_start, completed_at))
}

fn header_value<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    text.lines().find_map(|line| {
        let (candidate, value) = line.split_once(':')?;
        (candidate.trim() == key).then_some(value.trim())
    })
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn rfind_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .rposition(|window| window == needle)
}

fn unavailable_state(event: &SessionEvent, call_id: String) -> ShellReplayState {
    let source = legacy_preview(event);
    let mut start = source.len().saturating_sub(SHELL_REPLAY_PREVIEW_BYTES);
    while start < source.len() && !source.is_char_boundary(start) {
        start += 1;
    }
    // Borrow the legacy payload through boundary selection and allocate only
    // the final bounded tail. Historical 10 MiB rows must not be cloned before
    // the EventStore hydration sanitizer gets a chance to remove them.
    let preview = source[start..].to_string();
    ShellReplayState {
        replay_ref: ShellReplayRef {
            session_id: event.session_id.clone(),
            call_id,
            format_version: SHELL_REPLAY_FORMAT_VERSION,
        },
        bookmark: ShellReplayBookmark::default(),
        terminal_preview: preview,
        status: ShellReplayStatus::Incomplete,
        error: Some(HISTORICAL_OUTPUT_UNAVAILABLE.to_string()),
        completed_at: None,
    }
}

fn legacy_preview(event: &SessionEvent) -> &str {
    if let Some(core_types::extracted::ExtractedData::Shell(shell)) = event.extracted.as_ref() {
        if let Some(value) = shell.stream_output.as_ref().or(shell.output.as_ref()) {
            return value;
        }
    }
    ["streamOutput", "output"]
        .iter()
        .find_map(|key| event.args.get(*key).and_then(|value| value.as_str()))
        .or_else(|| {
            ["content", "observation", "output"]
                .iter()
                .find_map(|key| event.result.get(*key).and_then(|value| value.as_str()))
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use core_types::session_event::{ActivityStatus, EventDisplayVariant, EventSource};
    use serial_test::serial;
    use std::io::Write;

    fn shell_event(home: &Path, log_path: &Path) -> SessionEvent {
        SessionEvent {
            id: "shell-event".to_string(),
            chunk_id: None,
            session_id: "legacy-session".to_string(),
            created_at: "2026-07-19T09:00:00Z".to_string(),
            function_name: "run_shell".to_string(),
            ui_canonical: core_types::tool_names::RUN_SHELL.to_string(),
            action_type: "tool_call".to_string(),
            args: serde_json::json!({
                "command": "emit legacy",
                "cwd": home,
                "shellLogPath": log_path,
                "streamOutput": "bounded historical preview"
            }),
            result: serde_json::json!({"exitCode": 0}),
            source: EventSource::Assistant,
            display_text: "emit legacy".to_string(),
            display_status: EventDisplayStatus::Completed,
            display_variant: EventDisplayVariant::ToolCall,
            activity_status: ActivityStatus::Processed,
            thread_id: None,
            process_id: None,
            call_id: Some("legacy-call".to_string()),
            file_path: None,
            command: Some("emit legacy".to_string()),
            is_delta: None,
            repo_id: None,
            repo_path: None,
            extracted: None,
            payload_refs: Vec::new(),
            shell_replay: None,
            shell_replay_bookmarks: None,
            last_extract_at: None,
        }
    }

    fn write_legacy_log(path: &Path, body: &[u8], ended_at: &str) {
        let mut file = File::create(path).unwrap();
        writeln!(file, "---").unwrap();
        writeln!(file, "pid: 42").unwrap();
        writeln!(file, "cwd: /tmp").unwrap();
        writeln!(file, "command: emit legacy").unwrap();
        writeln!(file, "started_at: 2026-07-19T09:00:00Z").unwrap();
        writeln!(file, "---").unwrap();
        file.write_all(body).unwrap();
        writeln!(file).unwrap();
        writeln!(file, "---").unwrap();
        writeln!(file, "exit_code: 0").unwrap();
        writeln!(file, "ended_at: {ended_at}").unwrap();
        writeln!(file, "elapsed_ms: 1000").unwrap();
    }

    fn with_test_home(test: impl FnOnce(&Path)) {
        let sandbox = test_helpers::test_env::sandbox();
        let conn = database::db::get_connection().unwrap();
        database::init_shell_replay_tables(&conn).unwrap();
        test(sandbox.path());
    }

    #[test]
    #[serial]
    fn streams_trusted_log_and_attaches_only_final_mutable_state() {
        with_test_home(|home| {
            let legacy_dir = home.join("agent-terminal-logs");
            fs::create_dir_all(&legacy_dir).unwrap();
            let path = legacy_dir.join("1721379600000_0.txt");
            let mut body = vec![b'x'; LEGACY_IMPORT_BUFFER_BYTES - 1];
            body.extend_from_slice("中文🙂\nFINAL\n".as_bytes());
            write_legacy_log(&path, &body, "2026-07-19T09:00:01Z");

            let mut event = shell_event(home, &path);
            hydrate_legacy_shell_replays(std::slice::from_mut(&mut event));
            let state = event.shell_replay.expect("imported replay state");
            assert_eq!(state.status, ShellReplayStatus::Complete);
            assert_eq!(
                state.completed_at.as_deref(),
                Some("2026-07-19T09:00:01+00:00")
            );
            assert_eq!(state.bookmark.visible_bytes, body.len() as u64);
            assert!(state.terminal_preview.contains("中文🙂\nFINAL"));
            assert!(event.shell_replay_bookmarks.is_none());

            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            let range = runtime
                .block_on(super::super::shell_replay::shell_replay_read_range(
                    "legacy-session".to_string(),
                    "legacy-call".to_string(),
                    state.bookmark.visible_through_sequence,
                    state.bookmark.visible_bytes,
                    0,
                    state.bookmark.visible_bytes,
                ))
                .unwrap();
            let imported: String = range.frames.into_iter().map(|frame| frame.text).collect();
            assert_eq!(imported.as_bytes(), body);
        });
    }

    #[test]
    #[serial]
    fn missing_log_keeps_bounded_preview_and_no_historical_bookmark() {
        with_test_home(|home| {
            let path = home.join("agent-terminal-logs/1721379600000_1.txt");
            let mut event = shell_event(home, &path);
            hydrate_legacy_shell_replays(std::slice::from_mut(&mut event));
            let state = event.shell_replay.expect("unavailable replay state");
            assert_eq!(state.status, ShellReplayStatus::Incomplete);
            assert_eq!(state.bookmark, ShellReplayBookmark::default());
            assert_eq!(state.error.as_deref(), Some(HISTORICAL_OUTPUT_UNAVAILABLE));
            assert_eq!(state.terminal_preview, "bounded historical preview");
            assert!(event.shell_replay_bookmarks.is_none());
        });
    }

    #[test]
    #[serial]
    fn missing_log_copies_only_bounded_tail_from_ten_megabyte_payload() {
        with_test_home(|home| {
            let path = home.join("agent-terminal-logs/1721379600000_100.txt");
            let mut event = shell_event(home, &path);
            let mut payload = "x".repeat(10 * 1024 * 1024);
            payload.replace_range(payload.len() - 4.., "TAIL");
            event.args["streamOutput"] = serde_json::Value::String(payload);

            assert_eq!(legacy_preview(&event).len(), 10 * 1024 * 1024);
            hydrate_legacy_shell_replays(std::slice::from_mut(&mut event));
            let state = event.shell_replay.expect("bounded unavailable state");
            assert_eq!(state.status, ShellReplayStatus::Incomplete);
            assert_eq!(state.terminal_preview.len(), SHELL_REPLAY_PREVIEW_BYTES);
            assert!(state.terminal_preview.ends_with("TAIL"));
        });
    }

    #[test]
    #[serial]
    fn forged_same_name_directory_outside_known_roots_is_rejected() {
        with_test_home(|home| {
            let outside = tempfile::tempdir().unwrap();
            let forged_dir = outside.path().join("agent-terminal-logs");
            fs::create_dir_all(&forged_dir).unwrap();
            let path = forged_dir.join("1721379600000_99.txt");
            write_legacy_log(&path, b"MUST NOT IMPORT\n", "2026-07-19T09:00:01Z");

            let mut event = shell_event(home, &path);
            hydrate_legacy_shell_replays(std::slice::from_mut(&mut event));
            let state = event.shell_replay.expect("unavailable replay state");
            assert_eq!(state.status, ShellReplayStatus::Incomplete);
            assert_eq!(state.bookmark, ShellReplayBookmark::default());
            assert_eq!(state.error.as_deref(), Some(HISTORICAL_OUTPUT_UNAVAILABLE));
            assert!(!state.terminal_preview.contains("MUST NOT IMPORT"));
        });
    }

    #[test]
    #[serial]
    fn early_timeline_event_never_receives_imported_future_bookmark() {
        with_test_home(|home| {
            let legacy_dir = home.join("agent-terminal-logs");
            fs::create_dir_all(&legacy_dir).unwrap();
            let path = legacy_dir.join("1721379600000_2.txt");
            write_legacy_log(&path, b"EARLY\nFUTURE\n", "2026-07-19T09:00:10Z");

            let shell = shell_event(home, &path);
            let mut early = shell.clone();
            early.id = "early-cursor".to_string();
            early.function_name = "message".to_string();
            early.ui_canonical = "message".to_string();
            early.action_type = "assistant".to_string();
            early.call_id = None;
            early.shell_replay = None;
            early.args = serde_json::json!({});
            early.result = serde_json::json!({});
            early.created_at = "2026-07-19T09:00:05Z".to_string();

            let mut events = vec![early, shell];
            hydrate_legacy_shell_replays(&mut events);
            assert!(events[0].shell_replay.is_none());
            assert!(events[0].shell_replay_bookmarks.is_none());
            assert!(events[1].shell_replay.is_some());
            assert!(events[1].shell_replay_bookmarks.is_none());
        });
    }

    #[test]
    #[serial]
    fn terminal_log_without_footer_uses_file_mtime_as_completion_watermark() {
        with_test_home(|home| {
            let legacy_dir = home.join("agent-terminal-logs");
            fs::create_dir_all(&legacy_dir).unwrap();
            let path = legacy_dir.join("1721379600000_3.txt");
            let mut file = File::create(&path).unwrap();
            writeln!(file, "---").unwrap();
            writeln!(file, "pid: 42").unwrap();
            writeln!(file, "cwd: /tmp").unwrap();
            writeln!(file, "command: emit legacy").unwrap();
            writeln!(file, "started_at: 2026-07-19T09:00:00Z").unwrap();
            writeln!(file, "---").unwrap();
            file.write_all(b"completed body without footer\n").unwrap();
            file.sync_all().unwrap();

            let mut event = shell_event(home, &path);
            hydrate_legacy_shell_replays(std::slice::from_mut(&mut event));
            let state = event.shell_replay.expect("imported replay state");
            assert_eq!(state.status, ShellReplayStatus::Complete);
            assert!(state.completed_at.is_some());
            assert_eq!(
                state.bookmark.visible_bytes,
                b"completed body without footer\n".len() as u64
            );
            assert!(event.shell_replay_bookmarks.is_none());
        });
    }

    #[test]
    #[serial]
    fn startup_recovery_terminal_manifest_replaces_cached_running_state() {
        with_test_home(|home| {
            let target = ShellReplayTarget::new("legacy-session", "legacy-call");
            let mut writer = ShellReplayWriter::create_detached(
                &resolve_replay_root(),
                target,
                "partial command",
                home,
            )
            .unwrap();
            writer
                .append(ShellReplayStream::Stdout, b"partial output\n")
                .unwrap();

            // This is the stale state persisted in cached event meta before
            // the process crashed. Dropping the writer simulates the missing
            // completion barrier; startup recovery then repairs the manifest.
            let cached_running = load_replay_state("legacy-session", "legacy-call")
                .unwrap()
                .unwrap();
            assert_eq!(cached_running.status, ShellReplayStatus::Running);
            drop(writer);
            assert_eq!(
                super::super::shell_replay::recover_incomplete_replays().unwrap(),
                1
            );

            let missing_legacy_path = home.join("agent-terminal-logs/1721379600000_4.txt");
            let mut event = shell_event(home, &missing_legacy_path);
            event.display_status = EventDisplayStatus::Running;
            event.shell_replay = Some(cached_running);
            hydrate_legacy_shell_replays(std::slice::from_mut(&mut event));

            let repaired = event.shell_replay.expect("reconciled replay state");
            assert_eq!(repaired.status, ShellReplayStatus::Incomplete);
            assert_eq!(
                repaired.bookmark.visible_bytes,
                b"partial output\n".len() as u64
            );
            assert!(repaired.terminal_preview.contains("partial output"));
            assert!(repaired.completed_at.is_some());
            assert!(event.shell_replay_bookmarks.is_none());
        });
    }
}
