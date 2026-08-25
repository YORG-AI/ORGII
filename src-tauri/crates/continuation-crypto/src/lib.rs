//! Secure local foundations for portable continuation checkpoints.
//!
//! This crate deliberately contains no Tauri commands, network client, cloud
//! schema, Work Item activation, or agent-runtime policy. It owns only:
//!
//! - OS-secure device identity persistence and key rotation;
//! - the versioned raw-binary handoff envelope contract;
//! - standard age X25519 streaming encryption plus Ed25519 authentication;
//! - a bounded gzip-compressed manifest/event/blob/footer stream; and
//! - crash-safe owner-only ciphertext publication.
//!
//! Encryption, compression, secure-store access, fsync, and decryption are
//! synchronous blocking operations. Async/Tauri integrations must run them on
//! a dedicated blocking worker rather than an executor or render-critical
//! thread.
//!
//! Private key material never implements `Debug` or serde traits and is kept
//! in [`zeroize::Zeroizing`] containers whenever it is represented as bytes.

mod atomic_file;
mod envelope;
mod error;
mod framed_stream;
mod identity;
mod secret_store;
mod staging;
mod wire;

pub use envelope::{
    decrypt_cloud_checkpoint, write_cloud_checkpoint_atomic, CloudCheckpointDecryptRequest,
    CloudEnvelopeMetadata, CloudEnvelopeWriteRequest, CloudProfile, CommittedCloudEnvelope,
    CommittedCloudEnvelopeSql, CommittedRecipientReceipt, CommittedRecipientReceiptSql,
    EnvelopeArtifact, VerifiedEnvelope,
};
#[cfg(test)]
pub(crate) use envelope::{
    decrypt_local_checkpoint, write_local_checkpoint_atomic, LocalEnvelopeWriteRequest,
    LocalProfile,
};
pub use error::{ContinuationCryptoError, LimitKind, SecretStoreError};
pub use framed_stream::{
    BlobMetadata, CheckpointEvent, CheckpointFooter, CheckpointLimits, CheckpointManifest,
    CheckpointPlaintextHasher, CheckpointPlaintextSummary, CheckpointRecordWriter, CheckpointSink,
    CLOUD_CHECKPOINT_LIMITS, LOCAL_CHECKPOINT_LIMITS,
};
pub use identity::{
    device_fingerprint, DeviceIdentityManager, DevicePrivateIdentity, DevicePublicIdentity,
    DEVICE_FINGERPRINT_DOMAIN,
};
pub use secret_store::{DeviceSecretStore, KeyringDeviceSecretStore, SecretBytes};
pub use staging::PrivateStagingDirectory;
pub use wire::{
    canonical_header_bytes, signature_message, CloudRecipient, CloudRecipientSet,
    CompressionAlgorithm, ContinuationEnvelopeHeader, EncryptionAlgorithm, HashAlgorithm,
    RecipientScope, SignatureAlgorithm, ENVELOPE_END_MAGIC, ENVELOPE_MAGIC, ENVELOPE_VERSION,
    MAX_ENVELOPE_RECIPIENTS, RECIPIENT_SET_HASH_DOMAIN, SIGNATURE_BYTES, SIGNATURE_DOMAIN,
};

#[cfg(test)]
mod tests;
