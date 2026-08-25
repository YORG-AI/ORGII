# ORG2 Cloud continuation handoff envelope v1

This is the byte-level contract shared by the Rust device crate and the Cloud
prepare/commit implementation. It is specifically an optional Cloud E2EE
transport. Provider-neutral local continuation state belongs to the portable
IR layer and does not use this header. No signed field is encoded as JSON.

## Device fingerprint

```text
SHA256(
  UTF8("ORG2-CONTINUATION-DEVICE-V1") ||
  0x00 ||
  raw_x25519_public_key[32] ||
  raw_ed25519_public_key[32]
)
```

The external form is lowercase hexadecimal. Golden input
`x25519 = 00..1f`, `ed25519 = 20..3f` produces:

```text
3b7ec85045344de1f5b326e474baab6f293a211bbcb41e50b95aaa9ea10c6a9a
```

## Complete object

All integers are unsigned big-endian. UUIDs are canonical RFC 4122 raw 16-byte
values (the same bytes returned by PostgreSQL `uuid_send`). `string16` is a
big-endian `u16` byte length followed by nonempty canonical UTF-8 bytes.

```text
magic[8]                 = "ORG2HND\0"
envelope_version:u16     = 1
canonical_header_len:u32
canonical_header[canonical_header_len]
age_ciphertext[header.age_ciphertext_len]
ed25519_signature[64]
end_magic[8]             = "ORG2END\0"
```

`age_ciphertext` is exactly one standard binary age-encryption.org/v1 file,
without armor, containing one X25519 recipient stanza for every signed
recipient entry. It is never one object per recipient. `object_size` and
`object_sha256` cover every byte above, including prefix, header, signature,
and end marker. They are Cloud storage/path/quota metadata and cannot be inside
the signed header without a circular digest.

The only public artifact profile caps this complete object at 16 MiB. Broader
test-only limits are not constructible by upload/download code.

## Canonical signed header

Fields occur in this exact order:

```text
encryption_algorithm:u8       = 1 (age X25519)
signature_algorithm:u8        = 1 (Ed25519)
compression_algorithm:u8      = 1 (gzip)
hash_algorithm:u8             = 1 (SHA-256)
org_id:uuid[16]
checkpoint_id:uuid[16]
root_session_id:string16
source_episode_id:string16
source_runtime:string16
payload_schema:string16
payload_schema_version:u16
recipient_scope:u8             = 1 (audience) | 2 (explicit subset)
sender_user_id:uuid[16]
sender_device_id:uuid[16]
sender_key_version:u32
sender_x25519_public_key[32]
sender_ed25519_public_key[32]
sender_fingerprint[32]
recipient_count:u16            = 1..64
recipient_set_sha256[32]
recipient[recipient_count] {
  recipient_user_id:uuid[16]
  recipient_device_id:uuid[16]
  recipient_key_version:u32
  recipient_x25519_public_key[32]
  recipient_ed25519_public_key[32]
  recipient_fingerprint[32]
}
age_ciphertext_sha256[32]
created_at_unix_ms:u64
expires_at_unix_ms:u64
age_ciphertext_len:u64
```

Recipients are in strict ascending raw-byte order by
`(recipient_user_id, recipient_device_id, key_version)`. The `u32` key is
compared numerically and encoded big-endian, matching PostgreSQL `int4send` for
the allowed positive `int4` range. The encoder sorts; the decoder rejects
noncanonical order. Entries are unique, and one device cannot appear under
multiple users or key versions in a newly encrypted object. Historical objects
remain decryptable with their snapshotted old key.

The exact recipient-set digest is:

```text
SHA256(
  UTF8("ORG2-CONTINUATION-RECIPIENT-SET-V1") ||
  0x00 ||
  be_u16(recipient_count) ||
  for each canonical recipient:
    recipient_user_id[16] ||
    recipient_device_id[16] ||
    be_u32(recipient_key_version) ||
    recipient_x25519_public_key[32] ||
    recipient_ed25519_public_key[32] ||
    recipient_fingerprint[32]
)
```

`audience` means the server resolved the complete current root audience;
`subset` means an explicit handoff. Either way, the exact resulting array is
signed. Cloud stores common object metadata once and one small receipt row per
recipient. A decryptor first verifies the immutable object, full canonical
recipient set, sender signature, and committed object row; only then may it
select a caller receipt whose `(user, device, key version, keys, fingerprint)`
exactly equals an entry and whose private key reproduces that public identity.

Cloud mirrors the following common object fields and must compare every one to
the decoded header or complete-object snapshot before decrypt:

```text
checkpoint_id, org_id, root_session_id, source_episode_id,
sender_user_id, sender_device_id, sender_key_version,
sender_x25519_public_key, sender_ed25519_public_key, sender_fingerprint,
source_runtime, payload_schema, payload_schema_version, recipient_scope,
recipient_count,
recipient_set_sha256, client_created_at_unix_ms, expires_at_unix_ms,
age_ciphertext_len, age_ciphertext_sha256, footer_signature,
object_size, object_sha256, canonical_header
```

Each receipt mirrors:

```text
checkpoint_id, org_id, recipient_user_id, recipient_device_id,
recipient_key_version, recipient_x25519_public_key,
recipient_ed25519_public_key, recipient_fingerprint
```

SQL UUID text accepted by the Rust boundary is lowercase canonical hyphenated
form; it is decoded back to the raw 16 signed bytes. Key versions are
`1..=2147483647`. Runtime IDs match
`^[a-z0-9][a-z0-9._-]{0,63}$`. Payload schema IDs are non-empty canonical
UTF-8 without control bytes (maximum 128 bytes), and schema versions are
positive `u16`. Hashes are lowercase 64-hex, public keys are
canonical unpadded base64url raw-32, and the footer signature is canonical
unpadded base64url raw-64.

`created_at_unix_ms` is supplied and signed by the client; Cloud validates it
against bounded clock skew instead of replacing it with server time. The
sender public keys and fingerprint are snapshotted on the committed object
row, so a later key revocation does not make an already committed artifact
cryptographically unverifiable. Recipient keys are snapshotted on receipts.
The outer header contains no plaintext hash; that digest is inside the
encrypted manifest.

## One signature, two storage locations

The exact Ed25519 message is:

```text
UTF8("ORG2-CONTINUATION-ENVELOPE-SIGNATURE-V1") ||
0x00 ||
be_u32(canonical_header_len) ||
canonical_header ||
age_ciphertext_sha256[32]
```

The resulting 64 bytes are written verbatim in the object footer and sent
verbatim as the Cloud RPC signature. There is no separately encoded or
separately computed RPC signature.

The shared real-UUID golden is frozen in
`canonical_header_and_signed_bytes_have_exact_golden_vector`:

```text
org_id                    = 10000000-0000-0000-0000-000000000001
checkpoint_id             = 40000000-0000-0000-0000-000000000001
root_session_id           = root-session-a
source_episode_id         = episode-a
source_runtime            = codex
payload_schema            = org2.portable_conversation
payload_schema_version    = 2
sender_user_id            = 20000000-0000-0000-0000-000000000001
sender_device_id          = 30000000-0000-0000-0000-000000000001
recipient_scope           = audience (1)
recipient users/devices   = (...0002/...0002 key 9), (...0003/...0003 key 11)
recipient_set_sha256      = 9ddfed1c641fa7cd2e0b93511b878361a3bedf8485708c75f0057ab6429ecbb7
canonical_header_len      = 587
canonical_header_sha256   = 4bd4bde95b64e5a2230068bcf672184c3e4f64df6a010af1e1132d174841a5e1
SHA256(signed_message)    = eca71c52611d9317c51a0a4526a1f86bc68655dbaec73c35a7dfdd1f2f3fa10c
Ed25519 seed              = 9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60
signature                 = b612ae200776267d65b3635502e5044bd0910d5584d6d9cbeabf05823ee13927a946b1273b8527e3c767ef4effcd9cdc5242674b9c665993b8b5983874c7bd07
```

The test also freezes the complete 587-byte canonical header hex. The signed
message is reconstructed by the formula above; its digest and signature are
independently asserted for Cloud migration tests.

## Encrypted inner stream

After age decryption, gzip decompression yields:

```text
inner_magic[8]          = "ORG2CPS\0"
inner_version:u16       = 1
manifest_frame
event_or_blob_frame...
footer_frame
```

Every frame is `tag:u8 || payload_len:u32 || payload`. Tags are manifest `1`,
event `2`, blob `3`, and footer `255`. The encrypted manifest and footer carry
the SHA-256 of the canonical raw event/blob frames (including each frame tag
and length, excluding manifest/footer). Each blob also carries and verifies its
own SHA-256. Readers enforce per-frame, per-event, per-blob, record-count, blob
count, total decompressed-byte, and complete-object limits before allocation or
delivery, and reject unsafe or ambiguous relative paths.

Blob paths use forward-slash-separated printable ASCII components. They reject
absolute/empty/dot components, Windows-reserved characters and device names,
trailing dot/space, and case-insensitive duplicates. This deliberately avoids
cross-platform Unicode normalization and case-fold collisions when a handoff
is restored on a different filesystem.
