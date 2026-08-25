use std::{
    collections::HashSet,
    io::{Read, Write},
};

use sha2::{Digest, Sha256};

use crate::{ContinuationCryptoError, LimitKind};

pub const INNER_STREAM_MAGIC: &[u8; 8] = b"ORG2CPS\0";
pub const INNER_STREAM_VERSION: u16 = 1;

const FRAME_MANIFEST: u8 = 1;
const FRAME_EVENT: u8 = 2;
const FRAME_BLOB: u8 = 3;
const FRAME_FOOTER: u8 = 255;
const MAX_SCHEMA_ID_BYTES: usize = 128;
const MAX_EVENT_ID_BYTES: usize = 256;
const MAX_EVENT_KIND_BYTES: usize = 128;
const MAX_MEDIA_TYPE_BYTES: usize = 128;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CheckpointLimits {
    pub max_manifest_bytes: u64,
    pub max_frame_bytes: u64,
    pub max_total_decompressed_bytes: u64,
    pub max_records: u32,
    pub max_events: u32,
    pub max_event_bytes: u64,
    pub max_blobs: u32,
    pub max_blob_bytes: u64,
    pub max_path_bytes: u64,
    /// Maximum complete envelope size, including the public prefix/header,
    /// age ciphertext, Ed25519 signature, and end marker.
    pub max_envelope_bytes: u64,
    pub max_ciphertext_bytes: u64,
}

/// Limits for explicitly local/offline checkpoint artifacts.
pub const LOCAL_CHECKPOINT_LIMITS: CheckpointLimits = CheckpointLimits {
    max_manifest_bytes: 64 * 1024,
    max_frame_bytes: 64 * 1024 * 1024,
    max_total_decompressed_bytes: 256 * 1024 * 1024,
    max_records: 100_000,
    max_events: 100_000,
    max_event_bytes: 4 * 1024 * 1024,
    max_blobs: 1_024,
    max_blob_bytes: 64 * 1024 * 1024,
    max_path_bytes: 1_024,
    max_envelope_bytes: 512 * 1024 * 1024,
    max_ciphertext_bytes: 512 * 1024 * 1024,
};

/// Mandatory limits for artifacts crossing the ORG2 Cloud object plane.
///
/// Cloud integrations must use the typed cloud read/write entry points, which
/// apply this preset and therefore cannot accidentally inherit the 512 MiB
/// local-file ceiling.
pub const CLOUD_CHECKPOINT_LIMITS: CheckpointLimits = CheckpointLimits {
    max_manifest_bytes: 64 * 1024,
    max_frame_bytes: 16 * 1024 * 1024,
    max_total_decompressed_bytes: 64 * 1024 * 1024,
    max_records: 100_000,
    max_events: 100_000,
    max_event_bytes: 4 * 1024 * 1024,
    max_blobs: 1_024,
    max_blob_bytes: 16 * 1024 * 1024,
    max_path_bytes: 1_024,
    max_envelope_bytes: 16 * 1024 * 1024,
    max_ciphertext_bytes: 16 * 1024 * 1024,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckpointManifest {
    pub schema_id: String,
    pub schema_version: u16,
    pub expected_event_count: u32,
    pub expected_blob_count: u32,
    pub expected_logical_bytes: u64,
    /// SHA-256 of canonical raw Event and Blob frames, excluding Manifest and
    /// Footer. It is encrypted inside age and never appears in the public
    /// envelope header.
    pub plaintext_sha256: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckpointEvent {
    pub sequence: u64,
    pub event_id: String,
    pub event_kind: String,
    pub payload: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlobMetadata {
    pub relative_path: String,
    pub media_type: String,
    pub content_len: u64,
    pub sha256: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckpointFooter {
    pub event_count: u32,
    pub blob_count: u32,
    pub record_count: u32,
    pub logical_bytes: u64,
    pub plaintext_sha256: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckpointPlaintextSummary {
    pub event_count: u32,
    pub blob_count: u32,
    pub logical_bytes: u64,
    pub plaintext_sha256: [u8; 32],
}

impl CheckpointPlaintextSummary {
    pub fn manifest(&self, schema_id: String, schema_version: u16) -> CheckpointManifest {
        CheckpointManifest {
            schema_id,
            schema_version,
            expected_event_count: self.event_count,
            expected_blob_count: self.blob_count,
            expected_logical_bytes: self.logical_bytes,
            plaintext_sha256: self.plaintext_sha256,
        }
    }
}

/// First-pass canonical digest builder for the encrypted manifest.
///
/// Production snapshot sources are replayable files/event stores, so they can
/// be read once for this digest and again for age streaming without writing a
/// plaintext staging file. The envelope writer independently recomputes and
/// checks the same digest during the second pass.
pub struct CheckpointPlaintextHasher {
    limits: CheckpointLimits,
    digest: Sha256,
    event_count: u32,
    blob_count: u32,
    record_count: u32,
    logical_bytes: u64,
    last_event_sequence: Option<u64>,
    blob_paths: HashSet<String>,
}

impl CheckpointPlaintextHasher {
    pub fn new(limits: CheckpointLimits) -> Self {
        Self {
            limits,
            digest: Sha256::new(),
            event_count: 0,
            blob_count: 0,
            record_count: 0,
            logical_bytes: 0,
            last_event_sequence: None,
            blob_paths: HashSet::new(),
        }
    }

    pub fn update_event(
        &mut self,
        sequence: u64,
        event_id: &str,
        event_kind: &str,
        payload: &[u8],
    ) -> Result<(), ContinuationCryptoError> {
        validate_text("event id", event_id, MAX_EVENT_ID_BYTES)?;
        validate_text("event kind", event_kind, MAX_EVENT_KIND_BYTES)?;
        if self
            .last_event_sequence
            .is_some_and(|previous| sequence <= previous)
        {
            return Err(ContinuationCryptoError::InvalidFrame(
                "event sequences must be strictly increasing",
            ));
        }
        ensure_limit(
            LimitKind::EventBytes,
            self.limits.max_event_bytes,
            payload.len() as u64,
        )?;
        let event_count =
            self.event_count
                .checked_add(1)
                .ok_or(ContinuationCryptoError::InvalidFrame(
                    "event count overflow",
                ))?;
        ensure_limit(
            LimitKind::Events,
            self.limits.max_events as u64,
            event_count as u64,
        )?;
        let record_count = next_read_record(self.record_count, self.limits)?;
        let body = encode_event_payload(sequence, event_id, event_kind, payload)?;
        ensure_limit(
            LimitKind::FrameBytes,
            self.limits.max_frame_bytes,
            body.len() as u64,
        )?;
        hash_frame(&mut self.digest, FRAME_EVENT, &body)?;
        self.event_count = event_count;
        self.record_count = record_count;
        self.logical_bytes =
            add_read_logical(self.logical_bytes, payload.len() as u64, self.limits)?;
        self.last_event_sequence = Some(sequence);
        Ok(())
    }

    pub fn update_blob(
        &mut self,
        metadata: &BlobMetadata,
        content: &mut dyn Read,
    ) -> Result<(), ContinuationCryptoError> {
        validate_relative_path(&metadata.relative_path, self.limits.max_path_bytes)?;
        if !self
            .blob_paths
            .insert(portable_path_key(&metadata.relative_path))
        {
            return Err(ContinuationCryptoError::InvalidFrame("duplicate blob path"));
        }
        validate_text("media type", &metadata.media_type, MAX_MEDIA_TYPE_BYTES)?;
        ensure_limit(
            LimitKind::BlobBytes,
            self.limits.max_blob_bytes,
            metadata.content_len,
        )?;
        let blob_count = self
            .blob_count
            .checked_add(1)
            .ok_or(ContinuationCryptoError::InvalidFrame("blob count overflow"))?;
        ensure_limit(
            LimitKind::Blobs,
            self.limits.max_blobs as u64,
            blob_count as u64,
        )?;
        let record_count = next_read_record(self.record_count, self.limits)?;
        let prefix = encode_blob_prefix(metadata)?;
        let payload_len = (prefix.len() as u64)
            .checked_add(metadata.content_len)
            .ok_or(ContinuationCryptoError::InvalidFrame(
                "blob frame length overflow",
            ))?;
        ensure_limit(
            LimitKind::FrameBytes,
            self.limits.max_frame_bytes,
            payload_len,
        )?;
        self.digest.update([FRAME_BLOB]);
        self.digest.update(
            u32::try_from(payload_len)
                .map_err(|_| ContinuationCryptoError::InvalidFrame("blob frame exceeds u32"))?
                .to_be_bytes(),
        );
        self.digest.update(&prefix);
        let mut blob_digest = Sha256::new();
        read_exact_chunks(content, metadata.content_len, |bytes| {
            self.digest.update(bytes);
            blob_digest.update(bytes);
            Ok(())
        })?;
        let actual_sha256: [u8; 32] = blob_digest.finalize().into();
        if actual_sha256 != metadata.sha256 {
            return Err(ContinuationCryptoError::InvalidFrame(
                "blob SHA-256 mismatch",
            ));
        }
        self.blob_count = blob_count;
        self.record_count = record_count;
        self.logical_bytes =
            add_read_logical(self.logical_bytes, metadata.content_len, self.limits)?;
        Ok(())
    }

    pub fn finish(self) -> CheckpointPlaintextSummary {
        CheckpointPlaintextSummary {
            event_count: self.event_count,
            blob_count: self.blob_count,
            logical_bytes: self.logical_bytes,
            plaintext_sha256: self.digest.finalize().into(),
        }
    }
}

pub trait CheckpointRecordWriter {
    fn write_event(
        &mut self,
        sequence: u64,
        event_id: &str,
        event_kind: &str,
        payload: &[u8],
    ) -> Result<(), ContinuationCryptoError>;

    fn write_blob(
        &mut self,
        metadata: &BlobMetadata,
        content: &mut dyn Read,
    ) -> Result<(), ContinuationCryptoError>;
}

pub trait CheckpointSink {
    /// Begin an invisible staging transaction. No staged record may become
    /// externally visible before `commit_transaction`.
    fn begin_transaction(&mut self) -> Result<(), ContinuationCryptoError> {
        Ok(())
    }

    fn stage_manifest(
        &mut self,
        _manifest: &CheckpointManifest,
    ) -> Result<(), ContinuationCryptoError> {
        Ok(())
    }

    fn stage_event(&mut self, event: &CheckpointEvent) -> Result<(), ContinuationCryptoError>;

    /// The implementation must consume exactly `metadata.content_len` bytes.
    /// Returning early is rejected so no later frame can be misinterpreted.
    fn stage_blob(
        &mut self,
        metadata: &BlobMetadata,
        content: &mut dyn Read,
    ) -> Result<(), ContinuationCryptoError>;

    fn stage_footer(&mut self, _footer: &CheckpointFooter) -> Result<(), ContinuationCryptoError> {
        Ok(())
    }

    /// Atomically publish the staged checkpoint after footer/hash/EOF checks.
    fn commit_transaction(&mut self) -> Result<(), ContinuationCryptoError> {
        Ok(())
    }

    /// Discard every staged side effect. This must be idempotent and must not
    /// expose any staged record.
    fn abort_transaction(&mut self) {}
}

pub(crate) struct CheckpointStreamWriter<W: Write> {
    inner: W,
    manifest: CheckpointManifest,
    limits: CheckpointLimits,
    content_digest: Sha256,
    event_count: u32,
    blob_count: u32,
    record_count: u32,
    logical_bytes: u64,
    total_bytes: u64,
    last_event_sequence: Option<u64>,
    blob_paths: HashSet<String>,
}

impl<W: Write> CheckpointStreamWriter<W> {
    pub(crate) fn new(
        inner: W,
        manifest: CheckpointManifest,
        limits: CheckpointLimits,
    ) -> Result<Self, ContinuationCryptoError> {
        validate_manifest(&manifest, limits)?;
        let mut writer = Self {
            inner,
            manifest,
            limits,
            content_digest: Sha256::new(),
            event_count: 0,
            blob_count: 0,
            record_count: 0,
            logical_bytes: 0,
            total_bytes: 0,
            last_event_sequence: None,
            blob_paths: HashSet::new(),
        };
        writer.write_counted(INNER_STREAM_MAGIC)?;
        writer.write_counted(&INNER_STREAM_VERSION.to_be_bytes())?;
        let manifest_payload = encode_manifest(&writer.manifest)?;
        writer.ensure_limit(
            LimitKind::ManifestBytes,
            writer.limits.max_manifest_bytes,
            manifest_payload.len() as u64,
        )?;
        writer.write_frame_plain(FRAME_MANIFEST, &manifest_payload)?;
        Ok(writer)
    }

    pub(crate) fn finish(mut self) -> Result<W, ContinuationCryptoError> {
        let plaintext_sha256: [u8; 32] = self.content_digest.clone().finalize().into();
        let footer = CheckpointFooter {
            event_count: self.event_count,
            blob_count: self.blob_count,
            record_count: self.record_count,
            logical_bytes: self.logical_bytes,
            plaintext_sha256,
        };
        if footer.event_count != self.manifest.expected_event_count
            || footer.blob_count != self.manifest.expected_blob_count
            || footer.record_count
                != self
                    .manifest
                    .expected_event_count
                    .checked_add(self.manifest.expected_blob_count)
                    .ok_or(ContinuationCryptoError::InvalidFrame(
                        "record count overflow",
                    ))?
            || footer.logical_bytes != self.manifest.expected_logical_bytes
            || footer.plaintext_sha256 != self.manifest.plaintext_sha256
        {
            return Err(ContinuationCryptoError::InvalidFrame(
                "actual records do not match the encrypted manifest",
            ));
        }
        self.write_frame_plain(FRAME_FOOTER, &encode_footer(&footer))?;
        self.inner.flush().map_err(|error| {
            ContinuationCryptoError::io("flushing checkpoint frame stream", error)
        })?;
        Ok(self.inner)
    }

    fn write_event_impl(
        &mut self,
        sequence: u64,
        event_id: &str,
        event_kind: &str,
        payload: &[u8],
    ) -> Result<(), ContinuationCryptoError> {
        validate_text("event id", event_id, MAX_EVENT_ID_BYTES)?;
        validate_text("event kind", event_kind, MAX_EVENT_KIND_BYTES)?;
        if self
            .last_event_sequence
            .is_some_and(|previous| sequence <= previous)
        {
            return Err(ContinuationCryptoError::InvalidFrame(
                "event sequences must be strictly increasing",
            ));
        }
        self.ensure_limit(
            LimitKind::EventBytes,
            self.limits.max_event_bytes,
            payload.len() as u64,
        )?;
        let event_count =
            self.event_count
                .checked_add(1)
                .ok_or(ContinuationCryptoError::InvalidFrame(
                    "event count overflow",
                ))?;
        self.ensure_limit(
            LimitKind::Events,
            self.limits.max_events as u64,
            event_count as u64,
        )?;
        let record_count = self.next_record_count()?;
        let body = encode_event_payload(sequence, event_id, event_kind, payload)?;
        self.write_content_frame(FRAME_EVENT, &body)?;
        self.event_count = event_count;
        self.record_count = record_count;
        self.last_event_sequence = Some(sequence);
        self.add_logical_bytes(payload.len() as u64)?;
        Ok(())
    }

    fn write_blob_impl(
        &mut self,
        metadata: &BlobMetadata,
        content: &mut dyn Read,
    ) -> Result<(), ContinuationCryptoError> {
        validate_relative_path(&metadata.relative_path, self.limits.max_path_bytes)?;
        if !self
            .blob_paths
            .insert(portable_path_key(&metadata.relative_path))
        {
            return Err(ContinuationCryptoError::InvalidFrame("duplicate blob path"));
        }
        validate_text("media type", &metadata.media_type, MAX_MEDIA_TYPE_BYTES)?;
        self.ensure_limit(
            LimitKind::BlobBytes,
            self.limits.max_blob_bytes,
            metadata.content_len,
        )?;
        let blob_count = self
            .blob_count
            .checked_add(1)
            .ok_or(ContinuationCryptoError::InvalidFrame("blob count overflow"))?;
        self.ensure_limit(
            LimitKind::Blobs,
            self.limits.max_blobs as u64,
            blob_count as u64,
        )?;
        let record_count = self.next_record_count()?;

        let prefix = encode_blob_prefix(metadata)?;
        let payload_len = (prefix.len() as u64)
            .checked_add(metadata.content_len)
            .ok_or(ContinuationCryptoError::InvalidFrame(
                "blob frame length overflow",
            ))?;
        self.ensure_frame(payload_len)?;
        let payload_len_u32 = u32::try_from(payload_len)
            .map_err(|_| ContinuationCryptoError::InvalidFrame("blob frame exceeds u32"))?;
        let frame_header = [
            [FRAME_BLOB].as_slice(),
            payload_len_u32.to_be_bytes().as_slice(),
        ]
        .concat();
        self.write_content_bytes(&frame_header)?;
        self.write_content_bytes(&prefix)?;

        let mut blob_digest = Sha256::new();
        read_exact_chunks(content, metadata.content_len, |chunk| {
            blob_digest.update(chunk);
            self.write_content_bytes(chunk)
        })?;
        let actual_sha256: [u8; 32] = blob_digest.finalize().into();
        if actual_sha256 != metadata.sha256 {
            return Err(ContinuationCryptoError::InvalidFrame(
                "blob SHA-256 mismatch",
            ));
        }
        self.blob_count = blob_count;
        self.record_count = record_count;
        self.add_logical_bytes(metadata.content_len)?;
        Ok(())
    }

    fn next_record_count(&self) -> Result<u32, ContinuationCryptoError> {
        let next =
            self.record_count
                .checked_add(1)
                .ok_or(ContinuationCryptoError::InvalidFrame(
                    "record count overflow",
                ))?;
        self.ensure_limit(
            LimitKind::Records,
            self.limits.max_records as u64,
            next as u64,
        )?;
        Ok(next)
    }

    fn add_logical_bytes(&mut self, bytes: u64) -> Result<(), ContinuationCryptoError> {
        self.logical_bytes =
            self.logical_bytes
                .checked_add(bytes)
                .ok_or(ContinuationCryptoError::InvalidFrame(
                    "logical byte count overflow",
                ))?;
        self.ensure_limit(
            LimitKind::TotalDecompressedBytes,
            self.limits.max_total_decompressed_bytes,
            self.logical_bytes,
        )
    }

    fn ensure_frame(&self, payload_len: u64) -> Result<(), ContinuationCryptoError> {
        self.ensure_limit(
            LimitKind::FrameBytes,
            self.limits.max_frame_bytes,
            payload_len,
        )
    }

    fn ensure_limit(
        &self,
        kind: LimitKind,
        limit: u64,
        actual: u64,
    ) -> Result<(), ContinuationCryptoError> {
        if actual > limit {
            Err(ContinuationCryptoError::limit(kind, limit, actual))
        } else {
            Ok(())
        }
    }

    fn write_frame_plain(
        &mut self,
        tag: u8,
        payload: &[u8],
    ) -> Result<(), ContinuationCryptoError> {
        self.ensure_frame(payload.len() as u64)?;
        self.write_counted(&[tag])?;
        self.write_counted(
            &u32::try_from(payload.len())
                .map_err(|_| ContinuationCryptoError::InvalidFrame("frame exceeds u32"))?
                .to_be_bytes(),
        )?;
        self.write_counted(payload)
    }

    fn write_content_frame(
        &mut self,
        tag: u8,
        payload: &[u8],
    ) -> Result<(), ContinuationCryptoError> {
        self.ensure_frame(payload.len() as u64)?;
        self.write_content_bytes(&[tag])?;
        self.write_content_bytes(
            &u32::try_from(payload.len())
                .map_err(|_| ContinuationCryptoError::InvalidFrame("frame exceeds u32"))?
                .to_be_bytes(),
        )?;
        self.write_content_bytes(payload)
    }

    fn write_content_bytes(&mut self, bytes: &[u8]) -> Result<(), ContinuationCryptoError> {
        self.content_digest.update(bytes);
        self.write_counted(bytes)
    }

    fn write_counted(&mut self, bytes: &[u8]) -> Result<(), ContinuationCryptoError> {
        let next = self.total_bytes.checked_add(bytes.len() as u64).ok_or(
            ContinuationCryptoError::InvalidFrame("decompressed byte count overflow"),
        )?;
        self.ensure_limit(
            LimitKind::TotalDecompressedBytes,
            self.limits.max_total_decompressed_bytes,
            next,
        )?;
        self.inner
            .write_all(bytes)
            .map_err(|error| ContinuationCryptoError::io("writing checkpoint frame", error))?;
        self.total_bytes = next;
        Ok(())
    }
}

impl<W: Write> CheckpointRecordWriter for CheckpointStreamWriter<W> {
    fn write_event(
        &mut self,
        sequence: u64,
        event_id: &str,
        event_kind: &str,
        payload: &[u8],
    ) -> Result<(), ContinuationCryptoError> {
        self.write_event_impl(sequence, event_id, event_kind, payload)
    }

    fn write_blob(
        &mut self,
        metadata: &BlobMetadata,
        content: &mut dyn Read,
    ) -> Result<(), ContinuationCryptoError> {
        self.write_blob_impl(metadata, content)
    }
}

pub(crate) fn read_checkpoint_stream<R: Read>(
    mut reader: R,
    limits: CheckpointLimits,
    sink: &mut dyn CheckpointSink,
) -> Result<(CheckpointManifest, CheckpointFooter), ContinuationCryptoError> {
    let mut total_bytes = 0u64;
    let magic = read_array_counted::<8, _>(&mut reader, &mut total_bytes, limits)?;
    if &magic != INNER_STREAM_MAGIC {
        return Err(ContinuationCryptoError::InvalidFrame(
            "bad inner stream magic",
        ));
    }
    let version = u16::from_be_bytes(read_array_counted::<2, _>(
        &mut reader,
        &mut total_bytes,
        limits,
    )?);
    if version != INNER_STREAM_VERSION {
        return Err(ContinuationCryptoError::InvalidFrame(
            "unsupported inner stream version",
        ));
    }

    let (tag, length, raw_header) = read_frame_header(&mut reader, &mut total_bytes, limits)?;
    if tag != FRAME_MANIFEST {
        return Err(ContinuationCryptoError::InvalidFrame(
            "manifest must be the first frame",
        ));
    }
    ensure_limit(
        LimitKind::ManifestBytes,
        limits.max_manifest_bytes,
        length as u64,
    )?;
    let manifest_bytes = read_vec_counted(&mut reader, length as usize, &mut total_bytes, limits)?;
    let manifest = decode_manifest(&manifest_bytes)?;
    validate_manifest(&manifest, limits)?;
    let _ = raw_header;
    sink.stage_manifest(&manifest)?;

    let mut content_digest = Sha256::new();
    let mut event_count = 0u32;
    let mut blob_count = 0u32;
    let mut record_count = 0u32;
    let mut logical_bytes = 0u64;
    let mut last_event_sequence = None;
    let mut blob_paths = HashSet::new();

    let footer = loop {
        let (tag, length, raw_header) = read_frame_header(&mut reader, &mut total_bytes, limits)?;
        ensure_limit(LimitKind::FrameBytes, limits.max_frame_bytes, length as u64)?;
        match tag {
            FRAME_EVENT => {
                content_digest.update(raw_header);
                let payload = read_vec_counted_and_hash(
                    &mut reader,
                    length as usize,
                    &mut total_bytes,
                    limits,
                    &mut content_digest,
                )?;
                let event = decode_event(&payload, limits)?;
                if last_event_sequence.is_some_and(|previous| event.sequence <= previous) {
                    return Err(ContinuationCryptoError::InvalidFrame(
                        "event sequences must be strictly increasing",
                    ));
                }
                event_count =
                    event_count
                        .checked_add(1)
                        .ok_or(ContinuationCryptoError::InvalidFrame(
                            "event count overflow",
                        ))?;
                ensure_limit(
                    LimitKind::Events,
                    limits.max_events as u64,
                    event_count as u64,
                )?;
                record_count = next_read_record(record_count, limits)?;
                logical_bytes =
                    add_read_logical(logical_bytes, event.payload.len() as u64, limits)?;
                last_event_sequence = Some(event.sequence);
                sink.stage_event(&event)?;
            }
            FRAME_BLOB => {
                content_digest.update(raw_header);
                let mut prefix = BlobPrefixReader::new(
                    &mut reader,
                    &mut total_bytes,
                    limits,
                    &mut content_digest,
                    length as u64,
                );
                let metadata = prefix.read_metadata()?;
                if !blob_paths.insert(portable_path_key(&metadata.relative_path)) {
                    return Err(ContinuationCryptoError::InvalidFrame("duplicate blob path"));
                }
                blob_count = blob_count
                    .checked_add(1)
                    .ok_or(ContinuationCryptoError::InvalidFrame("blob count overflow"))?;
                ensure_limit(LimitKind::Blobs, limits.max_blobs as u64, blob_count as u64)?;
                record_count = next_read_record(record_count, limits)?;
                logical_bytes = add_read_logical(logical_bytes, metadata.content_len, limits)?;
                let mut content = prefix.content_reader(&metadata)?;
                sink.stage_blob(&metadata, &mut content)?;
                if content.remaining != 0 {
                    return Err(ContinuationCryptoError::BlobNotConsumed);
                }
                let actual_sha256: [u8; 32] = content.blob_digest.clone().finalize().into();
                if actual_sha256 != metadata.sha256 {
                    return Err(ContinuationCryptoError::InvalidFrame(
                        "blob SHA-256 mismatch",
                    ));
                }
            }
            FRAME_FOOTER => {
                let bytes =
                    read_vec_counted(&mut reader, length as usize, &mut total_bytes, limits)?;
                break decode_footer(&bytes)?;
            }
            FRAME_MANIFEST => {
                return Err(ContinuationCryptoError::InvalidFrame(
                    "duplicate manifest frame",
                ));
            }
            _ => return Err(ContinuationCryptoError::InvalidFrame("unknown frame tag")),
        }
    };

    let plaintext_sha256: [u8; 32] = content_digest.finalize().into();
    if footer.event_count != event_count
        || footer.blob_count != blob_count
        || footer.record_count != record_count
        || footer.logical_bytes != logical_bytes
        || footer.plaintext_sha256 != plaintext_sha256
        || manifest.expected_event_count != event_count
        || manifest.expected_blob_count != blob_count
        || manifest.expected_logical_bytes != logical_bytes
        || manifest.plaintext_sha256 != plaintext_sha256
    {
        return Err(ContinuationCryptoError::PlaintextHashMismatch);
    }
    sink.stage_footer(&footer)?;
    let mut trailing = [0u8; 1];
    let read = reader
        .read(&mut trailing)
        .map_err(|error| ContinuationCryptoError::io("checking framed stream end", error))?;
    if read != 0 {
        return Err(ContinuationCryptoError::InvalidFrame(
            "trailing bytes after footer",
        ));
    }
    Ok((manifest, footer))
}

fn validate_manifest(
    manifest: &CheckpointManifest,
    limits: CheckpointLimits,
) -> Result<(), ContinuationCryptoError> {
    validate_text("schema id", &manifest.schema_id, MAX_SCHEMA_ID_BYTES)?;
    if manifest.schema_version == 0 {
        return Err(ContinuationCryptoError::InvalidFrame(
            "schema version must be positive",
        ));
    }
    ensure_limit(
        LimitKind::Events,
        limits.max_events as u64,
        manifest.expected_event_count as u64,
    )?;
    ensure_limit(
        LimitKind::Blobs,
        limits.max_blobs as u64,
        manifest.expected_blob_count as u64,
    )?;
    let records = manifest
        .expected_event_count
        .checked_add(manifest.expected_blob_count)
        .ok_or(ContinuationCryptoError::InvalidFrame(
            "manifest record count overflow",
        ))?;
    ensure_limit(
        LimitKind::Records,
        limits.max_records as u64,
        records as u64,
    )?;
    ensure_limit(
        LimitKind::TotalDecompressedBytes,
        limits.max_total_decompressed_bytes,
        manifest.expected_logical_bytes,
    )
}

fn encode_manifest(manifest: &CheckpointManifest) -> Result<Vec<u8>, ContinuationCryptoError> {
    let mut bytes = Vec::with_capacity(64 + manifest.schema_id.len());
    put_string(&mut bytes, &manifest.schema_id)?;
    bytes.extend_from_slice(&manifest.schema_version.to_be_bytes());
    bytes.extend_from_slice(&manifest.expected_event_count.to_be_bytes());
    bytes.extend_from_slice(&manifest.expected_blob_count.to_be_bytes());
    bytes.extend_from_slice(&manifest.expected_logical_bytes.to_be_bytes());
    bytes.extend_from_slice(&manifest.plaintext_sha256);
    Ok(bytes)
}

fn decode_manifest(bytes: &[u8]) -> Result<CheckpointManifest, ContinuationCryptoError> {
    let mut cursor = PayloadCursor::new(bytes);
    let manifest = CheckpointManifest {
        schema_id: cursor.string(MAX_SCHEMA_ID_BYTES)?,
        schema_version: cursor.u16()?,
        expected_event_count: cursor.u32()?,
        expected_blob_count: cursor.u32()?,
        expected_logical_bytes: cursor.u64()?,
        plaintext_sha256: cursor.array()?,
    };
    cursor.finish()?;
    if encode_manifest(&manifest)? != bytes {
        return Err(ContinuationCryptoError::InvalidFrame(
            "non-canonical manifest encoding",
        ));
    }
    Ok(manifest)
}

fn decode_event(
    bytes: &[u8],
    limits: CheckpointLimits,
) -> Result<CheckpointEvent, ContinuationCryptoError> {
    let mut cursor = PayloadCursor::new(bytes);
    let sequence = cursor.u64()?;
    let event_id = cursor.string(MAX_EVENT_ID_BYTES)?;
    let event_kind = cursor.string(MAX_EVENT_KIND_BYTES)?;
    let payload_len = cursor.u32()? as usize;
    ensure_limit(
        LimitKind::EventBytes,
        limits.max_event_bytes,
        payload_len as u64,
    )?;
    let payload = cursor.take(payload_len)?.to_vec();
    cursor.finish()?;
    Ok(CheckpointEvent {
        sequence,
        event_id,
        event_kind,
        payload,
    })
}

fn encode_footer(footer: &CheckpointFooter) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(52);
    bytes.extend_from_slice(&footer.event_count.to_be_bytes());
    bytes.extend_from_slice(&footer.blob_count.to_be_bytes());
    bytes.extend_from_slice(&footer.record_count.to_be_bytes());
    bytes.extend_from_slice(&footer.logical_bytes.to_be_bytes());
    bytes.extend_from_slice(&footer.plaintext_sha256);
    bytes
}

fn decode_footer(bytes: &[u8]) -> Result<CheckpointFooter, ContinuationCryptoError> {
    let mut cursor = PayloadCursor::new(bytes);
    let footer = CheckpointFooter {
        event_count: cursor.u32()?,
        blob_count: cursor.u32()?,
        record_count: cursor.u32()?,
        logical_bytes: cursor.u64()?,
        plaintext_sha256: cursor.array()?,
    };
    cursor.finish()?;
    if encode_footer(&footer) != bytes {
        return Err(ContinuationCryptoError::InvalidFrame(
            "non-canonical footer encoding",
        ));
    }
    Ok(footer)
}

fn read_frame_header<R: Read>(
    reader: &mut R,
    total: &mut u64,
    limits: CheckpointLimits,
) -> Result<(u8, u32, [u8; 5]), ContinuationCryptoError> {
    let raw = read_array_counted::<5, _>(reader, total, limits)?;
    let length = u32::from_be_bytes(
        raw[1..5]
            .try_into()
            .map_err(|_| ContinuationCryptoError::InvalidFrame("truncated frame length"))?,
    );
    ensure_limit(LimitKind::FrameBytes, limits.max_frame_bytes, length as u64)?;
    Ok((raw[0], length, raw))
}

fn read_array_counted<const N: usize, R: Read>(
    reader: &mut R,
    total: &mut u64,
    limits: CheckpointLimits,
) -> Result<[u8; N], ContinuationCryptoError> {
    let mut bytes = [0u8; N];
    read_exact_counted(reader, &mut bytes, total, limits)?;
    Ok(bytes)
}

fn read_vec_counted<R: Read>(
    reader: &mut R,
    length: usize,
    total: &mut u64,
    limits: CheckpointLimits,
) -> Result<Vec<u8>, ContinuationCryptoError> {
    let mut bytes = vec![0u8; length];
    read_exact_counted(reader, &mut bytes, total, limits)?;
    Ok(bytes)
}

fn read_vec_counted_and_hash<R: Read>(
    reader: &mut R,
    length: usize,
    total: &mut u64,
    limits: CheckpointLimits,
    digest: &mut Sha256,
) -> Result<Vec<u8>, ContinuationCryptoError> {
    let bytes = read_vec_counted(reader, length, total, limits)?;
    digest.update(&bytes);
    Ok(bytes)
}

fn read_exact_counted<R: Read>(
    reader: &mut R,
    bytes: &mut [u8],
    total: &mut u64,
    limits: CheckpointLimits,
) -> Result<(), ContinuationCryptoError> {
    let next =
        total
            .checked_add(bytes.len() as u64)
            .ok_or(ContinuationCryptoError::InvalidFrame(
                "decompressed byte count overflow",
            ))?;
    ensure_limit(
        LimitKind::TotalDecompressedBytes,
        limits.max_total_decompressed_bytes,
        next,
    )?;
    reader
        .read_exact(bytes)
        .map_err(|error| ContinuationCryptoError::io("reading checkpoint frame", error))?;
    *total = next;
    Ok(())
}

struct BlobPrefixReader<'a, R> {
    reader: &'a mut R,
    total: &'a mut u64,
    limits: CheckpointLimits,
    content_digest: &'a mut Sha256,
    frame_remaining: u64,
}

impl<'a, R: Read> BlobPrefixReader<'a, R> {
    fn new(
        reader: &'a mut R,
        total: &'a mut u64,
        limits: CheckpointLimits,
        content_digest: &'a mut Sha256,
        frame_remaining: u64,
    ) -> Self {
        Self {
            reader,
            total,
            limits,
            content_digest,
            frame_remaining,
        }
    }

    fn read_metadata(&mut self) -> Result<BlobMetadata, ContinuationCryptoError> {
        let relative_path = self.string(self.limits.max_path_bytes as usize)?;
        validate_relative_path(&relative_path, self.limits.max_path_bytes)?;
        let media_type = self.string(MAX_MEDIA_TYPE_BYTES)?;
        validate_text("media type", &media_type, MAX_MEDIA_TYPE_BYTES)?;
        let content_len = u64::from_be_bytes(self.array()?);
        ensure_limit(
            LimitKind::BlobBytes,
            self.limits.max_blob_bytes,
            content_len,
        )?;
        let sha256 = self.array()?;
        if self.frame_remaining != content_len {
            return Err(ContinuationCryptoError::InvalidFrame(
                "blob frame length does not match declared content",
            ));
        }
        Ok(BlobMetadata {
            relative_path,
            media_type,
            content_len,
            sha256,
        })
    }

    fn content_reader(
        self,
        metadata: &BlobMetadata,
    ) -> Result<BlobContentReader<'a, R>, ContinuationCryptoError> {
        let final_total = (*self.total).checked_add(metadata.content_len).ok_or(
            ContinuationCryptoError::InvalidFrame("decompressed byte count overflow"),
        )?;
        ensure_limit(
            LimitKind::TotalDecompressedBytes,
            self.limits.max_total_decompressed_bytes,
            final_total,
        )?;
        Ok(BlobContentReader {
            reader: self.reader,
            total: self.total,
            limits: self.limits,
            content_digest: self.content_digest,
            blob_digest: Sha256::new(),
            remaining: metadata.content_len,
        })
    }

    fn string(&mut self, max: usize) -> Result<String, ContinuationCryptoError> {
        let length = u16::from_be_bytes(self.array()?) as usize;
        if length == 0 || length > max {
            return Err(ContinuationCryptoError::InvalidFrame(
                "invalid blob metadata string length",
            ));
        }
        let bytes = self.take(length)?;
        String::from_utf8(bytes)
            .map_err(|_| ContinuationCryptoError::InvalidFrame("blob metadata is not UTF-8"))
    }

    fn array<const N: usize>(&mut self) -> Result<[u8; N], ContinuationCryptoError> {
        self.take(N)?
            .try_into()
            .map_err(|_| ContinuationCryptoError::InvalidFrame("truncated blob metadata array"))
    }

    fn take(&mut self, length: usize) -> Result<Vec<u8>, ContinuationCryptoError> {
        if length as u64 > self.frame_remaining {
            return Err(ContinuationCryptoError::InvalidFrame(
                "blob metadata exceeds frame length",
            ));
        }
        let bytes = read_vec_counted(self.reader, length, self.total, self.limits)?;
        self.content_digest.update(&bytes);
        self.frame_remaining -= length as u64;
        Ok(bytes)
    }
}

struct BlobContentReader<'a, R> {
    reader: &'a mut R,
    total: &'a mut u64,
    limits: CheckpointLimits,
    content_digest: &'a mut Sha256,
    blob_digest: Sha256,
    remaining: u64,
}

impl<R: Read> Read for BlobContentReader<'_, R> {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        if self.remaining == 0 || output.is_empty() {
            return Ok(0);
        }
        let requested = output.len().min(self.remaining as usize);
        let next_total = self.total.checked_add(requested as u64).ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, "byte limit overflow")
        })?;
        if next_total > self.limits.max_total_decompressed_bytes {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "total decompressed byte limit exceeded",
            ));
        }
        let read = self.reader.read(&mut output[..requested])?;
        if read == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "truncated blob content",
            ));
        }
        let bytes = &output[..read];
        self.content_digest.update(bytes);
        self.blob_digest.update(bytes);
        self.remaining -= read as u64;
        *self.total += read as u64;
        Ok(read)
    }
}

struct PayloadCursor<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> PayloadCursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, position: 0 }
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], ContinuationCryptoError> {
        let end =
            self.position
                .checked_add(length)
                .ok_or(ContinuationCryptoError::InvalidFrame(
                    "payload length overflow",
                ))?;
        let value =
            self.bytes
                .get(self.position..end)
                .ok_or(ContinuationCryptoError::InvalidFrame(
                    "truncated frame payload",
                ))?;
        self.position = end;
        Ok(value)
    }

    fn u16(&mut self) -> Result<u16, ContinuationCryptoError> {
        Ok(u16::from_be_bytes(self.array()?))
    }

    fn u32(&mut self) -> Result<u32, ContinuationCryptoError> {
        Ok(u32::from_be_bytes(self.array()?))
    }

    fn u64(&mut self) -> Result<u64, ContinuationCryptoError> {
        Ok(u64::from_be_bytes(self.array()?))
    }

    fn array<const N: usize>(&mut self) -> Result<[u8; N], ContinuationCryptoError> {
        self.take(N)?
            .try_into()
            .map_err(|_| ContinuationCryptoError::InvalidFrame("truncated payload array"))
    }

    fn string(&mut self, max: usize) -> Result<String, ContinuationCryptoError> {
        let length = self.u16()? as usize;
        if length == 0 || length > max {
            return Err(ContinuationCryptoError::InvalidFrame(
                "invalid payload string length",
            ));
        }
        String::from_utf8(self.take(length)?.to_vec())
            .map_err(|_| ContinuationCryptoError::InvalidFrame("payload string is not UTF-8"))
    }

    fn finish(&self) -> Result<(), ContinuationCryptoError> {
        if self.position == self.bytes.len() {
            Ok(())
        } else {
            Err(ContinuationCryptoError::InvalidFrame(
                "trailing frame payload bytes",
            ))
        }
    }
}

fn put_string(bytes: &mut Vec<u8>, value: &str) -> Result<(), ContinuationCryptoError> {
    let length = u16::try_from(value.len())
        .map_err(|_| ContinuationCryptoError::InvalidFrame("string exceeds u16"))?;
    bytes.extend_from_slice(&length.to_be_bytes());
    bytes.extend_from_slice(value.as_bytes());
    Ok(())
}

fn encode_event_payload(
    sequence: u64,
    event_id: &str,
    event_kind: &str,
    payload: &[u8],
) -> Result<Vec<u8>, ContinuationCryptoError> {
    let mut body = Vec::with_capacity(16 + event_id.len() + event_kind.len() + payload.len());
    body.extend_from_slice(&sequence.to_be_bytes());
    put_string(&mut body, event_id)?;
    put_string(&mut body, event_kind)?;
    body.extend_from_slice(
        &u32::try_from(payload.len())
            .map_err(|_| ContinuationCryptoError::InvalidFrame("event payload too large"))?
            .to_be_bytes(),
    );
    body.extend_from_slice(payload);
    Ok(body)
}

fn encode_blob_prefix(metadata: &BlobMetadata) -> Result<Vec<u8>, ContinuationCryptoError> {
    let mut prefix = Vec::with_capacity(
        2 + metadata.relative_path.len() + 2 + metadata.media_type.len() + 8 + 32,
    );
    put_string(&mut prefix, &metadata.relative_path)?;
    put_string(&mut prefix, &metadata.media_type)?;
    prefix.extend_from_slice(&metadata.content_len.to_be_bytes());
    prefix.extend_from_slice(&metadata.sha256);
    Ok(prefix)
}

fn hash_frame(digest: &mut Sha256, tag: u8, payload: &[u8]) -> Result<(), ContinuationCryptoError> {
    digest.update([tag]);
    digest.update(
        u32::try_from(payload.len())
            .map_err(|_| ContinuationCryptoError::InvalidFrame("frame exceeds u32"))?
            .to_be_bytes(),
    );
    digest.update(payload);
    Ok(())
}

fn read_exact_chunks<F>(
    content: &mut dyn Read,
    mut remaining: u64,
    mut consume: F,
) -> Result<(), ContinuationCryptoError>
where
    F: FnMut(&[u8]) -> Result<(), ContinuationCryptoError>,
{
    let mut buffer = [0u8; 64 * 1024];
    while remaining > 0 {
        let requested = usize::try_from(remaining.min(buffer.len() as u64))
            .map_err(|_| ContinuationCryptoError::InvalidFrame("blob read size overflow"))?;
        let read = content
            .read(&mut buffer[..requested])
            .map_err(|error| ContinuationCryptoError::io("reading checkpoint blob", error))?;
        if read == 0 {
            return Err(ContinuationCryptoError::InvalidFrame(
                "blob ended before its declared length",
            ));
        }
        consume(&buffer[..read])?;
        remaining -= read as u64;
    }
    let mut extra = [0u8; 1];
    if content
        .read(&mut extra)
        .map_err(|error| ContinuationCryptoError::io("checking checkpoint blob length", error))?
        != 0
    {
        return Err(ContinuationCryptoError::InvalidFrame(
            "blob exceeds its declared length",
        ));
    }
    Ok(())
}

fn validate_text(
    label: &'static str,
    value: &str,
    max: usize,
) -> Result<(), ContinuationCryptoError> {
    if value.is_empty()
        || value.len() > max
        || value
            .bytes()
            .any(|byte| byte == 0 || byte.is_ascii_control())
    {
        return Err(ContinuationCryptoError::InvalidFrame(label));
    }
    Ok(())
}

pub(crate) fn validate_relative_path(
    path: &str,
    max_path_bytes: u64,
) -> Result<(), ContinuationCryptoError> {
    ensure_limit(LimitKind::PathBytes, max_path_bytes, path.len() as u64)?;
    if path.is_empty()
        || !path.is_ascii()
        || path.starts_with('/')
        || path.ends_with('/')
        || path
            .bytes()
            .any(|byte| byte == 0 || byte.is_ascii_control() || b"<>:\\|?*".contains(&byte))
        || path.split('/').any(|segment| {
            segment.is_empty()
                || segment == "."
                || segment == ".."
                || segment.ends_with('.')
                || segment.ends_with(' ')
                || is_windows_reserved_segment(segment)
        })
    {
        return Err(ContinuationCryptoError::UnsafePath(path.to_owned()));
    }
    Ok(())
}

fn portable_path_key(path: &str) -> String {
    // Cloud handoffs may be restored on a case-insensitive filesystem even if
    // they were produced on Linux. ASCII-only validation above makes this
    // lowercase mapping deterministic without locale or Unicode-normalization
    // ambiguity.
    path.to_ascii_lowercase()
}

fn is_windows_reserved_segment(segment: &str) -> bool {
    let stem = segment
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && matches!(&stem[..3], "COM" | "LPT")
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}

fn next_read_record(
    current: u32,
    limits: CheckpointLimits,
) -> Result<u32, ContinuationCryptoError> {
    let next = current
        .checked_add(1)
        .ok_or(ContinuationCryptoError::InvalidFrame(
            "record count overflow",
        ))?;
    ensure_limit(LimitKind::Records, limits.max_records as u64, next as u64)?;
    Ok(next)
}

fn add_read_logical(
    current: u64,
    bytes: u64,
    limits: CheckpointLimits,
) -> Result<u64, ContinuationCryptoError> {
    let next = current
        .checked_add(bytes)
        .ok_or(ContinuationCryptoError::InvalidFrame(
            "logical byte count overflow",
        ))?;
    ensure_limit(
        LimitKind::TotalDecompressedBytes,
        limits.max_total_decompressed_bytes,
        next,
    )?;
    Ok(next)
}

fn ensure_limit(kind: LimitKind, limit: u64, actual: u64) -> Result<(), ContinuationCryptoError> {
    if actual > limit {
        Err(ContinuationCryptoError::limit(kind, limit, actual))
    } else {
        Ok(())
    }
}
