//! File content tracker for stale-edit detection.
//!
//! After a `read_file`, the tracker records a hash of the file's CONTENT.
//! Before a file-modifying tool (`edit_file` / `apply_patch` / `delete_file`)
//! runs, it checks the file's content hash still matches; if an external
//! process changed the content, the edit is rejected with a re-read request.
//!
//! ## Why content hash, not mtime
//!
//! The previous implementation compared `mtime`. That produced **false stale
//! rejections**: any process that merely touches a file (an editor save with
//! no change, a backup/mirror copy, an `atime`/`mtime` bump, sub-second
//! `SystemTime` precision jitter on a same-second read→write) advances `mtime`
//! without changing content, so a strict `current > recorded` comparison fired
//! even though the bytes were identical. mtime is only a *proxy* for "did the
//! content change"; hashing the content answers that question directly — no
//! tolerance window, no precision pitfalls, and it still catches genuine
//! external edits (different bytes → different hash).

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};

use serde_json::Value;

use crate::tools::names as tool_names;

// ============================================
// File content tracker
// ============================================

/// Tracks file content hashes to detect stale edits.
///
/// `read_file` records the content hash. Before a file-modifying tool runs,
/// `assert_fresh` re-hashes the file and rejects the edit if the hash differs
/// (content changed externally). Files never read always pass — the edit tool
/// itself enforces read-before-edit via its description.
#[derive(Debug, Clone, Default)]
pub struct FileTimeTracker {
    /// file_path → last-observed content hash (after read or our own write)
    read_hashes: HashMap<String, u64>,
    /// Insertion order for FIFO eviction (HashMap iteration is unordered)
    insertion_order: Vec<String>,
}

const MAX_FILE_TRACKER_ENTRIES: usize = 500;

/// Hash a file's full content. `None` when the file cannot be read (missing,
/// permission, or it is a directory). Callers treat `None` as "no trustworthy
/// snapshot" and fail open rather than fabricating a stale signal.
fn hash_file_content(file_path: &str) -> Option<u64> {
    let bytes = std::fs::read(file_path).ok()?;
    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    Some(hasher.finish())
}

impl FileTimeTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns true if no files have been tracked.
    pub fn is_empty(&self) -> bool {
        self.read_hashes.is_empty()
    }

    /// Returns the number of tracked files.
    pub fn len(&self) -> usize {
        self.read_hashes.len()
    }

    /// Insert/refresh a file's content hash with FIFO eviction. Shared by the
    /// read and write recording paths so eviction logic lives in one place.
    fn upsert_hash(&mut self, file_path: &str, hash: u64) {
        let is_new = !self.read_hashes.contains_key(file_path);
        if is_new && self.read_hashes.len() >= MAX_FILE_TRACKER_ENTRIES {
            if let Some(oldest_key) = self.insertion_order.first().cloned() {
                self.read_hashes.remove(&oldest_key);
                self.insertion_order.remove(0);
            }
        }
        self.read_hashes.insert(file_path.to_string(), hash);
        if is_new {
            self.insertion_order.push(file_path.to_string());
        }
    }

    /// Drop a file from tracking (e.g. its content could not be hashed after a
    /// write). The next `assert_fresh` then takes the "never read → pass"
    /// branch instead of comparing against a stale snapshot forever.
    fn forget(&mut self, file_path: &str) {
        if self.read_hashes.remove(file_path).is_some() {
            self.insertion_order.retain(|p| p != file_path);
        }
    }

    /// Record the current content hash of a file after a successful read.
    pub fn record_read(&mut self, file_path: &str) {
        if let Some(hash) = hash_file_content(file_path) {
            self.upsert_hash(file_path, hash);
        }
    }

    /// Check if a file's content changed since the last recorded read/write.
    /// Returns Ok(()) if safe to edit, Err(message) if stale. Files never read
    /// always pass; files we cannot re-hash also pass (fail open — we have no
    /// trustworthy "changed" signal and must not block a legitimate edit).
    pub fn assert_fresh(&self, file_path: &str) -> Result<(), String> {
        let Some(recorded_hash) = self.read_hashes.get(file_path) else {
            return Ok(()); // Never read — let the tool handle it
        };

        let Some(current_hash) = hash_file_content(file_path) else {
            return Ok(()); // Cannot read content — fail open, don't fabricate stale
        };

        if current_hash != *recorded_hash {
            return Err(format!(
                "File was modified since you last read it: {}. Read it again before editing.",
                file_path
            ));
        }

        Ok(())
    }

    /// Record a write — refresh the tracked content hash after a successful
    /// edit/write. If the file can no longer be hashed (e.g. it was deleted),
    /// forget it so a stale snapshot never causes repeated false rejections.
    pub fn record_write(&mut self, file_path: &str) {
        match hash_file_content(file_path) {
            Some(hash) => self.upsert_hash(file_path, hash),
            None => self.forget(file_path),
        }
    }

    /// Single entry point for recording a tool's file effects, called by BOTH
    /// the sequential (`single.rs`) and concurrent (`parallel.rs`) execution
    /// paths so the read/write bookkeeping can never drift between them.
    ///
    /// On a successful read tool we snapshot each path's content hash; on a
    /// successful write tool we refresh it. Errored calls record nothing (the
    /// file was not actually changed). Non-tracked tools are ignored.
    pub fn record_tool_file_effects(&mut self, tool_name: &str, args: &Value, is_error: bool) {
        if is_error {
            return;
        }
        if FILE_READ_TOOLS.contains(&tool_name) {
            for path in extract_file_paths(tool_name, args) {
                self.record_read(&path);
            }
        } else if is_file_write_tool(tool_name) {
            for path in extract_file_paths(tool_name, args) {
                self.record_write(&path);
            }
        }
    }
}

/// Tools that read files — we track their mtime after execution.
pub(super) const FILE_READ_TOOLS: &[&str] = &[tool_names::READ_FILE];

/// Tools that modify files — we check mtime before execution.
pub(super) const FILE_WRITE_TOOLS: &[&str] = &[
    tool_names::EDIT_FILE,
    tool_names::DELETE_FILE,
    tool_names::APPLY_PATCH,
];

pub(crate) fn is_file_write_tool(tool_name: &str) -> bool {
    FILE_WRITE_TOOLS.contains(&tool_name)
}

/// Extract file path(s) from tool arguments for FileTime tracking.
///
/// Callers MUST gate this with `FILE_READ_TOOLS.contains(...)` or
/// `is_file_write_tool(...)` first — calling it for any other tool name
/// is a programming error. The previous catch-all `_ => Vec::new()` arm
/// silently absorbed such mistakes and would have made any new file-
/// modifying tool stop participating in stale-edit detection without a
/// single test failure.
pub(crate) fn extract_file_paths(tool_name: &str, args: &Value) -> Vec<String> {
    match tool_name {
        tool_names::READ_FILE | tool_names::EDIT_FILE | tool_names::DELETE_FILE => {
            // edit_file uses "file_path", read_file/delete_file may use "path" or "file_path"
            if let Some(path) = args
                .get("file_path")
                .or_else(|| args.get("path"))
                .and_then(|v| v.as_str())
            {
                vec![path.to_string()]
            } else {
                Vec::new()
            }
        }
        tool_names::APPLY_PATCH => {
            if let Some(patch) = args.get("patch_text").and_then(|v| v.as_str()) {
                let mut paths = Vec::new();
                for line in patch.lines() {
                    let trimmed = line.trim();
                    let file_path = trimmed
                        .strip_prefix("*** Add File:")
                        .or_else(|| trimmed.strip_prefix("*** Update File:"))
                        .or_else(|| trimmed.strip_prefix("*** Delete File:"))
                        .or_else(|| trimmed.strip_prefix("*** Move to:"));
                    if let Some(path) = file_path {
                        let path = path.trim();
                        if !path.is_empty() {
                            paths.push(path.to_string());
                        }
                    }
                }
                paths.sort();
                paths.dedup();
                paths
            } else {
                Vec::new()
            }
        }
        // Any other tool is a caller-path bug: a new file-modifying tool
        // must be added to `FILE_WRITE_TOOLS` *and* extended here; an
        // accidental call from an unrelated tool means the gate above
        // is missing and stale-edit detection would be skipped silently.
        other => {
            debug_assert!(
                false,
                "extract_file_paths called for non-tracked tool {other:?} — \
                 caller missed FILE_READ_TOOLS / is_file_write_tool gate"
            );
            tracing::error!(
                "[file_tracker] extract_file_paths called for non-tracked tool {other:?} — \
                 caller missed FILE_READ_TOOLS / is_file_write_tool gate; stale-edit \
                 detection will be skipped for this call"
            );
            Vec::new()
        }
    }
}

/// Pinning invariant: every member of `FILE_READ_TOOLS` and
/// `FILE_WRITE_TOOLS` MUST be handled by `extract_file_paths`. If a new
/// tool is added to either list without a matching arm, this check
/// will catch it.
#[cfg(test)]
mod gate_invariant_tests {
    use super::*;

    #[test]
    fn every_tracked_tool_has_an_extraction_arm() {
        // Empty args is fine — we only care that the function does NOT
        // hit the catch-all `tracing::error!` arm. The first two arms
        // both handle empty/missing arg payloads by returning an empty
        // vec, so reaching them with an empty `Value::Null` is benign.
        for &tool in FILE_READ_TOOLS.iter().chain(FILE_WRITE_TOOLS.iter()) {
            // We can't directly observe which arm fired, but
            // `debug_assert!` in the catch-all will panic in debug
            // builds, so this test is the regression guard.
            let _ = extract_file_paths(tool, &Value::Null);
        }
    }
}

/// Content-hash freshness behaviour: these pin the exact false-stale bug the
/// content-hash design fixes (a mtime bump with identical bytes must NOT be
/// reported stale) while preserving the real protection (changed bytes ARE
/// reported stale).
#[cfg(test)]
mod content_hash_tests {
    use super::*;
    use std::io::Write;
    use std::time::Duration;

    /// Write `content` to a unique temp path and return it. Uses the process id
    /// + a counter so parallel test threads never collide.
    fn temp_file(content: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut path = std::env::temp_dir();
        path.push(format!(
            "orgii_file_tracker_test_{}_{}.txt",
            std::process::id(),
            n
        ));
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(content.as_bytes()).unwrap();
        f.flush().unwrap();
        path
    }

    /// Force a later mtime without changing bytes — simulates an external
    /// `touch` / mirror copy / editor save-with-no-change.
    fn rewrite_same_bytes(path: &std::path::Path, content: &str) {
        // Sleep a hair so the filesystem records a strictly-later mtime; the
        // whole point is that the OLD mtime-based guard would have fired here.
        std::thread::sleep(Duration::from_millis(5));
        std::fs::write(path, content).unwrap();
    }

    #[test]
    fn same_content_passes_even_after_mtime_bump() {
        let path = temp_file("hello\nworld\n");
        let p = path.to_str().unwrap();
        let mut tracker = FileTimeTracker::new();
        tracker.record_read(p);
        // External process rewrites identical bytes → mtime advances, content
        // unchanged. The old mtime guard false-rejected here; hashing passes.
        rewrite_same_bytes(&path, "hello\nworld\n");
        assert!(tracker.assert_fresh(p).is_ok());
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn changed_content_is_rejected() {
        let path = temp_file("original\n");
        let p = path.to_str().unwrap();
        let mut tracker = FileTimeTracker::new();
        tracker.record_read(p);
        std::fs::write(&path, "tampered externally\n").unwrap();
        assert!(tracker.assert_fresh(p).is_err());
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn same_second_read_then_write_then_recheck_passes() {
        // Reproduces the reported bug: read → our own edit → next edit must NOT
        // be falsely flagged stale. record_write refreshes the hash to the
        // post-edit content so the following assert_fresh matches.
        let path = temp_file("v1\n");
        let p = path.to_str().unwrap();
        let mut tracker = FileTimeTracker::new();
        tracker.record_read(p);
        std::fs::write(&path, "v2 edited\n").unwrap();
        tracker.record_write(p);
        assert!(tracker.assert_fresh(p).is_ok());
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn record_write_on_missing_file_forgets_entry() {
        // A write whose file then can't be hashed (e.g. deleted) must forget
        // the entry so the next assert_fresh takes the "never read → pass"
        // branch instead of comparing against a stale snapshot forever.
        let path = temp_file("content\n");
        let p = path.to_str().unwrap().to_string();
        let mut tracker = FileTimeTracker::new();
        tracker.record_read(&p);
        assert_eq!(tracker.len(), 1);
        std::fs::remove_file(&path).ok();
        tracker.record_write(&p); // file gone → forget
        assert!(tracker.is_empty());
        assert!(tracker.assert_fresh(&p).is_ok()); // never-read branch
    }

    #[test]
    fn never_read_file_passes() {
        let tracker = FileTimeTracker::new();
        assert!(tracker.assert_fresh("/nonexistent/never/read.txt").is_ok());
    }

    #[test]
    fn record_tool_file_effects_routes_read_and_write() {
        let path = temp_file("alpha\n");
        let p = path.to_str().unwrap();
        let mut tracker = FileTimeTracker::new();
        let read_args = serde_json::json!({ "path": p });
        tracker.record_tool_file_effects(tool_names::READ_FILE, &read_args, false);
        assert_eq!(tracker.len(), 1);

        // External change → stale until a write refreshes the snapshot.
        std::fs::write(&path, "beta\n").unwrap();
        assert!(tracker.assert_fresh(p).is_err());

        let edit_args = serde_json::json!({ "file_path": p });
        tracker.record_tool_file_effects(tool_names::EDIT_FILE, &edit_args, false);
        assert!(tracker.assert_fresh(p).is_ok());

        // Errored tool calls record nothing.
        std::fs::write(&path, "gamma\n").unwrap();
        tracker.record_tool_file_effects(tool_names::EDIT_FILE, &edit_args, true);
        assert!(tracker.assert_fresh(p).is_err());
        std::fs::remove_file(&path).ok();
    }
}
