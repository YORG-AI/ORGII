use std::fs::{self, File, Metadata, OpenOptions};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use conversation_portability::{
    ExactReadError, ExactReadFailureKind, PortableSourceSnapshot, PortableSourceSnapshotAlgorithm,
    MAX_PORTABLE_CONVERSATION_BYTES, MAX_PORTABLE_CONVERSATION_EVENTS,
};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use super::ExactImportedFileSource;

const MAX_EXACT_JSONL_LINE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Copy)]
pub(super) struct ExactReadLimits {
    source_bytes: usize,
    line_bytes: usize,
    records: usize,
}

impl ExactReadLimits {
    pub(super) const fn production() -> Self {
        Self {
            source_bytes: MAX_PORTABLE_CONVERSATION_BYTES,
            line_bytes: MAX_EXACT_JSONL_LINE_BYTES,
            records: MAX_PORTABLE_CONVERSATION_EVENTS,
        }
    }

    #[cfg(test)]
    pub(super) const fn test(source_bytes: usize, line_bytes: usize, records: usize) -> Self {
        Self {
            source_bytes,
            line_bytes,
            records,
        }
    }
}

#[derive(Debug, Clone)]
pub(super) struct ExactSourceRecord {
    pub(super) index: u64,
    pub(super) value: Map<String, Value>,
}

#[derive(Debug, Clone)]
pub(super) struct ExactSourceRecords {
    pub(super) records: Vec<ExactSourceRecord>,
    pub(super) snapshot: PortableSourceSnapshot,
}

pub(super) fn read_source_records(
    source: &ExactImportedFileSource,
    limits: ExactReadLimits,
) -> Result<ExactSourceRecords, ExactReadError> {
    read_source_records_inner(source, limits, || {})
}

fn read_source_records_inner(
    source: &ExactImportedFileSource,
    limits: ExactReadLimits,
    after_open: impl FnOnce(),
) -> Result<ExactSourceRecords, ExactReadError> {
    let (mut file, opened_path, metadata_before) =
        open_verified_file(&source.source_path, &source.containment_root)?;
    after_open();
    let mut bytes = Vec::with_capacity(
        usize::try_from(metadata_before.len())
            .unwrap_or(limits.source_bytes)
            .min(limits.source_bytes),
    );
    (&mut file)
        .take((limits.source_bytes as u64).saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| {
            ExactReadError::new(
                ExactReadFailureKind::ReadFailed,
                format!(
                    "Failed to read exact transcript {}: {error}",
                    source.source_path.display()
                ),
            )
        })?;
    if bytes.len() > limits.source_bytes {
        return Err(ExactReadError::new(
            ExactReadFailureKind::SizeLimit,
            format!(
                "Exact transcript exceeds the {}-byte source limit",
                limits.source_bytes
            ),
        ));
    }
    let metadata_after = file.metadata().map_err(|error| {
        ExactReadError::new(
            ExactReadFailureKind::ReadFailed,
            format!("Failed to re-read exact transcript metadata: {error}"),
        )
    })?;
    if !same_open_file_snapshot(&metadata_before, &metadata_after)
        || metadata_after.len() != bytes.len() as u64
    {
        return Err(ExactReadError::new(
            ExactReadFailureKind::SourceChanged,
            "Exact transcript changed while its authoritative handle was being read",
        ));
    }
    verify_open_path_still_matches(&opened_path, &metadata_after)?;

    if !bytes.is_empty() && bytes.last() != Some(&b'\n') {
        return Err(ExactReadError::new(
            ExactReadFailureKind::UnterminatedTail,
            "Exact JSONL transcript ends with an unterminated record",
        ));
    }

    let mut records = Vec::new();
    for (physical_line, line) in bytes.split(|byte| *byte == b'\n').enumerate() {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if line.len() > limits.line_bytes {
            return Err(ExactReadError::new(
                ExactReadFailureKind::SizeLimit,
                format!(
                    "Exact JSONL line {} exceeds the {}-byte line limit",
                    physical_line + 1,
                    limits.line_bytes
                ),
            ));
        }
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        if records.len() >= limits.records {
            return Err(ExactReadError::new(
                ExactReadFailureKind::RecordLimit,
                format!(
                    "Exact transcript exceeds the {}-record limit",
                    limits.records
                ),
            ));
        }
        let value: Value = serde_json::from_slice(line).map_err(|error| {
            ExactReadError::new(
                ExactReadFailureKind::MalformedRecord,
                format!(
                    "Malformed exact JSONL record on line {}: {error}",
                    physical_line + 1
                ),
            )
        })?;
        let Value::Object(value) = value else {
            return Err(ExactReadError::new(
                ExactReadFailureKind::MalformedRecord,
                format!(
                    "Exact JSONL record on line {} is not an object",
                    physical_line + 1
                ),
            ));
        };
        records.push(ExactSourceRecord {
            index: records.len() as u64,
            value,
        });
    }

    let snapshot = PortableSourceSnapshot {
        algorithm: PortableSourceSnapshotAlgorithm::Sha256,
        digest: format!("{:x}", Sha256::digest(&bytes)),
        observed_bytes: bytes.len() as u64,
    };
    Ok(ExactSourceRecords { records, snapshot })
}

fn open_verified_file(
    path: &Path,
    containment_root: &Path,
) -> Result<(File, PathBuf, Metadata), ExactReadError> {
    if !path.is_absolute() || !containment_root.is_absolute() {
        return Err(ExactReadError::new(
            ExactReadFailureKind::InvalidSourcePath,
            "Exact transcript path and containment root must be absolute",
        ));
    }
    let root_link_metadata = fs::symlink_metadata(containment_root).map_err(|error| {
        ExactReadError::new(
            ExactReadFailureKind::InvalidSourcePath,
            format!("Failed to inspect exact transcript root: {error}"),
        )
    })?;
    if root_link_metadata.file_type().is_symlink() || !root_link_metadata.is_dir() {
        return Err(ExactReadError::new(
            ExactReadFailureKind::InvalidSourcePath,
            "Exact transcript containment root must be a real directory, not a symlink",
        ));
    }
    let canonical_root = containment_root.canonicalize().map_err(|error| {
        ExactReadError::new(
            ExactReadFailureKind::InvalidSourcePath,
            format!("Failed to resolve exact transcript root: {error}"),
        )
    })?;
    reject_symlink_components(path, containment_root)?;
    let canonical_path = path.canonicalize().map_err(|error| {
        ExactReadError::new(
            ExactReadFailureKind::InvalidSourcePath,
            format!("Failed to resolve exact transcript path: {error}"),
        )
    })?;
    if !canonical_path.starts_with(&canonical_root) {
        return Err(ExactReadError::new(
            ExactReadFailureKind::InvalidSourcePath,
            "Exact transcript escapes its authorized containment root",
        ));
    }

    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_FLAG_OPEN_REPARSE_POINT: inspect rather than follow a final
        // symlink/junction. The metadata check below rejects reparse points.
        options.custom_flags(0x0020_0000);
    }
    let file = options.open(path).map_err(|error| {
        ExactReadError::new(
            ExactReadFailureKind::InvalidSourcePath,
            format!("Failed to securely open exact transcript: {error}"),
        )
    })?;
    let metadata = file.metadata().map_err(|error| {
        ExactReadError::new(
            ExactReadFailureKind::ReadFailed,
            format!("Failed to inspect open exact transcript: {error}"),
        )
    })?;
    if !metadata.is_file() || metadata_is_reparse_point(&metadata) {
        return Err(ExactReadError::new(
            ExactReadFailureKind::InvalidSourcePath,
            "Exact transcript source must be a regular file without reparse indirection",
        ));
    }
    verify_open_path_still_matches(&canonical_path, &metadata)?;
    Ok((file, canonical_path, metadata))
}

fn reject_symlink_components(path: &Path, containment_root: &Path) -> Result<(), ExactReadError> {
    let relative = path.strip_prefix(containment_root).map_err(|_| {
        ExactReadError::new(
            ExactReadFailureKind::InvalidSourcePath,
            "Exact transcript path is not lexically contained by its authorized root",
        )
    })?;
    let mut current = containment_root.to_path_buf();
    for component in relative.components() {
        match component {
            Component::Normal(value) => current.push(value),
            Component::CurDir => continue,
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(ExactReadError::new(
                    ExactReadFailureKind::InvalidSourcePath,
                    "Exact transcript path contains an escaping component",
                ));
            }
        }
        let metadata = fs::symlink_metadata(&current).map_err(|error| {
            ExactReadError::new(
                ExactReadFailureKind::InvalidSourcePath,
                format!("Failed to inspect exact transcript path component: {error}"),
            )
        })?;
        if metadata.file_type().is_symlink() || metadata_is_reparse_point(&metadata) {
            return Err(ExactReadError::new(
                ExactReadFailureKind::InvalidSourcePath,
                "Exact transcript path contains a symlink or reparse point",
            ));
        }
    }
    Ok(())
}

fn verify_open_path_still_matches(
    canonical_path: &Path,
    open_metadata: &Metadata,
) -> Result<(), ExactReadError> {
    let path_metadata = fs::metadata(canonical_path).map_err(|error| {
        ExactReadError::new(
            ExactReadFailureKind::SourceChanged,
            format!("Exact transcript path changed after open: {error}"),
        )
    })?;
    if !same_file_identity(open_metadata, &path_metadata) {
        return Err(ExactReadError::new(
            ExactReadFailureKind::SourceChanged,
            "Exact transcript path was replaced after its authoritative handle was opened",
        ));
    }
    Ok(())
}

fn same_open_file_snapshot(left: &Metadata, right: &Metadata) -> bool {
    left.len() == right.len()
        && left.modified().ok() == right.modified().ok()
        && same_file_identity(left, right)
}

#[cfg(unix)]
fn same_file_identity(left: &Metadata, right: &Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    left.dev() == right.dev() && left.ino() == right.ino()
}

#[cfg(windows)]
fn same_file_identity(left: &Metadata, right: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    left.volume_serial_number() == right.volume_serial_number()
        && left.file_index() == right.file_index()
}

#[cfg(not(any(unix, windows)))]
fn same_file_identity(left: &Metadata, right: &Metadata) -> bool {
    left.len() == right.len() && left.modified().ok() == right.modified().ok()
}

#[cfg(windows)]
fn metadata_is_reparse_point(metadata: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
const fn metadata_is_reparse_point(_: &Metadata) -> bool {
    false
}

#[cfg(test)]
pub(super) fn read_source_records_with_limits(
    source: &ExactImportedFileSource,
    limits: ExactReadLimits,
) -> Result<ExactSourceRecords, ExactReadError> {
    read_source_records(source, limits)
}

#[cfg(test)]
pub(super) fn read_source_records_with_open_hook(
    source: &ExactImportedFileSource,
    limits: ExactReadLimits,
    after_open: impl FnOnce(),
) -> Result<ExactSourceRecords, ExactReadError> {
    read_source_records_inner(source, limits, after_open)
}

#[cfg(test)]
pub(super) const fn production_limits_for_test() -> (usize, usize, usize) {
    (
        MAX_PORTABLE_CONVERSATION_BYTES,
        MAX_EXACT_JSONL_LINE_BYTES,
        MAX_PORTABLE_CONVERSATION_EVENTS,
    )
}
