//! Helpers to read and slice job output bodies (shell log files / subagent
//! buffers) for inclusion in `await` responses.

use ::regex::Regex;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

use super::super::registry;

const MAX_AWAIT_BODY_BYTES: u64 = 256 * 1024;

/// Read the body of a terminal log file (skip YAML header).
///
/// Returns an empty string if the log file is missing (a job that hasn't
/// produced output yet is the common case). Other read failures (permission
/// denied, IO error) are logged at `warn!` so they're diagnosable instead
/// of silently returning empty output to the caller.
pub(super) fn read_log_body(log_path: &std::path::Path) -> String {
    let file = match File::open(log_path) {
        Ok(file) => file,
        Err(err) => {
            if err.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(
                    path = %log_path.display(),
                    error = %err,
                    "[await_tool] failed to read terminal log body"
                );
            }
            return String::new();
        }
    };
    let len = match file.metadata() {
        Ok(metadata) => metadata.len(),
        Err(err) => {
            tracing::warn!(path = %log_path.display(), error = %err, "[await_tool] failed to stat terminal log");
            return String::new();
        }
    };
    read_log_body_from_open_file(file, len, log_path)
}

fn read_log_body_from_open_file(
    mut file: File,
    observed_len: u64,
    log_path: &std::path::Path,
) -> String {
    let start = observed_len.saturating_sub(MAX_AWAIT_BODY_BYTES);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return String::new();
    }
    // Read no more than existed at the metadata snapshot. A legacy log may
    // still be growing, so an unbounded `read_to_end` after the seek could
    // otherwise consume arbitrarily more than the advertised tail limit.
    let read_limit = observed_len.saturating_sub(start).min(MAX_AWAIT_BODY_BYTES);
    let mut bytes = Vec::with_capacity(read_limit as usize);
    if let Err(err) = file.take(read_limit).read_to_end(&mut bytes) {
        tracing::warn!(path = %log_path.display(), error = %err, "[await_tool] failed to read bounded terminal tail");
        return String::new();
    }
    let mut content = String::from_utf8_lossy(&bytes).into_owned();
    if start > 0 {
        if let Some(first_newline) = content.find('\n') {
            content.drain(..=first_newline);
        }
    } else if let Some(after_open) = content.strip_prefix("---\n") {
        if let Some(header_end) = after_open.find("\n---\n") {
            content = after_open[header_end + 5..].to_string();
        }
    }
    if let Some(footer_start) = content.rfind("\n---\n") {
        content.truncate(footer_start);
    }
    content
}

/// Return the last N lines of a string.
pub(super) fn tail(text: &str, count: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.len().saturating_sub(count);
    lines[start..].join("\n")
}

/// Find the first line matching a regex, returning it for metadata.
pub(super) fn find_match_line<'a>(text: &'a str, re: &Regex) -> Option<&'a str> {
    text.lines().find(|line| re.is_match(line))
}

/// Read the current body of a job (log file for shells, buffer/final_result for subagents).
pub(super) fn read_body(handle: &str, kind: &registry::JobKind) -> String {
    match kind {
        registry::JobKind::Shell {
            replay_session_id: Some(session_id),
            replay_call_id: Some(call_id),
            ..
        } => super::super::shell_replay::read_replay_tail(session_id, call_id)
            .unwrap_or_else(|err| {
                tracing::warn!(session_id, call_id, error = %err, "[await_tool] failed to read replay tail");
                String::new()
            }),
        registry::JobKind::Shell { log_path, .. } => read_log_body(log_path),
        registry::JobKind::Subagent { .. } => registry::get_final_result(handle)
            .or_else(|| registry::get_recent_output(handle))
            .unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::OpenOptions;
    use std::io::Write;

    #[test]
    fn legacy_log_tail_is_strictly_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("large.log");
        std::fs::write(&path, vec![b'x'; (MAX_AWAIT_BODY_BYTES * 4) as usize]).unwrap();

        let body = read_log_body(&path);
        assert_eq!(body.len(), MAX_AWAIT_BODY_BYTES as usize);
    }

    #[test]
    fn legacy_log_growth_after_stat_cannot_expand_the_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("growing.log");
        std::fs::write(&path, vec![b'a'; 1_024]).unwrap();
        let reader = File::open(&path).unwrap();
        let observed_len = reader.metadata().unwrap().len();

        let mut writer = OpenOptions::new().append(true).open(&path).unwrap();
        writer
            .write_all(&vec![b'b'; (MAX_AWAIT_BODY_BYTES * 4) as usize])
            .unwrap();
        writer.flush().unwrap();

        let body = read_log_body_from_open_file(reader, observed_len, &path);
        assert_eq!(body.len(), observed_len as usize);
        assert!(body.bytes().all(|byte| byte == b'a'));
    }
}
