use std::fs::{self, Metadata};
use std::path::{Component, Path, PathBuf};
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::time::{Duration, SystemTime};
#[cfg(any(target_os = "linux", target_os = "macos"))]
use uuid::Uuid;

use crate::{
    NativeMaterializationError, NativeMaterializationFailureKind, NativeMaterializationResult,
};

#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::ffi::CString;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::fs::OpenOptions;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::io::{Read, Write};
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::os::unix::ffi::OsStrExt;
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PublishedFileIdentity {
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    pub(crate) bytes: u64,
}

pub(crate) fn require_supported_platform() -> NativeMaterializationResult<()> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        Ok(())
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        Err(NativeMaterializationError::new(
            NativeMaterializationFailureKind::UnsupportedPlatform,
            "Native transcript publication is disabled on this platform until no-follow, no-replace rename, and directory-fsync semantics are implemented",
        ))
    }
}

pub(crate) fn canonical_existing_directory(
    label: &str,
    path: &Path,
) -> NativeMaterializationResult<PathBuf> {
    if !path.is_absolute() {
        return Err(NativeMaterializationError::invalid(format!(
            "{label} must be an absolute path"
        )));
    }
    let canonical = fs::canonicalize(path).map_err(|error| {
        NativeMaterializationError::filesystem(format!(
            "Failed to resolve {label} {}: {error}",
            path.display()
        ))
    })?;
    let metadata = fs::symlink_metadata(&canonical).map_err(|error| {
        NativeMaterializationError::filesystem(format!(
            "Failed to inspect {label} {}: {error}",
            canonical.display()
        ))
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(NativeMaterializationError::filesystem(format!(
            "{label} must resolve to a real directory"
        )));
    }
    Ok(canonical)
}

pub(crate) fn validate_executable(path: &Path) -> NativeMaterializationResult<PathBuf> {
    if !path.is_absolute() {
        return Err(NativeMaterializationError::invalid(
            "CLI executable must be an absolute path selected by the launch registry",
        ));
    }
    let metadata = fs::metadata(path).map_err(|error| {
        NativeMaterializationError::filesystem(format!(
            "Failed to inspect CLI executable {}: {error}",
            path.display()
        ))
    })?;
    if !metadata.is_file() {
        return Err(NativeMaterializationError::invalid(
            "CLI executable does not resolve to a file",
        ));
    }
    #[cfg(unix)]
    if metadata.permissions().mode() & 0o111 == 0 {
        return Err(NativeMaterializationError::invalid(
            "CLI executable is not executable",
        ));
    }
    Ok(path.to_path_buf())
}

pub(crate) fn ensure_private_relative_directory(
    canonical_root: &Path,
    relative: &Path,
) -> NativeMaterializationResult<PathBuf> {
    reject_writable_directory(canonical_root)?;
    let mut current = canonical_root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(component) = component else {
            return Err(NativeMaterializationError::filesystem(
                "Target directory contains a non-normal path component",
            ));
        };
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(NativeMaterializationError::filesystem(format!(
                        "Target directory component is not a real directory: {}",
                        current.display()
                    )));
                }
                reject_writable_metadata(&current, &metadata)?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                create_private_directory(&current)?;
                reject_writable_directory(&current)?;
                fsync_directory(
                    current
                        .parent()
                        .ok_or_else(|| NativeMaterializationError::filesystem("Missing parent"))?,
                )?;
            }
            Err(error) => {
                return Err(NativeMaterializationError::filesystem(format!(
                    "Failed to inspect target directory {}: {error}",
                    current.display()
                )));
            }
        }
    }
    let resolved = fs::canonicalize(&current).map_err(|error| {
        NativeMaterializationError::filesystem(format!(
            "Failed to resolve target directory {}: {error}",
            current.display()
        ))
    })?;
    if !resolved.starts_with(canonical_root) {
        return Err(NativeMaterializationError::filesystem(
            "Target directory escaped the explicit profile root",
        ));
    }
    Ok(resolved)
}

#[cfg(unix)]
fn create_private_directory(path: &Path) -> NativeMaterializationResult<()> {
    match fs::DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let metadata = fs::symlink_metadata(path).map_err(|inspect_error| {
                NativeMaterializationError::filesystem(format!(
                    "Failed to inspect raced target directory {}: {inspect_error}",
                    path.display()
                ))
            })?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                Err(NativeMaterializationError::filesystem(format!(
                    "Raced target directory is not a real directory: {}",
                    path.display()
                )))
            } else {
                reject_writable_metadata(path, &metadata)
            }
        }
        Err(error) => Err(NativeMaterializationError::filesystem(format!(
            "Failed to create target directory {}: {error}",
            path.display()
        ))),
    }
}

#[cfg(not(unix))]
fn create_private_directory(_path: &Path) -> NativeMaterializationResult<()> {
    require_supported_platform()
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) fn publish_private_no_clobber(
    containment_root: &Path,
    target: &Path,
    bytes: &[u8],
) -> NativeMaterializationResult<PublishedFileIdentity> {
    require_supported_platform()?;
    let parent = target
        .parent()
        .ok_or_else(|| NativeMaterializationError::filesystem("Target has no parent"))?;
    validate_contained_target_parent(containment_root, parent)?;
    let target_name = target
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| NativeMaterializationError::filesystem("Target has no UTF-8 filename"))?;
    cleanup_stale_candidate_temporaries(
        parent,
        target_name,
        SystemTime::now()
            .checked_sub(Duration::from_secs(24 * 60 * 60))
            .ok_or_else(|| NativeMaterializationError::filesystem("System clock underflow"))?,
    )?;
    match fs::symlink_metadata(target) {
        Ok(_) => {
            return Err(NativeMaterializationError::new(
                NativeMaterializationFailureKind::NoClobber,
                format!(
                    "Refusing to overwrite existing native target: {}",
                    target.display()
                ),
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(NativeMaterializationError::filesystem(format!(
                "Failed to inspect native target before publication: {error}"
            )));
        }
    }
    let temporary_path = parent.join(format!(
        ".{target_name}.org2-materializing-{}.tmp",
        Uuid::new_v4()
    ));

    let mut temporary = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(&temporary_path)
        .map_err(|error| {
            NativeMaterializationError::filesystem(format!(
                "Failed to create private native staging file: {error}"
            ))
        })?;

    let write_result = (|| -> NativeMaterializationResult<PublishedFileIdentity> {
        temporary.write_all(bytes).map_err(|error| {
            NativeMaterializationError::filesystem(format!(
                "Failed to write native staging file: {error}"
            ))
        })?;
        temporary.sync_all().map_err(|error| {
            NativeMaterializationError::filesystem(format!(
                "Failed to fsync native staging file: {error}"
            ))
        })?;
        identity_from_metadata(temporary.metadata().map_err(|error| {
            NativeMaterializationError::filesystem(format!(
                "Failed to inspect native staging file: {error}"
            ))
        })?)
    })();
    drop(temporary);
    let staging_identity = match write_result {
        Ok(identity) => identity,
        Err(error) => {
            let _ = fs::remove_file(&temporary_path);
            return Err(error);
        }
    };

    if let Err(error) = atomic_rename_no_replace(&temporary_path, target) {
        let _ = fs::remove_file(&temporary_path);
        return Err(if error.kind() == std::io::ErrorKind::AlreadyExists {
            NativeMaterializationError::new(
                NativeMaterializationFailureKind::NoClobber,
                format!(
                    "Refusing to overwrite existing native target: {}",
                    target.display()
                ),
            )
        } else {
            NativeMaterializationError::filesystem(format!(
                "Failed to publish native target without clobbering: {error}"
            ))
        });
    }
    if let Err(error) = validate_contained_target_parent(containment_root, parent) {
        return cleanup_published_after_error(target, &staging_identity, error);
    }

    let identity = match fs::symlink_metadata(target)
        .map_err(|error| NativeMaterializationError::filesystem(error.to_string()))
        .and_then(identity_from_metadata)
    {
        Ok(identity) if same_file_identity(&identity, &staging_identity) => identity,
        Ok(_) => {
            return cleanup_published_after_error(
                target,
                &staging_identity,
                NativeMaterializationError::filesystem(
                    "Published native target does not retain the staged file identity",
                ),
            );
        }
        Err(error) => {
            return cleanup_published_after_error(target, &staging_identity, error);
        }
    };
    if let Err(error) = fsync_directory(parent) {
        return cleanup_published_after_error(target, &identity, error);
    }
    Ok(identity)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub(crate) fn publish_private_no_clobber(
    _containment_root: &Path,
    _target: &Path,
    _bytes: &[u8],
) -> NativeMaterializationResult<PublishedFileIdentity> {
    match require_supported_platform() {
        Err(error) => Err(error),
        Ok(()) => Err(NativeMaterializationError::filesystem(
            "Unsupported platform unexpectedly passed its publication guard",
        )),
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn cleanup_published_after_error<T>(
    target: &Path,
    expected: &PublishedFileIdentity,
    error: NativeMaterializationError,
) -> NativeMaterializationResult<T> {
    match remove_if_identity_matches(target, expected) {
        Ok(_) => Err(error),
        Err(cleanup_error) => Err(NativeMaterializationError::filesystem(format!(
            "{error}; identity-guarded cleanup also failed: {cleanup_error}"
        ))),
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn atomic_rename_no_replace(source: &Path, target: &Path) -> std::io::Result<()> {
    let source = CString::new(source.as_os_str().as_bytes()).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Native staging path contains an interior NUL",
        )
    })?;
    let target = CString::new(target.as_os_str().as_bytes()).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Native target path contains an interior NUL",
        )
    })?;
    #[cfg(target_os = "macos")]
    // SAFETY: both C strings are NUL-terminated, remain alive for the call,
    // and name same-directory paths selected by the guarded publisher.
    let status = unsafe { libc::renamex_np(source.as_ptr(), target.as_ptr(), libc::RENAME_EXCL) };
    #[cfg(target_os = "linux")]
    // SAFETY: both C strings are NUL-terminated and remain alive for the
    // duration of this no-replace renameat2 call.
    let status = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            target.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if status == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) fn read_identity_guarded(
    path: &Path,
    maximum_bytes: usize,
) -> NativeMaterializationResult<(Vec<u8>, PublishedFileIdentity)> {
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(path)
        .map_err(|error| {
            NativeMaterializationError::filesystem(format!(
                "Failed to open native transcript without following links: {error}"
            ))
        })?;
    let identity = identity_from_metadata(file.metadata().map_err(|error| {
        NativeMaterializationError::filesystem(format!(
            "Failed to inspect native transcript handle: {error}"
        ))
    })?)?;
    if identity.bytes > maximum_bytes as u64 {
        return Err(NativeMaterializationError::filesystem(format!(
            "Native transcript exceeds the {maximum_bytes}-byte safety limit"
        )));
    }
    let mut bytes = Vec::with_capacity(identity.bytes as usize);
    file.read_to_end(&mut bytes).map_err(|error| {
        NativeMaterializationError::filesystem(format!("Failed to read native transcript: {error}"))
    })?;
    if bytes.len() as u64 != identity.bytes {
        return Err(NativeMaterializationError::filesystem(
            "Native transcript changed while it was being read",
        ));
    }
    let final_identity = identity_from_metadata(file.metadata().map_err(|error| {
        NativeMaterializationError::filesystem(format!(
            "Failed to reinspect native transcript handle: {error}"
        ))
    })?)?;
    if !same_file_identity(&identity, &final_identity) || identity.bytes != final_identity.bytes {
        return Err(NativeMaterializationError::filesystem(
            "Native transcript changed while it was being read",
        ));
    }
    Ok((bytes, identity))
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub(crate) fn read_identity_guarded(
    _path: &Path,
    _maximum_bytes: usize,
) -> NativeMaterializationResult<(Vec<u8>, PublishedFileIdentity)> {
    match require_supported_platform() {
        Err(error) => Err(error),
        Ok(()) => Err(NativeMaterializationError::filesystem(
            "Unsupported platform unexpectedly passed its transcript-read guard",
        )),
    }
}

pub(crate) fn same_file_identity(
    left: &PublishedFileIdentity,
    right: &PublishedFileIdentity,
) -> bool {
    #[cfg(unix)]
    {
        left.device == right.device && left.inode == right.inode
    }
    #[cfg(not(unix))]
    {
        let _ = (left, right);
        false
    }
}

pub(crate) fn remove_if_identity_matches(
    path: &Path,
    expected: &PublishedFileIdentity,
) -> NativeMaterializationResult<bool> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(NativeMaterializationError::filesystem(format!(
                "Failed to inspect candidate cleanup target: {error}"
            )));
        }
    };
    let observed = identity_from_metadata(metadata)?;
    if !same_file_identity(&observed, expected) {
        return Err(NativeMaterializationError::filesystem(
            "Refusing to clean up a replaced native transcript",
        ));
    }
    fs::remove_file(path).map_err(|error| {
        NativeMaterializationError::filesystem(format!(
            "Failed to remove inactive native transcript candidate: {error}"
        ))
    })?;
    fsync_directory(
        path.parent()
            .ok_or_else(|| NativeMaterializationError::filesystem("Candidate has no parent"))?,
    )?;
    Ok(true)
}

pub(crate) fn move_candidate_to_recovery(
    source: &Path,
    expected: &PublishedFileIdentity,
    recovery_directory: &Path,
    recovery_name: &str,
) -> NativeMaterializationResult<PathBuf> {
    let (bytes, observed) = read_identity_guarded(source, 128 * 1024 * 1024)?;
    if !same_file_identity(&observed, expected) {
        return Err(NativeMaterializationError::filesystem(
            "Refusing to recover a replaced native transcript",
        ));
    }
    let recovery_path = recovery_directory.join(recovery_name);
    match fs::symlink_metadata(&recovery_path) {
        Ok(_) => {
            let (recovered, _) = read_identity_guarded(&recovery_path, 128 * 1024 * 1024)?;
            if recovered != bytes {
                return Err(NativeMaterializationError::new(
                    NativeMaterializationFailureKind::NoClobber,
                    "Recovery target exists with different bytes",
                ));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            publish_private_no_clobber(recovery_directory, &recovery_path, &bytes)?;
        }
        Err(error) => {
            return Err(NativeMaterializationError::filesystem(format!(
                "Failed to inspect recovery target: {error}"
            )));
        }
    }
    remove_if_identity_matches(source, expected)?;
    fsync_directory(recovery_directory)?;
    Ok(recovery_path)
}

fn identity_from_metadata(
    metadata: Metadata,
) -> NativeMaterializationResult<PublishedFileIdentity> {
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(NativeMaterializationError::filesystem(
            "Native transcript is not a regular non-symlink file",
        ));
    }
    #[cfg(unix)]
    {
        // SAFETY: geteuid has no preconditions and reads process credentials.
        if metadata.uid() != unsafe { libc::geteuid() } {
            return Err(NativeMaterializationError::filesystem(
                "Native transcript is not owned by the current effective user",
            ));
        }
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(NativeMaterializationError::filesystem(
                "Native transcript permissions expose account-scoped history to group or other users",
            ));
        }
        Ok(PublishedFileIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
            bytes: metadata.len(),
        })
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        require_supported_platform()?;
        unreachable!()
    }
}

#[cfg(unix)]
fn fsync_directory(path: &Path) -> NativeMaterializationResult<()> {
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| {
            NativeMaterializationError::filesystem(format!(
                "Failed to fsync directory {}: {error}",
                path.display()
            ))
        })
}

#[cfg(unix)]
fn reject_writable_directory(path: &Path) -> NativeMaterializationResult<()> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        NativeMaterializationError::filesystem(format!(
            "Failed to inspect private directory {}: {error}",
            path.display()
        ))
    })?;
    reject_writable_metadata(path, &metadata)
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn validate_contained_target_parent(
    containment_root: &Path,
    parent: &Path,
) -> NativeMaterializationResult<()> {
    let resolved = fs::canonicalize(parent).map_err(|error| {
        NativeMaterializationError::filesystem(format!(
            "Failed to resolve native target parent {}: {error}",
            parent.display()
        ))
    })?;
    if resolved != parent || !resolved.starts_with(containment_root) {
        return Err(NativeMaterializationError::filesystem(
            "Native target parent escaped its explicit containment root or gained a symlink",
        ));
    }
    reject_writable_directory(parent)
}

#[cfg(unix)]
fn reject_writable_metadata(path: &Path, metadata: &Metadata) -> NativeMaterializationResult<()> {
    // SAFETY: geteuid has no preconditions and reads process credentials.
    reject_directory_owner(path, metadata, unsafe { libc::geteuid() })?;
    if metadata.permissions().mode() & 0o022 != 0 {
        return Err(NativeMaterializationError::filesystem(format!(
            "Refusing group/world-writable native transcript directory {}",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn cleanup_stale_candidate_temporaries(
    parent: &Path,
    target_name: &str,
    stale_before: SystemTime,
) -> NativeMaterializationResult<()> {
    let prefix = format!(".{target_name}.org2-materializing-");
    let mut removed = false;
    for entry in fs::read_dir(parent).map_err(|error| {
        NativeMaterializationError::filesystem(format!(
            "Failed to scan native staging directory: {error}"
        ))
    })? {
        let entry = entry.map_err(|error| {
            NativeMaterializationError::filesystem(format!(
                "Failed to inspect native staging directory entry: {error}"
            ))
        })?;
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if !name.starts_with(&prefix) || !name.ends_with(".tmp") {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path()).map_err(|error| {
            NativeMaterializationError::filesystem(format!(
                "Failed to inspect candidate-scoped staging file: {error}"
            ))
        })?;
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            // SAFETY: geteuid has no preconditions and reads process credentials.
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.permissions().mode() & 0o077 != 0
        {
            return Err(NativeMaterializationError::filesystem(
                "Refusing to reconcile an unsafe candidate-scoped staging entry",
            ));
        }
        let modified = metadata.modified().map_err(|error| {
            NativeMaterializationError::filesystem(format!(
                "Failed to inspect native staging age: {error}"
            ))
        })?;
        if modified >= stale_before {
            continue;
        }
        fs::remove_file(entry.path()).map_err(|error| {
            NativeMaterializationError::filesystem(format!(
                "Failed to remove stale candidate-scoped staging file: {error}"
            ))
        })?;
        removed = true;
    }
    if removed {
        fsync_directory(parent)?;
    }
    Ok(())
}

#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
pub(crate) fn reject_directory_for_foreign_euid_test(
    path: &Path,
) -> NativeMaterializationResult<()> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| NativeMaterializationError::filesystem(error.to_string()))?;
    // SAFETY: geteuid has no preconditions and reads process credentials.
    reject_directory_owner(path, &metadata, unsafe { libc::geteuid() }.wrapping_add(1))
}

#[cfg(unix)]
fn reject_directory_owner(
    path: &Path,
    metadata: &Metadata,
    expected_euid: u32,
) -> NativeMaterializationResult<()> {
    if metadata.uid() != expected_euid {
        return Err(NativeMaterializationError::filesystem(format!(
            "Private native transcript directory is not owned by the current effective user: {}",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
pub(crate) fn cleanup_candidate_temporaries_for_test(
    parent: &Path,
    target_name: &str,
) -> NativeMaterializationResult<()> {
    cleanup_stale_candidate_temporaries(
        parent,
        target_name,
        SystemTime::now()
            .checked_add(Duration::from_secs(1))
            .ok_or_else(|| NativeMaterializationError::filesystem("System clock overflow"))?,
    )
}

#[cfg(not(unix))]
fn reject_writable_directory(_path: &Path) -> NativeMaterializationResult<()> {
    require_supported_platform()
}

#[cfg(not(unix))]
fn reject_writable_metadata(_path: &Path, _metadata: &Metadata) -> NativeMaterializationResult<()> {
    require_supported_platform()
}

#[cfg(not(unix))]
fn fsync_directory(_path: &Path) -> NativeMaterializationResult<()> {
    require_supported_platform()
}
