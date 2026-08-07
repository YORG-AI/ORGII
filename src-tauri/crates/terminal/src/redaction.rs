use regex::Regex;
use std::sync::OnceLock;

const REDACTION_PLACEHOLDER: &str = "secret_*******";

fn redaction_patterns() -> &'static [Regex] {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            r#"(?i)(\b[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASS|PRIVATE[_-]?KEY|SESSION[_-]?TOKEN|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN)[A-Z0-9_]*\b\s*[:=]\s*)[^\s'\"]+"#,
            r#"(?i)(\bBearer\s+)[A-Za-z0-9._~+/=-]{12,}"#,
            r#"\bgh[pousr]_[A-Za-z0-9_]{20,}\b"#,
            r#"\bsk-[A-Za-z0-9_-]{20,}\b"#,
            r#"\bAKIA[0-9A-Z]{16}\b"#,
            r#"\bASIA[0-9A-Z]{16}\b"#,
            r#"\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b"#,
            r#"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"#,
        ]
        .into_iter()
        .map(|pattern| Regex::new(pattern).expect("terminal redaction regex must compile"))
        .collect()
    })
}

pub fn redact_terminal_text(input: &str) -> String {
    let mut redacted = input.to_string();
    for pattern in redaction_patterns() {
        redacted = pattern
            .replace_all(&redacted, |captures: &regex::Captures<'_>| {
                if captures.len() > 1 {
                    format!("{}{}", &captures[1], REDACTION_PLACEHOLDER)
                } else {
                    REDACTION_PLACEHOLDER.to_string()
                }
            })
            .into_owned();
    }
    redacted
}

/// Bytes scanned past the trim point for a newline to resume at.
const TRIM_NEWLINE_SCAN_BYTES: usize = 4096;

pub fn append_redacted_bounded(buffer: &mut String, chunk: &str, max_chars: usize) {
    let redacted = redact_terminal_text(chunk);
    buffer.push_str(&redacted);
    let char_count = buffer.chars().count();

    // Hysteresis: trim only once the buffer exceeds max_chars by 25%, back
    // down to max_chars. Trimming on every append would rebuild the whole
    // String per PTY chunk while at capacity.
    if char_count <= max_chars + max_chars / 4 {
        return;
    }

    let keep_from = char_count - max_chars;
    let mut iter = buffer.chars();
    for _ in 0..keep_from {
        iter.next();
    }
    let tail = iter.as_str();

    // Resume at the next line start when one is near: a cut inside an ANSI
    // escape sequence leaves an orphaned tail (e.g. `[38;2;26;26;26m`) that
    // xterm renders as literal text when the snapshot is restored. Escape
    // sequences do not span newlines, so a line start is always sequence-safe.
    let mut scan_end = tail.len().min(TRIM_NEWLINE_SCAN_BYTES);
    while scan_end < tail.len() && !tail.is_char_boundary(scan_end) {
        scan_end += 1;
    }
    let resume_at = tail[..scan_end].find('\n').map(|i| i + 1).unwrap_or(0);

    *buffer = tail[resume_at..].to_string();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_key_value_secrets() {
        let output = redact_terminal_text("OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz\n");
        assert!(output.contains("OPENAI_API_KEY=secret_*******"));
        assert!(!output.contains("abcdefghijklmnopqrstuvwxyz"));
    }

    #[test]
    fn redacts_bearer_tokens() {
        let output = redact_terminal_text("Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456");
        assert_eq!(output, "Authorization: Bearer secret_*******");
    }

    #[test]
    fn bounds_redacted_buffer() {
        let mut buffer = String::new();
        append_redacted_bounded(&mut buffer, "abcdef", 4);
        assert_eq!(buffer, "cdef");
    }

    #[test]
    fn trim_hysteresis_keeps_buffer_within_25_percent_overshoot() {
        let mut buffer = String::new();
        // 100 chars with max 96: over max but within max + max/4 → no trim.
        append_redacted_bounded(&mut buffer, &"x".repeat(100), 96);
        assert_eq!(buffer.len(), 100);
        // Push past the threshold → trims back down to max.
        append_redacted_bounded(&mut buffer, &"y".repeat(50), 96);
        assert!(buffer.chars().count() <= 96);
    }

    #[test]
    fn trim_resumes_at_line_start_not_inside_escape_sequence() {
        let mut buffer = String::new();
        // Buffer layout: 50×'a' + '\n' + 16-char truecolor escape + 20×'b'
        // + '\n' + 30×'c' = 118 chars. With max 60 the naive cut lands at
        // char 58 — inside the escape — which would leave an orphaned
        // `…;26;26m` tail. The newline scan must resume at the 'c' line.
        append_redacted_bounded(&mut buffer, &format!("{}\n", "a".repeat(50)), 1000);
        append_redacted_bounded(
            &mut buffer,
            &format!("\x1b[38;2;26;26;26m{}\n{}", "b".repeat(20), "c".repeat(30)),
            60,
        );
        assert_eq!(buffer, "c".repeat(30));
    }

    #[test]
    fn trim_falls_back_to_char_boundary_without_newline() {
        let mut buffer = String::new();
        append_redacted_bounded(&mut buffer, &"z".repeat(200), 64);
        assert!(buffer.chars().count() <= 64);
        assert!(buffer.chars().all(|c| c == 'z'));
    }
}
