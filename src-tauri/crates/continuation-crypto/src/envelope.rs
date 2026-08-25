use std::{
    cell::Cell,
    fs::File,
    io::{BufReader, Read, Seek, SeekFrom, Write},
    marker::PhantomData,
    path::Path,
    rc::Rc,
};

use age::{Decryptor, Encryptor};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use flate2::{read::MultiGzDecoder, write::GzEncoder, Compression};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::{
    atomic_file::AtomicCiphertextFile,
    canonical_header_bytes,
    framed_stream::{read_checkpoint_stream, CheckpointRecordWriter, CheckpointStreamWriter},
    identity::{age_recipient_from_raw, verify_signature},
    signature_message,
    wire::{
        decode_canonical_header, ENVELOPE_END_MAGIC, ENVELOPE_MAGIC, ENVELOPE_VERSION,
        MAX_CANONICAL_HEADER_BYTES, MAX_CREATED_AT_FUTURE_SKEW_MS, PREFIX_BYTES, SIGNATURE_BYTES,
        SUFFIX_BYTES,
    },
    CheckpointFooter, CheckpointLimits, CheckpointManifest, CheckpointSink, CloudRecipient,
    CloudRecipientSet, CompressionAlgorithm, ContinuationCryptoError, ContinuationEnvelopeHeader,
    DevicePrivateIdentity, DevicePublicIdentity, EncryptionAlgorithm, HashAlgorithm, LimitKind,
    PrivateStagingDirectory, RecipientScope, SignatureAlgorithm, CLOUD_CHECKPOINT_LIMITS,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CloudEnvelopeMetadata {
    org_id: Uuid,
    checkpoint_id: Uuid,
    root_session_id: String,
    source_episode_id: String,
    source_runtime: String,
    payload_schema: String,
    payload_schema_version: u16,
    recipient_scope: RecipientScope,
    sender_user_id: Uuid,
    /// Client timestamp that is signed before upload and must be validated by
    /// the cloud prepare RPC rather than replaced with server time.
    created_at_unix_ms: u64,
    expires_at_unix_ms: u64,
}

impl CloudEnvelopeMetadata {
    #[allow(clippy::too_many_arguments)]
    pub fn try_new(
        org_id: Uuid,
        checkpoint_id: Uuid,
        root_session_id: String,
        source_episode_id: String,
        source_runtime: String,
        payload_schema: String,
        payload_schema_version: u16,
        recipient_scope: RecipientScope,
        sender_user_id: Uuid,
        created_at_unix_ms: u64,
        expires_at_unix_ms: u64,
        validation_now_unix_ms: u64,
    ) -> Result<Self, ContinuationCryptoError> {
        let metadata = Self {
            org_id,
            checkpoint_id,
            root_session_id,
            source_episode_id,
            source_runtime,
            payload_schema,
            payload_schema_version,
            recipient_scope,
            sender_user_id,
            created_at_unix_ms,
            expires_at_unix_ms,
        };
        metadata.validate_fresh(validation_now_unix_ms)?;
        Ok(metadata)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn try_from_sql(
        org_id: &str,
        checkpoint_id: &str,
        root_session_id: String,
        source_episode_id: String,
        source_runtime: String,
        payload_schema: String,
        payload_schema_version: u16,
        recipient_scope: &str,
        sender_user_id: &str,
        created_at_unix_ms: u64,
        expires_at_unix_ms: u64,
        validation_now_unix_ms: u64,
    ) -> Result<Self, ContinuationCryptoError> {
        Self::try_new(
            parse_canonical_uuid(org_id)?,
            parse_canonical_uuid(checkpoint_id)?,
            root_session_id,
            source_episode_id,
            source_runtime,
            payload_schema,
            payload_schema_version,
            parse_recipient_scope(recipient_scope)?,
            parse_canonical_uuid(sender_user_id)?,
            created_at_unix_ms,
            expires_at_unix_ms,
            validation_now_unix_ms,
        )
    }

    fn validate_fresh(&self, now_unix_ms: u64) -> Result<(), ContinuationCryptoError> {
        let header = self.header_with_identities(
            placeholder_identity(Uuid::from_u128(1)),
            CloudRecipientSet::try_new(vec![CloudRecipient::try_new(
                Uuid::from_u128(2),
                placeholder_identity(Uuid::from_u128(3)),
            )?])?,
            [1; 32],
            1,
        );
        header.validate()?;
        if self.created_at_unix_ms.abs_diff(now_unix_ms) > MAX_CREATED_AT_FUTURE_SKEW_MS {
            return Err(ContinuationCryptoError::InvalidEnvelope(
                "client creation time exceeds five-minute freshness skew",
            ));
        }
        if self.expires_at_unix_ms <= now_unix_ms {
            return Err(ContinuationCryptoError::InvalidEnvelope(
                "expiry must be in the future",
            ));
        }
        Ok(())
    }

    fn header_with_identities(
        &self,
        sender: DevicePublicIdentity,
        recipients: CloudRecipientSet,
        age_ciphertext_sha256: [u8; 32],
        age_ciphertext_len: u64,
    ) -> ContinuationEnvelopeHeader {
        ContinuationEnvelopeHeader {
            encryption_algorithm: EncryptionAlgorithm::AgeX25519,
            signature_algorithm: SignatureAlgorithm::Ed25519,
            compression_algorithm: CompressionAlgorithm::Gzip,
            hash_algorithm: HashAlgorithm::Sha256,
            org_id: self.org_id,
            checkpoint_id: self.checkpoint_id,
            root_session_id: self.root_session_id.clone(),
            source_episode_id: self.source_episode_id.clone(),
            source_runtime: self.source_runtime.clone(),
            payload_schema: self.payload_schema.clone(),
            payload_schema_version: self.payload_schema_version,
            recipient_scope: self.recipient_scope,
            sender_user_id: self.sender_user_id,
            sender,
            recipient_set_sha256: recipients.sha256(),
            recipients,
            age_ciphertext_sha256,
            created_at_unix_ms: self.created_at_unix_ms,
            expires_at_unix_ms: self.expires_at_unix_ms,
            age_ciphertext_len,
        }
    }

    pub fn org_id(&self) -> Uuid {
        self.org_id
    }
    pub fn checkpoint_id(&self) -> Uuid {
        self.checkpoint_id
    }
    pub fn root_session_id(&self) -> &str {
        &self.root_session_id
    }
    pub fn source_episode_id(&self) -> &str {
        &self.source_episode_id
    }
    pub fn source_runtime(&self) -> &str {
        &self.source_runtime
    }
    pub fn payload_schema(&self) -> &str {
        &self.payload_schema
    }
    pub fn payload_schema_version(&self) -> u16 {
        self.payload_schema_version
    }
    pub fn recipient_scope(&self) -> RecipientScope {
        self.recipient_scope
    }
    pub fn sender_user_id(&self) -> Uuid {
        self.sender_user_id
    }
    pub fn created_at_unix_ms(&self) -> u64 {
        self.created_at_unix_ms
    }
    pub fn expires_at_unix_ms(&self) -> u64 {
        self.expires_at_unix_ms
    }
}

struct EnvelopeWriteRequest<'a> {
    pub metadata: CloudEnvelopeMetadata,
    pub sender: &'a DevicePrivateIdentity,
    pub recipients: CloudRecipientSet,
    pub manifest: CheckpointManifest,
    pub limits: CheckpointLimits,
}

#[cfg(test)]
pub(crate) struct LocalEnvelopeWriteRequest<'a> {
    pub metadata: CloudEnvelopeMetadata,
    pub sender: &'a DevicePrivateIdentity,
    pub recipients: CloudRecipientSet,
    pub manifest: CheckpointManifest,
    pub limits: CheckpointLimits,
}

/// Cloud upload request with no caller-controlled limit profile.
///
/// This separate type makes it impossible for Cloud code to pass the broader
/// local-file defaults by mistake.
pub struct CloudEnvelopeWriteRequest<'a> {
    pub metadata: CloudEnvelopeMetadata,
    pub sender: &'a DevicePrivateIdentity,
    pub recipients: CloudRecipientSet,
    pub manifest: CheckpointManifest,
}

/// All trusted Cloud snapshots required to decrypt one immutable object.
///
/// Grouping them prevents a call site from accidentally omitting the caller's
/// receipt or confusing its current key with the committed sender snapshot.
pub struct CloudCheckpointDecryptRequest<'a> {
    pub expected: &'a CommittedCloudEnvelope,
    pub receipt: &'a CommittedRecipientReceipt,
    pub trusted_sender: &'a DevicePublicIdentity,
    pub recipient: &'a DevicePrivateIdentity,
    pub now_unix_ms: u64,
}

/// The two non-interchangeable digest domains needed by Cloud storage.
///
/// `header.age_ciphertext_*` covers only the standard age payload and is
/// authenticated by `signature`. `object_*` covers the complete on-disk
/// artifact (prefix, canonical header, age payload, signature, end marker)
/// and is used for object-store path/integrity/quota checks.
mod profile_sealed {
    pub trait Sealed {}
}

pub trait EnvelopeProfile: profile_sealed::Sealed {}

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LocalProfile {}
#[cfg(test)]
impl profile_sealed::Sealed for LocalProfile {}
#[cfg(test)]
impl EnvelopeProfile for LocalProfile {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
/// The only artifact profile exported by this crate.
///
/// Provider-neutral local continuation uses portable IR, not this transport:
///
/// ```compile_fail
/// use continuation_crypto::{EnvelopeArtifact, LocalProfile};
/// fn upload_local(_: EnvelopeArtifact<LocalProfile>) {}
/// ```
pub enum CloudProfile {}
impl profile_sealed::Sealed for CloudProfile {}
impl EnvelopeProfile for CloudProfile {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EnvelopeArtifact<P: EnvelopeProfile> {
    header: ContinuationEnvelopeHeader,
    /// Exact opaque canonical header bytes sent to the Cloud prepare RPC.
    canonical_header: Vec<u8>,
    /// Exact Ed25519 bytes present in the file footer and sent to Cloud.
    signature: [u8; 64],
    object_size: u64,
    object_sha256: [u8; 32],
    profile: PhantomData<fn() -> P>,
}

impl<P: EnvelopeProfile> EnvelopeArtifact<P> {
    pub fn header(&self) -> &ContinuationEnvelopeHeader {
        &self.header
    }
    pub fn canonical_header(&self) -> &[u8] {
        &self.canonical_header
    }
    pub fn signature(&self) -> &[u8; 64] {
        &self.signature
    }
    pub fn object_size(&self) -> u64 {
        self.object_size
    }
    pub fn object_sha256(&self) -> &[u8; 32] {
        &self.object_sha256
    }
}

impl EnvelopeArtifact<CloudProfile> {
    /// Produce the immutable row descriptor accepted by Cloud upload code.
    ///
    /// The crate exports no provider-neutral/local artifact profile; generic
    /// local continuation state belongs to the portable IR layer.
    pub fn cloud_upload_descriptor(&self) -> CommittedCloudEnvelope {
        CommittedCloudEnvelope::from_cloud_artifact(self)
    }
}

/// Exact immutable SQL row snapshot needed before Cloud decryption.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommittedCloudEnvelope {
    pub(crate) header: ContinuationEnvelopeHeader,
    pub(crate) canonical_header: Vec<u8>,
    pub(crate) signature: [u8; 64],
    pub(crate) object_size: u64,
    pub(crate) object_sha256: [u8; 32],
}

/// SQL-facing committed row. Every textual encoding is revalidated as its
/// unique canonical form before the object path is opened.
pub struct CommittedCloudEnvelopeSql<'a> {
    pub checkpoint_id: &'a str,
    pub org_id: &'a str,
    pub root_session_id: &'a str,
    pub source_episode_id: &'a str,
    pub client_created_at_unix_ms: u64,
    pub sender_user_id: &'a str,
    pub sender_device_id: &'a str,
    pub sender_key_version: i32,
    pub source_runtime: &'a str,
    pub payload_schema: &'a str,
    pub payload_schema_version: i32,
    pub recipient_scope: &'a str,
    pub recipient_count: i32,
    pub recipient_set_sha256: &'a str,
    pub object_size: i64,
    pub object_sha256: &'a str,
    pub age_ciphertext_len: i64,
    pub age_ciphertext_sha256: &'a str,
    pub footer_signature: &'a str,
    pub expires_at_unix_ms: u64,
    pub canonical_header: &'a [u8],
    pub sender_encryption_public_key: &'a str,
    pub sender_signing_public_key: &'a str,
    pub sender_fingerprint: &'a str,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommittedRecipientReceipt {
    org_id: Uuid,
    checkpoint_id: Uuid,
    recipient: CloudRecipient,
}

pub struct CommittedRecipientReceiptSql<'a> {
    pub org_id: &'a str,
    pub checkpoint_id: &'a str,
    pub recipient_user_id: &'a str,
    pub recipient_device_id: &'a str,
    pub recipient_key_version: i32,
    pub recipient_encryption_public_key: &'a str,
    pub recipient_signing_public_key: &'a str,
    pub recipient_fingerprint: &'a str,
}

impl CommittedRecipientReceipt {
    pub fn try_from_sql(
        row: CommittedRecipientReceiptSql<'_>,
    ) -> Result<Self, ContinuationCryptoError> {
        let identity = DevicePublicIdentity::try_new(
            parse_canonical_uuid(row.recipient_device_id)?,
            positive_sql_key_version(row.recipient_key_version)?,
            decode_base64url(
                row.recipient_encryption_public_key,
                "recipient X25519 public key",
            )?,
            decode_base64url(
                row.recipient_signing_public_key,
                "recipient Ed25519 public key",
            )?,
            decode_lower_hex(row.recipient_fingerprint, "recipient fingerprint")?,
        )?;
        let org_id = parse_canonical_uuid(row.org_id)?;
        let checkpoint_id = parse_canonical_uuid(row.checkpoint_id)?;
        if org_id.is_nil() || checkpoint_id.is_nil() {
            return Err(ContinuationCryptoError::InvalidEnvelope(
                "receipt routing UUIDs must be non-nil",
            ));
        }
        Ok(Self {
            org_id,
            checkpoint_id,
            recipient: CloudRecipient::try_new(
                parse_canonical_uuid(row.recipient_user_id)?,
                identity,
            )?,
        })
    }

    pub fn recipient(&self) -> &CloudRecipient {
        &self.recipient
    }

    pub fn org_id(&self) -> Uuid {
        self.org_id
    }

    pub fn checkpoint_id(&self) -> Uuid {
        self.checkpoint_id
    }
}

impl CommittedCloudEnvelope {
    pub fn from_cloud_artifact(artifact: &EnvelopeArtifact<CloudProfile>) -> Self {
        Self {
            header: artifact.header.clone(),
            canonical_header: artifact.canonical_header.clone(),
            signature: artifact.signature,
            object_size: artifact.object_size,
            object_sha256: artifact.object_sha256,
        }
    }

    pub fn header(&self) -> &ContinuationEnvelopeHeader {
        &self.header
    }
    pub fn canonical_header(&self) -> &[u8] {
        &self.canonical_header
    }
    pub fn signature(&self) -> &[u8; 64] {
        &self.signature
    }
    pub fn object_size(&self) -> u64 {
        self.object_size
    }
    pub fn object_sha256(&self) -> &[u8; 32] {
        &self.object_sha256
    }

    pub fn try_from_sql(
        row: CommittedCloudEnvelopeSql<'_>,
        validation_now_unix_ms: u64,
    ) -> Result<Self, ContinuationCryptoError> {
        let object_size = positive_sql_i64(row.object_size, "object size")?;
        if object_size > CLOUD_CHECKPOINT_LIMITS.max_envelope_bytes {
            return Err(ContinuationCryptoError::limit(
                LimitKind::EnvelopeBytes,
                CLOUD_CHECKPOINT_LIMITS.max_envelope_bytes,
                object_size,
            ));
        }
        let age_ciphertext_len = positive_sql_i64(row.age_ciphertext_len, "age ciphertext length")?;
        let object_sha256 = decode_lower_hex::<32>(row.object_sha256, "object SHA-256")?;
        let age_ciphertext_sha256 =
            decode_lower_hex::<32>(row.age_ciphertext_sha256, "age ciphertext SHA-256")?;
        let signature = decode_base64url::<64>(row.footer_signature, "footer signature")?;
        let sender = DevicePublicIdentity::try_new(
            parse_canonical_uuid(row.sender_device_id)?,
            positive_sql_key_version(row.sender_key_version)?,
            decode_base64url(row.sender_encryption_public_key, "sender X25519 public key")?,
            decode_base64url(row.sender_signing_public_key, "sender Ed25519 public key")?,
            decode_lower_hex(row.sender_fingerprint, "sender fingerprint")?,
        )?;
        let recipient_count = u16::try_from(row.recipient_count)
            .ok()
            .filter(|value| (1..=64).contains(value))
            .ok_or(ContinuationCryptoError::InvalidEnvelope(
                "recipient count must be between one and 64",
            ))?;
        let recipient_set_sha256 =
            decode_lower_hex::<32>(row.recipient_set_sha256, "recipient set SHA-256")?;
        let header = decode_canonical_header(row.canonical_header)?;
        if header.org_id != parse_canonical_uuid(row.org_id)?
            || header.checkpoint_id != parse_canonical_uuid(row.checkpoint_id)?
            || header.root_session_id != row.root_session_id
            || header.source_episode_id != row.source_episode_id
            || header.source_runtime != row.source_runtime
            || header.payload_schema != row.payload_schema
            || i32::from(header.payload_schema_version) != row.payload_schema_version
            || header.recipient_scope != parse_recipient_scope(row.recipient_scope)?
            || header.sender_user_id != parse_canonical_uuid(row.sender_user_id)?
            || header.created_at_unix_ms != row.client_created_at_unix_ms
            || header.expires_at_unix_ms != row.expires_at_unix_ms
            || header.sender != sender
            || header.recipients.as_slice().len() != recipient_count as usize
            || header.recipient_set_sha256 != recipient_set_sha256
            || header.age_ciphertext_len != age_ciphertext_len
            || header.age_ciphertext_sha256 != age_ciphertext_sha256
        {
            return Err(ContinuationCryptoError::CloudMetadataMismatch(
                "committed SQL fields",
            ));
        }
        if header.created_at_unix_ms
            > validation_now_unix_ms.saturating_add(MAX_CREATED_AT_FUTURE_SKEW_MS)
            || header.expires_at_unix_ms <= validation_now_unix_ms
        {
            return Err(ContinuationCryptoError::CloudMetadataMismatch(
                "committed SQL timestamps",
            ));
        }
        let expected_object_size = (PREFIX_BYTES as u64)
            .checked_add(row.canonical_header.len() as u64)
            .and_then(|value| value.checked_add(age_ciphertext_len))
            .and_then(|value| value.checked_add(SUFFIX_BYTES as u64))
            .ok_or(ContinuationCryptoError::InvalidEnvelope(
                "committed object size overflow",
            ))?;
        if object_size != expected_object_size {
            return Err(ContinuationCryptoError::CloudMetadataMismatch(
                "object and age lengths",
            ));
        }
        Ok(Self {
            header,
            canonical_header: row.canonical_header.to_vec(),
            signature,
            object_size,
            object_sha256,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedEnvelope<P: EnvelopeProfile> {
    artifact: EnvelopeArtifact<P>,
    pub manifest: CheckpointManifest,
    pub footer: CheckpointFooter,
}

impl<P: EnvelopeProfile> VerifiedEnvelope<P> {
    pub fn artifact(&self) -> &EnvelopeArtifact<P> {
        &self.artifact
    }
}

fn parse_canonical_uuid(value: &str) -> Result<Uuid, ContinuationCryptoError> {
    let parsed = Uuid::parse_str(value)
        .map_err(|_| ContinuationCryptoError::InvalidEnvelope("invalid canonical UUID"))?;
    if parsed.to_string() != value {
        return Err(ContinuationCryptoError::InvalidEnvelope(
            "UUID must be lowercase canonical hyphenated text",
        ));
    }
    Ok(parsed)
}

fn positive_sql_i64(value: i64, label: &'static str) -> Result<u64, ContinuationCryptoError> {
    u64::try_from(value)
        .ok()
        .filter(|value| *value > 0)
        .ok_or(ContinuationCryptoError::InvalidEnvelope(label))
}

fn positive_sql_key_version(value: i32) -> Result<u32, ContinuationCryptoError> {
    u32::try_from(value).ok().filter(|value| *value > 0).ok_or(
        ContinuationCryptoError::InvalidIdentity("key version must be in positive SQL int range"),
    )
}

fn parse_recipient_scope(value: &str) -> Result<RecipientScope, ContinuationCryptoError> {
    match value {
        "audience" => Ok(RecipientScope::Audience),
        "subset" => Ok(RecipientScope::Subset),
        _ => Err(ContinuationCryptoError::InvalidEnvelope(
            "recipient scope must be audience or subset",
        )),
    }
}

fn decode_lower_hex<const N: usize>(
    value: &str,
    label: &'static str,
) -> Result<[u8; N], ContinuationCryptoError> {
    if value.len() != N * 2
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(ContinuationCryptoError::InvalidEnvelope(label));
    }
    hex::decode(value)
        .map_err(|_| ContinuationCryptoError::InvalidEnvelope(label))?
        .try_into()
        .map_err(|_| ContinuationCryptoError::InvalidEnvelope(label))
}

fn decode_base64url<const N: usize>(
    value: &str,
    label: &'static str,
) -> Result<[u8; N], ContinuationCryptoError> {
    let decoded = Zeroizing::new(
        URL_SAFE_NO_PAD
            .decode(value)
            .map_err(|_| ContinuationCryptoError::InvalidEnvelope(label))?,
    );
    if URL_SAFE_NO_PAD.encode(decoded.as_slice()) != value {
        return Err(ContinuationCryptoError::InvalidEnvelope(label));
    }
    decoded
        .as_slice()
        .try_into()
        .map_err(|_| ContinuationCryptoError::InvalidEnvelope(label))
}

fn placeholder_identity(device_id: Uuid) -> DevicePublicIdentity {
    // Only used to reuse the canonical header validator for route metadata.
    // These fixed keys are valid X25519/Ed25519 public encodings.
    let encryption = [1u8; 32];
    let signing = ed25519_dalek::SigningKey::from_bytes(&[1u8; 32])
        .verifying_key()
        .to_bytes();
    DevicePublicIdentity::try_new(
        device_id,
        1,
        encryption,
        signing,
        crate::device_fingerprint(&encryption, &signing),
    )
    .expect("fixed placeholder identity is valid")
}

/// Write a checkpoint without ever materializing plaintext on disk.
///
/// The sibling staging file is owner-only from creation, contains only the
/// public envelope prefix plus age ciphertext, is fsynced, and is atomically
/// published without clobbering an existing checkpoint object.
#[cfg(test)]
pub(crate) fn write_local_checkpoint_atomic<F>(
    destination: &Path,
    staging: &PrivateStagingDirectory,
    job_id: &str,
    request: LocalEnvelopeWriteRequest<'_>,
    write_records: F,
) -> Result<EnvelopeArtifact<LocalProfile>, ContinuationCryptoError>
where
    F: FnOnce(&mut dyn CheckpointRecordWriter) -> Result<(), ContinuationCryptoError>,
{
    write_checkpoint_atomic_impl::<LocalProfile, _>(
        destination,
        staging,
        job_id,
        EnvelopeWriteRequest {
            metadata: request.metadata,
            sender: request.sender,
            recipients: request.recipients,
            manifest: request.manifest,
            limits: request.limits,
        },
        write_records,
    )
}

/// Cloud-safe writer with a non-overridable 16 MiB complete-object ceiling.
///
/// The explicitly local writer is for offline artifacts. Code that uploads an
/// artifact must call this entry point so the 512 MiB local defaults cannot
/// leak into the Cloud object plane.
pub fn write_cloud_checkpoint_atomic<F>(
    destination: &Path,
    staging: &PrivateStagingDirectory,
    job_id: &str,
    request: CloudEnvelopeWriteRequest<'_>,
    write_records: F,
) -> Result<EnvelopeArtifact<CloudProfile>, ContinuationCryptoError>
where
    F: FnOnce(&mut dyn CheckpointRecordWriter) -> Result<(), ContinuationCryptoError>,
{
    write_checkpoint_atomic_impl::<CloudProfile, _>(
        destination,
        staging,
        job_id,
        EnvelopeWriteRequest {
            metadata: request.metadata,
            sender: request.sender,
            recipients: request.recipients,
            manifest: request.manifest,
            limits: CLOUD_CHECKPOINT_LIMITS,
        },
        write_records,
    )
}

fn write_checkpoint_atomic_impl<P, F>(
    destination: &Path,
    staging: &PrivateStagingDirectory,
    job_id: &str,
    request: EnvelopeWriteRequest<'_>,
    write_records: F,
) -> Result<EnvelopeArtifact<P>, ContinuationCryptoError>
where
    P: EnvelopeProfile,
    F: FnOnce(&mut dyn CheckpointRecordWriter) -> Result<(), ContinuationCryptoError>,
{
    if request.manifest.schema_id != request.metadata.payload_schema
        || request.manifest.schema_version != request.metadata.payload_schema_version
    {
        return Err(ContinuationCryptoError::InvalidEnvelope(
            "manifest schema does not match signed payload schema",
        ));
    }
    let sender = request.sender.public_identity()?;
    let mut header = request.metadata.header_with_identities(
        sender,
        request.recipients.clone(),
        [0; 32],
        // A positive fixed-width placeholder keeps header validation and
        // canonical byte length stable until age finishes streaming.
        1,
    );
    let placeholder_header = canonical_header_bytes(&header)?;
    let header_len = u32::try_from(placeholder_header.len())
        .map_err(|_| ContinuationCryptoError::InvalidEnvelope("header length overflow"))?;
    let fixed_object_bytes = (PREFIX_BYTES as u64)
        .checked_add(placeholder_header.len() as u64)
        .and_then(|value| value.checked_add(SUFFIX_BYTES as u64))
        .ok_or(ContinuationCryptoError::InvalidEnvelope(
            "envelope length overflow",
        ))?;
    let minimum_object_bytes =
        fixed_object_bytes
            .checked_add(1)
            .ok_or(ContinuationCryptoError::InvalidEnvelope(
                "envelope length overflow",
            ))?;
    if minimum_object_bytes > request.limits.max_envelope_bytes {
        return Err(ContinuationCryptoError::limit(
            LimitKind::EnvelopeBytes,
            request.limits.max_envelope_bytes,
            minimum_object_bytes,
        ));
    }
    let max_ciphertext_for_object = request.limits.max_envelope_bytes - fixed_object_bytes;
    let ciphertext_write_limit = request
        .limits
        .max_ciphertext_bytes
        .min(max_ciphertext_for_object);
    let ciphertext_limit_kind = if max_ciphertext_for_object <= request.limits.max_ciphertext_bytes
    {
        LimitKind::EnvelopeBytes
    } else {
        LimitKind::CiphertextBytes
    };
    let ciphertext_limit_hit = Rc::new(Cell::new(false));
    let mut atomic = AtomicCiphertextFile::create(staging, job_id, destination)?;

    let encryption_result: Result<(u64, [u8; 32]), ContinuationCryptoError> = (|| {
        let file = atomic.file_mut();
        file.write_all(ENVELOPE_MAGIC)
            .map_err(|error| ContinuationCryptoError::io("writing envelope magic", error))?;
        file.write_all(&ENVELOPE_VERSION.to_be_bytes())
            .map_err(|error| ContinuationCryptoError::io("writing envelope version", error))?;
        file.write_all(&header_len.to_be_bytes()).map_err(|error| {
            ContinuationCryptoError::io("writing envelope header length", error)
        })?;
        file.write_all(&placeholder_header)
            .map_err(|error| ContinuationCryptoError::io("writing envelope header", error))?;

        let age_recipients = request
            .recipients
            .as_slice()
            .iter()
            .map(|recipient| age_recipient_from_raw(&recipient.identity().encryption_public_key))
            .collect::<Result<Vec<_>, _>>()?;
        let encryptor = Encryptor::with_recipients(
            age_recipients
                .iter()
                .map(|recipient| recipient as &dyn age::Recipient),
        )
        .map_err(|error| ContinuationCryptoError::AgeEncrypt(error.to_string()))?;
        let ciphertext_writer = HashingWriter::new(
            file,
            ciphertext_write_limit,
            Rc::clone(&ciphertext_limit_hit),
        );
        let age_writer = encryptor
            .wrap_output(ciphertext_writer)
            .map_err(|error| ContinuationCryptoError::AgeEncrypt(error.to_string()))?;
        let gzip_writer = GzEncoder::new(age_writer, Compression::new(6));
        let mut frame_writer =
            CheckpointStreamWriter::new(gzip_writer, request.manifest, request.limits)?;
        write_records(&mut frame_writer)?;
        let gzip_writer = frame_writer.finish()?;
        let age_writer = gzip_writer
            .finish()
            .map_err(|error| ContinuationCryptoError::InvalidCompression(error.to_string()))?;
        let ciphertext_writer = age_writer
            .finish()
            .map_err(|error| ContinuationCryptoError::AgeEncrypt(error.to_string()))?;
        let (_file, ciphertext_len, ciphertext_sha256) = ciphertext_writer.finish();
        Ok((ciphertext_len, ciphertext_sha256))
    })();
    if ciphertext_limit_hit.get() {
        let (limit, actual) = if ciphertext_limit_kind == LimitKind::EnvelopeBytes {
            (
                request.limits.max_envelope_bytes,
                request.limits.max_envelope_bytes.saturating_add(1),
            )
        } else {
            (
                request.limits.max_ciphertext_bytes,
                request.limits.max_ciphertext_bytes.saturating_add(1),
            )
        };
        return Err(ContinuationCryptoError::limit(
            ciphertext_limit_kind,
            limit,
            actual,
        ));
    }
    let (age_ciphertext_len, age_ciphertext_sha256) = encryption_result?;

    if age_ciphertext_len > request.limits.max_ciphertext_bytes {
        return Err(ContinuationCryptoError::limit(
            LimitKind::CiphertextBytes,
            request.limits.max_ciphertext_bytes,
            age_ciphertext_len,
        ));
    }
    header.age_ciphertext_len = age_ciphertext_len;
    header.age_ciphertext_sha256 = age_ciphertext_sha256;
    let raw_header = canonical_header_bytes(&header)?;
    if raw_header.len() != placeholder_header.len() {
        return Err(ContinuationCryptoError::InvalidEnvelope(
            "patched header changed canonical length",
        ));
    }
    let signature = request
        .sender
        .sign(&signature_message(&raw_header, &age_ciphertext_sha256)?);
    let expected_object_size = (PREFIX_BYTES as u64)
        .checked_add(raw_header.len() as u64)
        .and_then(|value| value.checked_add(age_ciphertext_len))
        .and_then(|value| value.checked_add(SUFFIX_BYTES as u64))
        .ok_or(ContinuationCryptoError::InvalidEnvelope(
            "envelope length overflow",
        ))?;
    if expected_object_size > request.limits.max_envelope_bytes {
        return Err(ContinuationCryptoError::limit(
            LimitKind::EnvelopeBytes,
            request.limits.max_envelope_bytes,
            expected_object_size,
        ));
    }
    {
        let file = atomic.file_mut();
        file.seek(SeekFrom::Start(PREFIX_BYTES as u64))
            .map_err(|error| ContinuationCryptoError::io("seeking to envelope header", error))?;
        file.write_all(&raw_header)
            .map_err(|error| ContinuationCryptoError::io("patching envelope header", error))?;
        let suffix_offset = (PREFIX_BYTES as u64)
            .checked_add(raw_header.len() as u64)
            .and_then(|value| value.checked_add(age_ciphertext_len))
            .ok_or(ContinuationCryptoError::InvalidEnvelope(
                "envelope length overflow",
            ))?;
        file.seek(SeekFrom::Start(suffix_offset))
            .map_err(|error| ContinuationCryptoError::io("seeking to envelope signature", error))?;
        file.write_all(&signature)
            .map_err(|error| ContinuationCryptoError::io("writing envelope signature", error))?;
        file.write_all(ENVELOPE_END_MAGIC)
            .map_err(|error| ContinuationCryptoError::io("writing envelope footer magic", error))?;
    }
    let (object_size, object_sha256) = hash_complete_object(atomic.file_mut())?;
    if object_size != expected_object_size {
        return Err(ContinuationCryptoError::InvalidEnvelope(
            "written envelope size does not match its canonical layout",
        ));
    }
    atomic.publish(object_size, &object_sha256)?;
    Ok(EnvelopeArtifact {
        header,
        canonical_header: raw_header,
        signature,
        object_size,
        object_sha256,
        profile: PhantomData,
    })
}

/// Verify the public envelope before invoking age, then decrypt and parse its
/// bounded inner stream into the supplied sink.
#[cfg(test)]
pub(crate) fn decrypt_local_checkpoint(
    source: &Path,
    staging: &PrivateStagingDirectory,
    trusted_sender: &DevicePublicIdentity,
    recipient: &DevicePrivateIdentity,
    now_unix_ms: u64,
    limits: CheckpointLimits,
    sink: &mut dyn CheckpointSink,
) -> Result<VerifiedEnvelope<LocalProfile>, ContinuationCryptoError> {
    let context = DecryptContext {
        expected: None,
        receipt: None,
        trusted_sender,
        recipient,
        now_unix_ms,
        limits,
    };
    decrypt_checkpoint_impl::<LocalProfile, _>(source, staging, &context, sink, || {})
}

/// Verify and decrypt an object obtained from ORG2 Cloud.
///
/// Unlike the local entry point, this always applies the 16 MiB full-object
/// preset and requires the committed row's full-object digest, exact opaque
/// header, and exact footer/RPC signature to match before decryption.
pub fn decrypt_cloud_checkpoint(
    source: &Path,
    staging: &PrivateStagingDirectory,
    request: CloudCheckpointDecryptRequest<'_>,
    sink: &mut dyn CheckpointSink,
) -> Result<VerifiedEnvelope<CloudProfile>, ContinuationCryptoError> {
    let context = DecryptContext {
        expected: Some(request.expected),
        receipt: Some(request.receipt),
        trusted_sender: request.trusted_sender,
        recipient: request.recipient,
        now_unix_ms: request.now_unix_ms,
        limits: CLOUD_CHECKPOINT_LIMITS,
    };
    decrypt_checkpoint_impl::<CloudProfile, _>(source, staging, &context, sink, || {})
}

#[derive(Clone, Copy)]
struct DecryptContext<'a> {
    expected: Option<&'a CommittedCloudEnvelope>,
    receipt: Option<&'a CommittedRecipientReceipt>,
    trusted_sender: &'a DevicePublicIdentity,
    recipient: &'a DevicePrivateIdentity,
    now_unix_ms: u64,
    limits: CheckpointLimits,
}

fn decrypt_checkpoint_impl<P, H>(
    source: &Path,
    staging: &PrivateStagingDirectory,
    context: &DecryptContext<'_>,
    sink: &mut dyn CheckpointSink,
    after_verified_snapshot: H,
) -> Result<VerifiedEnvelope<P>, ContinuationCryptoError>
where
    P: EnvelopeProfile,
    H: FnOnce(),
{
    let mut verified = verify_outer_envelope::<P>(source, staging, context)?;
    after_verified_snapshot();
    verified
        .snapshot
        .seek(SeekFrom::Start(verified.ciphertext_offset))
        .map_err(|error| ContinuationCryptoError::io("seeking to age ciphertext", error))?;
    let ciphertext = (&mut verified.snapshot).take(verified.artifact.header.age_ciphertext_len);
    let decryptor = Decryptor::new(BufReader::new(ciphertext))
        .map_err(|error| ContinuationCryptoError::AgeDecrypt(error.to_string()))?;
    let age_identity = context.recipient.age_identity()?;
    let decrypted = decryptor
        .decrypt(std::iter::once(&age_identity as &dyn age::Identity))
        .map_err(|error| ContinuationCryptoError::AgeDecrypt(error.to_string()))?;
    // MultiGzDecoder consumes all members and rejects trailing non-gzip bytes;
    // the framed reader independently caps every frame and total output.
    let gzip = MultiGzDecoder::new(decrypted);
    sink.begin_transaction()?;
    match read_checkpoint_stream(gzip, context.limits, sink) {
        Ok((manifest, footer)) => {
            if manifest.schema_id != verified.artifact.header.payload_schema
                || manifest.schema_version
                    != verified.artifact.header.payload_schema_version
            {
                sink.abort_transaction();
                return Err(ContinuationCryptoError::InvalidEnvelope(
                    "decrypted manifest schema does not match signed payload schema",
                ));
            }
            if let Err(error) = sink.commit_transaction() {
                sink.abort_transaction();
                return Err(error);
            }
            Ok(VerifiedEnvelope {
                artifact: verified.artifact,
                manifest,
                footer,
            })
        }
        Err(error) => {
            sink.abort_transaction();
            Err(error)
        }
    }
}

struct VerifiedOuter<P: EnvelopeProfile> {
    artifact: EnvelopeArtifact<P>,
    ciphertext_offset: u64,
    snapshot: File,
}

fn verify_outer_envelope<P: EnvelopeProfile>(
    source: &Path,
    staging: &PrivateStagingDirectory,
    context: &DecryptContext<'_>,
) -> Result<VerifiedOuter<P>, ContinuationCryptoError> {
    let DecryptContext {
        expected,
        receipt,
        trusted_sender,
        recipient,
        now_unix_ms,
        limits,
    } = *context;
    trusted_sender.validate()?;
    let (mut snapshot, object_size, object_sha256) =
        copy_source_to_snapshot(source, staging, limits.max_envelope_bytes)?;
    if expected.is_some_and(|value| object_size != value.object_size) {
        return Err(ContinuationCryptoError::ObjectHashMismatch);
    }
    if expected.is_some_and(|value| object_sha256 != value.object_sha256) {
        return Err(ContinuationCryptoError::ObjectHashMismatch);
    }
    let mut prefix = [0u8; PREFIX_BYTES];
    snapshot
        .read_exact(&mut prefix)
        .map_err(|error| ContinuationCryptoError::io("reading envelope prefix", error))?;
    if &prefix[..ENVELOPE_MAGIC.len()] != ENVELOPE_MAGIC {
        return Err(ContinuationCryptoError::InvalidEnvelope(
            "bad envelope magic",
        ));
    }
    let version = u16::from_be_bytes(
        prefix[ENVELOPE_MAGIC.len()..ENVELOPE_MAGIC.len() + 2]
            .try_into()
            .map_err(|_| ContinuationCryptoError::InvalidEnvelope("truncated version"))?,
    );
    if version != ENVELOPE_VERSION {
        return Err(ContinuationCryptoError::UnsupportedEnvelopeVersion(version));
    }
    let header_len = u32::from_be_bytes(
        prefix[ENVELOPE_MAGIC.len() + 2..PREFIX_BYTES]
            .try_into()
            .map_err(|_| ContinuationCryptoError::InvalidEnvelope("truncated header length"))?,
    ) as usize;
    if header_len == 0 || header_len > MAX_CANONICAL_HEADER_BYTES {
        return Err(ContinuationCryptoError::limit(
            LimitKind::HeaderBytes,
            MAX_CANONICAL_HEADER_BYTES as u64,
            header_len as u64,
        ));
    }
    let mut raw_header = vec![0u8; header_len];
    snapshot
        .read_exact(&mut raw_header)
        .map_err(|error| ContinuationCryptoError::io("reading canonical header", error))?;
    let header = decode_canonical_header(&raw_header)?;
    if expected.is_some_and(|value| value.canonical_header.as_slice() != raw_header) {
        return Err(ContinuationCryptoError::CloudMetadataMismatch(
            "canonical header",
        ));
    }
    if header.sender != *trusted_sender {
        return Err(ContinuationCryptoError::UntrustedSender);
    }
    if expected.is_some_and(|value| value.header != header) {
        return Err(ContinuationCryptoError::CloudMetadataMismatch(
            "signed routing or key snapshot fields",
        ));
    }
    if header.age_ciphertext_len > limits.max_ciphertext_bytes {
        return Err(ContinuationCryptoError::limit(
            LimitKind::CiphertextBytes,
            limits.max_ciphertext_bytes,
            header.age_ciphertext_len,
        ));
    }
    let expected_len = (PREFIX_BYTES as u64)
        .checked_add(header_len as u64)
        .and_then(|value| value.checked_add(header.age_ciphertext_len))
        .and_then(|value| value.checked_add(SUFFIX_BYTES as u64))
        .ok_or(ContinuationCryptoError::InvalidEnvelope(
            "envelope length overflow",
        ))?;
    if object_size != expected_len {
        return Err(ContinuationCryptoError::InvalidEnvelope(
            "envelope file length does not match header",
        ));
    }
    let ciphertext_offset = (PREFIX_BYTES + header_len) as u64;
    let mut remaining = header.age_ciphertext_len;
    let mut age_ciphertext_digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    while remaining > 0 {
        let requested = usize::try_from(remaining.min(buffer.len() as u64))
            .map_err(|_| ContinuationCryptoError::InvalidEnvelope("read size overflow"))?;
        snapshot
            .read_exact(&mut buffer[..requested])
            .map_err(|error| ContinuationCryptoError::io("hashing age ciphertext", error))?;
        let chunk = &buffer[..requested];
        age_ciphertext_digest.update(chunk);
        remaining -= requested as u64;
    }
    let age_ciphertext_sha256: [u8; 32] = age_ciphertext_digest.finalize().into();
    if age_ciphertext_sha256 != header.age_ciphertext_sha256 {
        return Err(ContinuationCryptoError::CiphertextHashMismatch);
    }
    let mut signature = [0u8; SIGNATURE_BYTES];
    snapshot
        .read_exact(&mut signature)
        .map_err(|error| ContinuationCryptoError::io("reading envelope signature", error))?;
    if expected.is_some_and(|value| value.signature != signature) {
        return Err(ContinuationCryptoError::CloudMetadataMismatch("signature"));
    }
    let mut end_magic = [0u8; 8];
    snapshot
        .read_exact(&mut end_magic)
        .map_err(|error| ContinuationCryptoError::io("reading envelope end marker", error))?;
    if &end_magic != ENVELOPE_END_MAGIC {
        return Err(ContinuationCryptoError::InvalidEnvelope(
            "bad envelope end marker",
        ));
    }
    verify_signature(
        trusted_sender,
        &signature_message(&raw_header, &age_ciphertext_sha256)?,
        &signature,
    )?;
    let own_public = recipient.public_identity()?;
    if let Some(receipt) = receipt {
        if receipt.org_id != header.org_id || receipt.checkpoint_id != header.checkpoint_id {
            return Err(ContinuationCryptoError::CloudMetadataMismatch(
                "recipient receipt routing",
            ));
        }
        if !header
            .recipients
            .as_slice()
            .iter()
            .any(|entry| entry == &receipt.recipient)
        {
            return Err(ContinuationCryptoError::CloudMetadataMismatch(
                "recipient receipt snapshot",
            ));
        }
        recipient.verify_own_public(receipt.recipient.identity())?;
    } else if !header
        .recipients
        .as_slice()
        .iter()
        .any(|entry| entry.identity() == &own_public)
    {
        return Err(ContinuationCryptoError::WrongRecipient);
    }
    if header.created_at_unix_ms > now_unix_ms.saturating_add(MAX_CREATED_AT_FUTURE_SKEW_MS) {
        return Err(ContinuationCryptoError::CreatedInFuture);
    }
    if header.expires_at_unix_ms <= now_unix_ms {
        return Err(ContinuationCryptoError::Expired(header.expires_at_unix_ms));
    }
    Ok(VerifiedOuter {
        artifact: EnvelopeArtifact {
            header,
            canonical_header: raw_header,
            signature,
            object_size,
            object_sha256,
            profile: PhantomData,
        },
        ciphertext_offset,
        snapshot,
    })
}

fn copy_source_to_snapshot(
    source: &Path,
    staging: &PrivateStagingDirectory,
    max_bytes: u64,
) -> Result<(File, u64, [u8; 32]), ContinuationCryptoError> {
    let mut source_file = File::open(source)
        .map_err(|error| ContinuationCryptoError::io("opening continuation envelope", error))?;
    let mut snapshot = staging.anonymous_ciphertext()?;
    let mut digest = Sha256::new();
    let mut object_size = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = source_file
            .read(&mut buffer)
            .map_err(|error| ContinuationCryptoError::io("snapshotting ciphertext", error))?;
        if read == 0 {
            break;
        }
        let next = object_size.checked_add(read as u64).ok_or(
            ContinuationCryptoError::InvalidEnvelope("snapshot length overflow"),
        )?;
        if next > max_bytes {
            return Err(ContinuationCryptoError::limit(
                LimitKind::EnvelopeBytes,
                max_bytes,
                next,
            ));
        }
        let chunk = &buffer[..read];
        snapshot
            .write_all(chunk)
            .map_err(|error| ContinuationCryptoError::io("writing ciphertext snapshot", error))?;
        digest.update(chunk);
        object_size = next;
    }
    snapshot
        .flush()
        .map_err(|error| ContinuationCryptoError::io("flushing ciphertext snapshot", error))?;
    snapshot
        .seek(SeekFrom::Start(0))
        .map_err(|error| ContinuationCryptoError::io("rewinding ciphertext snapshot", error))?;
    Ok((snapshot, object_size, digest.finalize().into()))
}

#[cfg(test)]
#[allow(clippy::too_many_arguments)]
pub(crate) fn decrypt_local_checkpoint_with_hook<H>(
    source: &Path,
    staging: &PrivateStagingDirectory,
    trusted_sender: &DevicePublicIdentity,
    recipient: &DevicePrivateIdentity,
    now_unix_ms: u64,
    limits: CheckpointLimits,
    sink: &mut dyn CheckpointSink,
    after_verified_snapshot: H,
) -> Result<VerifiedEnvelope<LocalProfile>, ContinuationCryptoError>
where
    H: FnOnce(),
{
    let context = DecryptContext {
        expected: None,
        receipt: None,
        trusted_sender,
        recipient,
        now_unix_ms,
        limits,
    };
    decrypt_checkpoint_impl::<LocalProfile, _>(
        source,
        staging,
        &context,
        sink,
        after_verified_snapshot,
    )
}

struct HashingWriter<W> {
    inner: W,
    digest: Sha256,
    bytes_written: u64,
    max_bytes: u64,
    limit_hit: Rc<Cell<bool>>,
}

fn hash_complete_object(file: &mut File) -> Result<(u64, [u8; 32]), ContinuationCryptoError> {
    file.flush()
        .map_err(|error| ContinuationCryptoError::io("flushing envelope before hashing", error))?;
    file.seek(SeekFrom::Start(0))
        .map_err(|error| ContinuationCryptoError::io("rewinding envelope for hashing", error))?;
    let mut digest = Sha256::new();
    let mut size = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| ContinuationCryptoError::io("hashing complete envelope", error))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
        size = size
            .checked_add(read as u64)
            .ok_or(ContinuationCryptoError::InvalidEnvelope(
                "full object length overflow",
            ))?;
    }
    Ok((size, digest.finalize().into()))
}

impl<W> HashingWriter<W> {
    fn new(inner: W, max_bytes: u64, limit_hit: Rc<Cell<bool>>) -> Self {
        Self {
            inner,
            digest: Sha256::new(),
            bytes_written: 0,
            max_bytes,
            limit_hit,
        }
    }

    fn finish(self) -> (W, u64, [u8; 32]) {
        (
            self.inner,
            self.bytes_written,
            self.digest.finalize().into(),
        )
    }
}

impl<W: Write> Write for HashingWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let requested_end = self
            .bytes_written
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| std::io::Error::other("ciphertext length overflow"))?;
        if requested_end > self.max_bytes {
            self.limit_hit.set(true);
            return Err(std::io::Error::new(
                std::io::ErrorKind::FileTooLarge,
                "ciphertext byte limit exceeded",
            ));
        }
        let written = self.inner.write(bytes)?;
        self.digest.update(&bytes[..written]);
        self.bytes_written = self
            .bytes_written
            .checked_add(written as u64)
            .ok_or_else(|| std::io::Error::other("ciphertext length overflow"))?;
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}
