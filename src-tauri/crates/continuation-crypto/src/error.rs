use std::io;

use thiserror::Error;

/// Secure-store failures never contain the value being stored or loaded.
#[derive(Debug, Error)]
pub enum SecretStoreError {
    #[error("the operating-system secure store is unavailable (backend detail redacted)")]
    Unavailable,
    #[error("the operating-system secure store denied access (backend detail redacted)")]
    AccessDenied,
    #[error("the operating-system secure store returned ambiguous identity data")]
    Ambiguous,
    #[error("the operating-system secure store rejected the operation (backend detail redacted)")]
    Rejected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LimitKind {
    HeaderBytes,
    FrameBytes,
    TotalDecompressedBytes,
    Records,
    Events,
    EventBytes,
    Blobs,
    BlobBytes,
    PathBytes,
    ManifestBytes,
    CiphertextBytes,
    EnvelopeBytes,
}

impl std::fmt::Display for LimitKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let value = match self {
            Self::HeaderBytes => "header bytes",
            Self::FrameBytes => "frame bytes",
            Self::TotalDecompressedBytes => "total decompressed bytes",
            Self::Records => "records",
            Self::Events => "events",
            Self::EventBytes => "event bytes",
            Self::Blobs => "blobs",
            Self::BlobBytes => "blob bytes",
            Self::PathBytes => "path bytes",
            Self::ManifestBytes => "manifest bytes",
            Self::CiphertextBytes => "ciphertext bytes",
            Self::EnvelopeBytes => "full envelope bytes",
        };
        f.write_str(value)
    }
}

#[derive(Debug, Error)]
pub enum ContinuationCryptoError {
    #[error(transparent)]
    SecretStore(#[from] SecretStoreError),
    #[error("I/O failure while {operation}: {source}")]
    Io {
        operation: &'static str,
        #[source]
        source: io::Error,
    },
    #[error("invalid device identity: {0}")]
    InvalidIdentity(&'static str),
    #[error("device identity has not been initialized")]
    IdentityMissing,
    #[error("device key version {0} is not retained")]
    KeyVersionMissing(u32),
    #[error("device key version cannot advance past the positive SQL int range")]
    KeyVersionExhausted,
    #[error("device identity changed during a compare-and-swap transaction")]
    IdentityConflict,
    #[error("secure device identity record is corrupt: {0}")]
    CorruptIdentity(&'static str),
    #[error("invalid continuation envelope: {0}")]
    InvalidEnvelope(&'static str),
    #[error("invalid private staging capability: {0}")]
    InvalidStaging(&'static str),
    #[error("unsupported continuation envelope version {0}")]
    UnsupportedEnvelopeVersion(u16),
    #[error("unsupported {kind} algorithm id {value}")]
    UnsupportedAlgorithm { kind: &'static str, value: u8 },
    #[error("continuation checkpoint expired at {0}")]
    Expired(u64),
    #[error("continuation checkpoint was created implausibly far in the future")]
    CreatedInFuture,
    #[error("continuation checkpoint sender does not match the trusted device key")]
    UntrustedSender,
    #[error("continuation checkpoint is not addressed to this device key")]
    WrongRecipient,
    #[error("continuation checkpoint age-ciphertext SHA-256 does not match its signed header")]
    CiphertextHashMismatch,
    #[error(
        "continuation checkpoint full-object size or SHA-256 does not match the committed row"
    )]
    ObjectHashMismatch,
    #[error("continuation checkpoint Cloud metadata does not match its {0}")]
    CloudMetadataMismatch(&'static str),
    #[error("continuation checkpoint plaintext hash does not match its framed stream")]
    PlaintextHashMismatch,
    #[error("continuation checkpoint signature is invalid")]
    InvalidSignature,
    #[error("age encryption failed: {0}")]
    AgeEncrypt(String),
    #[error("age decryption failed: {0}")]
    AgeDecrypt(String),
    #[error("gzip stream is invalid: {0}")]
    InvalidCompression(String),
    #[error("checkpoint frame stream is invalid: {0}")]
    InvalidFrame(&'static str),
    #[error("checkpoint blob path is unsafe: {0}")]
    UnsafePath(String),
    #[error("checkpoint sink did not consume the complete blob payload")]
    BlobNotConsumed,
    #[error("{kind} limit exceeded: {actual} > {limit}")]
    LimitExceeded {
        kind: LimitKind,
        limit: u64,
        actual: u64,
    },
    #[error("destination already exists: {0}")]
    DestinationExists(String),
}

impl ContinuationCryptoError {
    pub(crate) fn io(operation: &'static str, source: io::Error) -> Self {
        Self::Io { operation, source }
    }

    pub(crate) fn limit(kind: LimitKind, limit: u64, actual: u64) -> Self {
        Self::LimitExceeded {
            kind,
            limit,
            actual,
        }
    }
}
