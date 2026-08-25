use std::{cmp::Ordering, collections::HashSet};

use crate::{ContinuationCryptoError, DevicePublicIdentity, LimitKind};
use uuid::Uuid;

pub const ENVELOPE_MAGIC: &[u8; 8] = b"ORG2HND\0";
pub const ENVELOPE_VERSION: u16 = 1;
pub const SIGNATURE_DOMAIN: &[u8] = b"ORG2-CONTINUATION-ENVELOPE-SIGNATURE-V1";
pub const ENVELOPE_END_MAGIC: &[u8; 8] = b"ORG2END\0";
pub const MAX_CANONICAL_HEADER_BYTES: usize = 16 * 1024;
pub const MAX_CONVERSATION_ID_BYTES: usize = 200;
pub const MAX_RUNTIME_ID_BYTES: usize = 64;
pub const MAX_PAYLOAD_SCHEMA_ID_BYTES: usize = 128;
pub const MAX_ENVELOPE_RECIPIENTS: usize = 64;
pub const RECIPIENT_SET_HASH_DOMAIN: &[u8] = b"ORG2-CONTINUATION-RECIPIENT-SET-V1";
pub const MIN_ENVELOPE_TTL_MS: u64 = 5 * 60 * 1_000;
pub const MAX_ENVELOPE_TTL_MS: u64 = 7 * 24 * 60 * 60 * 1_000;
pub const MAX_CREATED_AT_FUTURE_SKEW_MS: u64 = 5 * 60 * 1_000;
pub const SIGNATURE_BYTES: usize = 64;
pub const PREFIX_BYTES: usize = ENVELOPE_MAGIC.len() + 2 + 4;
pub const SUFFIX_BYTES: usize = SIGNATURE_BYTES + ENVELOPE_END_MAGIC.len();

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum EncryptionAlgorithm {
    AgeX25519 = 1,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum SignatureAlgorithm {
    Ed25519 = 1,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum CompressionAlgorithm {
    Gzip = 1,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum HashAlgorithm {
    Sha256 = 1,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum RecipientScope {
    Audience = 1,
    Subset = 2,
}

impl TryFrom<u8> for RecipientScope {
    type Error = ContinuationCryptoError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            1 => Ok(Self::Audience),
            2 => Ok(Self::Subset),
            _ => Err(ContinuationCryptoError::UnsupportedAlgorithm {
                kind: "recipient scope",
                value,
            }),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CloudRecipient {
    recipient_user_id: Uuid,
    identity: DevicePublicIdentity,
}

impl CloudRecipient {
    pub fn try_new(
        recipient_user_id: Uuid,
        identity: DevicePublicIdentity,
    ) -> Result<Self, ContinuationCryptoError> {
        if recipient_user_id.is_nil() {
            return Err(ContinuationCryptoError::InvalidEnvelope(
                "recipient user UUID must be non-nil",
            ));
        }
        identity.validate()?;
        Ok(Self {
            recipient_user_id,
            identity,
        })
    }

    pub fn recipient_user_id(&self) -> Uuid {
        self.recipient_user_id
    }

    pub fn identity(&self) -> &DevicePublicIdentity {
        &self.identity
    }

    fn canonical_cmp(&self, other: &Self) -> Ordering {
        self.recipient_user_id
            .as_bytes()
            .cmp(other.recipient_user_id.as_bytes())
            .then_with(|| {
                self.identity
                    .device_id
                    .as_bytes()
                    .cmp(other.identity.device_id.as_bytes())
            })
            .then_with(|| self.identity.key_version.cmp(&other.identity.key_version))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CloudRecipientSet(Vec<CloudRecipient>);

impl CloudRecipientSet {
    pub fn try_new(mut recipients: Vec<CloudRecipient>) -> Result<Self, ContinuationCryptoError> {
        recipients.sort_by(CloudRecipient::canonical_cmp);
        Self::validate_entries(&recipients, false)?;
        Ok(Self(recipients))
    }

    pub fn as_slice(&self) -> &[CloudRecipient] {
        &self.0
    }

    pub fn sha256(&self) -> [u8; 32] {
        use sha2::{Digest, Sha256};

        let mut digest = Sha256::new();
        digest.update(RECIPIENT_SET_HASH_DOMAIN);
        digest.update([0]);
        digest.update((self.0.len() as u16).to_be_bytes());
        for recipient in &self.0 {
            digest.update(recipient.recipient_user_id.as_bytes());
            digest.update(recipient.identity.device_id.as_bytes());
            digest.update(recipient.identity.key_version.to_be_bytes());
            digest.update(recipient.identity.encryption_public_key);
            digest.update(recipient.identity.signing_public_key);
            digest.update(recipient.identity.fingerprint);
        }
        digest.finalize().into()
    }

    fn from_canonical(recipients: Vec<CloudRecipient>) -> Result<Self, ContinuationCryptoError> {
        Self::validate_entries(&recipients, true)?;
        Ok(Self(recipients))
    }

    fn validate_entries(
        recipients: &[CloudRecipient],
        require_sorted_input: bool,
    ) -> Result<(), ContinuationCryptoError> {
        if recipients.is_empty() || recipients.len() > MAX_ENVELOPE_RECIPIENTS {
            return Err(ContinuationCryptoError::InvalidEnvelope(
                "recipient list must contain between one and 64 entries",
            ));
        }
        let mut user_devices = HashSet::with_capacity(recipients.len());
        let mut device_ids = HashSet::with_capacity(recipients.len());
        for (index, recipient) in recipients.iter().enumerate() {
            recipient.identity.validate()?;
            if recipient.recipient_user_id.is_nil()
                || !user_devices.insert((recipient.recipient_user_id, recipient.identity.device_id))
                || !device_ids.insert(recipient.identity.device_id)
            {
                return Err(ContinuationCryptoError::InvalidEnvelope(
                    "recipient list contains a duplicate device key route",
                ));
            }
            if require_sorted_input
                && index > 0
                && recipients[index - 1].canonical_cmp(recipient) != Ordering::Less
            {
                return Err(ContinuationCryptoError::InvalidEnvelope(
                    "recipient list is not in strict canonical order",
                ));
            }
        }
        Ok(())
    }
}

macro_rules! algorithm_try_from {
    ($type:ty, $kind:literal, $variant:path) => {
        impl TryFrom<u8> for $type {
            type Error = ContinuationCryptoError;

            fn try_from(value: u8) -> Result<Self, Self::Error> {
                match value {
                    1 => Ok($variant),
                    other => Err(ContinuationCryptoError::UnsupportedAlgorithm {
                        kind: $kind,
                        value: other,
                    }),
                }
            }
        }
    };
}

algorithm_try_from!(
    EncryptionAlgorithm,
    "encryption",
    EncryptionAlgorithm::AgeX25519
);
algorithm_try_from!(SignatureAlgorithm, "signature", SignatureAlgorithm::Ed25519);
algorithm_try_from!(
    CompressionAlgorithm,
    "compression",
    CompressionAlgorithm::Gzip
);
algorithm_try_from!(HashAlgorithm, "hash", HashAlgorithm::Sha256);

/// Canonical public metadata mirrored by cloud storage for routing and audit.
///
/// It intentionally contains no plaintext digest or private/session contents.
/// `age_ciphertext_sha256` is the SHA-256 of exactly the standard age payload
/// that follows the header. Full-object size/hash are deliberately outside
/// this signed header: they cover this header and the signature too, so putting
/// either value here would create a circular digest. Cloud persists both sets
/// as distinct fields.
///
/// All integers use big-endian encoding; all strings use a big-endian `u16`
/// byte-length prefix followed by canonical UTF-8 bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContinuationEnvelopeHeader {
    pub encryption_algorithm: EncryptionAlgorithm,
    pub signature_algorithm: SignatureAlgorithm,
    pub compression_algorithm: CompressionAlgorithm,
    pub hash_algorithm: HashAlgorithm,
    pub org_id: Uuid,
    pub checkpoint_id: Uuid,
    pub root_session_id: String,
    pub source_episode_id: String,
    pub source_runtime: String,
    pub payload_schema: String,
    pub payload_schema_version: u16,
    pub recipient_scope: RecipientScope,
    pub sender_user_id: Uuid,
    pub sender: DevicePublicIdentity,
    pub recipients: CloudRecipientSet,
    pub recipient_set_sha256: [u8; 32],
    pub age_ciphertext_sha256: [u8; 32],
    pub created_at_unix_ms: u64,
    pub expires_at_unix_ms: u64,
    pub age_ciphertext_len: u64,
}

impl ContinuationEnvelopeHeader {
    pub fn validate(&self) -> Result<(), ContinuationCryptoError> {
        validate_identifier(
            "root session id",
            &self.root_session_id,
            MAX_CONVERSATION_ID_BYTES,
        )?;
        validate_identifier(
            "source episode id",
            &self.source_episode_id,
            MAX_CONVERSATION_ID_BYTES,
        )?;
        validate_runtime("source runtime", &self.source_runtime)?;
        validate_identifier(
            "payload schema",
            &self.payload_schema,
            MAX_PAYLOAD_SCHEMA_ID_BYTES,
        )?;
        if self.payload_schema_version == 0 {
            return Err(ContinuationCryptoError::InvalidEnvelope(
                "payload schema version must be positive",
            ));
        }
        self.sender.validate()?;
        CloudRecipientSet::validate_entries(self.recipients.as_slice(), true)?;
        if self.recipient_set_sha256 != self.recipients.sha256() {
            return Err(ContinuationCryptoError::InvalidEnvelope(
                "recipient set SHA-256 mismatch",
            ));
        }
        if self.org_id.is_nil() || self.checkpoint_id.is_nil() || self.sender_user_id.is_nil() {
            return Err(ContinuationCryptoError::InvalidEnvelope(
                "routing UUIDs must be non-nil",
            ));
        }
        if self.created_at_unix_ms == 0 {
            return Err(ContinuationCryptoError::InvalidEnvelope(
                "created-at timestamp must be positive",
            ));
        }
        if self.expires_at_unix_ms <= self.created_at_unix_ms {
            return Err(ContinuationCryptoError::InvalidEnvelope(
                "expiry must be later than creation",
            ));
        }
        let ttl = self.expires_at_unix_ms - self.created_at_unix_ms;
        if !(MIN_ENVELOPE_TTL_MS..=MAX_ENVELOPE_TTL_MS).contains(&ttl) {
            return Err(ContinuationCryptoError::InvalidEnvelope(
                "envelope lifetime must be between five minutes and seven days",
            ));
        }
        if self.age_ciphertext_len == 0 {
            return Err(ContinuationCryptoError::InvalidEnvelope(
                "ciphertext length must be positive",
            ));
        }
        Ok(())
    }
}

pub fn canonical_header_bytes(
    header: &ContinuationEnvelopeHeader,
) -> Result<Vec<u8>, ContinuationCryptoError> {
    header.validate()?;
    let mut bytes = Vec::with_capacity(768);
    bytes.push(header.encryption_algorithm as u8);
    bytes.push(header.signature_algorithm as u8);
    bytes.push(header.compression_algorithm as u8);
    bytes.push(header.hash_algorithm as u8);
    bytes.extend_from_slice(header.org_id.as_bytes());
    bytes.extend_from_slice(header.checkpoint_id.as_bytes());
    put_string(&mut bytes, &header.root_session_id)?;
    put_string(&mut bytes, &header.source_episode_id)?;
    put_string(&mut bytes, &header.source_runtime)?;
    put_string(&mut bytes, &header.payload_schema)?;
    bytes.extend_from_slice(&header.payload_schema_version.to_be_bytes());
    bytes.push(header.recipient_scope as u8);
    bytes.extend_from_slice(header.sender_user_id.as_bytes());
    put_identity(&mut bytes, &header.sender)?;
    bytes.extend_from_slice(&(header.recipients.as_slice().len() as u16).to_be_bytes());
    bytes.extend_from_slice(&header.recipient_set_sha256);
    for recipient in header.recipients.as_slice() {
        bytes.extend_from_slice(recipient.recipient_user_id.as_bytes());
        put_identity(&mut bytes, &recipient.identity)?;
    }
    bytes.extend_from_slice(&header.age_ciphertext_sha256);
    bytes.extend_from_slice(&header.created_at_unix_ms.to_be_bytes());
    bytes.extend_from_slice(&header.expires_at_unix_ms.to_be_bytes());
    bytes.extend_from_slice(&header.age_ciphertext_len.to_be_bytes());
    if bytes.len() > MAX_CANONICAL_HEADER_BYTES {
        return Err(ContinuationCryptoError::limit(
            LimitKind::HeaderBytes,
            MAX_CANONICAL_HEADER_BYTES as u64,
            bytes.len() as u64,
        ));
    }
    Ok(bytes)
}

pub(crate) fn decode_canonical_header(
    bytes: &[u8],
) -> Result<ContinuationEnvelopeHeader, ContinuationCryptoError> {
    if bytes.len() > MAX_CANONICAL_HEADER_BYTES {
        return Err(ContinuationCryptoError::limit(
            LimitKind::HeaderBytes,
            MAX_CANONICAL_HEADER_BYTES as u64,
            bytes.len() as u64,
        ));
    }
    let mut cursor = HeaderCursor::new(bytes);
    let header = ContinuationEnvelopeHeader {
        encryption_algorithm: EncryptionAlgorithm::try_from(cursor.u8()?)?,
        signature_algorithm: SignatureAlgorithm::try_from(cursor.u8()?)?,
        compression_algorithm: CompressionAlgorithm::try_from(cursor.u8()?)?,
        hash_algorithm: HashAlgorithm::try_from(cursor.u8()?)?,
        org_id: Uuid::from_bytes(cursor.array()?),
        checkpoint_id: Uuid::from_bytes(cursor.array()?),
        root_session_id: cursor.string(MAX_CONVERSATION_ID_BYTES)?,
        source_episode_id: cursor.string(MAX_CONVERSATION_ID_BYTES)?,
        source_runtime: cursor.string(MAX_RUNTIME_ID_BYTES)?,
        payload_schema: cursor.string(MAX_PAYLOAD_SCHEMA_ID_BYTES)?,
        payload_schema_version: cursor.u16()?,
        recipient_scope: RecipientScope::try_from(cursor.u8()?)?,
        sender_user_id: Uuid::from_bytes(cursor.array()?),
        sender: cursor.identity()?,
        recipients: {
            let count = cursor.u16()? as usize;
            let expected_sha256: [u8; 32] = cursor.array()?;
            let recipients = cursor.recipients_with_count(count)?;
            if recipients.sha256() != expected_sha256 {
                return Err(ContinuationCryptoError::InvalidEnvelope(
                    "recipient set SHA-256 mismatch",
                ));
            }
            recipients
        },
        recipient_set_sha256: {
            // Recomputed below from the decoded canonical set; keeping this
            // field explicit binds the Cloud object-row mirror.
            [0; 32]
        },
        age_ciphertext_sha256: cursor.array()?,
        created_at_unix_ms: cursor.u64()?,
        expires_at_unix_ms: cursor.u64()?,
        age_ciphertext_len: cursor.u64()?,
    };
    if !cursor.is_empty() {
        return Err(ContinuationCryptoError::InvalidEnvelope(
            "trailing canonical header bytes",
        ));
    }
    let mut header = header;
    header.recipient_set_sha256 = header.recipients.sha256();
    header.validate()?;
    if canonical_header_bytes(&header)? != bytes {
        return Err(ContinuationCryptoError::InvalidEnvelope(
            "non-canonical header encoding",
        ));
    }
    Ok(header)
}

/// Exact bytes signed by the sender:
///
/// `SIGNATURE_DOMAIN || 0x00 || be_u32(header_len) || raw_header || age_ciphertext_sha256`
///
/// The returned bytes are the single signature contract used by both the
/// envelope footer and the Cloud prepare/commit RPC. Callers must persist the
/// resulting 64 Ed25519 bytes verbatim; there is no second RPC signature.
pub fn signature_message(
    raw_header: &[u8],
    age_ciphertext_sha256: &[u8; 32],
) -> Result<Vec<u8>, ContinuationCryptoError> {
    if raw_header.len() > MAX_CANONICAL_HEADER_BYTES {
        return Err(ContinuationCryptoError::limit(
            LimitKind::HeaderBytes,
            MAX_CANONICAL_HEADER_BYTES as u64,
            raw_header.len() as u64,
        ));
    }
    let header_len = u32::try_from(raw_header.len())
        .map_err(|_| ContinuationCryptoError::InvalidEnvelope("header length overflow"))?;
    let mut message = Vec::with_capacity(
        SIGNATURE_DOMAIN.len() + 1 + 4 + raw_header.len() + age_ciphertext_sha256.len(),
    );
    message.extend_from_slice(SIGNATURE_DOMAIN);
    message.push(0);
    message.extend_from_slice(&header_len.to_be_bytes());
    message.extend_from_slice(raw_header);
    message.extend_from_slice(age_ciphertext_sha256);
    Ok(message)
}

fn put_string(bytes: &mut Vec<u8>, value: &str) -> Result<(), ContinuationCryptoError> {
    let length = u16::try_from(value.len())
        .map_err(|_| ContinuationCryptoError::InvalidEnvelope("string length overflow"))?;
    bytes.extend_from_slice(&length.to_be_bytes());
    bytes.extend_from_slice(value.as_bytes());
    Ok(())
}

fn put_identity(
    bytes: &mut Vec<u8>,
    identity: &DevicePublicIdentity,
) -> Result<(), ContinuationCryptoError> {
    identity.validate()?;
    bytes.extend_from_slice(identity.device_id.as_bytes());
    bytes.extend_from_slice(&identity.key_version.to_be_bytes());
    bytes.extend_from_slice(&identity.encryption_public_key);
    bytes.extend_from_slice(&identity.signing_public_key);
    bytes.extend_from_slice(&identity.fingerprint);
    Ok(())
}

fn validate_identifier(
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
        return Err(ContinuationCryptoError::InvalidEnvelope(label));
    }
    Ok(())
}

fn validate_runtime(label: &'static str, value: &str) -> Result<(), ContinuationCryptoError> {
    let mut bytes = value.bytes();
    let Some(first) = bytes.next() else {
        return Err(ContinuationCryptoError::InvalidEnvelope(label));
    };
    if value.len() > MAX_RUNTIME_ID_BYTES
        || !(first.is_ascii_lowercase() || first.is_ascii_digit())
        || !bytes.all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
    {
        return Err(ContinuationCryptoError::InvalidEnvelope(label));
    }
    Ok(())
}

struct HeaderCursor<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> HeaderCursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, position: 0 }
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], ContinuationCryptoError> {
        let end =
            self.position
                .checked_add(length)
                .ok_or(ContinuationCryptoError::InvalidEnvelope(
                    "header length overflow",
                ))?;
        let value =
            self.bytes
                .get(self.position..end)
                .ok_or(ContinuationCryptoError::InvalidEnvelope(
                    "truncated canonical header",
                ))?;
        self.position = end;
        Ok(value)
    }

    fn u8(&mut self) -> Result<u8, ContinuationCryptoError> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, ContinuationCryptoError> {
        Ok(u16::from_be_bytes(self.take(2)?.try_into().map_err(
            |_| ContinuationCryptoError::InvalidEnvelope("truncated header u16"),
        )?))
    }

    fn u32(&mut self) -> Result<u32, ContinuationCryptoError> {
        Ok(u32::from_be_bytes(self.take(4)?.try_into().map_err(
            |_| ContinuationCryptoError::InvalidEnvelope("truncated header u32"),
        )?))
    }

    fn u64(&mut self) -> Result<u64, ContinuationCryptoError> {
        Ok(u64::from_be_bytes(self.take(8)?.try_into().map_err(
            |_| ContinuationCryptoError::InvalidEnvelope("truncated header u64"),
        )?))
    }

    fn array<const N: usize>(&mut self) -> Result<[u8; N], ContinuationCryptoError> {
        self.take(N)?
            .try_into()
            .map_err(|_| ContinuationCryptoError::InvalidEnvelope("truncated header array"))
    }

    fn string(&mut self, max: usize) -> Result<String, ContinuationCryptoError> {
        let length = self.u16()? as usize;
        if length == 0 || length > max {
            return Err(ContinuationCryptoError::InvalidEnvelope(
                "invalid header string length",
            ));
        }
        String::from_utf8(self.take(length)?.to_vec())
            .map_err(|_| ContinuationCryptoError::InvalidEnvelope("header string is not UTF-8"))
    }

    fn identity(&mut self) -> Result<DevicePublicIdentity, ContinuationCryptoError> {
        DevicePublicIdentity::try_new(
            Uuid::from_bytes(self.array()?),
            self.u32()?,
            self.array()?,
            self.array()?,
            self.array()?,
        )
    }

    fn recipients_with_count(
        &mut self,
        count: usize,
    ) -> Result<CloudRecipientSet, ContinuationCryptoError> {
        if count == 0 || count > MAX_ENVELOPE_RECIPIENTS {
            return Err(ContinuationCryptoError::InvalidEnvelope(
                "invalid recipient count",
            ));
        }
        let mut recipients = Vec::with_capacity(count);
        for _ in 0..count {
            recipients.push(CloudRecipient::try_new(
                Uuid::from_bytes(self.array()?),
                self.identity()?,
            )?);
        }
        CloudRecipientSet::from_canonical(recipients)
    }

    fn is_empty(&self) -> bool {
        self.position == self.bytes.len()
    }
}
