use std::path::Path;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

use super::{
    types::{CursorUsageError, CursorUsageFailureKind},
    MAX_CURSOR_METADATA_BYTES,
};

pub(super) async fn read_small_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    let metadata = tokio::fs::symlink_metadata(path).await.ok()?;
    if !metadata.file_type().is_file() || metadata.len() > MAX_CURSOR_METADATA_BYTES as u64 {
        return None;
    }
    let file = tokio::fs::OpenOptions::new()
        .read(true)
        .open(path)
        .await
        .ok()?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_CURSOR_METADATA_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .await
        .ok()?;
    if bytes.len() > MAX_CURSOR_METADATA_BYTES {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

pub(super) async fn atomic_write_json<T: Serialize>(
    path: &Path,
    value: &T,
) -> Result<(), CursorUsageError> {
    let bytes = serde_json::to_vec(value).map_err(|error| {
        CursorUsageError::new(
            CursorUsageFailureKind::Cache,
            format!("Failed to serialize Cursor usage cache: {error}"),
        )
    })?;
    atomic_write_bytes(path, &bytes).await
}

async fn atomic_write_bytes(path: &Path, bytes: &[u8]) -> Result<(), CursorUsageError> {
    let parent = path.parent().ok_or_else(|| {
        CursorUsageError::new(
            CursorUsageFailureKind::Cache,
            "Cursor usage cache path has no parent",
        )
    })?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(cache_io_error)?;
    set_sensitive_directory_permissions(parent).await?;

    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("cursor-usage");
    let temporary_path = parent.join(format!(".{file_name}.{}.tmp", Uuid::new_v4()));
    let write_result = async {
        let mut file = open_sensitive_new(&temporary_path).await?;
        file.write_all(bytes).await.map_err(cache_io_error)?;
        file.sync_all().await.map_err(cache_io_error)?;
        drop(file);
        replace_with_staged_file(&temporary_path, path).await
    }
    .await;

    if write_result.is_err() {
        let _ = tokio::fs::remove_file(&temporary_path).await;
    }
    write_result
}

pub(super) async fn open_sensitive_new(path: &Path) -> Result<tokio::fs::File, CursorUsageError> {
    let mut options = tokio::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        options.mode(0o600);
    }
    options.open(path).await.map_err(cache_io_error)
}

pub(super) async fn atomic_copy_file(
    source: &Path,
    target: &Path,
    max_bytes: u64,
) -> Result<(), CursorUsageError> {
    let parent = target.parent().ok_or_else(|| {
        CursorUsageError::new(
            CursorUsageFailureKind::Cache,
            "Cursor usage archive path has no parent",
        )
    })?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(cache_io_error)?;
    set_sensitive_directory_permissions(parent).await?;
    let file_name = target
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("cursor-usage");
    let staged = parent.join(format!(".{file_name}.copy.tmp"));
    remove_file_if_present(&staged).await?;
    let copy_result = async {
        let source_file = tokio::fs::OpenOptions::new()
            .read(true)
            .open(source)
            .await
            .map_err(cache_io_error)?;
        let source_metadata = source_file.metadata().await.map_err(cache_io_error)?;
        if !source_metadata.is_file() || source_metadata.len() > max_bytes {
            return Err(CursorUsageError::new(
                CursorUsageFailureKind::Cache,
                format!("Cursor usage archive source exceeds the {max_bytes}-byte safety limit"),
            ));
        }
        let mut target_file = open_sensitive_new(&staged).await?;
        let copied = tokio::io::copy(
            &mut source_file.take(max_bytes.saturating_add(1)),
            &mut target_file,
        )
        .await
        .map_err(cache_io_error)?;
        if copied > max_bytes {
            return Err(CursorUsageError::new(
                CursorUsageFailureKind::Cache,
                format!("Cursor usage archive source exceeds the {max_bytes}-byte safety limit"),
            ));
        }
        target_file.sync_all().await.map_err(cache_io_error)?;
        drop(target_file);
        replace_with_staged_file(&staged, target).await
    }
    .await;
    if copy_result.is_err() {
        let _ = tokio::fs::remove_file(&staged).await;
    }
    copy_result
}

#[cfg(not(windows))]
pub(super) async fn replace_with_staged_file(
    staged: &Path,
    target: &Path,
) -> Result<(), CursorUsageError> {
    tokio::fs::rename(staged, target)
        .await
        .map_err(cache_io_error)
}

#[cfg(windows)]
pub(super) async fn replace_with_staged_file(
    staged: &Path,
    target: &Path,
) -> Result<(), CursorUsageError> {
    // Windows rename does not replace an existing target. Preserve the
    // previous last-good beside it until the staged file is installed, then
    // restore it if installation fails.
    let backup = target.with_extension(format!("backup-{}", Uuid::new_v4()));
    let had_target = tokio::fs::metadata(target).await.is_ok();
    if had_target {
        tokio::fs::rename(target, &backup)
            .await
            .map_err(cache_io_error)?;
    }
    match tokio::fs::rename(staged, target).await {
        Ok(()) => {
            if had_target {
                let _ = tokio::fs::remove_file(backup).await;
            }
            Ok(())
        }
        Err(error) => {
            if had_target {
                let _ = tokio::fs::rename(&backup, target).await;
            }
            Err(cache_io_error(error))
        }
    }
}

pub(super) async fn set_sensitive_directory_permissions(
    path: &Path,
) -> Result<(), CursorUsageError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .await
            .map_err(cache_io_error)?;
    }
    Ok(())
}

pub(super) async fn set_sensitive_file_permissions(path: &Path) -> Result<(), CursorUsageError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .await
            .map_err(cache_io_error)?;
    }
    Ok(())
}

pub(super) fn cache_io_error(error: std::io::Error) -> CursorUsageError {
    CursorUsageError::new(
        CursorUsageFailureKind::Cache,
        format!("Cursor usage cache I/O failed: {error}"),
    )
}

pub(super) async fn atomic_archive_file_if_present(
    active_path: &Path,
    archive_path: &Path,
) -> Result<bool, CursorUsageError> {
    match tokio::fs::symlink_metadata(active_path).await {
        Ok(metadata) if metadata.file_type().is_file() => {}
        Ok(_) => {
            return Err(CursorUsageError::new(
                CursorUsageFailureKind::Cache,
                "Cursor usage archive source is not a regular file",
            ))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(cache_io_error(error)),
    }
    atomic_copy_file(active_path, archive_path, MAX_CURSOR_METADATA_BYTES as u64).await?;
    tokio::fs::remove_file(active_path)
        .await
        .map_err(cache_io_error)?;
    Ok(true)
}

pub(super) async fn remove_file_if_present(path: &Path) -> Result<(), CursorUsageError> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(cache_io_error(error)),
    }
}
