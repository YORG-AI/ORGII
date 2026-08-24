//! Bounded tail capture for child-process output streams.
//!
//! Test processes can emit arbitrarily large output (watch modes, verbose
//! reporters, runaway logging). Captured output must stay within a fixed
//! budget so a single run can never grow app memory without bound: once the
//! budget is exceeded the *oldest* bytes are dropped, keeping the tail —
//! summaries and failures print last, so the tail is the useful part for
//! both parsing and error reporting.

use std::collections::VecDeque;

use tokio::io::{AsyncRead, AsyncReadExt};

/// Output captured from one stream (stdout or stderr) of a test process.
#[derive(Debug)]
pub(crate) struct CapturedOutput {
    /// Tail of the stream, lossily decoded as UTF-8. At most `max_bytes`
    /// long (a byte or two shorter when truncation split a code point).
    pub text: String,
    /// True when the stream produced more than `max_bytes` and the head
    /// was dropped. Parsers that need the full document (JSON reporters)
    /// cannot succeed on truncated output.
    pub truncated: bool,
    /// Total bytes the stream produced, including dropped bytes.
    pub total_bytes: u64,
}

/// Read `reader` to EOF, retaining at most `max_bytes` of the tail.
///
/// Reads in fixed-size chunks (never buffers a whole line), so a single
/// line larger than the budget — e.g. one giant JSON document — still
/// respects the bound.
pub(crate) async fn capture_stream<R: AsyncRead + Unpin>(
    mut reader: R,
    max_bytes: usize,
) -> CapturedOutput {
    let mut tail: VecDeque<u8> = VecDeque::new();
    let mut total_bytes: u64 = 0;
    let mut chunk = [0u8; 8192];

    loop {
        match reader.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => {
                total_bytes += n as u64;
                tail.extend(&chunk[..n]);
                if tail.len() > max_bytes {
                    let excess = tail.len() - max_bytes;
                    tail.drain(..excess);
                }
            }
            // Pipe errors (e.g. the child was killed mid-write) end the
            // capture; whatever arrived so far is still returned.
            Err(_) => break,
        }
    }

    let truncated = total_bytes > tail.len() as u64;
    let bytes: Vec<u8> = tail.into();
    CapturedOutput {
        text: String::from_utf8_lossy(&bytes).into_owned(),
        truncated,
        total_bytes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn small_output_is_kept_verbatim() {
        let captured = capture_stream(&b"hello\nworld\n"[..], 1024).await;
        assert_eq!(captured.text, "hello\nworld\n");
        assert!(!captured.truncated);
        assert_eq!(captured.total_bytes, 12);
    }

    #[tokio::test]
    async fn oversized_output_keeps_only_the_tail() {
        let input: Vec<u8> = (0..10_000u32)
            .flat_map(|i| format!("line-{i}\n").into_bytes())
            .collect();
        let captured = capture_stream(&input[..], 1000).await;
        assert!(captured.truncated);
        assert_eq!(captured.total_bytes, input.len() as u64);
        assert!(captured.text.len() <= 1000);
        // The tail must contain the *last* line, not the first.
        assert!(captured.text.contains("line-9999"));
        assert!(!captured.text.contains("line-0\n"));
    }

    #[tokio::test]
    async fn single_line_larger_than_budget_is_bounded() {
        let input = vec![b'a'; 1_000_000];
        let captured = capture_stream(&input[..], 4096).await;
        assert!(captured.truncated);
        assert_eq!(captured.total_bytes, 1_000_000);
        assert_eq!(captured.text.len(), 4096);
    }

    #[tokio::test]
    async fn truncation_mid_code_point_is_lossy_not_fatal() {
        // 4-byte emoji repeated; a byte-oriented cut can land mid-sequence.
        // Each orphaned lead-in byte decodes to one 3-byte U+FFFD, so the
        // text may exceed the byte budget by a few replacement chars — the
        // point is that decoding stays sane, not byte-exact.
        let input: Vec<u8> = "😀".repeat(1000).into_bytes();
        let captured = capture_stream(&input[..], 10).await;
        assert!(captured.truncated);
        assert!(captured.text.len() <= 10 + 3 * "\u{FFFD}".len());
        assert!(captured.text.contains('😀'));
    }

    #[tokio::test]
    async fn empty_stream_yields_empty_capture() {
        let captured = capture_stream(&b""[..], 1024).await;
        assert_eq!(captured.text, "");
        assert!(!captured.truncated);
        assert_eq!(captured.total_bytes, 0);
    }
}
