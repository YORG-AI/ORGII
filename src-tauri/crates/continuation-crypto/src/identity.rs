use std::{str::FromStr, sync::Mutex};

use age::secrecy::ExposeSecret;
use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use rand_core::OsRng;
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::{
    ContinuationCryptoError, DeviceSecretStore, PrivateStagingDirectory, SecretBytes,
    SecretStoreError,
};

pub const DEVICE_FINGERPRINT_DOMAIN: &[u8] = b"ORG2-CONTINUATION-DEVICE-V1";
const PRIVATE_KEY_CHECKSUM_DOMAIN: &[u8] = b"ORG2-CONTINUATION-PRIVATE-KEY-CHECKSUM-V1";
const ACTIVE_POINTER_CHECKSUM_DOMAIN: &[u8] = b"ORG2-CONTINUATION-ACTIVE-KEY-CHECKSUM-V1";
const KEY_RECORD_MAGIC: &[u8; 8] = b"ORG2KEY\0";
const ACTIVE_POINTER_MAGIC: &[u8; 8] = b"ORG2ACT\0";
const SECRET_RECORD_VERSION: u16 = 1;
const MAX_AGE_SECRET_BYTES: usize = 256;
const SQL_MAX_KEY_VERSION: u32 = i32::MAX as u32;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DevicePublicIdentity {
    pub device_id: Uuid,
    pub key_version: u32,
    pub encryption_public_key: [u8; 32],
    pub signing_public_key: [u8; 32],
    pub fingerprint: [u8; 32],
}

impl DevicePublicIdentity {
    pub fn try_new(
        device_id: Uuid,
        key_version: u32,
        encryption_public_key: [u8; 32],
        signing_public_key: [u8; 32],
        fingerprint: [u8; 32],
    ) -> Result<Self, ContinuationCryptoError> {
        if device_id.is_nil() {
            return Err(ContinuationCryptoError::InvalidIdentity(
                "device UUID must be non-nil",
            ));
        }
        validate_key_version(key_version)?;
        let expected = device_fingerprint(&encryption_public_key, &signing_public_key);
        if fingerprint != expected {
            return Err(ContinuationCryptoError::InvalidIdentity(
                "public-key fingerprint mismatch",
            ));
        }
        if encryption_public_key == [0; 32] {
            return Err(ContinuationCryptoError::InvalidIdentity(
                "X25519 public key must be nonzero",
            ));
        }
        let verifying_key = VerifyingKey::from_bytes(&signing_public_key).map_err(|_| {
            ContinuationCryptoError::InvalidIdentity("invalid Ed25519 verifying key")
        })?;
        if verifying_key.is_weak() {
            return Err(ContinuationCryptoError::InvalidIdentity(
                "weak Ed25519 verifying key",
            ));
        }
        age_recipient_from_raw(&encryption_public_key)?;
        Ok(Self {
            device_id,
            key_version,
            encryption_public_key,
            signing_public_key,
            fingerprint,
        })
    }

    pub fn fingerprint_hex(&self) -> String {
        hex::encode(self.fingerprint)
    }

    pub fn validate(&self) -> Result<(), ContinuationCryptoError> {
        Self::try_new(
            self.device_id,
            self.key_version,
            self.encryption_public_key,
            self.signing_public_key,
            self.fingerprint,
        )
        .map(|_| ())
    }
}

/// Private device identity. Intentionally not `Clone`, `Debug`, or serde.
pub struct DevicePrivateIdentity {
    device_id: Uuid,
    key_version: u32,
    age_secret: Zeroizing<String>,
    signing_secret: Zeroizing<[u8; 32]>,
}

impl DevicePrivateIdentity {
    pub fn device_id(&self) -> Uuid {
        self.device_id
    }

    pub fn key_version(&self) -> u32 {
        self.key_version
    }

    pub fn public_identity(&self) -> Result<DevicePublicIdentity, ContinuationCryptoError> {
        let age_identity = self.age_identity()?;
        let encryption_public_key = raw_age_recipient(&age_identity.to_public())?;
        let signing_key = SigningKey::from_bytes(&self.signing_secret);
        let signing_public_key = signing_key.verifying_key().to_bytes();
        let fingerprint = device_fingerprint(&encryption_public_key, &signing_public_key);
        DevicePublicIdentity::try_new(
            self.device_id,
            self.key_version,
            encryption_public_key,
            signing_public_key,
            fingerprint,
        )
    }

    pub(crate) fn age_identity(&self) -> Result<age::x25519::Identity, ContinuationCryptoError> {
        age::x25519::Identity::from_str(self.age_secret.as_str())
            .map_err(|_| ContinuationCryptoError::CorruptIdentity("invalid age X25519 secret"))
    }

    pub(crate) fn sign(&self, message: &[u8]) -> [u8; 64] {
        SigningKey::from_bytes(&self.signing_secret)
            .sign(message)
            .to_bytes()
    }

    pub(crate) fn verify_own_public(
        &self,
        public: &DevicePublicIdentity,
    ) -> Result<(), ContinuationCryptoError> {
        if self.public_identity()? == *public {
            Ok(())
        } else {
            Err(ContinuationCryptoError::WrongRecipient)
        }
    }
}

pub(crate) fn verify_signature(
    public: &DevicePublicIdentity,
    message: &[u8],
    signature: &[u8; 64],
) -> Result<(), ContinuationCryptoError> {
    let key = VerifyingKey::from_bytes(&public.signing_public_key)
        .map_err(|_| ContinuationCryptoError::InvalidSignature)?;
    let signature = ed25519_dalek::Signature::from_bytes(signature);
    key.verify_strict(message, &signature)
        .map_err(|_| ContinuationCryptoError::InvalidSignature)
}

pub fn device_fingerprint(
    encryption_public_key: &[u8; 32],
    signing_public_key: &[u8; 32],
) -> [u8; 32] {
    let mut digest = Sha256::new();
    digest.update(DEVICE_FINGERPRINT_DOMAIN);
    digest.update([0]);
    digest.update(encryption_public_key);
    digest.update(signing_public_key);
    digest.finalize().into()
}

fn raw_age_recipient(
    recipient: &age::x25519::Recipient,
) -> Result<[u8; 32], ContinuationCryptoError> {
    let encoded = recipient.to_string();
    let (hrp, bytes) = bech32::decode(&encoded).map_err(|_| {
        ContinuationCryptoError::CorruptIdentity("invalid age X25519 recipient encoding")
    })?;
    if hrp.as_str() != "age" || bytes.len() != 32 {
        return Err(ContinuationCryptoError::CorruptIdentity(
            "unexpected age X25519 recipient encoding",
        ));
    }
    bytes.try_into().map_err(|_| {
        ContinuationCryptoError::CorruptIdentity("unexpected age X25519 public-key length")
    })
}

pub(crate) fn age_recipient_from_raw(
    raw: &[u8; 32],
) -> Result<age::x25519::Recipient, ContinuationCryptoError> {
    let hrp = bech32::Hrp::parse("age")
        .map_err(|_| ContinuationCryptoError::InvalidIdentity("invalid age recipient HRP"))?;
    let encoded = bech32::encode::<bech32::Bech32>(hrp, raw)
        .map_err(|_| ContinuationCryptoError::InvalidIdentity("cannot encode age recipient"))?;
    age::x25519::Recipient::from_str(&encoded)
        .map_err(|_| ContinuationCryptoError::InvalidIdentity("invalid age X25519 public key"))
}

fn generate_key(device_id: Uuid, key_version: u32) -> StoredKey {
    let age_identity = age::x25519::Identity::generate();
    let age_secret = age_identity.to_string();
    let signing_key = SigningKey::generate(&mut OsRng);
    StoredKey {
        key_version,
        age_secret: Zeroizing::new(age_secret.expose_secret().to_owned()),
        signing_secret: Zeroizing::new(signing_key.to_bytes()),
        device_id,
    }
}

struct StoredKey {
    key_version: u32,
    age_secret: Zeroizing<String>,
    signing_secret: Zeroizing<[u8; 32]>,
    device_id: Uuid,
}

impl StoredKey {
    fn into_private(self) -> DevicePrivateIdentity {
        DevicePrivateIdentity {
            device_id: self.device_id,
            key_version: self.key_version,
            age_secret: self.age_secret,
            signing_secret: self.signing_secret,
        }
    }

    fn encode(&self) -> Result<SecretBytes, ContinuationCryptoError> {
        let age_bytes = self.age_secret.as_bytes();
        if age_bytes.is_empty() || age_bytes.len() > MAX_AGE_SECRET_BYTES {
            return Err(ContinuationCryptoError::CorruptIdentity(
                "invalid age secret length",
            ));
        }
        let public = self.public_identity()?;
        let mut bytes = Zeroizing::new(Vec::with_capacity(384));
        bytes.extend_from_slice(KEY_RECORD_MAGIC);
        bytes.extend_from_slice(&SECRET_RECORD_VERSION.to_be_bytes());
        bytes.extend_from_slice(self.device_id.as_bytes());
        bytes.extend_from_slice(&self.key_version.to_be_bytes());
        bytes.extend_from_slice(&(age_bytes.len() as u16).to_be_bytes());
        bytes.extend_from_slice(age_bytes);
        bytes.extend_from_slice(self.signing_secret.as_slice());
        bytes.extend_from_slice(&public.fingerprint);
        let checksum = record_checksum(PRIVATE_KEY_CHECKSUM_DOMAIN, &bytes);
        bytes.extend_from_slice(&checksum);
        Ok(SecretBytes::new(std::mem::take(&mut *bytes)))
    }

    fn decode(
        expected_device_id: Uuid,
        expected_version: u32,
        secret: &SecretBytes,
    ) -> Result<Self, ContinuationCryptoError> {
        let bytes = secret.as_slice();
        if bytes.len() < 8 + 2 + 16 + 4 + 2 + 1 + 32 + 32 + 32 {
            return Err(ContinuationCryptoError::CorruptIdentity(
                "truncated private key record",
            ));
        }
        let (body, encoded_checksum) = bytes.split_at(bytes.len() - 32);
        if record_checksum(PRIVATE_KEY_CHECKSUM_DOMAIN, body).as_slice() != encoded_checksum {
            return Err(ContinuationCryptoError::CorruptIdentity(
                "private key record checksum mismatch",
            ));
        }
        let mut cursor = SecretCursor::new(body);
        if cursor.take(8)? != KEY_RECORD_MAGIC || cursor.u16()? != SECRET_RECORD_VERSION {
            return Err(ContinuationCryptoError::CorruptIdentity(
                "unsupported private key record",
            ));
        }
        let device_id = Uuid::from_bytes(cursor.array()?);
        let key_version = cursor.u32()?;
        if device_id != expected_device_id || key_version != expected_version {
            return Err(ContinuationCryptoError::CorruptIdentity(
                "private key record identity mismatch",
            ));
        }
        validate_key_version(key_version)?;
        let age_len = cursor.u16()? as usize;
        if age_len == 0 || age_len > MAX_AGE_SECRET_BYTES {
            return Err(ContinuationCryptoError::CorruptIdentity(
                "invalid age secret length",
            ));
        }
        let age_secret = Zeroizing::new(
            std::str::from_utf8(cursor.take(age_len)?)
                .map_err(|_| ContinuationCryptoError::CorruptIdentity("age secret is not UTF-8"))?
                .to_owned(),
        );
        let signing_secret = Zeroizing::new(cursor.array()?);
        let encoded_fingerprint: [u8; 32] = cursor.array()?;
        if !cursor.is_empty() {
            return Err(ContinuationCryptoError::CorruptIdentity(
                "trailing private key record bytes",
            ));
        }
        let key = Self {
            key_version,
            age_secret,
            signing_secret,
            device_id,
        };
        if key.public_identity()?.fingerprint != encoded_fingerprint {
            return Err(ContinuationCryptoError::CorruptIdentity(
                "private key public fingerprint mismatch",
            ));
        }
        Ok(key)
    }

    fn public_identity(&self) -> Result<DevicePublicIdentity, ContinuationCryptoError> {
        let age_identity = age::x25519::Identity::from_str(self.age_secret.as_str())
            .map_err(|_| ContinuationCryptoError::CorruptIdentity("invalid age X25519 secret"))?;
        let encryption_public_key = raw_age_recipient(&age_identity.to_public())?;
        let signing_public_key = SigningKey::from_bytes(&self.signing_secret)
            .verifying_key()
            .to_bytes();
        DevicePublicIdentity::try_new(
            self.device_id,
            self.key_version,
            encryption_public_key,
            signing_public_key,
            device_fingerprint(&encryption_public_key, &signing_public_key),
        )
    }
}

#[derive(Clone, PartialEq, Eq)]
struct ActivePointer {
    device_id: Uuid,
    active_version: u32,
    generation: u64,
    active_fingerprint: [u8; 32],
}

impl ActivePointer {
    fn encode(&self) -> SecretBytes {
        let mut bytes = Zeroizing::new(Vec::with_capacity(102));
        bytes.extend_from_slice(ACTIVE_POINTER_MAGIC);
        bytes.extend_from_slice(&SECRET_RECORD_VERSION.to_be_bytes());
        bytes.extend_from_slice(self.device_id.as_bytes());
        bytes.extend_from_slice(&self.active_version.to_be_bytes());
        bytes.extend_from_slice(&self.generation.to_be_bytes());
        bytes.extend_from_slice(&self.active_fingerprint);
        let checksum = record_checksum(ACTIVE_POINTER_CHECKSUM_DOMAIN, &bytes);
        bytes.extend_from_slice(&checksum);
        SecretBytes::new(std::mem::take(&mut *bytes))
    }

    fn decode(
        expected_device_id: Uuid,
        secret: &SecretBytes,
    ) -> Result<Self, ContinuationCryptoError> {
        let bytes = secret.as_slice();
        const BODY_LEN: usize = 8 + 2 + 16 + 4 + 8 + 32;
        if bytes.len() != BODY_LEN + 32 {
            return Err(ContinuationCryptoError::CorruptIdentity(
                "active pointer has wrong length",
            ));
        }
        let (body, encoded_checksum) = bytes.split_at(BODY_LEN);
        if record_checksum(ACTIVE_POINTER_CHECKSUM_DOMAIN, body).as_slice() != encoded_checksum {
            return Err(ContinuationCryptoError::CorruptIdentity(
                "active pointer checksum mismatch",
            ));
        }
        let mut cursor = SecretCursor::new(body);
        if cursor.take(8)? != ACTIVE_POINTER_MAGIC || cursor.u16()? != SECRET_RECORD_VERSION {
            return Err(ContinuationCryptoError::CorruptIdentity(
                "unsupported active pointer",
            ));
        }
        let pointer = Self {
            device_id: Uuid::from_bytes(cursor.array()?),
            active_version: cursor.u32()?,
            generation: cursor.u64()?,
            active_fingerprint: cursor.array()?,
        };
        if pointer.device_id != expected_device_id || pointer.generation == 0 || !cursor.is_empty()
        {
            return Err(ContinuationCryptoError::CorruptIdentity(
                "invalid active pointer fields",
            ));
        }
        validate_key_version(pointer.active_version)?;
        Ok(pointer)
    }
}

fn record_checksum(domain: &[u8], bytes: &[u8]) -> [u8; 32] {
    let mut digest = Sha256::new();
    digest.update(domain);
    digest.update([0]);
    digest.update(bytes);
    digest.finalize().into()
}

struct SecretCursor<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> SecretCursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, position: 0 }
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], ContinuationCryptoError> {
        let end =
            self.position
                .checked_add(length)
                .ok_or(ContinuationCryptoError::CorruptIdentity(
                    "identity length overflow",
                ))?;
        let value =
            self.bytes
                .get(self.position..end)
                .ok_or(ContinuationCryptoError::CorruptIdentity(
                    "truncated identity record",
                ))?;
        self.position = end;
        Ok(value)
    }

    fn array<const N: usize>(&mut self) -> Result<[u8; N], ContinuationCryptoError> {
        self.take(N)?.try_into().map_err(|_| {
            ContinuationCryptoError::CorruptIdentity("truncated fixed-width identity field")
        })
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
    fn is_empty(&self) -> bool {
        self.position == self.bytes.len()
    }
}

/// Serialized identity manager with a per-profile cross-process lock and CAS.
pub struct DeviceIdentityManager<S> {
    store: S,
    staging: PrivateStagingDirectory,
    operation_gate: Mutex<()>,
}

impl<S: DeviceSecretStore> DeviceIdentityManager<S> {
    pub fn new(store: S, staging: PrivateStagingDirectory) -> Self {
        Self {
            store,
            staging,
            operation_gate: Mutex::new(()),
        }
    }

    pub fn load_current(
        &self,
        device_id: Uuid,
    ) -> Result<DevicePrivateIdentity, ContinuationCryptoError> {
        let _guard = self.lock_in_process()?;
        let _process_lock = self.lock_profile(device_id)?;
        let pointer = self
            .load_pointer(device_id)?
            .ok_or(ContinuationCryptoError::IdentityMissing)?;
        self.load_pointer_key(&pointer)
    }

    pub fn load_version(
        &self,
        device_id: Uuid,
        key_version: u32,
    ) -> Result<DevicePrivateIdentity, ContinuationCryptoError> {
        validate_key_version(key_version)?;
        let _guard = self.lock_in_process()?;
        let _process_lock = self.lock_profile(device_id)?;
        self.load_key(device_id, key_version)?
            .map(StoredKey::into_private)
            .ok_or(ContinuationCryptoError::KeyVersionMissing(key_version))
    }

    pub fn load_or_create(
        &self,
        device_id: Uuid,
    ) -> Result<DevicePrivateIdentity, ContinuationCryptoError> {
        let _guard = self.lock_in_process()?;
        let _process_lock = self.lock_profile(device_id)?;
        if let Some(pointer) = self.load_pointer(device_id)? {
            return self.load_pointer_key(&pointer);
        }
        let key = match self.load_key(device_id, 1)? {
            Some(key) => key,
            None => {
                let key = generate_key(device_id, 1);
                self.persist_key_if_absent(&key)?;
                self.load_key(device_id, 1)?
                    .ok_or(SecretStoreError::Unavailable)?
            }
        };
        let public = key.public_identity()?;
        let next = ActivePointer {
            device_id,
            active_version: 1,
            generation: 1,
            active_fingerprint: public.fingerprint,
        };
        self.store_pointer_cas(device_id, None, &next)?;
        self.load_pointer_key(&next)
    }

    pub fn rotate(
        &self,
        device_id: Uuid,
    ) -> Result<DevicePrivateIdentity, ContinuationCryptoError> {
        let _guard = self.lock_in_process()?;
        let _process_lock = self.lock_profile(device_id)?;
        let current = self
            .load_pointer(device_id)?
            .ok_or(ContinuationCryptoError::IdentityMissing)?;
        let next_version = current
            .active_version
            .checked_add(1)
            .filter(|value| *value <= SQL_MAX_KEY_VERSION)
            .ok_or(ContinuationCryptoError::KeyVersionExhausted)?;
        let key = match self.load_key(device_id, next_version)? {
            Some(key) => key,
            None => {
                let key = generate_key(device_id, next_version);
                self.persist_key_if_absent(&key)?;
                self.load_key(device_id, next_version)?
                    .ok_or(SecretStoreError::Unavailable)?
            }
        };
        let next = ActivePointer {
            device_id,
            active_version: next_version,
            generation: current
                .generation
                .checked_add(1)
                .ok_or(ContinuationCryptoError::KeyVersionExhausted)?,
            active_fingerprint: key.public_identity()?.fingerprint,
        };
        self.store_pointer_cas(device_id, Some(&current), &next)?;
        self.load_pointer_key(&next)
    }

    fn lock_in_process(&self) -> Result<std::sync::MutexGuard<'_, ()>, SecretStoreError> {
        self.operation_gate
            .lock()
            .map_err(|_| SecretStoreError::Unavailable)
    }

    fn lock_profile(&self, device_id: Uuid) -> Result<std::fs::File, ContinuationCryptoError> {
        self.staging.transaction_lock_file(&device_id.to_string())
    }

    fn load_pointer(
        &self,
        device_id: Uuid,
    ) -> Result<Option<ActivePointer>, ContinuationCryptoError> {
        self.store
            .load(&active_entry_id(device_id))?
            .map(|secret| ActivePointer::decode(device_id, &secret))
            .transpose()
    }

    fn load_key(
        &self,
        device_id: Uuid,
        key_version: u32,
    ) -> Result<Option<StoredKey>, ContinuationCryptoError> {
        self.store
            .load(&key_entry_id(device_id, key_version))?
            .map(|secret| StoredKey::decode(device_id, key_version, &secret))
            .transpose()
    }

    fn load_pointer_key(
        &self,
        pointer: &ActivePointer,
    ) -> Result<DevicePrivateIdentity, ContinuationCryptoError> {
        let key = self
            .load_key(pointer.device_id, pointer.active_version)?
            .ok_or(ContinuationCryptoError::KeyVersionMissing(
                pointer.active_version,
            ))?;
        if key.public_identity()?.fingerprint != pointer.active_fingerprint {
            return Err(ContinuationCryptoError::CorruptIdentity(
                "active pointer fingerprint mismatch",
            ));
        }
        Ok(key.into_private())
    }

    fn persist_key_if_absent(&self, key: &StoredKey) -> Result<(), ContinuationCryptoError> {
        let entry_id = key_entry_id(key.device_id, key.key_version);
        if self.store.load(&entry_id)?.is_some() {
            return Err(ContinuationCryptoError::IdentityConflict);
        }
        self.store.store(&entry_id, &key.encode()?)?;
        let persisted = self
            .store
            .load(&entry_id)?
            .ok_or(SecretStoreError::Unavailable)?;
        let decoded = StoredKey::decode(key.device_id, key.key_version, &persisted)?;
        if decoded.public_identity()? != key.public_identity()? {
            return Err(ContinuationCryptoError::IdentityConflict);
        }
        Ok(())
    }

    fn store_pointer_cas(
        &self,
        device_id: Uuid,
        expected: Option<&ActivePointer>,
        next: &ActivePointer,
    ) -> Result<(), ContinuationCryptoError> {
        if self.load_pointer(device_id)?.as_ref() != expected {
            return Err(ContinuationCryptoError::IdentityConflict);
        }
        self.store
            .store(&active_entry_id(device_id), &next.encode())?;
        if self.load_pointer(device_id)?.as_ref() != Some(next) {
            return Err(ContinuationCryptoError::IdentityConflict);
        }
        Ok(())
    }
}

fn active_entry_id(device_id: Uuid) -> String {
    format!("device:{device_id}:active")
}
fn key_entry_id(device_id: Uuid, key_version: u32) -> String {
    format!("device:{device_id}:key:{key_version}")
}

fn validate_key_version(key_version: u32) -> Result<(), ContinuationCryptoError> {
    if key_version == 0 || key_version > SQL_MAX_KEY_VERSION {
        return Err(ContinuationCryptoError::InvalidIdentity(
            "key version must be in positive SQL int range",
        ));
    }
    Ok(())
}
