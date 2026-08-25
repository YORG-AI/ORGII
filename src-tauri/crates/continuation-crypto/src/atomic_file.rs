use std::{fs::File, io::Read, path::PathBuf};

use sha2::{Digest, Sha256};

use crate::{staging::sync_directory, ContinuationCryptoError, PrivateStagingDirectory};

pub(crate) struct AtomicCiphertextFile {
    destination: PathBuf,
    temp: Option<tempfile::NamedTempFile>,
}

impl AtomicCiphertextFile {
    pub(crate) fn create(
        staging: &PrivateStagingDirectory,
        job_id: &str,
        destination: &std::path::Path,
    ) -> Result<Self, ContinuationCryptoError> {
        let destination = staging.validate_destination(destination)?;
        let temp = staging.named_ciphertext(job_id)?;
        Ok(Self {
            destination,
            temp: Some(temp),
        })
    }

    pub(crate) fn file_mut(&mut self) -> &mut File {
        self.temp
            .as_mut()
            .expect("staging file is available until publish")
            .as_file_mut()
    }

    pub(crate) fn publish(
        mut self,
        expected_size: u64,
        expected_sha256: &[u8; 32],
    ) -> Result<(), ContinuationCryptoError> {
        self.publish_impl(expected_size, expected_sha256, PublishFault::None)
    }

    fn publish_impl(
        &mut self,
        expected_size: u64,
        expected_sha256: &[u8; 32],
        fault: PublishFault,
    ) -> Result<(), ContinuationCryptoError> {
        self.temp
            .as_mut()
            .expect("staging file is available until publish")
            .as_file_mut()
            .sync_all()
            .map_err(|error| ContinuationCryptoError::io("fsyncing ciphertext", error))?;
        if fault == PublishFault::AfterTempFsync {
            return Err(ContinuationCryptoError::io(
                "simulated crash after ciphertext fsync",
                std::io::Error::other("fault injection"),
            ));
        }
        let parent = self
            .destination
            .parent()
            .ok_or(ContinuationCryptoError::InvalidEnvelope(
                "destination has no parent directory",
            ))?
            .to_owned();
        let temp = self
            .temp
            .take()
            .expect("staging file is consumed exactly once");
        let persisted = match temp.persist_noclobber(&self.destination) {
            Ok(file) => file,
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                if let Some(existing) =
                    open_verified_existing(&self.destination, expected_size, expected_sha256)?
                {
                    // A prior attempt may have renamed successfully and then
                    // crashed before the directory entry became durable. Sync
                    // the exact file handle that was hashed, then complete the
                    // parent-directory barrier before reporting idempotent
                    // success.
                    existing.sync_all().map_err(|error| {
                        ContinuationCryptoError::io("fsyncing reconciled ciphertext", error)
                    })?;
                    if fault == PublishFault::AfterReconciledFileFsyncBeforeDirectoryFsync {
                        return Err(ContinuationCryptoError::io(
                            "simulated crash while reconciling ciphertext rename",
                            std::io::Error::other("fault injection"),
                        ));
                    }
                    sync_directory(&parent)?;
                    return Ok(());
                }
                return Err(ContinuationCryptoError::DestinationExists(
                    self.destination.display().to_string(),
                ));
            }
            Err(error) => {
                return Err(ContinuationCryptoError::io(
                    "atomically publishing ciphertext",
                    error.error,
                ));
            }
        };
        persisted
            .sync_all()
            .map_err(|error| ContinuationCryptoError::io("fsyncing published ciphertext", error))?;
        if fault == PublishFault::AfterRenameBeforeDirectoryFsync {
            return Err(ContinuationCryptoError::io(
                "simulated crash after ciphertext rename",
                std::io::Error::other("fault injection"),
            ));
        }
        sync_directory(&parent)?;
        Ok(())
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PublishFault {
    None,
    AfterTempFsync,
    AfterRenameBeforeDirectoryFsync,
    AfterReconciledFileFsyncBeforeDirectoryFsync,
}

fn open_verified_existing(
    path: &std::path::Path,
    expected_size: u64,
    expected_sha256: &[u8; 32],
) -> Result<Option<File>, ContinuationCryptoError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        ContinuationCryptoError::io("inspecting existing ciphertext path", error)
    })?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(ContinuationCryptoError::InvalidStaging(
            "existing ciphertext destination is not a regular file",
        ));
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(path)
        .map_err(|error| ContinuationCryptoError::io("opening existing ciphertext", error))?;
    let metadata = file
        .metadata()
        .map_err(|error| ContinuationCryptoError::io("inspecting existing ciphertext", error))?;
    if !metadata.is_file() || metadata.len() != expected_size {
        return Ok(None);
    }
    let mut digest = Sha256::new();
    let mut remaining = expected_size;
    let mut buffer = [0u8; 64 * 1024];
    while remaining > 0 {
        let requested = remaining.min(buffer.len() as u64) as usize;
        file.read_exact(&mut buffer[..requested])
            .map_err(|error| ContinuationCryptoError::io("hashing existing ciphertext", error))?;
        digest.update(&buffer[..requested]);
        remaining -= requested as u64;
    }
    let mut trailing = [0u8; 1];
    if file
        .read(&mut trailing)
        .map_err(|error| ContinuationCryptoError::io("checking existing ciphertext EOF", error))?
        != 0
    {
        return Ok(None);
    }
    if digest.finalize().as_slice() != expected_sha256 {
        return Ok(None);
    }
    Ok(Some(file))
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;

    #[test]
    fn crash_faults_are_recoverable_and_reconcile_by_hash() {
        let temp = tempfile::tempdir().unwrap();
        let staging = PrivateStagingDirectory::create(temp.path()).unwrap();
        let destination = temp.path().join("fault-checkpoint.age");
        let bytes = b"ciphertext-only-test";
        let digest: [u8; 32] = Sha256::digest(bytes).into();

        let mut before_rename =
            AtomicCiphertextFile::create(&staging, "fault-a", &destination).unwrap();
        before_rename.file_mut().write_all(bytes).unwrap();
        assert!(before_rename
            .publish_impl(bytes.len() as u64, &digest, PublishFault::AfterTempFsync)
            .is_err());
        assert!(!destination.exists());

        let mut after_rename =
            AtomicCiphertextFile::create(&staging, "fault-b", &destination).unwrap();
        after_rename.file_mut().write_all(bytes).unwrap();
        assert!(after_rename
            .publish_impl(
                bytes.len() as u64,
                &digest,
                PublishFault::AfterRenameBeforeDirectoryFsync,
            )
            .is_err());
        assert_eq!(std::fs::read(&destination).unwrap(), bytes);

        let mut interrupted_retry =
            AtomicCiphertextFile::create(&staging, "fault-c", &destination).unwrap();
        interrupted_retry.file_mut().write_all(bytes).unwrap();
        assert!(interrupted_retry
            .publish_impl(
                bytes.len() as u64,
                &digest,
                PublishFault::AfterReconciledFileFsyncBeforeDirectoryFsync,
            )
            .is_err());

        let mut completed_retry =
            AtomicCiphertextFile::create(&staging, "fault-d", &destination).unwrap();
        completed_retry.file_mut().write_all(bytes).unwrap();
        completed_retry
            .publish(bytes.len() as u64, &digest)
            .unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), bytes);
    }

    #[cfg(unix)]
    #[test]
    fn idempotent_reconcile_never_follows_an_existing_symlink() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let staging = PrivateStagingDirectory::create(temp.path()).unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(outside.path(), b"ciphertext-only-test").unwrap();
        let destination = temp.path().join("symlink-checkpoint.age");
        symlink(outside.path(), &destination).unwrap();
        let bytes = b"ciphertext-only-test";
        let digest: [u8; 32] = Sha256::digest(bytes).into();
        let mut atomic =
            AtomicCiphertextFile::create(&staging, "symlink-fault", &destination).unwrap();
        atomic.file_mut().write_all(bytes).unwrap();
        assert!(matches!(
            atomic.publish(bytes.len() as u64, &digest),
            Err(ContinuationCryptoError::InvalidStaging(
                "existing ciphertext destination is not a regular file"
            ))
        ));
        assert_eq!(std::fs::read(outside.path()).unwrap(), bytes);
    }
}
