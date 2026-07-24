//! Generation-scoped, rebuildable payload artifacts.
//!
//! Some provider locators (JSONL records, Cursor blobs and Warp protobuf task
//! rows) cannot serve a byte range without decoding the entire source record.
//! Doing that once per 256 KiB page turns a large Shell output into quadratic
//! work.  These helpers materialize such payloads once while their source row
//! is already decoded, then let the common range reader use SQLite `SUBSTR`.
//!
//! The incremental writer reserves a `zeroblob` and fills it through SQLite's
//! blob API.  Cross-record payloads therefore retain at most one decoded
//! source record in Rust, never a transcript- or payload-sized concatenation.

use std::io::Write;

use rusqlite::blob::ZeroBlob;
use rusqlite::{params, DatabaseName, OptionalExtension, Transaction};
use sha2::{Digest, Sha256};

use super::ImportedHistorySourceId;

const ARTIFACT_TABLE: &str = "imported_replay_payload_artifacts";

struct HashingWriter<'blob, 'conn> {
    blob: &'blob mut rusqlite::blob::Blob<'conn>,
    hash: Sha256,
    written: u64,
}

impl Write for HashingWriter<'_, '_> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let written = self.blob.write(bytes)?;
        Digest::update(&mut self.hash, &bytes[..written]);
        self.written = self.written.saturating_add(written as u64);
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.blob.flush()
    }
}

#[allow(
    clippy::too_many_arguments,
    reason = "Replay adapter boundaries keep cursor, generation, and payload fields explicit"
)]
pub(super) fn store_text(
    tx: &Transaction<'_>,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    generation: &str,
    event_id: &str,
    field_path: &str,
    text: &str,
) -> Result<String, String> {
    store_bytes(
        tx,
        source,
        source_session_id,
        generation,
        event_id,
        field_path,
        text.as_bytes(),
    )
}

#[allow(
    clippy::too_many_arguments,
    reason = "Replay adapter boundaries keep cursor, generation, and payload fields explicit"
)]
pub(super) fn store_bytes(
    tx: &Transaction<'_>,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    generation: &str,
    event_id: &str,
    field_path: &str,
    payload: &[u8],
) -> Result<String, String> {
    let content_hash = sha256_hex(payload);
    tx.execute(
        "INSERT INTO imported_replay_payload_artifacts(
             source,source_session_id,generation,content_hash,payload
         ) VALUES (?1,?2,?3,?4,?5)
         ON CONFLICT(source,source_session_id,generation,content_hash) DO NOTHING",
        params![
            source.as_str(),
            source_session_id,
            generation,
            content_hash,
            payload
        ],
    )
    .map_err(|error| format!("store replay payload artifact: {error}"))?;
    reference(
        tx,
        source,
        source_session_id,
        generation,
        event_id,
        field_path,
        &content_hash,
    )?;
    Ok(content_hash)
}

/// Stream exactly `total_bytes` into one content-addressed artifact.
///
/// The producer may decode one JSONL line/blob at a time and call
/// `write_all`; the complete payload is never assembled in Rust.  The
/// temporary key is generation/event scoped and is atomically replaced by
/// the final content hash inside the caller's replay-index transaction.
#[allow(
    clippy::too_many_arguments,
    reason = "Replay adapter boundaries keep cursor, generation, and payload fields explicit"
)]
pub(super) fn store_streamed<F>(
    tx: &Transaction<'_>,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    generation: &str,
    event_id: &str,
    field_path: &str,
    total_bytes: u64,
    produce: F,
) -> Result<String, String>
where
    F: FnOnce(&mut dyn Write) -> Result<(), String>,
{
    store_streamed_for_scope(
        tx,
        source.as_str(),
        source_session_id,
        generation,
        event_id,
        field_path,
        total_bytes,
        produce,
    )
}

/// Storage-neutral counterpart used by ORGII-owned managed/snapshot replay
/// adapters. Vendor adapters should continue to call [`store_streamed`].
#[allow(
    clippy::too_many_arguments,
    reason = "Replay adapter boundaries keep cursor, generation, and payload fields explicit"
)]
pub(super) fn store_streamed_for_scope<F>(
    tx: &Transaction<'_>,
    source_id: &str,
    source_session_id: &str,
    generation: &str,
    event_id: &str,
    field_path: &str,
    total_bytes: u64,
    produce: F,
) -> Result<String, String>
where
    F: FnOnce(&mut dyn Write) -> Result<(), String>,
{
    let blob_len = i32::try_from(total_bytes).map_err(|_| {
        format!(
            "Replay payload artifact is too large for incremental SQLite BLOB I/O: {total_bytes} bytes"
        )
    })?;
    let temporary_hash = temporary_hash(event_id, field_path);
    tx.execute(
        "DELETE FROM imported_replay_payload_artifacts
         WHERE source=?1 AND source_session_id=?2 AND generation=?3 AND content_hash=?4",
        params![source_id, source_session_id, generation, temporary_hash],
    )
    .map_err(|error| format!("clear interrupted replay payload artifact: {error}"))?;
    tx.execute(
        "INSERT INTO imported_replay_payload_artifacts(
             source,source_session_id,generation,content_hash,payload
         ) VALUES (?1,?2,?3,?4,?5)",
        params![
            source_id,
            source_session_id,
            generation,
            temporary_hash,
            ZeroBlob(blob_len)
        ],
    )
    .map_err(|error| format!("reserve replay payload artifact: {error}"))?;
    let row_id = tx
        .query_row(
            "SELECT rowid FROM imported_replay_payload_artifacts
             WHERE source=?1 AND source_session_id=?2 AND generation=?3 AND content_hash=?4",
            params![source_id, source_session_id, generation, temporary_hash],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("locate replay payload artifact BLOB: {error}"))?;

    let (content_hash, written) = {
        let mut blob = tx
            .blob_open(DatabaseName::Main, ARTIFACT_TABLE, "payload", row_id, false)
            .map_err(|error| format!("open replay payload artifact BLOB: {error}"))?;
        let (content_hash, written) = {
            let mut writer = HashingWriter {
                blob: &mut blob,
                hash: Sha256::new(),
                written: 0,
            };
            produce(&mut writer)?;
            writer
                .flush()
                .map_err(|error| format!("flush replay payload artifact: {error}"))?;
            (digest_hex(writer.hash.clone().finalize()), writer.written)
        };
        blob.close()
            .map_err(|error| format!("close replay payload artifact BLOB: {error}"))?;
        (content_hash, written)
    };
    if written != total_bytes {
        return Err(format!(
            "Replay payload artifact length changed while decoding: expected {total_bytes}, wrote {written}"
        ));
    }

    let duplicate_row_id = tx
        .query_row(
            "SELECT rowid FROM imported_replay_payload_artifacts
             WHERE source=?1 AND source_session_id=?2 AND generation=?3 AND content_hash=?4",
            params![source_id, source_session_id, generation, content_hash],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| format!("deduplicate replay payload artifact: {error}"))?;
    if duplicate_row_id.is_some_and(|existing| existing != row_id) {
        tx.execute(
            "DELETE FROM imported_replay_payload_artifacts WHERE rowid=?1",
            [row_id],
        )
        .map_err(|error| format!("remove duplicate replay payload artifact: {error}"))?;
    } else {
        tx.execute(
            "UPDATE imported_replay_payload_artifacts SET content_hash=?1 WHERE rowid=?2",
            params![content_hash, row_id],
        )
        .map_err(|error| format!("publish replay payload artifact hash: {error}"))?;
    }
    reference_for_scope(
        tx,
        source_id,
        source_session_id,
        generation,
        event_id,
        field_path,
        &content_hash,
    )?;
    Ok(content_hash)
}

/// Resolve an already-published artifact for an immutable ORGII-owned scope.
///
/// This deliberately is not used by vendor replay drivers: some provider
/// stores can mutate a row without changing generation, so their normal
/// materialization path must re-check source identity. Managed CLI and
/// collaboration snapshot generations, by contrast, are immutable epochs.
#[allow(
    clippy::too_many_arguments,
    reason = "Replay adapter boundaries keep cursor, generation, and payload fields explicit"
)]
pub(super) fn find_for_immutable_scope(
    tx: &Transaction<'_>,
    source_id: &str,
    source_session_id: &str,
    generation: &str,
    event_id: &str,
    field_path: &str,
    expected_bytes: u64,
) -> Result<Option<String>, String> {
    let row = tx
        .query_row(
            "SELECT ref.content_hash,LENGTH(artifact.payload)
             FROM imported_replay_payload_artifact_refs AS ref
             JOIN imported_replay_payload_artifacts AS artifact
               ON artifact.source=ref.source
              AND artifact.source_session_id=ref.source_session_id
              AND artifact.generation=ref.generation
              AND artifact.content_hash=ref.content_hash
             WHERE ref.source=?1 AND ref.source_session_id=?2 AND ref.generation=?3
               AND ref.event_id=?4 AND ref.field_path=?5",
            params![
                source_id,
                source_session_id,
                generation,
                event_id,
                field_path
            ],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(|error| format!("find immutable replay payload artifact: {error}"))?;
    let Some((content_hash, stored_bytes)) = row else {
        return Ok(None);
    };
    if u64::try_from(stored_bytes).ok() != Some(expected_bytes) {
        return Ok(None);
    }
    Ok(Some(content_hash))
}

#[allow(
    clippy::too_many_arguments,
    reason = "Replay adapter boundaries keep cursor, generation, and payload fields explicit"
)]
pub(super) fn reference(
    tx: &Transaction<'_>,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    generation: &str,
    event_id: &str,
    field_path: &str,
    content_hash: &str,
) -> Result<(), String> {
    reference_for_scope(
        tx,
        source.as_str(),
        source_session_id,
        generation,
        event_id,
        field_path,
        content_hash,
    )
}

#[allow(
    clippy::too_many_arguments,
    reason = "Replay adapter boundaries keep cursor, generation, and payload fields explicit"
)]
fn reference_for_scope(
    tx: &Transaction<'_>,
    source_id: &str,
    source_session_id: &str,
    generation: &str,
    event_id: &str,
    field_path: &str,
    content_hash: &str,
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO imported_replay_payload_artifact_refs(
             source,source_session_id,generation,event_id,field_path,content_hash
         ) VALUES (?1,?2,?3,?4,?5,?6)
         ON CONFLICT(source,source_session_id,generation,event_id,field_path) DO UPDATE SET
             content_hash=excluded.content_hash",
        params![
            source_id,
            source_session_id,
            generation,
            event_id,
            field_path,
            content_hash
        ],
    )
    .map(|_| ())
    .map_err(|error| format!("reference replay payload artifact: {error}"))
}

pub(super) fn delete_event_refs(
    tx: &Transaction<'_>,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    generation: &str,
    event_id: &str,
) -> Result<(), String> {
    tx.execute(
        "DELETE FROM imported_replay_payload_artifact_refs
         WHERE source=?1 AND source_session_id=?2 AND generation=?3 AND event_id=?4",
        params![source.as_str(), source_session_id, generation, event_id],
    )
    .map(|_| ())
    .map_err(|error| format!("delete replay payload artifact refs: {error}"))
}

pub(super) fn delete_orphans(
    tx: &Transaction<'_>,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    generation: &str,
) -> Result<(), String> {
    tx.execute(
        "DELETE FROM imported_replay_payload_artifacts AS artifact
         WHERE artifact.source=?1 AND artifact.source_session_id=?2 AND artifact.generation=?3
           AND NOT EXISTS (
             SELECT 1 FROM imported_replay_payload_artifact_refs AS ref
             WHERE ref.source=artifact.source
               AND ref.source_session_id=artifact.source_session_id
               AND ref.generation=artifact.generation
               AND ref.content_hash=artifact.content_hash
           )
           AND NOT EXISTS (
             SELECT 1 FROM imported_replay_shell_segments AS shell
             WHERE shell.source=artifact.source
               AND shell.source_session_id=artifact.source_session_id
               AND shell.generation=artifact.generation
               AND shell.content_hash=artifact.content_hash
           )",
        params![source.as_str(), source_session_id, generation],
    )
    .map(|_| ())
    .map_err(|error| format!("delete orphan replay payload artifacts: {error}"))
}

fn temporary_hash(event_id: &str, field_path: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in event_id
        .as_bytes()
        .iter()
        .chain(std::iter::once(&0))
        .chain(field_path.as_bytes())
    {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("pending-{hash:016x}")
}

fn sha256_hex(bytes: &[u8]) -> String {
    digest_hex(Sha256::digest(bytes))
}

fn digest_hex(digest: impl AsRef<[u8]>) -> String {
    digest
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::sqlite::SqliteRecordStore;

    #[test]
    fn streamed_artifact_is_exact_and_content_deduplicated() {
        let mut conn = rusqlite::Connection::open_in_memory().expect("replay DB");
        SqliteRecordStore::init_tables(&conn).expect("replay schema");
        SqliteRecordStore::init_source_cache_tables(&conn).expect("replay cache schema");
        let tx = conn.transaction().expect("artifact transaction");
        let source = ImportedHistorySourceId::CodexApp;
        let expected = "你🙂payload".repeat(10_000);
        let hash = store_streamed(
            &tx,
            source,
            "session",
            "generation",
            "event-a",
            "result.output",
            expected.len() as u64,
            |writer| {
                for bytes in expected.as_bytes().chunks(997) {
                    writer.write_all(bytes).map_err(|error| error.to_string())?;
                }
                Ok(())
            },
        )
        .expect("stream artifact");
        for index in 1..50 {
            let duplicate = store_text(
                &tx,
                source,
                "session",
                "generation",
                &format!("event-{index}"),
                "result.output",
                &expected,
            )
            .expect("deduplicated artifact");
            assert_eq!(hash, duplicate);
        }
        assert_eq!(hash.len(), 64);
        let artifact_count = tx
            .query_row(
                "SELECT COUNT(*) FROM imported_replay_payload_artifacts",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("artifact count");
        assert_eq!(artifact_count, 1);
        let reference_count = tx
            .query_row(
                "SELECT COUNT(*) FROM imported_replay_payload_artifact_refs",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("artifact reference count");
        assert_eq!(reference_count, 50);
    }

    #[test]
    fn canonical_hash_is_standard_sha256() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
