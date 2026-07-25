//! Authoritative physical wire contract for bounded replay Cloud rows.
//!
//! The external replay spool writes this format and collaboration snapshot
//! ingest reads it. Keeping the framing, field layout and budgets here avoids
//! encoder/decoder drift across the two command subsystems.

use std::io::Write;

use orgtrack_core::sources::imported_history::replay;
use serde::{Deserialize, Serialize};

pub(crate) const CLOUD_SEGMENT_WIRE_MAX_BYTES: usize = replay::HARD_MAX_PAYLOAD_RANGE_BYTES;
/// One already-published Attachment-V1 physical row may predate the bounded
/// wire contract. New writers remain capped by `CLOUD_SEGMENT_WIRE_MAX_BYTES`;
/// ingest grants this larger ceiling to at most one candidate row per page
/// and verifies after decompression that it is actually V1.
pub(crate) const LEGACY_V1_MAX_WIRE_BYTES: usize = 64 * 1024 * 1024;
pub(crate) const CLOUD_PAGE_MAX_BYTES: usize = replay::HARD_MAX_IPC_BYTES;
pub(crate) const CLOUD_PAGE_MAX_SEGMENTS: usize = replay::HARD_MAX_EVENTS;
/// Leaves room for frame metadata, gzip overhead, base64 growth and the
/// containing JSON object under [`CLOUD_SEGMENT_WIRE_MAX_BYTES`].
pub(crate) const REPLAY_ATTACHMENT_CHUNK_BYTES: usize = 176 * 1024;
pub(crate) const REPLAY_ATTACHMENT_V2_MAGIC: &[u8] = b"ORGII-REPLAY-ATTACHMENT-V2\0";
pub(crate) const REPLAY_ATTACHMENT_V2_MAX_DECOMPRESSED_BYTES: u64 = 512 * 1024;
pub(crate) const LEGACY_V1_MAX_DECOMPRESSED_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReplayAttachmentV2FrameHeader {
    pub(crate) kind: String,
    pub(crate) attachment_id: String,
    pub(crate) part_index: u64,
    pub(crate) chunk_offset: u64,
    pub(crate) chunk_bytes: u64,
    pub(crate) final_part: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) event_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) attachment_hash: Option<String>,
}

#[derive(Debug)]
pub(crate) struct DecodedReplayAttachmentV2Frame<'a> {
    pub(crate) header: ReplayAttachmentV2FrameHeader,
    pub(crate) chunk: &'a [u8],
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn validate_header(
    header: &ReplayAttachmentV2FrameHeader,
    actual_chunk_bytes: usize,
) -> Result<(), String> {
    if header.kind != "event" || !is_sha256_hex(&header.attachment_id) {
        return Err("header kind or attachmentId is invalid".to_string());
    }
    if header.chunk_bytes != actual_chunk_bytes as u64 {
        return Err("chunk length is inconsistent with chunkBytes".to_string());
    }
    match (
        header.final_part,
        header.event_bytes,
        header.attachment_hash.as_deref(),
    ) {
        (false, None, None) => Ok(()),
        (true, Some(event_bytes), Some(hash))
            if is_sha256_hex(hash)
                && header
                    .chunk_offset
                    .checked_add(header.chunk_bytes)
                    .is_some_and(|end| end == event_bytes) =>
        {
            Ok(())
        }
        _ => Err("final-part metadata is inconsistent".to_string()),
    }
}

pub(crate) fn write_replay_attachment_v2_frame(
    output: &mut impl Write,
    header: &ReplayAttachmentV2FrameHeader,
    chunk: &[u8],
) -> Result<(), String> {
    validate_header(header, chunk.len())?;
    let header_json = serde_json::to_vec(header)
        .map_err(|error| format!("serialize attachment V2 header: {error}"))?;
    let header_len = u32::try_from(header_json.len())
        .map_err(|_| "attachment V2 header exceeds u32".to_string())?;
    output
        .write_all(REPLAY_ATTACHMENT_V2_MAGIC)
        .map_err(|error| format!("write attachment V2 magic: {error}"))?;
    output
        .write_all(&header_len.to_be_bytes())
        .map_err(|error| format!("write attachment V2 header length: {error}"))?;
    output
        .write_all(&header_json)
        .map_err(|error| format!("write attachment V2 header: {error}"))?;
    output
        .write_all(chunk)
        .map_err(|error| format!("write attachment V2 chunk: {error}"))
}

pub(crate) fn encode_replay_attachment_v2_frame(
    header: &ReplayAttachmentV2FrameHeader,
    chunk: &[u8],
) -> Result<Vec<u8>, String> {
    let mut frame = Vec::with_capacity(
        REPLAY_ATTACHMENT_V2_MAGIC
            .len()
            .saturating_add(4)
            .saturating_add(256)
            .saturating_add(chunk.len()),
    );
    write_replay_attachment_v2_frame(&mut frame, header, chunk)?;
    Ok(frame)
}

pub(crate) fn decode_replay_attachment_v2_frame(
    bytes: &[u8],
) -> Result<DecodedReplayAttachmentV2Frame<'_>, String> {
    let prefix_bytes = REPLAY_ATTACHMENT_V2_MAGIC.len().saturating_add(4);
    if bytes.len() < prefix_bytes || !bytes.starts_with(REPLAY_ATTACHMENT_V2_MAGIC) {
        return Err("magic prefix is invalid".to_string());
    }
    let header_len = u32::from_be_bytes(
        bytes[REPLAY_ATTACHMENT_V2_MAGIC.len()..prefix_bytes]
            .try_into()
            .map_err(|_| "header length is truncated".to_string())?,
    ) as usize;
    let payload_offset = prefix_bytes
        .checked_add(header_len)
        .ok_or_else(|| "header length overflows the frame".to_string())?;
    if header_len == 0 || payload_offset > bytes.len() {
        return Err("header is truncated".to_string());
    }
    let header = serde_json::from_slice::<ReplayAttachmentV2FrameHeader>(
        &bytes[prefix_bytes..payload_offset],
    )
    .map_err(|error| format!("header JSON is invalid: {error}"))?;
    let chunk = &bytes[payload_offset..];
    validate_header(&header, chunk.len())?;
    Ok(DecodedReplayAttachmentV2Frame { header, chunk })
}

#[cfg(test)]
mod tests {
    use sha2::{Digest, Sha256};

    use super::*;

    #[test]
    fn attachment_v2_frame_keeps_the_published_golden_hash() {
        let header = ReplayAttachmentV2FrameHeader {
            kind: "event".to_string(),
            attachment_id: "dd56de4137951d9c92681b03416ec15f886b4482a27e3a517d32f085244cbe5d"
                .to_string(),
            part_index: 0,
            chunk_offset: 0,
            chunk_bytes: 3,
            final_part: true,
            event_bytes: Some(3),
            attachment_hash: Some(
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".to_string(),
            ),
        };
        let frame = encode_replay_attachment_v2_frame(&header, b"abc").expect("golden frame");
        assert_eq!(
            format!("{:x}", Sha256::digest(&frame)),
            "1cf7b415e8558ddb0d72bcf9212ff381c9a57bfd719628824a61e4a67bcf3126"
        );
        let decoded = decode_replay_attachment_v2_frame(&frame).expect("decode golden frame");
        assert_eq!(decoded.header, header);
        assert_eq!(decoded.chunk, b"abc");
    }

    #[test]
    fn attachment_v2_decoder_rejects_corrupt_framing_and_metadata() {
        let header = ReplayAttachmentV2FrameHeader {
            kind: "event".to_string(),
            attachment_id: "a".repeat(64),
            part_index: 0,
            chunk_offset: 0,
            chunk_bytes: 3,
            final_part: true,
            event_bytes: Some(3),
            attachment_hash: Some("b".repeat(64)),
        };
        let frame = encode_replay_attachment_v2_frame(&header, b"abc").expect("valid frame");

        let mut bad_magic = frame.clone();
        bad_magic[0] ^= 1;
        assert!(decode_replay_attachment_v2_frame(&bad_magic)
            .expect_err("bad magic must fail")
            .contains("magic"));

        let mut wrong_chunk_bytes = header.clone();
        wrong_chunk_bytes.chunk_bytes = 2;
        assert!(
            encode_replay_attachment_v2_frame(&wrong_chunk_bytes, b"abc")
                .expect_err("wrong chunk length must fail")
                .contains("chunk length")
        );

        let mut missing_final_hash = header;
        missing_final_hash.attachment_hash = None;
        assert!(
            encode_replay_attachment_v2_frame(&missing_final_hash, b"abc")
                .expect_err("incomplete final metadata must fail")
                .contains("final-part metadata")
        );
    }

    #[test]
    fn shared_budget_manifest_matches_the_rust_wire_contract() {
        let manifest: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/shared/externalReplayBudgets.json"
        )))
        .expect("shared replay budget manifest");
        assert_eq!(manifest["replayMaxTurns"], replay::HARD_MAX_TURNS);
        assert_eq!(manifest["replayMaxEvents"], replay::HARD_MAX_EVENTS);
        assert_eq!(manifest["replayMaxIpcBytes"], replay::HARD_MAX_IPC_BYTES);
        assert_eq!(
            manifest["payloadRangeMaxBytes"],
            replay::HARD_MAX_PAYLOAD_RANGE_BYTES
        );
        assert_eq!(
            manifest["shellReplayRangeMaxBytes"],
            agent_core::tools::impls::coding::exec::shell_replay::SHELL_REPLAY_RANGE_MAX_BYTES
        );
        assert_eq!(
            manifest["cloudSegmentMaxBytes"],
            CLOUD_SEGMENT_WIRE_MAX_BYTES
        );
        assert_eq!(
            manifest["cloudLegacyV1SegmentMaxBytes"],
            LEGACY_V1_MAX_WIRE_BYTES
        );
        assert_eq!(manifest["cloudPageMaxBytes"], CLOUD_PAGE_MAX_BYTES);
        assert_eq!(manifest["cloudPageMaxSegments"], CLOUD_PAGE_MAX_SEGMENTS);
        assert_eq!(
            manifest["cloudAttachmentChunkBytes"],
            REPLAY_ATTACHMENT_CHUNK_BYTES
        );
    }
}
