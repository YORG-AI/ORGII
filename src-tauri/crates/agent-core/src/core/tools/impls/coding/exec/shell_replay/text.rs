//! UTF-8- and terminal-escape-aware prefix/truncation helpers shared by the
//! shell replay writer and startup recovery.

const ANSI_SEQUENCE_CARRY_MAX_BYTES: usize = 64;

/// Largest prefix that can be decoded independently as UTF-8. A short
/// incomplete suffix is retained by the pipe/PTY pump for its next read;
/// genuinely invalid bytes stay in the artifact and are rendered lossily.
pub(crate) fn complete_utf8_prefix_len(bytes: &[u8]) -> usize {
    match std::str::from_utf8(bytes) {
        Ok(_) => bytes.len(),
        Err(err) if err.error_len().is_none() => err.valid_up_to(),
        Err(_) => bytes.len(),
    }
}

/// Largest prefix that is independently renderable by a terminal. Besides a
/// split UTF-8 codepoint, retain a short trailing ANSI CSI sequence (for
/// example `ESC[31` without its final `m`) for the next frame. This keeps a
/// range that starts at a frame boundary from exposing a naked `[31m` fragment.
/// The carry is deliberately capped so malformed, unterminated control data
/// cannot grow writer memory without bound.
pub(crate) fn complete_terminal_prefix_len(bytes: &[u8]) -> usize {
    let utf8_end = complete_utf8_prefix_len(bytes);
    let prefix = &bytes[..utf8_end];
    let scan_start = prefix.len().saturating_sub(ANSI_SEQUENCE_CARRY_MAX_BYTES);
    let Some(relative_escape) = prefix[scan_start..].iter().rposition(|byte| *byte == 0x1b) else {
        return utf8_end;
    };
    let escape = scan_start + relative_escape;
    let suffix = &prefix[escape..];
    if suffix.len() == 1 {
        return escape;
    }
    if suffix[1] == b'[' && !suffix[2..].iter().any(|byte| matches!(*byte, 0x40..=0x7e)) {
        return escape;
    }
    utf8_end
}

pub(super) fn decode_utf8_prefix(bytes: &[u8]) -> (String, usize) {
    for trim in 0..=3.min(bytes.len()) {
        let end = bytes.len() - trim;
        if let Ok(text) = std::str::from_utf8(&bytes[..end]) {
            return (text.to_string(), end);
        }
    }
    (String::from_utf8_lossy(bytes).into_owned(), bytes.len())
}

pub(super) fn decode_utf8_tail(bytes: &[u8]) -> (String, usize) {
    for skip in 0..=3.min(bytes.len()) {
        if let Ok(text) = std::str::from_utf8(&bytes[skip..]) {
            return (text.to_string(), bytes.len() - skip);
        }
    }
    (String::from_utf8_lossy(bytes).into_owned(), bytes.len())
}

pub(super) fn truncate_string_prefix(mut value: String, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value;
    }
    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value.truncate(end);
    value
}

pub(super) fn truncate_string_tail(value: String, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value;
    }
    let mut start = value.len() - max_bytes;
    while start < value.len() && !value.is_char_boundary(start) {
        start += 1;
    }
    value[start..].to_string()
}

pub(super) fn decode_utf8_tail_bounded(bytes: &[u8], max_bytes: usize) -> String {
    truncate_string_tail(decode_utf8_tail(bytes).0, max_bytes)
}
