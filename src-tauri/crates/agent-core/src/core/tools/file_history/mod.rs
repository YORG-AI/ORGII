//! Per-session file-copy snapshot system.
//!
//! Replaces the legacy shadow-git snapshot (`snapshot.rs`) which was per-project
//! and caused multi-session data loss: when session A restored its snapshot, it
//! would overwrite files concurrently being modified by session B.
//!
//! Storage layout:
//! ```text
//! ~/.orgii/file-history/
//!   <session_id>/
//!     backups/
//!       <content_hash>            # raw file bytes, content-addressed (dedup)
//!     snapshots/
//!       <snapshot_id>.json        # FileSnapshot manifest
//! ```
//!
//! Concurrency: each tracked file is captured by *copying* the current bytes
//! into the per-session backup pool. Restore writes only those captured files
//! back, never touching files modified by other sessions.
//!
//! Module layout:
//! - **`types`** — public data types + tunable constants (`FileBackup`,
//!   `FileSnapshot`, `RewindStats`, `EvictionStats`, `TtlPruneStats`,
//!   `MAX_SNAPSHOTS_PER_SESSION`, `DEFAULT_FILE_HISTORY_TTL_DAYS`). Only
//!   `TtlPruneStats` and `DEFAULT_FILE_HISTORY_TTL_DAYS` are flat-exposed —
//!   the rest are reached via `file_history::types::*` from siblings only.
//! - **`paths`** — path helpers + manifest JSON I/O. All other modules go
//!   through `read_snapshot` / `write_snapshot` here.
//! - **`capture`** — snapshot creation + per-file capture
//!   (`make_snapshot`, `make_tool_snapshot`, `track_edit`,
//!   `track_edit_from_bytes`, `track_new_file`).
//! - **`inspect`** — diff / change-detection
//!   (`has_any_changes`, `has_changes_after_message`, `session_numstat`).
//! - **`rewind`** — restore API
//!   (`rewind_to_message`, `rewind_file`).
//! - **`cleanup`** — eviction, blob GC, orphan + TTL pruning
//!   (`remove_session`, `prune_orphan_sessions`,
//!   `evict_old_manifests_for_session`, `gc_unreferenced_blobs`,
//!   `enforce_session_cap_after_save`, `prune_old_file_history`).
//! - **`debug_seed`** (debug-only) — synthetic seeders for housekeeping
//!   E2E tests that intentionally bypass the capture path.
//!
//! Items kept at the `file_history::` surface — checked one by one against
//! real call sites. The `EvictionStats`, `FileBackup`, `FileSnapshot`,
//! `RewindStats`, `MAX_SNAPSHOTS_PER_SESSION` types/constants are reached
//! exclusively through the deeper `file_history::types::*` segment by
//! siblings inside this module, so we don't flatten them.

mod capture;
mod cleanup;
mod inspect;
mod paths;
mod rewind;
mod types;

#[cfg(debug_assertions)]
mod debug_seed;

pub use capture::{make_snapshot, make_tool_snapshot, track_edit_from_bytes, track_new_file};
pub use cleanup::{
    discard_tool_call_snapshots, enforce_session_cap_after_save, evict_old_manifests_for_session,
    prune_old_file_history, prune_orphan_sessions, remove_session,
};
pub use inspect::{has_changes_after_message, session_numstat, session_unified_diff};
pub use paths::read_snapshot_created_at as get_snapshot_created_at;
pub use rewind::{
    restore_snapshot, rewind_file, rewind_file_to_message, rewind_to_message,
    REDO_SNAPSHOT_TOOL_CALL_ID,
};
pub use types::{TtlPruneStats, DEFAULT_FILE_HISTORY_TTL_DAYS};

#[cfg(debug_assertions)]
pub use debug_seed::{debug_seed_aged_session, debug_seed_manifests};

#[cfg(test)]
mod tests {
    use super::capture::track_edit;
    use super::cleanup::gc_unreferenced_blobs;
    use super::inspect::{get_diff_stats, has_any_changes};
    use super::paths::{backup_file, backups_dir, read_snapshot, session_root};
    use super::rewind::restore_snapshot;
    use super::*;
    use std::fs;
    use std::path::Path;
    use test_helpers::test_env;

    // file_history writes under paths::file_history_dir, which resolves
    // through `ORGII_HOME`. Delegating to the crate-wide test_env sandbox
    // keeps these tests serialized against every other sandboxed test
    // via a single lock — no cross-module races.
    fn with_sandbox<F: FnOnce(&Path)>(test: F) {
        let guard = test_env::sandbox();
        test(guard.path());
    }

    #[test]
    fn make_tool_snapshot_rejects_empty_file_list() {
        with_sandbox(|_| {
            let err = make_tool_snapshot("sess-empty", &[]).unwrap_err();
            assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput);
            assert!(!session_root("sess-empty").exists());
        });
    }

    #[test]
    fn capture_and_rewind_restores_original_bytes() {
        with_sandbox(|sandbox| {
            let project = sandbox.join("proj");
            fs::create_dir_all(&project).unwrap();
            let file = project.join("a.txt");
            fs::write(&file, b"hello").unwrap();

            let sid = "sess-1";
            let snap = make_snapshot(sid).unwrap();
            track_edit(sid, &snap, &file).unwrap();

            // Mutate after snapshot.
            fs::write(&file, b"goodbye").unwrap();
            assert!(has_any_changes(sid, &snap).unwrap());

            let stats = restore_snapshot(sid, &snap).unwrap();
            assert_eq!(stats.restored, 1);
            assert_eq!(fs::read(&file).unwrap(), b"hello");
        });
    }

    #[test]
    fn rewind_does_not_touch_files_outside_snapshot() {
        with_sandbox(|sandbox| {
            let project = sandbox.join("proj");
            fs::create_dir_all(&project).unwrap();

            let tracked = project.join("tracked.txt");
            let untracked = project.join("untracked.txt");
            fs::write(&tracked, b"v1").unwrap();
            fs::write(&untracked, b"other-session-value").unwrap();

            let sid = "sess-iso";
            let snap = make_snapshot(sid).unwrap();
            track_edit(sid, &snap, &tracked).unwrap();

            // Mutate both files.
            fs::write(&tracked, b"v2").unwrap();
            fs::write(&untracked, b"NEW-other-session-value").unwrap();

            restore_snapshot(sid, &snap).unwrap();

            // Tracked file rolled back; untracked file preserved.
            assert_eq!(fs::read(&tracked).unwrap(), b"v1");
            assert_eq!(fs::read(&untracked).unwrap(), b"NEW-other-session-value");
        });
    }

    #[test]
    fn rewind_deletes_file_that_did_not_exist_at_capture() {
        with_sandbox(|sandbox| {
            let project = sandbox.join("proj");
            fs::create_dir_all(&project).unwrap();
            let new_file = project.join("created-after.txt");

            let sid = "sess-del";
            let snap = make_snapshot(sid).unwrap();
            track_edit(sid, &snap, &new_file).unwrap();

            fs::write(&new_file, b"created").unwrap();
            assert!(new_file.exists());

            let stats = restore_snapshot(sid, &snap).unwrap();
            assert_eq!(stats.deleted, 1);
            assert!(!new_file.exists());
        });
    }

    #[test]
    fn restore_redo_snapshot_reapplies_rewound_changes() {
        with_sandbox(|sandbox| {
            let project = sandbox.join("proj");
            fs::create_dir_all(&project).unwrap();
            let file = project.join("a.txt");
            fs::write(&file, b"v1").unwrap();

            let sid = "sess-redo";
            let snap = make_snapshot(sid).unwrap();
            track_edit(sid, &snap, &file).unwrap();

            fs::write(&file, b"v2").unwrap();
            let redo_snapshot_id = make_tool_snapshot(sid, std::slice::from_ref(&file)).unwrap();

            restore_snapshot(sid, &snap).unwrap();
            assert_eq!(fs::read(&file).unwrap(), b"v1");

            let redo_stats = restore_snapshot(sid, &redo_snapshot_id).unwrap();
            assert_eq!(redo_stats.restored, 1);
            assert_eq!(fs::read(&file).unwrap(), b"v2");
        });
    }

    #[test]
    fn track_edit_is_idempotent_first_capture_wins() {
        with_sandbox(|sandbox| {
            let project = sandbox.join("proj");
            fs::create_dir_all(&project).unwrap();
            let file = project.join("a.txt");
            fs::write(&file, b"v1").unwrap();

            let sid = "sess-idem";
            let snap = make_snapshot(sid).unwrap();
            track_edit(sid, &snap, &file).unwrap();

            // Second tool-call captures again *after* mutation should NOT
            // overwrite the original capture.
            fs::write(&file, b"v2").unwrap();
            track_edit(sid, &snap, &file).unwrap();

            restore_snapshot(sid, &snap).unwrap();
            assert_eq!(fs::read(&file).unwrap(), b"v1");
        });
    }

    #[test]
    fn diff_stats_classifies_added_changed_deleted() {
        with_sandbox(|sandbox| {
            let project = sandbox.join("proj");
            fs::create_dir_all(&project).unwrap();
            let existing = project.join("existing.txt");
            let to_delete = project.join("delete-me.txt");
            let to_add = project.join("add-me.txt");
            fs::write(&existing, b"v1").unwrap();
            fs::write(&to_delete, b"present").unwrap();

            let sid = "sess-diff";
            let snap = make_snapshot(sid).unwrap();
            track_edit(sid, &snap, &existing).unwrap();
            track_edit(sid, &snap, &to_delete).unwrap();
            track_edit(sid, &snap, &to_add).unwrap();

            // Now mutate: change existing, delete one, create the other.
            fs::write(&existing, b"v2").unwrap();
            fs::remove_file(&to_delete).unwrap();
            fs::write(&to_add, b"new").unwrap();

            let stats = get_diff_stats(sid, &snap).unwrap();
            assert_eq!(stats.files_changed, 1);
            assert_eq!(stats.files_deleted, 1);
            assert_eq!(stats.files_added, 1);
        });
    }

    #[test]
    fn remove_session_clears_directory() {
        with_sandbox(|_| {
            let sid = "sess-rm";
            let snap = make_snapshot(sid).unwrap();
            assert!(session_root(sid).exists());
            remove_session(sid).unwrap();
            assert!(!session_root(sid).exists());
            // Reading a removed snapshot returns an error.
            assert!(read_snapshot(sid, &snap).is_err());
        });
    }

    #[test]
    fn prune_removes_only_orphans() {
        with_sandbox(|_| {
            make_snapshot("alive-1").unwrap();
            make_snapshot("alive-2").unwrap();
            make_snapshot("orphan").unwrap();

            let removed =
                prune_orphan_sessions(&["alive-1".to_string(), "alive-2".to_string()]).unwrap();
            assert_eq!(removed, 1);
            assert!(session_root("alive-1").exists());
            assert!(session_root("alive-2").exists());
            assert!(!session_root("orphan").exists());
        });
    }

    #[test]
    fn gc_unreferenced_blobs_drops_only_orphan_blobs() {
        with_sandbox(|sandbox| {
            let project = sandbox.join("proj");
            fs::create_dir_all(&project).unwrap();
            let sid = "sess-gc";

            // Snapshot 1: capture file-a with content "v1".
            let file_a = project.join("a.txt");
            fs::write(&file_a, b"v1").unwrap();
            let snap_a = make_snapshot(sid).unwrap();
            track_edit(sid, &snap_a, &file_a).unwrap();

            // Confirm blob exists.
            let hash_a = blake3::hash(b"v1").to_hex().to_string();
            assert!(backup_file(sid, &hash_a).exists());

            // Inject an orphan blob that no manifest references.
            let orphan_blob = backups_dir(sid).join("orphan-hash-zzz");
            fs::write(&orphan_blob, b"dead bytes").unwrap();
            assert!(orphan_blob.exists());

            let removed = gc_unreferenced_blobs(sid).unwrap();
            assert_eq!(removed, 1, "only the orphan blob should be collected");
            assert!(!orphan_blob.exists());
            assert!(
                backup_file(sid, &hash_a).exists(),
                "referenced blob must survive GC"
            );
        });
    }

    #[test]
    fn prune_old_file_history_removes_aged_session_dirs() {
        with_sandbox(|_| {
            make_snapshot("fresh").unwrap();
            make_snapshot("aged").unwrap();

            let fresh_root = session_root("fresh");
            let aged_root = session_root("aged");
            assert!(fresh_root.exists());
            assert!(aged_root.exists());

            // Backdate the "aged" session directory by opening it read-only
            // and calling set_modified on the dir handle. Works on macOS +
            // Linux via the O_RDONLY-on-directory path Rust stdlib uses.
            let target = std::time::SystemTime::now()
                .checked_sub(std::time::Duration::from_secs(60 * 86_400))
                .unwrap();
            let dir_handle = std::fs::File::options()
                .read(true)
                .open(&aged_root)
                .expect("open session dir read-only");
            dir_handle
                .set_modified(target)
                .expect("set_modified on dir handle");
            drop(dir_handle);

            let stats = prune_old_file_history(30).unwrap();
            assert!(
                !aged_root.exists(),
                "aged session dir should be pruned, stats={:?}",
                stats
            );
            assert!(fresh_root.exists(), "fresh session dir must survive");
            assert_eq!(stats.sessions_removed, 1);
        });
    }
}
