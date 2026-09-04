//! Binary framing for PTY output delivered over a Tauri channel.
//!
//! A frame is `[8-byte big-endian stream offset][raw PTY bytes]`. The offset
//! lets the frontend line a chunk up against the restore snapshot's
//! `covers_seq`; the payload length is the chunk's byte count for flow
//! control. Both travelled as separate JSON fields on the `pty-output-{id}`
//! event transport, which had to base64 the payload and splice it into a
//! JavaScript source string the webview then parsed before it could run.
//!
//! The decoder is `src/util/terminal/ptyOutputFrame.ts`; the two must agree.

/// Bytes of big-endian stream offset prefixed to every frame.
pub const PTY_FRAME_HEADER_BYTES: usize = 8;

/// Frame `payload` as the chunk starting at stream offset `seq`.
pub fn encode_pty_output_frame(seq: u64, payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(PTY_FRAME_HEADER_BYTES + payload.len());
    frame.extend_from_slice(&seq.to_be_bytes());
    frame.extend_from_slice(payload);
    frame
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefixes_the_stream_offset_in_big_endian() {
        let frame = encode_pty_output_frame(0x0102_0304_0506_0708, b"hi");
        assert_eq!(
            frame,
            vec![0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, b'h', b'i']
        );
    }

    #[test]
    fn preserves_payload_bytes_verbatim() {
        // A split UTF-8 codepoint must survive framing untouched: the frontend
        // decoder is streaming and reassembles it across chunks.
        let payload = [0xE2, 0x94]; // leading two bytes of U+2500
        let frame = encode_pty_output_frame(7, &payload);
        assert_eq!(&frame[PTY_FRAME_HEADER_BYTES..], &payload);
    }

    #[test]
    fn frames_an_empty_payload_as_a_bare_header() {
        assert_eq!(encode_pty_output_frame(0, b"").len(), PTY_FRAME_HEADER_BYTES);
    }

    #[test]
    fn encodes_offsets_beyond_u32() {
        let seq = u64::from(u32::MAX) + 1;
        let frame = encode_pty_output_frame(seq, b"x");
        let mut header = [0u8; PTY_FRAME_HEADER_BYTES];
        header.copy_from_slice(&frame[..PTY_FRAME_HEADER_BYTES]);
        assert_eq!(u64::from_be_bytes(header), seq);
    }
}
