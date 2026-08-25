use std::{
    collections::HashMap,
    io::{Cursor, Read},
    ops::Deref,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::{Signer, SigningKey};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::*;

const NOW_MS: u64 = 1_800_000_000_000;

#[derive(Clone, Default)]
struct MemorySecretStore {
    values: Arc<Mutex<HashMap<String, Vec<u8>>>>,
}

impl crate::secret_store::sealed::Sealed for MemorySecretStore {}

impl DeviceSecretStore for MemorySecretStore {
    fn load(&self, device_id: &str) -> Result<Option<SecretBytes>, SecretStoreError> {
        Ok(self
            .values
            .lock()
            .map_err(|_| SecretStoreError::Unavailable)?
            .get(device_id)
            .cloned()
            .map(SecretBytes::new))
    }

    fn store(&self, device_id: &str, secret: &SecretBytes) -> Result<(), SecretStoreError> {
        self.values
            .lock()
            .map_err(|_| SecretStoreError::Unavailable)?
            .insert(device_id.to_owned(), secret.as_slice().to_vec());
        Ok(())
    }
}

struct UnavailableSecretStore;

impl crate::secret_store::sealed::Sealed for UnavailableSecretStore {}

impl DeviceSecretStore for UnavailableSecretStore {
    fn load(&self, _device_id: &str) -> Result<Option<SecretBytes>, SecretStoreError> {
        Err(SecretStoreError::Unavailable)
    }

    fn store(&self, _device_id: &str, _secret: &SecretBytes) -> Result<(), SecretStoreError> {
        Err(SecretStoreError::Unavailable)
    }
}

#[derive(Clone)]
struct FailActivePointerStore {
    inner: MemorySecretStore,
    fail_next_active_store: Arc<AtomicBool>,
}

impl crate::secret_store::sealed::Sealed for FailActivePointerStore {}

impl DeviceSecretStore for FailActivePointerStore {
    fn load(&self, entry_id: &str) -> Result<Option<SecretBytes>, SecretStoreError> {
        self.inner.load(entry_id)
    }

    fn store(&self, entry_id: &str, secret: &SecretBytes) -> Result<(), SecretStoreError> {
        if entry_id.ends_with(":active")
            && self.fail_next_active_store.swap(false, Ordering::SeqCst)
        {
            return Err(SecretStoreError::Rejected);
        }
        self.inner.store(entry_id, secret)
    }
}

struct NonConsumingSink;

impl CheckpointSink for NonConsumingSink {
    fn stage_event(&mut self, _event: &CheckpointEvent) -> Result<(), ContinuationCryptoError> {
        Ok(())
    }

    fn stage_blob(
        &mut self,
        _metadata: &BlobMetadata,
        _content: &mut dyn Read,
    ) -> Result<(), ContinuationCryptoError> {
        Ok(())
    }
}

#[derive(Default)]
struct CollectingSink {
    manifest: Option<CheckpointManifest>,
    events: Vec<CheckpointEvent>,
    blobs: Vec<(BlobMetadata, Vec<u8>)>,
    footer: Option<CheckpointFooter>,
    pending: Option<StagedCollection>,
    begin_count: u32,
    commit_count: u32,
    abort_count: u32,
    fail_after_staging_event: bool,
}

#[derive(Default)]
struct StagedCollection {
    manifest: Option<CheckpointManifest>,
    events: Vec<CheckpointEvent>,
    blobs: Vec<(BlobMetadata, Vec<u8>)>,
    footer: Option<CheckpointFooter>,
}

impl CheckpointSink for CollectingSink {
    fn begin_transaction(&mut self) -> Result<(), ContinuationCryptoError> {
        self.begin_count += 1;
        self.pending = Some(StagedCollection::default());
        Ok(())
    }

    fn stage_manifest(
        &mut self,
        manifest: &CheckpointManifest,
    ) -> Result<(), ContinuationCryptoError> {
        self.pending
            .as_mut()
            .ok_or(ContinuationCryptoError::InvalidFrame(
                "test sink transaction not started",
            ))?
            .manifest = Some(manifest.clone());
        Ok(())
    }

    fn stage_event(&mut self, event: &CheckpointEvent) -> Result<(), ContinuationCryptoError> {
        self.pending
            .as_mut()
            .ok_or(ContinuationCryptoError::InvalidFrame(
                "test sink transaction not started",
            ))?
            .events
            .push(event.clone());
        if self.fail_after_staging_event {
            return Err(ContinuationCryptoError::InvalidFrame(
                "simulated transactional sink failure",
            ));
        }
        Ok(())
    }

    fn stage_blob(
        &mut self,
        metadata: &BlobMetadata,
        content: &mut dyn Read,
    ) -> Result<(), ContinuationCryptoError> {
        let mut bytes = Vec::new();
        content
            .read_to_end(&mut bytes)
            .map_err(|error| ContinuationCryptoError::io("collecting test blob", error))?;
        self.pending
            .as_mut()
            .ok_or(ContinuationCryptoError::InvalidFrame(
                "test sink transaction not started",
            ))?
            .blobs
            .push((metadata.clone(), bytes));
        Ok(())
    }

    fn stage_footer(&mut self, footer: &CheckpointFooter) -> Result<(), ContinuationCryptoError> {
        self.pending
            .as_mut()
            .ok_or(ContinuationCryptoError::InvalidFrame(
                "test sink transaction not started",
            ))?
            .footer = Some(footer.clone());
        Ok(())
    }

    fn commit_transaction(&mut self) -> Result<(), ContinuationCryptoError> {
        let staged = self
            .pending
            .take()
            .ok_or(ContinuationCryptoError::InvalidFrame(
                "test sink transaction not started",
            ))?;
        self.manifest = staged.manifest;
        self.events = staged.events;
        self.blobs = staged.blobs;
        self.footer = staged.footer;
        self.commit_count += 1;
        Ok(())
    }

    fn abort_transaction(&mut self) {
        self.pending = None;
        self.abort_count += 1;
    }
}

struct Fixture<'a> {
    event_payload: &'a [u8],
    blob_payload: &'a [u8],
    blob: BlobMetadata,
    manifest: CheckpointManifest,
}

fn fixture<'a>(event_payload: &'a [u8], blob_payload: &'a [u8]) -> Fixture<'a> {
    let blob = BlobMetadata {
        relative_path: "attachments/native-transcript.jsonl".into(),
        media_type: "application/x-ndjson".into(),
        content_len: blob_payload.len() as u64,
        sha256: Sha256::digest(blob_payload).into(),
    };
    let mut hasher = CheckpointPlaintextHasher::new(LOCAL_CHECKPOINT_LIMITS);
    hasher
        .update_event(7, "event-7", "agent-event", event_payload)
        .expect("hash event");
    hasher
        .update_blob(&blob, &mut Cursor::new(blob_payload))
        .expect("hash blob");
    let manifest = hasher
        .finish()
        .manifest("org2.continuation.checkpoint".into(), 1);
    Fixture {
        event_payload,
        blob_payload,
        blob,
        manifest,
    }
}

fn write_fixture(
    destination: &Path,
    sender: &DevicePrivateIdentity,
    recipient: &DevicePublicIdentity,
    fixture: &Fixture<'_>,
) -> Result<EnvelopeArtifact<LocalProfile>, ContinuationCryptoError> {
    let staging = staging_for(destination);
    write_local_checkpoint_atomic(
        destination,
        &staging,
        "fixture-job",
        LocalEnvelopeWriteRequest {
            metadata: test_metadata(),
            sender,
            recipients: test_recipient_set(recipient.clone()),
            manifest: fixture.manifest.clone(),
            limits: LOCAL_CHECKPOINT_LIMITS,
        },
        |writer| {
            writer.write_event(7, "event-7", "agent-event", fixture.event_payload)?;
            writer.write_blob(&fixture.blob, &mut Cursor::new(fixture.blob_payload))
        },
    )
}

fn staging_for(path: &Path) -> PrivateStagingDirectory {
    PrivateStagingDirectory::create(path.parent().expect("fixture path has parent"))
        .expect("private staging directory")
}

fn test_uuid(value: u128) -> Uuid {
    Uuid::from_u128(value)
}

fn test_recipient_set(identity: DevicePublicIdentity) -> CloudRecipientSet {
    CloudRecipientSet::try_new(vec![CloudRecipient::try_new(
        test_uuid(0x20000000000000000000000000000002),
        identity,
    )
    .unwrap()])
    .unwrap()
}

fn test_metadata() -> CloudEnvelopeMetadata {
    CloudEnvelopeMetadata::try_new(
        test_uuid(0x10000000000000000000000000000001),
        test_uuid(0x40000000000000000000000000000001),
        "root-session-a".into(),
        "episode-a".into(),
        "codex".into(),
        "org2.continuation.checkpoint".into(),
        1,
        RecipientScope::Audience,
        test_uuid(0x20000000000000000000000000000001),
        NOW_MS,
        NOW_MS + 3_600_000,
        NOW_MS,
    )
    .unwrap()
}

struct MemoryIdentityManager {
    _temp: tempfile::TempDir,
    manager: DeviceIdentityManager<MemorySecretStore>,
}

impl Deref for MemoryIdentityManager {
    type Target = DeviceIdentityManager<MemorySecretStore>;

    fn deref(&self) -> &Self::Target {
        &self.manager
    }
}

fn memory_manager(store: MemorySecretStore) -> MemoryIdentityManager {
    let temp = tempfile::tempdir().unwrap();
    let staging = PrivateStagingDirectory::create(temp.path()).unwrap();
    let manager = DeviceIdentityManager::new(store, staging);
    MemoryIdentityManager {
        _temp: temp,
        manager,
    }
}

fn identities() -> (
    MemoryIdentityManager,
    DevicePrivateIdentity,
    DevicePrivateIdentity,
) {
    let store = MemorySecretStore::default();
    let manager = memory_manager(store);
    let sender = manager
        .load_or_create(test_uuid(0x30000000000000000000000000000001))
        .expect("sender identity");
    let recipient = manager
        .load_or_create(test_uuid(0x30000000000000000000000000000002))
        .expect("recipient identity");
    (manager, sender, recipient)
}

#[test]
fn cloud_fingerprint_golden_vector_matches_raw_key_contract() {
    let encryption: [u8; 32] = std::array::from_fn(|index| index as u8);
    let signing: [u8; 32] = std::array::from_fn(|index| (index + 32) as u8);
    assert_eq!(
        hex::encode(device_fingerprint(&encryption, &signing)),
        "3b7ec85045344de1f5b326e474baab6f293a211bbcb41e50b95aaa9ea10c6a9a"
    );
}

#[test]
fn canonical_header_and_signed_bytes_have_exact_golden_vector() {
    let encryption_sender: [u8; 32] = std::array::from_fn(|index| index as u8);
    let encryption_recipient: [u8; 32] = std::array::from_fn(|index| (index + 32) as u8);
    let sender_signing_public: [u8; 32] =
        hex::decode("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
            .unwrap()
            .try_into()
            .unwrap();
    let recipient_signing_public: [u8; 32] =
        hex::decode("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c")
            .unwrap()
            .try_into()
            .unwrap();
    let sender = DevicePublicIdentity::try_new(
        test_uuid(0x30000000000000000000000000000001),
        7,
        encryption_sender,
        sender_signing_public,
        device_fingerprint(&encryption_sender, &sender_signing_public),
    )
    .unwrap();
    let recipient = DevicePublicIdentity::try_new(
        test_uuid(0x30000000000000000000000000000002),
        9,
        encryption_recipient,
        recipient_signing_public,
        device_fingerprint(&encryption_recipient, &recipient_signing_public),
    )
    .unwrap();
    let encryption_recipient_two: [u8; 32] = std::array::from_fn(|index| (index + 64) as u8);
    let recipient_two_signing_public = SigningKey::from_bytes(&[3; 32]).verifying_key().to_bytes();
    let recipient_two = DevicePublicIdentity::try_new(
        test_uuid(0x30000000000000000000000000000003),
        11,
        encryption_recipient_two,
        recipient_two_signing_public,
        device_fingerprint(&encryption_recipient_two, &recipient_two_signing_public),
    )
    .unwrap();
    // Constructor input is deliberately reversed; canonicalization is raw
    // `(user UUID, device UUID, key version)` byte ordering.
    let recipients = CloudRecipientSet::try_new(vec![
        CloudRecipient::try_new(test_uuid(0x20000000000000000000000000000003), recipient_two)
            .unwrap(),
        CloudRecipient::try_new(test_uuid(0x20000000000000000000000000000002), recipient).unwrap(),
    ])
    .unwrap();
    let recipient_set_sha256 = recipients.sha256();
    let digest = [0xa5; 32];
    let header = ContinuationEnvelopeHeader {
        encryption_algorithm: EncryptionAlgorithm::AgeX25519,
        signature_algorithm: SignatureAlgorithm::Ed25519,
        compression_algorithm: CompressionAlgorithm::Gzip,
        hash_algorithm: HashAlgorithm::Sha256,
        org_id: test_uuid(0x10000000000000000000000000000001),
        checkpoint_id: test_uuid(0x40000000000000000000000000000001),
        root_session_id: "root-session-a".into(),
        source_episode_id: "episode-a".into(),
        source_runtime: "codex".into(),
        payload_schema: "org2.portable_conversation".into(),
        payload_schema_version: 2,
        recipient_scope: RecipientScope::Audience,
        sender_user_id: test_uuid(0x20000000000000000000000000000001),
        sender,
        recipients,
        recipient_set_sha256,
        age_ciphertext_sha256: digest,
        created_at_unix_ms: NOW_MS,
        expires_at_unix_ms: NOW_MS + 3_600_000,
        age_ciphertext_len: 1_234,
    };
    let raw_header = canonical_header_bytes(&header).unwrap();
    let signed = signature_message(&raw_header, &digest).unwrap();
    let signing_seed: [u8; 32] =
        hex::decode("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
            .unwrap()
            .try_into()
            .unwrap();
    let signature = SigningKey::from_bytes(&signing_seed).sign(&signed);

    assert_eq!(
        header.recipients.as_slice()[0].identity().fingerprint_hex(),
        "d137b40d6290e550801d7481ebaab1ca9ca2f1936e89ddb26ede2b663a0d57db"
    );
    assert_eq!(
        header.recipients.as_slice()[1].identity().fingerprint_hex(),
        "0aa1f475680f3504f42465144b415100ab0d25b787494a1860ccca47af8197b4"
    );
    assert_eq!(
        hex::encode(recipient_set_sha256),
        "9ddfed1c641fa7cd2e0b93511b878361a3bedf8485708c75f0057ab6429ecbb7"
    );
    assert_eq!(raw_header.len(), 587);
    assert_eq!(
        hex::encode(&raw_header),
        "010101011000000000000000000000000000000140000000000000000000000000000001000e726f6f742d73657373696f6e2d610009657069736f64652d610005636f646578001a6f7267322e706f727461626c655f636f6e766572736174696f6e000201200000000000000000000000000000013000000000000000000000000000000100000007000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1fd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a5c63ff72e6ce93d42fe2dab5ef6a11bc9aeba024d6176910d9dfb8d9460c397a00029ddfed1c641fa7cd2e0b93511b878361a3bedf8485708c75f0057ab6429ecbb7200000000000000000000000000000023000000000000000000000000000000200000009202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660cd137b40d6290e550801d7481ebaab1ca9ca2f1936e89ddb26ede2b663a0d57db20000000000000000000000000000003300000000000000000000000000000030000000b404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5fed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d10aa1f475680f3504f42465144b415100ab0d25b787494a1860ccca47af8197b4a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5000001a3185c5000000001a318933e8000000000000004d2"
    );
    assert_eq!(
        hex::encode(Sha256::digest(&raw_header)),
        "4bd4bde95b64e5a2230068bcf672184c3e4f64df6a010af1e1132d174841a5e1"
    );
    assert_eq!(
        hex::encode(Sha256::digest(&signed)),
        "eca71c52611d9317c51a0a4526a1f86bc68655dbaec73c35a7dfdd1f2f3fa10c"
    );
    assert_eq!(
        hex::encode(signature.to_bytes()),
        "b612ae200776267d65b3635502e5044bd0910d5584d6d9cbeabf05823ee13927a946b1273b8527e3c767ef4effcd9cdc5242674b9c665993b8b5983874c7bd07"
    );
}

#[test]
fn recipient_sets_sort_and_reject_ambiguous_device_routes_or_excess_entries() {
    let (manager, _sender, recipient_one) = identities();
    let recipient_two = manager
        .load_or_create(test_uuid(0x30000000000000000000000000000003))
        .unwrap();
    let first = CloudRecipient::try_new(
        test_uuid(0x20000000000000000000000000000002),
        recipient_one.public_identity().unwrap(),
    )
    .unwrap();
    let second = CloudRecipient::try_new(
        test_uuid(0x20000000000000000000000000000003),
        recipient_two.public_identity().unwrap(),
    )
    .unwrap();
    let sorted = CloudRecipientSet::try_new(vec![second.clone(), first.clone()]).unwrap();
    assert_eq!(sorted.as_slice(), &[first.clone(), second]);

    assert!(CloudRecipientSet::try_new(vec![
        first.clone(),
        CloudRecipient::try_new(
            test_uuid(0x20000000000000000000000000000003),
            first.identity().clone(),
        )
        .unwrap(),
    ])
    .is_err());

    let old = manager
        .load_or_create(test_uuid(0x30000000000000000000000000000004))
        .unwrap();
    let current = manager.rotate(old.device_id()).unwrap();
    assert!(CloudRecipientSet::try_new(vec![
        CloudRecipient::try_new(
            test_uuid(0x20000000000000000000000000000004),
            old.public_identity().unwrap(),
        )
        .unwrap(),
        CloudRecipient::try_new(
            test_uuid(0x20000000000000000000000000000004),
            current.public_identity().unwrap(),
        )
        .unwrap(),
    ])
    .is_err());

    let too_many = (1..=65)
        .map(|index| {
            let encryption = [index as u8; 32];
            let signing = SigningKey::from_bytes(&[index as u8; 32])
                .verifying_key()
                .to_bytes();
            let identity = DevicePublicIdentity::try_new(
                Uuid::from_u128(0x50000000000000000000000000000000 + index),
                1,
                encryption,
                signing,
                device_fingerprint(&encryption, &signing),
            )
            .unwrap();
            CloudRecipient::try_new(
                Uuid::from_u128(0x60000000000000000000000000000000 + index),
                identity,
            )
            .unwrap()
        })
        .collect();
    assert!(CloudRecipientSet::try_new(too_many).is_err());
}

#[test]
fn cloud_routing_metadata_and_receipt_sql_encodings_are_strict() {
    let valid = || {
        CloudEnvelopeMetadata::try_from_sql(
            "10000000-0000-0000-0000-000000000001",
            "40000000-0000-0000-0000-000000000001",
            "root-session-a".into(),
            "episode-a".into(),
            "codex".into(),
            "org2.continuation.checkpoint".into(),
            1,
            "audience",
            "20000000-0000-0000-0000-000000000001",
            NOW_MS,
            NOW_MS + 3_600_000,
            NOW_MS,
        )
    };
    assert!(valid().is_ok());
    assert!(CloudEnvelopeMetadata::try_from_sql(
        "10000000-0000-0000-0000-000000000001",
        "40000000-0000-0000-0000-000000000001",
        "root-session-a".into(),
        "episode-a".into(),
        "Codex".into(),
        "org2.continuation.checkpoint".into(),
        1,
        "audience",
        "20000000-0000-0000-0000-000000000001",
        NOW_MS,
        NOW_MS + 3_600_000,
        NOW_MS,
    )
    .is_err());
    assert!(CloudEnvelopeMetadata::try_from_sql(
        "10000000-0000-0000-0000-000000000001",
        "40000000-0000-0000-0000-000000000001",
        "x".repeat(201),
        "episode-a".into(),
        "codex".into(),
        "org2.continuation.checkpoint".into(),
        1,
        "subset",
        "20000000-0000-0000-0000-000000000001",
        NOW_MS,
        NOW_MS + 3_600_000,
        NOW_MS,
    )
    .is_err());
    assert!(CloudEnvelopeMetadata::try_from_sql(
        "10000000-0000-0000-0000-000000000001",
        "40000000-0000-0000-0000-000000000001",
        "root-session-a".into(),
        "episode-a".into(),
        "codex".into(),
        "org2.continuation.checkpoint".into(),
        1,
        "all",
        "20000000-0000-0000-0000-000000000001",
        NOW_MS,
        NOW_MS + 3_600_000,
        NOW_MS,
    )
    .is_err());
    assert!(CloudEnvelopeMetadata::try_from_sql(
        "10000000-0000-0000-0000-000000000001",
        "40000000-0000-0000-0000-000000000001",
        "root-session-a".into(),
        "episode-a".into(),
        "codex".into(),
        "org2.continuation.checkpoint".into(),
        1,
        "audience",
        "20000000-0000-0000-0000-000000000001",
        NOW_MS,
        NOW_MS + 299_999,
        NOW_MS,
    )
    .is_err());

    let (_manager, _sender, recipient) = identities();
    let identity = recipient.public_identity().unwrap();
    let device_id = identity.device_id.to_string();
    let encryption = URL_SAFE_NO_PAD.encode(identity.encryption_public_key);
    let signing = URL_SAFE_NO_PAD.encode(identity.signing_public_key);
    let fingerprint = identity.fingerprint_hex();
    let receipt = |user_id: &str, key_version: i32, encryption_key: &str| {
        CommittedRecipientReceipt::try_from_sql(CommittedRecipientReceiptSql {
            org_id: "10000000-0000-0000-0000-000000000001",
            checkpoint_id: "40000000-0000-0000-0000-000000000001",
            recipient_user_id: user_id,
            recipient_device_id: &device_id,
            recipient_key_version: key_version,
            recipient_encryption_public_key: encryption_key,
            recipient_signing_public_key: &signing,
            recipient_fingerprint: &fingerprint,
        })
    };
    assert!(receipt(
        "20000000-0000-0000-0000-000000000002",
        identity.key_version as i32,
        &encryption,
    )
    .is_ok());
    assert!(receipt("20000000-0000-0000-0000-000000000002", 0, &encryption,).is_err());
    let padded = format!("{encryption}=");
    assert!(receipt(
        "20000000-0000-0000-0000-000000000002",
        identity.key_version as i32,
        &padded,
    )
    .is_err());
    assert!(receipt(
        "20000000-0000-0000-0000-00000000000A",
        identity.key_version as i32,
        &encryption,
    )
    .is_err());
}

#[test]
fn secure_store_round_trip_and_sixteen_rotations_preserve_version_one() {
    let store = MemorySecretStore::default();
    let manager = memory_manager(store);
    let device_id = test_uuid(0x3000000000000000000000000000000a);
    let first = manager.load_or_create(device_id).unwrap();
    let first_public = first.public_identity().unwrap();
    assert_eq!(first_public.key_version, 1);
    let again = manager.load_or_create(device_id).unwrap();
    assert_eq!(again.public_identity().unwrap(), first_public);

    for expected in 2..=17 {
        let rotated = manager.rotate(device_id).unwrap();
        assert_eq!(rotated.key_version(), expected);
    }
    assert_eq!(manager.load_version(device_id, 1).unwrap().key_version(), 1);
    assert_eq!(manager.load_version(device_id, 3).unwrap().key_version(), 3);
    assert_eq!(manager.load_current(device_id).unwrap().key_version(), 17);
}

#[test]
fn independent_managers_serialize_rotation_to_versions_two_then_three() {
    let temp = tempfile::tempdir().unwrap();
    let staging = PrivateStagingDirectory::create(temp.path()).unwrap();
    let store = MemorySecretStore::default();
    let first_manager = DeviceIdentityManager::new(store.clone(), staging.clone());
    let second_manager = DeviceIdentityManager::new(store.clone(), staging.clone());
    let device_id = test_uuid(0x3000000000000000000000000000000b);
    first_manager.load_or_create(device_id).unwrap();
    let barrier = Arc::new(std::sync::Barrier::new(3));
    let first_barrier = Arc::clone(&barrier);
    let first = std::thread::spawn(move || {
        first_barrier.wait();
        first_manager.rotate(device_id).unwrap().key_version()
    });
    let second_barrier = Arc::clone(&barrier);
    let second = std::thread::spawn(move || {
        second_barrier.wait();
        second_manager.rotate(device_id).unwrap().key_version()
    });
    barrier.wait();
    let mut versions = [first.join().unwrap(), second.join().unwrap()];
    versions.sort_unstable();
    assert_eq!(versions, [2, 3]);
    let verifier = DeviceIdentityManager::new(store, staging);
    assert_eq!(
        verifier.load_version(device_id, 1).unwrap().key_version(),
        1
    );
    assert_eq!(verifier.load_current(device_id).unwrap().key_version(), 3);
}

#[test]
fn unavailable_os_store_fails_closed_without_ephemeral_identity() {
    let temp = tempfile::tempdir().unwrap();
    let manager = DeviceIdentityManager::new(
        UnavailableSecretStore,
        PrivateStagingDirectory::create(temp.path()).unwrap(),
    );
    assert!(matches!(
        manager.load_or_create(test_uuid(0x3000000000000000000000000000000c)),
        Err(ContinuationCryptoError::SecretStore(
            SecretStoreError::Unavailable
        ))
    ));
}

#[test]
fn corrupt_secure_store_record_fails_closed_without_replacing_keys() {
    let store = MemorySecretStore::default();
    let device_id = test_uuid(0x3000000000000000000000000000000d);
    let pointer_entry = format!("device:{device_id}:active");
    store
        .values
        .lock()
        .unwrap()
        .insert(pointer_entry.clone(), b"not-an-active-pointer".to_vec());
    let manager = memory_manager(store.clone());
    assert!(matches!(
        manager.load_or_create(device_id),
        Err(ContinuationCryptoError::CorruptIdentity(_))
    ));
    assert_eq!(
        store.values.lock().unwrap().get(&pointer_entry).unwrap(),
        b"not-an-active-pointer"
    );
}

#[test]
fn secure_store_pointer_crashes_recover_the_exact_persisted_key() {
    let temp = tempfile::tempdir().unwrap();
    let staging = PrivateStagingDirectory::create(temp.path()).unwrap();
    let inner = MemorySecretStore::default();
    let fail_flag = Arc::new(AtomicBool::new(true));
    let faulting = DeviceIdentityManager::new(
        FailActivePointerStore {
            inner: inner.clone(),
            fail_next_active_store: Arc::clone(&fail_flag),
        },
        staging.clone(),
    );
    let device_id = test_uuid(0x3000000000000000000000000000000e);
    assert!(matches!(
        faulting.load_or_create(device_id),
        Err(ContinuationCryptoError::SecretStore(
            SecretStoreError::Rejected
        ))
    ));
    let key_entry = format!("device:{device_id}:key:1");
    let pointer_entry = format!("device:{device_id}:active");
    assert!(inner.values.lock().unwrap().contains_key(&key_entry));
    assert!(!inner.values.lock().unwrap().contains_key(&pointer_entry));

    let recovered = DeviceIdentityManager::new(inner.clone(), staging.clone())
        .load_or_create(device_id)
        .unwrap();
    assert_eq!(recovered.key_version(), 1);

    let normal = DeviceIdentityManager::new(inner.clone(), staging.clone());
    let before_rotation = normal.load_current(device_id).unwrap();
    assert_eq!(
        before_rotation.public_identity().unwrap(),
        recovered.public_identity().unwrap()
    );
    fail_flag.store(true, Ordering::SeqCst);
    let faulting_rotation = DeviceIdentityManager::new(
        FailActivePointerStore {
            inner: inner.clone(),
            fail_next_active_store: Arc::clone(&fail_flag),
        },
        staging.clone(),
    );
    assert!(matches!(
        faulting_rotation.rotate(device_id),
        Err(ContinuationCryptoError::SecretStore(
            SecretStoreError::Rejected
        ))
    ));
    let persisted_v2 = normal
        .load_version(device_id, 2)
        .unwrap()
        .public_identity()
        .unwrap();
    let retried_v2 = normal.rotate(device_id).unwrap().public_identity().unwrap();
    assert_eq!(retried_v2, persisted_v2);
    assert_eq!(normal.load_current(device_id).unwrap().key_version(), 2);
}

#[test]
fn tampered_per_version_key_record_fails_checksum_without_replacement() {
    let store = MemorySecretStore::default();
    let manager = memory_manager(store.clone());
    let device_id = test_uuid(0x3000000000000000000000000000000f);
    manager.load_or_create(device_id).unwrap();
    let key_entry = format!("device:{device_id}:key:1");
    let original = store
        .values
        .lock()
        .unwrap()
        .get(&key_entry)
        .unwrap()
        .clone();
    store.values.lock().unwrap().get_mut(&key_entry).unwrap()[17] ^= 1;
    assert!(matches!(
        manager.load_current(device_id),
        Err(ContinuationCryptoError::CorruptIdentity(_))
    ));
    assert_ne!(
        store.values.lock().unwrap().get(&key_entry).unwrap(),
        &original
    );
}

#[test]
fn encrypted_checkpoint_round_trips_with_age_and_owner_only_atomic_file() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("checkpoint.org2h");
    let (_manager, sender, recipient) = identities();
    let recipient_public = recipient.public_identity().unwrap();
    let source = fixture(b"event payload", b"native transcript\nline two\n");
    let artifact = write_fixture(&path, &sender, &recipient_public, &source).unwrap();
    assert_ne!(artifact.header().age_ciphertext_sha256, [0; 32]);
    assert_eq!(
        artifact.object_size(),
        std::fs::metadata(&path).unwrap().len()
    );
    let actual_object_sha256: [u8; 32] = Sha256::digest(std::fs::read(&path).unwrap()).into();
    assert_eq!(*artifact.object_sha256(), actual_object_sha256);
    let file_bytes = std::fs::read(&path).unwrap();
    let footer_signature_offset = file_bytes.len() - SIGNATURE_BYTES - ENVELOPE_END_MAGIC.len();
    assert_eq!(
        artifact.signature().as_slice(),
        &file_bytes[footer_signature_offset..footer_signature_offset + SIGNATURE_BYTES]
    );

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    assert!(std::fs::read_dir(temp.path()).unwrap().all(|entry| {
        !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".ciphertext.tmp")
    }));

    let mut sink = CollectingSink::default();
    let verified = decrypt_local_checkpoint(
        &path,
        &staging_for(&path),
        &sender.public_identity().unwrap(),
        &recipient,
        NOW_MS + 1,
        LOCAL_CHECKPOINT_LIMITS,
        &mut sink,
    )
    .unwrap();
    assert_eq!(verified.artifact(), &artifact);
    assert_eq!(sink.events.len(), 1);
    assert_eq!(sink.events[0].payload, b"event payload");
    assert_eq!(sink.blobs[0].1, b"native transcript\nline two\n");
    assert_eq!(sink.manifest, Some(source.manifest));
    assert_eq!(sink.footer, Some(verified.footer));
    assert_eq!(sink.begin_count, 1);
    assert_eq!(sink.commit_count, 1);
    assert_eq!(sink.abort_count, 0);
}

#[test]
fn verified_snapshot_is_immutable_across_path_swap_and_in_place_mutation() {
    let temp = tempfile::tempdir().unwrap();
    let path_swap_source = temp.path().join("path-swap.org2h");
    let replacement = temp.path().join("replacement.org2h");
    let displaced = temp.path().join("displaced.org2h");
    let in_place_source = temp.path().join("in-place.org2h");
    let staging = staging_for(&path_swap_source);
    let (_manager, sender, recipient) = identities();
    let recipient_public = recipient.public_identity().unwrap();
    let original = fixture(b"original event", b"original blob");
    let changed = fixture(b"replacement event", b"replacement blob");
    write_fixture(&path_swap_source, &sender, &recipient_public, &original).unwrap();
    write_fixture(&replacement, &sender, &recipient_public, &changed).unwrap();

    let mut path_swap_sink = CollectingSink::default();
    crate::envelope::decrypt_local_checkpoint_with_hook(
        &path_swap_source,
        &staging,
        &sender.public_identity().unwrap(),
        &recipient,
        NOW_MS + 1,
        LOCAL_CHECKPOINT_LIMITS,
        &mut path_swap_sink,
        || {
            std::fs::rename(&path_swap_source, &displaced).unwrap();
            std::fs::rename(&replacement, &path_swap_source).unwrap();
        },
    )
    .unwrap();
    assert_eq!(path_swap_sink.events[0].payload, b"original event");
    assert_eq!(path_swap_sink.blobs[0].1, b"original blob");
    assert_eq!(path_swap_sink.commit_count, 1);

    write_fixture(&in_place_source, &sender, &recipient_public, &original).unwrap();
    let mut in_place_sink = CollectingSink::default();
    crate::envelope::decrypt_local_checkpoint_with_hook(
        &in_place_source,
        &staging,
        &sender.public_identity().unwrap(),
        &recipient,
        NOW_MS + 1,
        LOCAL_CHECKPOINT_LIMITS,
        &mut in_place_sink,
        || {
            use std::io::Write as _;
            let mut source = std::fs::OpenOptions::new()
                .write(true)
                .truncate(true)
                .open(&in_place_source)
                .unwrap();
            source.write_all(b"mutated after snapshot").unwrap();
            source.sync_all().unwrap();
        },
    )
    .unwrap();
    assert_eq!(in_place_sink.events[0].payload, b"original event");
    assert_eq!(in_place_sink.blobs[0].1, b"original blob");
    assert_eq!(in_place_sink.commit_count, 1);
}

#[test]
fn outer_verification_and_sink_failures_publish_zero_sink_side_effects() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("transactional-sink.org2h");
    let staging = staging_for(&path);
    let (_manager, sender, recipient) = identities();
    let recipient_public = recipient.public_identity().unwrap();
    let source = fixture(b"event", b"blob");
    write_fixture(&path, &sender, &recipient_public, &source).unwrap();
    let mut tampered = std::fs::read(&path).unwrap();
    let header_len = u32::from_be_bytes(tampered[10..14].try_into().unwrap()) as usize;
    tampered[14 + header_len + 5] ^= 1;
    std::fs::write(&path, tampered).unwrap();
    let mut untouched = CollectingSink::default();
    assert!(matches!(
        decrypt_local_checkpoint(
            &path,
            &staging,
            &sender.public_identity().unwrap(),
            &recipient,
            NOW_MS + 1,
            LOCAL_CHECKPOINT_LIMITS,
            &mut untouched,
        ),
        Err(ContinuationCryptoError::CiphertextHashMismatch)
    ));
    assert_eq!(untouched.begin_count, 0);
    assert_eq!(untouched.commit_count, 0);
    assert_eq!(untouched.abort_count, 0);
    assert!(untouched.manifest.is_none());
    assert!(untouched.events.is_empty());
    assert!(untouched.blobs.is_empty());

    let clean_path = temp.path().join("transactional-sink-clean.org2h");
    write_fixture(&clean_path, &sender, &recipient_public, &source).unwrap();
    let clean_staging = staging_for(&clean_path);
    let mut failing = CollectingSink {
        fail_after_staging_event: true,
        ..CollectingSink::default()
    };
    assert!(matches!(
        decrypt_local_checkpoint(
            &clean_path,
            &clean_staging,
            &sender.public_identity().unwrap(),
            &recipient,
            NOW_MS + 1,
            LOCAL_CHECKPOINT_LIMITS,
            &mut failing,
        ),
        Err(ContinuationCryptoError::InvalidFrame(
            "simulated transactional sink failure"
        ))
    ));
    assert_eq!(failing.begin_count, 1);
    assert_eq!(failing.commit_count, 0);
    assert_eq!(failing.abort_count, 1);
    assert!(failing.pending.is_none());
    assert!(failing.manifest.is_none());
    assert!(failing.events.is_empty());
    assert!(failing.blobs.is_empty());
}

#[test]
fn cloud_entrypoint_pins_row_metadata_footer_signature_and_16_mib_profile() {
    assert_eq!(CLOUD_CHECKPOINT_LIMITS.max_envelope_bytes, 16 * 1024 * 1024);
    assert_eq!(
        LOCAL_CHECKPOINT_LIMITS.max_envelope_bytes,
        512 * 1024 * 1024
    );
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("cloud-checkpoint.org2h");
    let (manager, sender, recipient) = identities();
    let recipient_public = recipient.public_identity().unwrap();
    let recipient_two = manager
        .load_or_create(test_uuid(0x30000000000000000000000000000003))
        .unwrap();
    let recipient_two_public = recipient_two.public_identity().unwrap();
    let recipients = CloudRecipientSet::try_new(vec![
        CloudRecipient::try_new(
            test_uuid(0x20000000000000000000000000000003),
            recipient_two_public.clone(),
        )
        .unwrap(),
        CloudRecipient::try_new(
            test_uuid(0x20000000000000000000000000000002),
            recipient_public.clone(),
        )
        .unwrap(),
    ])
    .unwrap();
    let source = fixture(b"cloud event", b"cloud blob");
    let artifact = write_cloud_checkpoint_atomic(
        &path,
        &staging_for(&path),
        "cloud-job",
        CloudEnvelopeWriteRequest {
            metadata: test_metadata(),
            sender: &sender,
            recipients,
            manifest: source.manifest,
        },
        |writer| {
            writer.write_event(7, "event-7", "agent-event", source.event_payload)?;
            writer.write_blob(&source.blob, &mut Cursor::new(source.blob_payload))
        },
    )
    .unwrap();
    let header = artifact.header();
    let checkpoint_id = header.checkpoint_id.to_string();
    let org_id = header.org_id.to_string();
    let sender_user_id = header.sender_user_id.to_string();
    let sender_device_id = header.sender.device_id.to_string();
    let recipient_set_sha256 = hex::encode(header.recipient_set_sha256);
    let object_sha256 = hex::encode(artifact.object_sha256());
    let age_ciphertext_sha256 = hex::encode(header.age_ciphertext_sha256);
    let footer_signature = URL_SAFE_NO_PAD.encode(artifact.signature());
    let sender_encryption_public_key = URL_SAFE_NO_PAD.encode(header.sender.encryption_public_key);
    let sender_signing_public_key = URL_SAFE_NO_PAD.encode(header.sender.signing_public_key);
    let sender_fingerprint = hex::encode(header.sender.fingerprint);
    macro_rules! row {
        ($sender_user:expr, $sender_device:expr, $recipient_count:expr, $set_hash:expr $(,)?) => {
            CommittedCloudEnvelopeSql {
                checkpoint_id: &checkpoint_id,
                org_id: &org_id,
                root_session_id: &header.root_session_id,
                source_episode_id: &header.source_episode_id,
                client_created_at_unix_ms: header.created_at_unix_ms,
                sender_user_id: $sender_user,
                sender_device_id: $sender_device,
                sender_key_version: header.sender.key_version as i32,
                source_runtime: &header.source_runtime,
                payload_schema: &header.payload_schema,
                payload_schema_version: i32::from(header.payload_schema_version),
                recipient_scope: "audience",
                recipient_count: $recipient_count,
                recipient_set_sha256: $set_hash,
                object_size: artifact.object_size() as i64,
                object_sha256: &object_sha256,
                age_ciphertext_len: header.age_ciphertext_len as i64,
                age_ciphertext_sha256: &age_ciphertext_sha256,
                footer_signature: &footer_signature,
                expires_at_unix_ms: header.expires_at_unix_ms,
                canonical_header: artifact.canonical_header(),
                sender_encryption_public_key: &sender_encryption_public_key,
                sender_signing_public_key: &sender_signing_public_key,
                sender_fingerprint: &sender_fingerprint,
            }
        };
    }
    let expected = CommittedCloudEnvelope::try_from_sql(
        row!(
            &sender_user_id,
            &sender_device_id,
            header.recipients.as_slice().len() as i32,
            &recipient_set_sha256,
        ),
        NOW_MS + 1,
    )
    .unwrap();
    let make_receipt = |user_id: Uuid, identity: &DevicePublicIdentity| {
        let recipient_user_id = user_id.to_string();
        let recipient_device_id = identity.device_id.to_string();
        let recipient_encryption_public_key =
            URL_SAFE_NO_PAD.encode(identity.encryption_public_key);
        let recipient_signing_public_key = URL_SAFE_NO_PAD.encode(identity.signing_public_key);
        let recipient_fingerprint = hex::encode(identity.fingerprint);
        CommittedRecipientReceipt::try_from_sql(CommittedRecipientReceiptSql {
            org_id: &org_id,
            checkpoint_id: &checkpoint_id,
            recipient_user_id: &recipient_user_id,
            recipient_device_id: &recipient_device_id,
            recipient_key_version: identity.key_version as i32,
            recipient_encryption_public_key: &recipient_encryption_public_key,
            recipient_signing_public_key: &recipient_signing_public_key,
            recipient_fingerprint: &recipient_fingerprint,
        })
        .unwrap()
    };
    let receipt = make_receipt(
        test_uuid(0x20000000000000000000000000000002),
        &recipient_public,
    );
    let receipt_two = make_receipt(
        test_uuid(0x20000000000000000000000000000003),
        &recipient_two_public,
    );
    let swapped_user_receipt = make_receipt(
        test_uuid(0x20000000000000000000000000000003),
        &recipient_public,
    );
    for (private, receipt) in [(&recipient, &receipt), (&recipient_two, &receipt_two)] {
        let verified = decrypt_cloud_checkpoint(
            &path,
            &staging_for(&path),
            CloudCheckpointDecryptRequest {
                expected: &expected,
                receipt,
                trusted_sender: &sender.public_identity().unwrap(),
                recipient: private,
                now_unix_ms: NOW_MS + 1,
            },
            &mut CollectingSink::default(),
        )
        .unwrap();
        assert_eq!(verified.artifact(), &artifact);
    }

    let noncanonical_path = temp.path().join("noncanonical-recipient-order.org2h");
    let mut noncanonical = std::fs::read(&path).unwrap();
    let first_user = test_uuid(0x20000000000000000000000000000002);
    let second_user = test_uuid(0x20000000000000000000000000000003);
    let first_header_offset = artifact
        .canonical_header()
        .windows(16)
        .position(|window| window == first_user.as_bytes())
        .unwrap();
    let second_header_offset = artifact
        .canonical_header()
        .windows(16)
        .position(|window| window == second_user.as_bytes())
        .unwrap();
    const RECIPIENT_ENTRY_BYTES: usize = 16 + 16 + 4 + 32 + 32 + 32;
    let first_entry = artifact.canonical_header()
        [first_header_offset..first_header_offset + RECIPIENT_ENTRY_BYTES]
        .to_vec();
    let second_entry = artifact.canonical_header()
        [second_header_offset..second_header_offset + RECIPIENT_ENTRY_BYTES]
        .to_vec();
    let prefix_bytes = ENVELOPE_MAGIC.len() + 2 + 4;
    noncanonical[prefix_bytes + first_header_offset
        ..prefix_bytes + first_header_offset + RECIPIENT_ENTRY_BYTES]
        .copy_from_slice(&second_entry);
    noncanonical[prefix_bytes + second_header_offset
        ..prefix_bytes + second_header_offset + RECIPIENT_ENTRY_BYTES]
        .copy_from_slice(&first_entry);
    std::fs::write(&noncanonical_path, noncanonical).unwrap();
    let mut untouched = CollectingSink::default();
    assert!(matches!(
        decrypt_local_checkpoint(
            &noncanonical_path,
            &staging_for(&noncanonical_path),
            &sender.public_identity().unwrap(),
            &recipient,
            NOW_MS + 1,
            LOCAL_CHECKPOINT_LIMITS,
            &mut untouched,
        ),
        Err(ContinuationCryptoError::InvalidEnvelope(
            "recipient list is not in strict canonical order"
        ))
    ));
    assert_eq!(untouched.begin_count, 0);

    for swapped in [
        row!(
            "20000000-0000-0000-0000-000000000002",
            &sender_device_id,
            header.recipients.as_slice().len() as i32,
            &recipient_set_sha256,
        ),
        row!(
            &sender_user_id,
            "30000000-0000-0000-0000-000000000002",
            header.recipients.as_slice().len() as i32,
            &recipient_set_sha256,
        ),
        row!(&sender_user_id, &sender_device_id, 1, &recipient_set_sha256,),
        row!(
            &sender_user_id,
            &sender_device_id,
            header.recipients.as_slice().len() as i32,
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ),
    ] {
        assert!(CommittedCloudEnvelope::try_from_sql(swapped, NOW_MS + 1).is_err());
    }

    let mut wrong_object = expected.clone();
    wrong_object.object_sha256[0] ^= 1;
    assert!(matches!(
        decrypt_cloud_checkpoint(
            &path,
            &staging_for(&path),
            CloudCheckpointDecryptRequest {
                expected: &wrong_object,
                receipt: &receipt,
                trusted_sender: &sender.public_identity().unwrap(),
                recipient: &recipient,
                now_unix_ms: NOW_MS + 1,
            },
            &mut CollectingSink::default(),
        ),
        Err(ContinuationCryptoError::ObjectHashMismatch)
    ));

    let mut wrong_rpc_signature = expected.clone();
    wrong_rpc_signature.signature[0] ^= 1;
    assert!(matches!(
        decrypt_cloud_checkpoint(
            &path,
            &staging_for(&path),
            CloudCheckpointDecryptRequest {
                expected: &wrong_rpc_signature,
                receipt: &receipt,
                trusted_sender: &sender.public_identity().unwrap(),
                recipient: &recipient,
                now_unix_ms: NOW_MS + 1,
            },
            &mut CollectingSink::default(),
        ),
        Err(ContinuationCryptoError::CloudMetadataMismatch("signature"))
    ));

    assert!(matches!(
        decrypt_cloud_checkpoint(
            &path,
            &staging_for(&path),
            CloudCheckpointDecryptRequest {
                expected: &expected,
                receipt: &receipt_two,
                trusted_sender: &sender.public_identity().unwrap(),
                recipient: &recipient,
                now_unix_ms: NOW_MS + 1,
            },
            &mut CollectingSink::default(),
        ),
        Err(ContinuationCryptoError::WrongRecipient)
    ));
    assert!(matches!(
        decrypt_cloud_checkpoint(
            &path,
            &staging_for(&path),
            CloudCheckpointDecryptRequest {
                expected: &expected,
                receipt: &swapped_user_receipt,
                trusted_sender: &sender.public_identity().unwrap(),
                recipient: &recipient,
                now_unix_ms: NOW_MS + 1,
            },
            &mut CollectingSink::default(),
        ),
        Err(ContinuationCryptoError::CloudMetadataMismatch(
            "recipient receipt snapshot"
        ))
    ));
}

#[test]
fn full_envelope_limit_and_blob_consumption_are_enforced() {
    let temp = tempfile::tempdir().unwrap();
    let rejected_path = temp.path().join("full-object-too-large.org2h");
    let ciphertext_rejected_path = temp.path().join("ciphertext-too-large.org2h");
    let accepted_path = temp.path().join("blob-consumption.org2h");
    let (_manager, sender, recipient) = identities();
    let recipient_public = recipient.public_identity().unwrap();
    let source = fixture(b"event", b"blob");
    let mut tiny_limits = LOCAL_CHECKPOINT_LIMITS;
    tiny_limits.max_envelope_bytes = 1;
    let write_result = write_local_checkpoint_atomic(
        &rejected_path,
        &staging_for(&rejected_path),
        "rejected-job",
        LocalEnvelopeWriteRequest {
            metadata: test_metadata(),
            sender: &sender,
            recipients: test_recipient_set(recipient_public.clone()),
            manifest: source.manifest.clone(),
            limits: tiny_limits,
        },
        |writer| {
            writer.write_event(7, "event-7", "agent-event", source.event_payload)?;
            writer.write_blob(&source.blob, &mut Cursor::new(source.blob_payload))
        },
    );
    assert!(matches!(
        write_result,
        Err(ContinuationCryptoError::LimitExceeded {
            kind: LimitKind::EnvelopeBytes,
            ..
        })
    ));
    assert!(!rejected_path.exists());

    let mut tiny_ciphertext_limits = LOCAL_CHECKPOINT_LIMITS;
    tiny_ciphertext_limits.max_ciphertext_bytes = 1;
    let ciphertext_result = write_local_checkpoint_atomic(
        &ciphertext_rejected_path,
        &staging_for(&ciphertext_rejected_path),
        "ciphertext-rejected-job",
        LocalEnvelopeWriteRequest {
            metadata: test_metadata(),
            sender: &sender,
            recipients: test_recipient_set(recipient_public.clone()),
            manifest: source.manifest.clone(),
            limits: tiny_ciphertext_limits,
        },
        |writer| {
            writer.write_event(7, "event-7", "agent-event", source.event_payload)?;
            writer.write_blob(&source.blob, &mut Cursor::new(source.blob_payload))
        },
    );
    assert!(matches!(
        ciphertext_result,
        Err(ContinuationCryptoError::LimitExceeded {
            kind: LimitKind::CiphertextBytes,
            ..
        })
    ));
    assert!(!ciphertext_rejected_path.exists());

    write_fixture(&accepted_path, &sender, &recipient_public, &source).unwrap();
    assert!(matches!(
        decrypt_local_checkpoint(
            &accepted_path,
            &staging_for(&accepted_path),
            &sender.public_identity().unwrap(),
            &recipient,
            NOW_MS + 1,
            LOCAL_CHECKPOINT_LIMITS,
            &mut NonConsumingSink,
        ),
        Err(ContinuationCryptoError::BlobNotConsumed)
    ));
}

#[test]
fn ciphertext_header_and_signature_tampering_are_rejected_before_plaintext_delivery() {
    let temp = tempfile::tempdir().unwrap();
    let original = temp.path().join("original.org2h");
    let (_manager, sender, recipient) = identities();
    let recipient_public = recipient.public_identity().unwrap();
    let source = fixture(b"event", b"blob");
    let artifact = write_fixture(&original, &sender, &recipient_public, &source).unwrap();
    let sender_public = sender.public_identity().unwrap();
    let bytes = std::fs::read(&original).unwrap();
    let header_len = u32::from_be_bytes(bytes[10..14].try_into().unwrap()) as usize;
    let ciphertext_offset = 14 + header_len;

    let ciphertext_path = temp.path().join("ciphertext-tampered.org2h");
    let mut ciphertext = bytes.clone();
    ciphertext[ciphertext_offset + 5] ^= 1;
    std::fs::write(&ciphertext_path, ciphertext).unwrap();
    assert!(matches!(
        decrypt_local_checkpoint(
            &ciphertext_path,
            &staging_for(&ciphertext_path),
            &sender_public,
            &recipient,
            NOW_MS + 1,
            LOCAL_CHECKPOINT_LIMITS,
            &mut CollectingSink::default()
        ),
        Err(ContinuationCryptoError::CiphertextHashMismatch)
    ));

    let header_path = temp.path().join("header-tampered.org2h");
    let mut header_tampered = bytes.clone();
    let runtime_offset = header_tampered[..14 + header_len]
        .windows(b"codex".len())
        .position(|window| window == b"codex")
        .unwrap();
    header_tampered[runtime_offset] = b'd';
    std::fs::write(&header_path, header_tampered).unwrap();
    assert!(matches!(
        decrypt_local_checkpoint(
            &header_path,
            &staging_for(&header_path),
            &sender_public,
            &recipient,
            NOW_MS + 1,
            LOCAL_CHECKPOINT_LIMITS,
            &mut CollectingSink::default()
        ),
        Err(ContinuationCryptoError::InvalidSignature)
    ));

    let signature_path = temp.path().join("signature-tampered.org2h");
    let mut signature_tampered = bytes;
    let signature_offset = signature_tampered.len() - 64 - 8;
    signature_tampered[signature_offset + 17] ^= 1;
    std::fs::write(&signature_path, signature_tampered).unwrap();
    assert!(matches!(
        decrypt_local_checkpoint(
            &signature_path,
            &staging_for(&signature_path),
            &sender_public,
            &recipient,
            NOW_MS + 1,
            LOCAL_CHECKPOINT_LIMITS,
            &mut CollectingSink::default()
        ),
        Err(ContinuationCryptoError::InvalidSignature)
    ));

    assert_ne!(artifact.header().age_ciphertext_sha256, [0; 32]);
}

#[test]
fn truncated_outer_envelope_corpus_never_begins_a_sink_transaction() {
    let temp = tempfile::tempdir().unwrap();
    let original = temp.path().join("truncation-source.org2h");
    let (_manager, sender, recipient) = identities();
    let source = fixture(b"event", b"blob");
    write_fixture(
        &original,
        &sender,
        &recipient.public_identity().unwrap(),
        &source,
    )
    .unwrap();
    let bytes = std::fs::read(&original).unwrap();
    let header_len = u32::from_be_bytes(bytes[10..14].try_into().unwrap()) as usize;
    let cuts = [
        0,
        1,
        ENVELOPE_MAGIC.len() - 1,
        ENVELOPE_MAGIC.len(),
        13,
        14,
        14 + header_len / 2,
        14 + header_len,
        bytes.len() - SIGNATURE_BYTES - ENVELOPE_END_MAGIC.len(),
        bytes.len() - ENVELOPE_END_MAGIC.len(),
        bytes.len() - 1,
    ];
    for (index, cut) in cuts.into_iter().enumerate() {
        let path = temp.path().join(format!("truncated-{index}.org2h"));
        std::fs::write(&path, &bytes[..cut]).unwrap();
        let mut sink = CollectingSink::default();
        assert!(decrypt_local_checkpoint(
            &path,
            &staging_for(&path),
            &sender.public_identity().unwrap(),
            &recipient,
            NOW_MS + 1,
            LOCAL_CHECKPOINT_LIMITS,
            &mut sink,
        )
        .is_err());
        assert_eq!(sink.begin_count, 0);
        assert_eq!(sink.commit_count, 0);
        assert_eq!(sink.abort_count, 0);
    }
}

#[test]
fn wrong_recipient_expiry_limits_and_path_traversal_fail_closed() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("checkpoint.org2h");
    let (manager, sender, recipient) = identities();
    let recipient_public = recipient.public_identity().unwrap();
    let large_event = vec![b'x'; 2_048];
    let source = fixture(&large_event, b"blob");
    write_fixture(&path, &sender, &recipient_public, &source).unwrap();
    let other = manager
        .load_or_create(test_uuid(0x30000000000000000000000000000003))
        .unwrap();
    let sender_public = sender.public_identity().unwrap();
    assert!(matches!(
        decrypt_local_checkpoint(
            &path,
            &staging_for(&path),
            &sender_public,
            &other,
            NOW_MS + 1,
            LOCAL_CHECKPOINT_LIMITS,
            &mut CollectingSink::default()
        ),
        Err(ContinuationCryptoError::WrongRecipient)
    ));
    assert!(matches!(
        decrypt_local_checkpoint(
            &path,
            &staging_for(&path),
            &sender_public,
            &recipient,
            NOW_MS + 3_600_000,
            LOCAL_CHECKPOINT_LIMITS,
            &mut CollectingSink::default()
        ),
        Err(ContinuationCryptoError::Expired(_))
    ));
    let low_limits = CheckpointLimits {
        max_total_decompressed_bytes: 512,
        ..LOCAL_CHECKPOINT_LIMITS
    };
    assert!(matches!(
        decrypt_local_checkpoint(
            &path,
            &staging_for(&path),
            &sender_public,
            &recipient,
            NOW_MS + 1,
            low_limits,
            &mut CollectingSink::default()
        ),
        Err(ContinuationCryptoError::LimitExceeded {
            kind: LimitKind::TotalDecompressedBytes,
            ..
        })
    ));

    for relative_path in [
        "../../outside",
        "/absolute/path",
        "C:/windows/path",
        "windows\\backslash",
        "safe/../escape",
        "safe//ambiguous",
        "safe/NUL.txt",
        "safe/trailing.",
        "safe/含糊.bin",
    ] {
        let unsafe_blob = BlobMetadata {
            relative_path: relative_path.into(),
            media_type: "application/octet-stream".into(),
            content_len: 1,
            sha256: Sha256::digest(b"x").into(),
        };
        let mut hasher = CheckpointPlaintextHasher::new(LOCAL_CHECKPOINT_LIMITS);
        assert!(matches!(
            hasher.update_blob(&unsafe_blob, &mut Cursor::new(b"x")),
            Err(ContinuationCryptoError::UnsafePath(_))
        ));
    }
    let duplicate = BlobMetadata {
        relative_path: "safe/blob.bin".into(),
        media_type: "application/octet-stream".into(),
        content_len: 1,
        sha256: Sha256::digest(b"x").into(),
    };
    let mut hasher = CheckpointPlaintextHasher::new(LOCAL_CHECKPOINT_LIMITS);
    hasher
        .update_blob(&duplicate, &mut Cursor::new(b"x"))
        .unwrap();
    let duplicate_case_variant = BlobMetadata {
        relative_path: "SAFE/BLOB.BIN".into(),
        ..duplicate
    };
    assert!(matches!(
        hasher.update_blob(&duplicate_case_variant, &mut Cursor::new(b"x")),
        Err(ContinuationCryptoError::InvalidFrame("duplicate blob path"))
    ));
}

#[test]
fn old_recipient_key_remains_decryptable_after_rotation_without_implicit_pruning() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("old-key.org2h");
    let store = MemorySecretStore::default();
    let manager = memory_manager(store);
    let sender_id = test_uuid(0x30000000000000000000000000000011);
    let recipient_id = test_uuid(0x30000000000000000000000000000012);
    let sender = manager.load_or_create(sender_id).unwrap();
    let recipient_v1 = manager.load_or_create(recipient_id).unwrap();
    let recipient_v1_public = recipient_v1.public_identity().unwrap();
    let recipient_v2 = manager.rotate(recipient_id).unwrap();
    let source = fixture(b"event", b"blob");
    write_fixture(&path, &sender, &recipient_v1_public, &source).unwrap();
    assert!(matches!(
        decrypt_local_checkpoint(
            &path,
            &staging_for(&path),
            &sender.public_identity().unwrap(),
            &recipient_v2,
            NOW_MS + 1,
            LOCAL_CHECKPOINT_LIMITS,
            &mut CollectingSink::default()
        ),
        Err(ContinuationCryptoError::WrongRecipient)
    ));
    let retained_v1 = manager.load_version(recipient_id, 1).unwrap();
    decrypt_local_checkpoint(
        &path,
        &staging_for(&path),
        &sender.public_identity().unwrap(),
        &retained_v1,
        NOW_MS + 1,
        LOCAL_CHECKPOINT_LIMITS,
        &mut CollectingSink::default(),
    )
    .unwrap();
}

#[test]
fn committed_sender_snapshot_verifies_after_sender_key_rotation_or_revocation() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("sender-snapshot.org2h");
    let store = MemorySecretStore::default();
    let manager = memory_manager(store);
    let sender_id = test_uuid(0x30000000000000000000000000000021);
    let recipient_id = test_uuid(0x30000000000000000000000000000022);
    let sender_v1 = manager.load_or_create(sender_id).unwrap();
    let sender_v1_snapshot = sender_v1.public_identity().unwrap();
    let recipient = manager.load_or_create(recipient_id).unwrap();
    let recipient_public = recipient.public_identity().unwrap();
    let source = fixture(b"event", b"blob");
    write_fixture(&path, &sender_v1, &recipient_public, &source).unwrap();

    let sender_v2 = manager.rotate(sender_id).unwrap();
    let sender_v2_public = sender_v2.public_identity().unwrap();
    assert!(matches!(
        decrypt_local_checkpoint(
            &path,
            &staging_for(&path),
            &sender_v2_public,
            &recipient,
            NOW_MS + 1,
            LOCAL_CHECKPOINT_LIMITS,
            &mut CollectingSink::default(),
        ),
        Err(ContinuationCryptoError::UntrustedSender)
    ));
    decrypt_local_checkpoint(
        &path,
        &staging_for(&path),
        &sender_v1_snapshot,
        &recipient,
        NOW_MS + 1,
        LOCAL_CHECKPOINT_LIMITS,
        &mut CollectingSink::default(),
    )
    .unwrap();
}

#[test]
fn writer_rejects_record_limits_without_publishing_partial_ciphertext() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("too-large.org2h");
    let (_manager, sender, recipient) = identities();
    let recipient_public = recipient.public_identity().unwrap();
    let payload = b"too large";
    let mut limits = LOCAL_CHECKPOINT_LIMITS;
    limits.max_event_bytes = 2;
    let mut hasher = CheckpointPlaintextHasher::new(LOCAL_CHECKPOINT_LIMITS);
    hasher.update_event(1, "e", "event", payload).unwrap();
    let manifest = hasher
        .finish()
        .manifest("org2.continuation.checkpoint".into(), 1);
    let result = write_local_checkpoint_atomic(
        &path,
        &staging_for(&path),
        "record-limit-job",
        LocalEnvelopeWriteRequest {
            metadata: test_metadata(),
            sender: &sender,
            recipients: test_recipient_set(recipient_public.clone()),
            manifest,
            limits,
        },
        |writer| writer.write_event(1, "e", "event", payload),
    );
    assert!(matches!(
        result,
        Err(ContinuationCryptoError::LimitExceeded {
            kind: LimitKind::EventBytes,
            ..
        })
    ));
    assert!(!path.exists());
}

#[test]
fn writer_rejects_manifest_schema_not_bound_by_the_signed_header() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("schema-mismatch.org2h");
    let (_manager, sender, recipient) = identities();
    let source = fixture(b"event", b"blob");
    let mut manifest = source.manifest;
    manifest.schema_version = 2;

    let result = write_local_checkpoint_atomic(
        &path,
        &staging_for(&path),
        "schema-mismatch-job",
        LocalEnvelopeWriteRequest {
            metadata: test_metadata(),
            sender: &sender,
            recipients: test_recipient_set(recipient.public_identity().unwrap()),
            manifest,
            limits: LOCAL_CHECKPOINT_LIMITS,
        },
        |writer| writer.write_event(7, "event-7", "agent-event", source.event_payload),
    );
    assert!(matches!(
        result,
        Err(ContinuationCryptoError::InvalidEnvelope(
            "manifest schema does not match signed payload schema"
        ))
    ));
    assert!(!path.exists());
}

#[test]
fn first_pass_enforces_frame_record_blob_and_blob_byte_limits() {
    let mut frame_limits = LOCAL_CHECKPOINT_LIMITS;
    frame_limits.max_frame_bytes = 1;
    assert!(matches!(
        CheckpointPlaintextHasher::new(frame_limits).update_event(1, "e", "event", b"x"),
        Err(ContinuationCryptoError::LimitExceeded {
            kind: LimitKind::FrameBytes,
            ..
        })
    ));

    let mut record_limits = LOCAL_CHECKPOINT_LIMITS;
    record_limits.max_records = 0;
    assert!(matches!(
        CheckpointPlaintextHasher::new(record_limits).update_event(1, "e", "event", b"x"),
        Err(ContinuationCryptoError::LimitExceeded {
            kind: LimitKind::Records,
            ..
        })
    ));

    let blob = BlobMetadata {
        relative_path: "safe/blob.bin".into(),
        media_type: "application/octet-stream".into(),
        content_len: 1,
        sha256: Sha256::digest(b"x").into(),
    };
    let mut blob_count_limits = LOCAL_CHECKPOINT_LIMITS;
    blob_count_limits.max_blobs = 0;
    assert!(matches!(
        CheckpointPlaintextHasher::new(blob_count_limits)
            .update_blob(&blob, &mut Cursor::new(b"x")),
        Err(ContinuationCryptoError::LimitExceeded {
            kind: LimitKind::Blobs,
            ..
        })
    ));

    let mut blob_byte_limits = LOCAL_CHECKPOINT_LIMITS;
    blob_byte_limits.max_blob_bytes = 0;
    assert!(matches!(
        CheckpointPlaintextHasher::new(blob_byte_limits).update_blob(&blob, &mut Cursor::new(b"x")),
        Err(ContinuationCryptoError::LimitExceeded {
            kind: LimitKind::BlobBytes,
            ..
        })
    ));
}

#[test]
fn atomic_publish_never_clobbers_an_existing_checkpoint() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("checkpoint.org2h");
    let (_manager, sender, recipient) = identities();
    let recipient_public = recipient.public_identity().unwrap();
    let source = fixture(b"event", b"blob");
    write_fixture(&path, &sender, &recipient_public, &source).unwrap();
    let before = std::fs::read(&path).unwrap();
    assert!(matches!(
        write_fixture(&path, &sender, &recipient_public, &source),
        Err(ContinuationCryptoError::DestinationExists(_))
    ));
    assert_eq!(std::fs::read(&path).unwrap(), before);
}
