//! Provider-native transcript filesystem primitives.
//!
//! These operations are deliberately below the materialization coordinator:
//! they own cross-process exclusion and crash-safe replacement of a provider
//! transcript, but know nothing about canonical conversations or bindings.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use uuid::Uuid;

/// Opaque change token for one provider-native transcript file.
///
/// This intentionally exposes no path to the frontend. Nanosecond mtime plus
/// byte length is the same filesystem identity used by imported-history scan
/// invalidation, and lets canonical readers detect an external native App
/// append even when the managed Session row itself did not change.
pub(super) fn native_transcript_revision(path: &Path) -> Result<String, String> {
    let (modified_at_ns, size_bytes) =
        orgtrack_core::sources::imported_history::paths::file_metadata_signature(
            path,
            "provider-native transcript",
        )?;
    Ok(format!("native-file-v1:{modified_at_ns}:{size_bytes}"))
}

pub(super) struct ClaudeTranscriptGuard {
    lock_file: fs::File,
}

impl Drop for ClaudeTranscriptGuard {
    fn drop(&mut self) {
        // Closing the descriptor also releases the lock; explicit unlock keeps
        // lock ownership obvious to readers and is best effort during Drop.
        let _ = self.lock_file.unlock();
    }
}

/// Serialize every mutation of one Claude native UUID across ORG2 processes.
/// The adjacent lock file is stable even when the transcript inode is replaced.
pub(super) fn lock_claude_transcript(path: &Path) -> Result<ClaudeTranscriptGuard, String> {
    let parent = path.parent().ok_or_else(|| {
        format!(
            "Claude transcript has no parent directory: {}",
            path.display()
        )
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "create Claude transcript directory {}: {error}",
            parent.display()
        )
    })?;

    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("transcript");
    let lock_path = parent.join(format!(".{file_name}.orgii.lock"));
    let lock_file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)
        .map_err(|error| {
            format!(
                "open Claude transcript lock {}: {error}",
                lock_path.display()
            )
        })?;
    lock_file
        .lock()
        .map_err(|error| format!("lock Claude transcript {}: {error}", lock_path.display()))?;
    Ok(ClaudeTranscriptGuard { lock_file })
}

#[cfg(windows)]
fn atomic_replace_file(staged: &Path, destination: &Path, label: &str) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let staged_wide = staged
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination_wide = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    unsafe {
        MoveFileExW(
            PCWSTR(staged_wide.as_ptr()),
            PCWSTR(destination_wide.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    }
    .map_err(|error| {
        format!(
            "commit {label} {} -> {}: {error}",
            staged.display(),
            destination.display()
        )
    })
}

#[cfg(not(windows))]
fn atomic_replace_file(staged: &Path, destination: &Path, label: &str) -> Result<(), String> {
    fs::rename(staged, destination).map_err(|error| {
        format!(
            "commit {label} {} -> {}: {error}",
            staged.display(),
            destination.display()
        )
    })
}

#[cfg(unix)]
fn sync_parent(path: &Path, label: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{label} has no parent: {}", path.display()))?;
    fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("sync {label} directory {}: {error}", parent.display()))
}

#[cfg(not(unix))]
fn sync_parent(_path: &Path, _label: &str) -> Result<(), String> {
    Ok(())
}

fn staged_path(destination: &Path, extension: &str) -> PathBuf {
    destination.with_extension(format!("{extension}-{}", Uuid::new_v4().simple()))
}

fn ensure_parent(path: &Path, label: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{label} path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("create {label} directory {}: {error}", parent.display()))
}

fn replace_with_staged_path(
    destination: &Path,
    staged_extension: &str,
    label: &str,
    sync_contents: bool,
    prepare: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<(), String> {
    ensure_parent(destination, label)?;
    let staged = staged_path(destination, staged_extension);
    let result = (|| -> Result<(), String> {
        prepare(&staged)?;
        if sync_contents {
            fs::File::open(&staged)
                .and_then(|file| file.sync_all())
                .map_err(|error| format!("sync staged {label} {}: {error}", staged.display()))?;
        }
        atomic_replace_file(&staged, destination, label)?;
        sync_parent(destination, label)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&staged);
    }
    result
}

/// Crash-safe whole-file replacement. The caller serializes content into the
/// provided staged file, while this filesystem owner handles directory setup,
/// fsync, atomic replacement, parent sync, and failed-stage cleanup.
pub(super) fn write_file_atomically(
    destination: &Path,
    staged_extension: &str,
    label: &str,
    write: impl FnOnce(&mut fs::File) -> Result<(), String>,
) -> Result<(), String> {
    replace_with_staged_path(destination, staged_extension, label, true, |staged| {
        let mut file = fs::File::create(staged)
            .map_err(|error| format!("create staged {label} {}: {error}", staged.display()))?;
        write(&mut file)
    })
}

/// Crash-safe copy into a provider-owned destination.
pub(super) fn copy_file_atomically(
    source: &Path,
    destination: &Path,
    label: &str,
) -> Result<(), String> {
    replace_with_staged_path(destination, "jsonl.tmp", label, true, |staged| {
        fs::copy(source, staged).map(|_| ()).map_err(|error| {
            format!(
                "copy {label} {} -> {}: {error}",
                source.display(),
                staged.display()
            )
        })
    })
}

/// Atomically replace an account-profile runner alias with a link to the
/// provider-native transcript.
pub(super) fn replace_file_link_atomically(
    source: &Path,
    destination: &Path,
    label: &str,
) -> Result<(), String> {
    if source == destination {
        return Ok(());
    }
    replace_with_staged_path(destination, "jsonl.link", label, false, |staged| {
        #[cfg(unix)]
        return std::os::unix::fs::symlink(source, staged).map_err(|error| {
            format!(
                "link {label} {} -> {}: {error}",
                staged.display(),
                source.display()
            )
        });

        #[cfg(not(unix))]
        fs::hard_link(source, staged).map_err(|error| {
            format!(
                "link {label} {} -> {}: {error}",
                staged.display(),
                source.display()
            )
        })
    })
}

/// Append a serialized JSONL suffix without ever exposing a partially written
/// provider transcript. The caller must hold [`lock_claude_transcript`] from
/// inspection through this commit.
pub(super) fn append_suffix_atomically(path: &Path, suffix: &[u8]) -> Result<(), String> {
    replace_with_staged_path(path, "jsonl.tmp", "Claude transcript", true, |staged| {
        let mut source = fs::File::open(path)
            .map_err(|error| format!("open Claude transcript {}: {error}", path.display()))?;
        let source_permissions = source
            .metadata()
            .map_err(|error| {
                format!(
                    "read Claude transcript metadata {}: {error}",
                    path.display()
                )
            })?
            .permissions();
        let mut output = fs::File::create(staged).map_err(|error| {
            format!(
                "create staged Claude transcript {}: {error}",
                staged.display()
            )
        })?;
        fs::set_permissions(staged, source_permissions).map_err(|error| {
            format!(
                "preserve Claude transcript permissions on {}: {error}",
                staged.display()
            )
        })?;
        let mut last_byte = None;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = source
                .read(&mut buffer)
                .map_err(|error| format!("read Claude transcript {}: {error}", path.display()))?;
            if read == 0 {
                break;
            }
            last_byte = Some(buffer[read - 1]);
            output.write_all(&buffer[..read]).map_err(|error| {
                format!("copy Claude transcript into {}: {error}", staged.display())
            })?;
        }
        if last_byte.is_some_and(|byte| byte != b'\n') {
            output.write_all(b"\n").map_err(|error| {
                format!(
                    "terminate staged Claude transcript {}: {error}",
                    staged.display()
                )
            })?;
        }
        output.write_all(suffix).map_err(|error| {
            format!(
                "append staged Claude transcript {}: {error}",
                staged.display()
            )
        })?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOCK_CHILD_PATH: &str = "ORGII_CLAUDE_TRANSCRIPT_LOCK_CHILD_PATH";
    const LOCK_CHILD_READY: &str = "ORGII_CLAUDE_TRANSCRIPT_LOCK_CHILD_READY";

    #[test]
    fn native_revision_changes_when_an_external_app_appends() {
        let temp = tempfile::tempdir().expect("temp native transcript root");
        let path = temp.path().join("session.jsonl");
        fs::write(&path, b"{\"type\":\"user\"}\n").expect("seed transcript");
        let before = native_transcript_revision(&path).expect("initial revision");

        fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("open transcript for append")
            .write_all(b"{\"type\":\"assistant\"}\n")
            .expect("append transcript");

        let after = native_transcript_revision(&path).expect("appended revision");
        assert_ne!(before, after);
    }

    #[test]
    fn atomic_suffix_commit_preserves_prefix_and_repairs_missing_newline() {
        let temp = tempfile::tempdir().expect("temp Claude transcript root");
        let path = temp.path().join("session.jsonl");
        fs::write(&path, br#"{"type":"user"}"#).expect("seed transcript");
        let _guard = lock_claude_transcript(&path).expect("lock transcript");

        append_suffix_atomically(&path, b"{\"type\":\"assistant\"}\n")
            .expect("append suffix atomically");

        assert_eq!(
            fs::read_to_string(&path).expect("read transcript"),
            "{\"type\":\"user\"}\n{\"type\":\"assistant\"}\n"
        );
    }

    #[test]
    #[ignore = "launched by claude_transcript_mutation_is_locked_across_processes"]
    fn claude_transcript_lock_child() {
        let Some(path) = std::env::var_os(LOCK_CHILD_PATH).map(std::path::PathBuf::from) else {
            return;
        };
        let ready = std::path::PathBuf::from(
            std::env::var_os(LOCK_CHILD_READY).expect("lock child ready marker"),
        );
        fs::write(&ready, b"ready").expect("write child ready marker");
        let _guard = lock_claude_transcript(&path).expect("child lock transcript");
        append_suffix_atomically(&path, b"{\"type\":\"assistant\"}\n")
            .expect("child append transcript");
    }

    #[test]
    fn claude_transcript_mutation_is_locked_across_processes() {
        use std::process::Command;
        use std::thread;
        use std::time::{Duration, Instant};

        let temp = tempfile::tempdir().expect("temp Claude transcript root");
        let path = temp.path().join("session.jsonl");
        let ready = temp.path().join("child-ready");
        fs::write(&path, b"{\"type\":\"user\"}\n").expect("seed transcript");
        let guard = lock_claude_transcript(&path).expect("parent lock transcript");
        let mut child = Command::new(std::env::current_exe().expect("current test executable"))
            .arg("claude_transcript_lock_child")
            .arg("--ignored")
            .env(LOCK_CHILD_PATH, &path)
            .env(LOCK_CHILD_READY, &ready)
            .spawn()
            .expect("launch transcript lock child");

        let deadline = Instant::now() + Duration::from_secs(5);
        while !ready.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(ready.exists(), "child must reach transcript lock boundary");
        thread::sleep(Duration::from_millis(100));
        assert_eq!(
            fs::read_to_string(&path).expect("read locked transcript"),
            "{\"type\":\"user\"}\n"
        );
        assert!(
            child.try_wait().expect("inspect child").is_none(),
            "child must wait for the cross-process lock"
        );

        drop(guard);
        assert!(child.wait().expect("wait for child").success());
        assert_eq!(
            fs::read_to_string(&path).expect("read committed transcript"),
            "{\"type\":\"user\"}\n{\"type\":\"assistant\"}\n"
        );
    }
}
