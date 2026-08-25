use std::{
    fs::File,
    path::{Path, PathBuf},
};

use crate::ContinuationCryptoError;

const MAX_JOB_ID_BYTES: usize = 64;
const MAX_ARTIFACT_NAME_BYTES: usize = 128;

/// Validated capability for an app-private continuation staging directory.
///
/// Construction canonicalizes the directory and verifies that it is owned by
/// the current OS user and inaccessible to other users. A missing final
/// directory is created owner-only under an existing parent; production never
/// chmods or rewrites the ACL of an existing caller-supplied directory. All
/// named staging and anonymous snapshot files are created through this
/// capability.
#[derive(Clone)]
pub struct PrivateStagingDirectory {
    root: PathBuf,
}

impl PrivateStagingDirectory {
    pub fn create(path: &Path) -> Result<Self, ContinuationCryptoError> {
        if !path.is_absolute() {
            return Err(ContinuationCryptoError::InvalidStaging(
                "staging directory must be absolute",
            ));
        }
        let created = !path.exists();
        if created {
            create_private_directory(path)?;
            // Defense in depth after owner-only creation; the subsequent
            // read-back verification remains authoritative.
            secure_private_directory(path)?;
        }
        let metadata = std::fs::symlink_metadata(path).map_err(|error| {
            ContinuationCryptoError::io("inspecting private staging directory", error)
        })?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(ContinuationCryptoError::InvalidStaging(
                "staging capability must name a real directory",
            ));
        }
        // Unit tests use `tempfile` roots whose inherited Windows ACL is not
        // owner-only. Production never mutates an existing directory: it must
        // already be an app-private capability or construction fails closed.
        #[cfg(test)]
        if !created {
            secure_private_directory(path)?;
        }
        let root = std::fs::canonicalize(path).map_err(|error| {
            ContinuationCryptoError::io("canonicalizing private staging directory", error)
        })?;
        verify_private_directory(&root)?;
        Ok(Self { root })
    }

    pub fn path(&self) -> &Path {
        &self.root
    }

    pub fn cleanup_job(&self, job_id: &str) -> Result<u32, ContinuationCryptoError> {
        validate_job_id(job_id)?;
        let prefix = format!(".org2-continuation-{job_id}-");
        let mut removed = 0u32;
        let entries = std::fs::read_dir(&self.root).map_err(|error| {
            ContinuationCryptoError::io("scanning continuation staging directory", error)
        })?;
        for entry in entries {
            let entry = entry.map_err(|error| {
                ContinuationCryptoError::io("reading continuation staging entry", error)
            })?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if !name.starts_with(&prefix) || !name.ends_with(".ciphertext.tmp") {
                continue;
            }
            let metadata = std::fs::symlink_metadata(entry.path()).map_err(|error| {
                ContinuationCryptoError::io("inspecting continuation staging entry", error)
            })?;
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err(ContinuationCryptoError::InvalidStaging(
                    "job staging entry is not a regular file",
                ));
            }
            std::fs::remove_file(entry.path()).map_err(|error| {
                ContinuationCryptoError::io("removing stale job ciphertext", error)
            })?;
            removed = removed
                .checked_add(1)
                .ok_or(ContinuationCryptoError::InvalidStaging(
                    "staging cleanup count overflow",
                ))?;
        }
        sync_directory(&self.root)?;
        Ok(removed)
    }

    pub(crate) fn named_ciphertext(
        &self,
        job_id: &str,
    ) -> Result<tempfile::NamedTempFile, ContinuationCryptoError> {
        validate_job_id(job_id)?;
        let prefix = format!(".org2-continuation-{job_id}-");
        let mut builder = tempfile::Builder::new();
        builder.prefix(&prefix).suffix(".ciphertext.tmp");
        #[cfg(unix)]
        let temp = builder.tempfile_in(&self.root).map_err(|error| {
            ContinuationCryptoError::io("creating private ciphertext staging file", error)
        })?;
        #[cfg(windows)]
        let temp = builder
            .make_in(&self.root, |path| {
                windows_security::create_private_file(path, false)
            })
            .map_err(|error| {
                ContinuationCryptoError::io("creating private ciphertext staging file", error)
            })?;
        secure_owner_only_file(temp.path())?;
        Ok(temp)
    }

    pub(crate) fn anonymous_ciphertext(&self) -> Result<File, ContinuationCryptoError> {
        #[cfg(unix)]
        let file = tempfile::tempfile_in(&self.root).map_err(|error| {
            ContinuationCryptoError::io("creating anonymous ciphertext snapshot", error)
        })?;
        #[cfg(windows)]
        let file = tempfile::Builder::new()
            .prefix(".org2-continuation-snapshot-")
            .suffix(".ciphertext.tmp")
            .make_in(&self.root, |path| {
                windows_security::create_private_file(path, true)
            })
            .map_err(|error| {
                ContinuationCryptoError::io("creating delete-on-close ciphertext snapshot", error)
            })?
            .into_file();
        verify_owner_only_file(&file)?;
        Ok(file)
    }

    pub(crate) fn validate_destination(
        &self,
        destination: &Path,
    ) -> Result<PathBuf, ContinuationCryptoError> {
        let parent = destination
            .parent()
            .ok_or(ContinuationCryptoError::InvalidStaging(
                "artifact destination has no parent",
            ))?;
        let canonical_parent = std::fs::canonicalize(parent).map_err(|error| {
            ContinuationCryptoError::io("canonicalizing artifact destination parent", error)
        })?;
        if canonical_parent != self.root {
            return Err(ContinuationCryptoError::InvalidStaging(
                "artifact destination must be inside the private staging capability",
            ));
        }
        let artifact_name = destination
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or(ContinuationCryptoError::InvalidStaging(
                "artifact destination name is not canonical UTF-8",
            ))?;
        validate_artifact_name(artifact_name)?;
        Ok(self.root.join(artifact_name))
    }

    pub(crate) fn transaction_lock_file(
        &self,
        profile_id: &str,
    ) -> Result<File, ContinuationCryptoError> {
        validate_job_id(profile_id)?;
        let path = self.root.join(format!(".identity-{profile_id}.lock"));
        #[cfg(unix)]
        let file = {
            let mut options = std::fs::OpenOptions::new();
            options.read(true).write(true).create(true);
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
            options.open(&path).map_err(|error| {
                ContinuationCryptoError::io("opening profile transaction lock", error)
            })?
        };
        #[cfg(windows)]
        let file = windows_security::open_private_lock_file(&path).map_err(|error| {
            ContinuationCryptoError::io("opening profile transaction lock", error)
        })?;
        secure_owner_only_file(&path)?;
        lock_profile_file(&file)?;
        Ok(file)
    }
}

#[cfg(unix)]
fn lock_profile_file(file: &File) -> Result<(), ContinuationCryptoError> {
    use std::os::fd::AsRawFd;
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
    if result == 0 {
        Ok(())
    } else {
        Err(ContinuationCryptoError::io(
            "locking identity profile",
            std::io::Error::last_os_error(),
        ))
    }
}

#[cfg(windows)]
fn lock_profile_file(_file: &File) -> Result<(), ContinuationCryptoError> {
    // `open_private_lock_file` acquires the range lock on the same handle
    // before returning it. Keeping that handle alive is the lock guard.
    Ok(())
}

fn validate_job_id(value: &str) -> Result<(), ContinuationCryptoError> {
    if value.is_empty()
        || value.len() > MAX_JOB_ID_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(ContinuationCryptoError::InvalidStaging(
            "job/profile id must be lowercase ASCII alphanumeric or hyphen",
        ));
    }
    Ok(())
}

fn validate_artifact_name(value: &str) -> Result<(), ContinuationCryptoError> {
    let mut bytes = value.bytes();
    let Some(first) = bytes.next() else {
        return Err(ContinuationCryptoError::InvalidStaging(
            "artifact name must be one bounded portable path component",
        ));
    };
    if value.len() > MAX_ARTIFACT_NAME_BYTES
        || !(first.is_ascii_lowercase() || first.is_ascii_digit())
        || value.ends_with('.')
        || value.contains("..")
        || !bytes.all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
    {
        return Err(ContinuationCryptoError::InvalidStaging(
            "artifact name must match the lowercase portable allowlist",
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn create_private_directory(path: &Path) -> Result<(), ContinuationCryptoError> {
    use std::os::unix::fs::DirBuilderExt;
    let mut builder = std::fs::DirBuilder::new();
    // Never recursively create or chmod an unresolved ancestor. The caller
    // must supply an existing app-private parent capability.
    builder.recursive(false).mode(0o700);
    builder
        .create(path)
        .map_err(|error| ContinuationCryptoError::io("creating private staging directory", error))
}

#[cfg(windows)]
fn create_private_directory(path: &Path) -> Result<(), ContinuationCryptoError> {
    windows_security::create_or_secure_private_directory(path)
        .map_err(|error| ContinuationCryptoError::io("creating private staging directory", error))
}

#[cfg(unix)]
fn secure_private_directory(path: &Path) -> Result<(), ContinuationCryptoError> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
        .map_err(|error| ContinuationCryptoError::io("securing staging directory", error))
}

#[cfg(unix)]
fn verify_private_directory(path: &Path) -> Result<(), ContinuationCryptoError> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let metadata = std::fs::metadata(path)
        .map_err(|error| ContinuationCryptoError::io("verifying staging directory", error))?;
    if metadata.uid() != unsafe { libc::geteuid() } || metadata.permissions().mode() & 0o077 != 0 {
        return Err(ContinuationCryptoError::InvalidStaging(
            "staging directory is not current-user private",
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn secure_owner_only_file(path: &Path) -> Result<(), ContinuationCryptoError> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|error| ContinuationCryptoError::io("securing staging file", error))?;
    let file = File::open(path)
        .map_err(|error| ContinuationCryptoError::io("opening secured staging file", error))?;
    verify_owner_only_file(&file)
}

#[cfg(unix)]
fn verify_owner_only_file(file: &File) -> Result<(), ContinuationCryptoError> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let metadata = file
        .metadata()
        .map_err(|error| ContinuationCryptoError::io("verifying staging file", error))?;
    if metadata.uid() != unsafe { libc::geteuid() } || metadata.permissions().mode() & 0o077 != 0 {
        return Err(ContinuationCryptoError::InvalidStaging(
            "staging file is not current-user private",
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn secure_private_directory(path: &Path) -> Result<(), ContinuationCryptoError> {
    windows_security::apply_owner_only_acl(path, true)
        .map_err(|error| ContinuationCryptoError::io("securing staging directory DACL", error))
}

#[cfg(windows)]
fn verify_private_directory(path: &Path) -> Result<(), ContinuationCryptoError> {
    windows_security::verify_owner_only_acl(path, true)
}

#[cfg(windows)]
fn secure_owner_only_file(path: &Path) -> Result<(), ContinuationCryptoError> {
    windows_security::apply_owner_only_acl(path, false)
        .map_err(|error| ContinuationCryptoError::io("securing staging file DACL", error))?;
    windows_security::verify_owner_only_acl(path, false)
}

#[cfg(windows)]
fn verify_owner_only_file(file: &File) -> Result<(), ContinuationCryptoError> {
    windows_security::verify_owner_only_file_handle(file)
}

#[cfg(unix)]
pub(crate) fn sync_directory(path: &Path) -> Result<(), ContinuationCryptoError> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| ContinuationCryptoError::io("fsyncing staging directory", error))
}

#[cfg(windows)]
pub(crate) fn sync_directory(path: &Path) -> Result<(), ContinuationCryptoError> {
    windows_security::sync_directory(path)
        .map_err(|error| ContinuationCryptoError::io("fsyncing staging directory", error))
}

#[cfg(windows)]
mod windows_security {
    use std::{
        ffi::c_void,
        fs::File,
        mem::{size_of, zeroed},
        os::windows::{
            ffi::OsStrExt,
            io::{AsRawHandle, FromRawHandle},
        },
        path::Path,
        ptr::{null, null_mut},
    };

    use windows_sys::Win32::{
        Foundation::{
            CloseHandle, GetLastError, LocalFree, ERROR_ALREADY_EXISTS, ERROR_INSUFFICIENT_BUFFER,
            HANDLE, INVALID_HANDLE_VALUE,
        },
        Security::{
            AclSizeInformation,
            Authorization::{
                GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW, EXPLICIT_ACCESS_W,
                SET_ACCESS, SE_FILE_OBJECT, TRUSTEE_IS_SID, TRUSTEE_IS_USER,
            },
            CopySid, EqualSid, GetAce, GetAclInformation, GetLengthSid,
            GetSecurityDescriptorControl, GetSecurityDescriptorDacl, GetTokenInformation,
            InitializeSecurityDescriptor, IsValidAcl, SetSecurityDescriptorControl,
            SetSecurityDescriptorDacl, SetSecurityDescriptorOwner, TokenUser, ACCESS_ALLOWED_ACE,
            ACL_SIZE_INFORMATION, CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION, INHERITED_ACE,
            OBJECT_INHERIT_ACE, OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
            PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES, SECURITY_DESCRIPTOR,
            SE_DACL_PROTECTED, TOKEN_QUERY, TOKEN_USER,
        },
        Storage::FileSystem::{
            CreateDirectoryW, CreateFileW, FlushFileBuffers, LockFileEx, CREATE_NEW,
            FILE_ALL_ACCESS, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_TEMPORARY,
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_DELETE_ON_CLOSE, FILE_GENERIC_READ,
            FILE_GENERIC_WRITE, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
            LOCKFILE_EXCLUSIVE_LOCK, OPEN_ALWAYS, OPEN_EXISTING,
        },
        System::{
            Threading::{GetCurrentProcess, OpenProcessToken},
            IO::OVERLAPPED,
        },
    };

    use crate::ContinuationCryptoError;

    struct OwnedHandle(HANDLE);

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
                unsafe { CloseHandle(self.0) };
            }
        }
    }

    struct LocalAllocation(*mut c_void);

    impl Drop for LocalAllocation {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { LocalFree(self.0) };
            }
        }
    }

    struct OwnerSecurity {
        _sid: Vec<u8>,
        acl: LocalAllocation,
        _descriptor: Box<SECURITY_DESCRIPTOR>,
        attributes: SECURITY_ATTRIBUTES,
    }

    impl OwnerSecurity {
        fn new(directory: bool) -> std::io::Result<Self> {
            let mut sid = current_user_sid()?;
            let mut entry = EXPLICIT_ACCESS_W::default();
            entry.grfAccessPermissions = FILE_ALL_ACCESS;
            entry.grfAccessMode = SET_ACCESS;
            entry.grfInheritance = if directory {
                OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE
            } else {
                0
            };
            entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
            entry.Trustee.TrusteeType = TRUSTEE_IS_USER;
            entry.Trustee.ptstrName = sid.as_mut_ptr().cast();
            let mut acl = null_mut();
            let status = unsafe { SetEntriesInAclW(1, &entry, null(), &mut acl) };
            if status != 0 {
                return Err(std::io::Error::from_raw_os_error(status as i32));
            }
            let acl = LocalAllocation(acl.cast());
            let mut descriptor = Box::new(unsafe { zeroed::<SECURITY_DESCRIPTOR>() });
            let descriptor_ptr = (&mut *descriptor as *mut SECURITY_DESCRIPTOR).cast();
            if unsafe { InitializeSecurityDescriptor(descriptor_ptr, 1) } == 0
                || unsafe { SetSecurityDescriptorOwner(descriptor_ptr, sid.as_mut_ptr().cast(), 0) }
                    == 0
                || unsafe { SetSecurityDescriptorDacl(descriptor_ptr, 1, acl.0.cast(), 0) } == 0
                || unsafe {
                    SetSecurityDescriptorControl(
                        descriptor_ptr,
                        SE_DACL_PROTECTED,
                        SE_DACL_PROTECTED,
                    )
                } == 0
            {
                return Err(std::io::Error::last_os_error());
            }
            let attributes = SECURITY_ATTRIBUTES {
                nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: descriptor_ptr,
                bInheritHandle: 0,
            };
            Ok(Self {
                _sid: sid,
                acl,
                _descriptor: descriptor,
                attributes,
            })
        }

        fn attributes(&self) -> *const SECURITY_ATTRIBUTES {
            &self.attributes
        }

        fn acl(&self) -> *const windows_sys::Win32::Security::ACL {
            self.acl.0.cast()
        }

        fn owner_sid(&self) -> PSID {
            self._sid.as_ptr().cast_mut().cast()
        }
    }

    pub(super) fn create_or_secure_private_directory(path: &Path) -> std::io::Result<()> {
        if path.exists() {
            return apply_owner_only_acl(path, true);
        }
        let parent = path
            .parent()
            .ok_or_else(|| std::io::Error::other("staging directory has no parent"))?;
        if !parent.is_dir() {
            return Err(std::io::Error::other(
                "staging directory parent must already exist",
            ));
        }
        let wide = wide_path(path);
        let security = OwnerSecurity::new(true)?;
        if unsafe { CreateDirectoryW(wide.as_ptr(), security.attributes()) } == 0 {
            let error = unsafe { GetLastError() };
            if error != ERROR_ALREADY_EXISTS {
                return Err(std::io::Error::from_raw_os_error(error as i32));
            }
        }
        verify_owner_only_acl(path, true).map_err(to_io)
    }

    pub(super) fn create_private_file(path: &Path, delete_on_close: bool) -> std::io::Result<File> {
        let security = OwnerSecurity::new(false)?;
        let wide = wide_path(path);
        let mut flags = FILE_ATTRIBUTE_TEMPORARY;
        if delete_on_close {
            flags |= FILE_FLAG_DELETE_ON_CLOSE;
        }
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_ALL_ACCESS,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                security.attributes(),
                CREATE_NEW,
                flags,
                null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error());
        }
        Ok(unsafe { File::from_raw_handle(handle) })
    }

    pub(super) fn open_private_lock_file(path: &Path) -> std::io::Result<File> {
        let security = OwnerSecurity::new(false)?;
        let wide = wide_path(path);
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                FILE_GENERIC_READ | FILE_GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                security.attributes(),
                OPEN_ALWAYS,
                FILE_ATTRIBUTE_NORMAL,
                null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error());
        }
        let file = unsafe { File::from_raw_handle(handle) };
        apply_owner_only_acl(path, false)?;
        let mut overlapped = unsafe { zeroed::<OVERLAPPED>() };
        if unsafe {
            LockFileEx(
                file.as_raw_handle(),
                LOCKFILE_EXCLUSIVE_LOCK,
                0,
                u32::MAX,
                u32::MAX,
                &mut overlapped,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        Ok(file)
    }

    pub(super) fn sync_directory(path: &Path) -> std::io::Result<()> {
        let wide = wide_path(path);
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                FILE_GENERIC_READ | FILE_GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS,
                null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error());
        }
        let handle = OwnedHandle(handle);
        if unsafe { FlushFileBuffers(handle.0) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    pub(super) fn apply_owner_only_acl(path: &Path, directory: bool) -> std::io::Result<()> {
        let wide = wide_path(path);
        let security = OwnerSecurity::new(directory)?;
        let status = unsafe {
            SetNamedSecurityInfoW(
                wide.as_ptr().cast_mut(),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION
                    | DACL_SECURITY_INFORMATION
                    | PROTECTED_DACL_SECURITY_INFORMATION,
                security.owner_sid(),
                null_mut(),
                security.acl(),
                null(),
            )
        };
        if status != 0 {
            return Err(std::io::Error::from_raw_os_error(status as i32));
        }
        verify_owner_only_acl(path, directory).map_err(to_io)
    }

    pub(super) fn verify_owner_only_file_handle(
        file: &File,
    ) -> Result<(), ContinuationCryptoError> {
        let path = final_path_from_handle(file)?;
        verify_owner_only_acl(&path, false)
    }

    pub(super) fn verify_owner_only_acl(
        path: &Path,
        directory: bool,
    ) -> Result<(), ContinuationCryptoError> {
        let wide = wide_path(path);
        let mut owner = null_mut();
        let mut dacl = null_mut();
        let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
        let status = unsafe {
            GetNamedSecurityInfoW(
                wide.as_ptr(),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut owner,
                null_mut(),
                &mut dacl,
                null_mut(),
                &mut descriptor,
            )
        };
        if status != 0 {
            return Err(ContinuationCryptoError::io(
                "reading Windows owner DACL",
                std::io::Error::from_raw_os_error(status as i32),
            ));
        }
        let _descriptor = LocalAllocation(descriptor);
        let expected_sid = current_user_sid()
            .map_err(|error| ContinuationCryptoError::io("reading Windows user SID", error))?;
        if owner.is_null()
            || dacl.is_null()
            || unsafe { EqualSid(owner, expected_sid.as_ptr().cast_mut().cast()) } == 0
            || unsafe { IsValidAcl(dacl) } == 0
        {
            return Err(ContinuationCryptoError::InvalidStaging(
                "Windows staging owner or DACL is invalid",
            ));
        }
        let mut present = 0;
        let mut descriptor_dacl = null_mut();
        let mut defaulted = 0;
        if unsafe {
            GetSecurityDescriptorDacl(
                descriptor,
                &mut present,
                &mut descriptor_dacl,
                &mut defaulted,
            )
        } == 0
            || present == 0
            || descriptor_dacl != dacl
        {
            return Err(ContinuationCryptoError::InvalidStaging(
                "Windows staging DACL is absent",
            ));
        }
        let mut control = 0u16;
        let mut revision = 0u32;
        if unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } == 0
            || control & SE_DACL_PROTECTED == 0
        {
            return Err(ContinuationCryptoError::InvalidStaging(
                "Windows staging DACL permits inheritance",
            ));
        }
        let mut info = ACL_SIZE_INFORMATION::default();
        if unsafe {
            GetAclInformation(
                dacl,
                (&mut info as *mut ACL_SIZE_INFORMATION).cast(),
                size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            )
        } == 0
            || info.AceCount != 1
        {
            return Err(ContinuationCryptoError::InvalidStaging(
                "Windows staging DACL must contain exactly one ACE",
            ));
        }
        let mut ace_ptr = null_mut();
        if unsafe { GetAce(dacl, 0, &mut ace_ptr) } == 0 || ace_ptr.is_null() {
            return Err(ContinuationCryptoError::InvalidStaging(
                "Windows staging DACL ACE is unreadable",
            ));
        }
        let ace = unsafe { &*(ace_ptr.cast::<ACCESS_ALLOWED_ACE>()) };
        let ace_sid = (&ace.SidStart as *const u32).cast_mut().cast();
        let expected_flags = if directory {
            (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE) as u8
        } else {
            0
        };
        if ace.Header.AceType != 0
            || ace.Header.AceFlags & INHERITED_ACE as u8 != 0
            || ace.Header.AceFlags & expected_flags != expected_flags
            || ace.Mask & FILE_ALL_ACCESS != FILE_ALL_ACCESS
            || unsafe { EqualSid(ace_sid, expected_sid.as_ptr().cast_mut().cast()) } == 0
        {
            return Err(ContinuationCryptoError::InvalidStaging(
                "Windows staging DACL is not owner-only full control",
            ));
        }
        Ok(())
    }

    fn current_user_sid() -> std::io::Result<Vec<u8>> {
        let mut token = null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let token = OwnedHandle(token);
        let mut required = 0u32;
        unsafe {
            GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut required);
        }
        if required == 0 || unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER {
            return Err(std::io::Error::last_os_error());
        }
        let mut token_info = vec![0u8; required as usize];
        if unsafe {
            GetTokenInformation(
                token.0,
                TokenUser,
                token_info.as_mut_ptr().cast(),
                required,
                &mut required,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        let token_user = unsafe { &*(token_info.as_ptr().cast::<TOKEN_USER>()) };
        let sid_len = unsafe { GetLengthSid(token_user.User.Sid) };
        if sid_len == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let mut sid = vec![0u8; sid_len as usize];
        if unsafe { CopySid(sid_len, sid.as_mut_ptr().cast(), token_user.User.Sid) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(sid)
    }

    fn final_path_from_handle(file: &File) -> Result<std::path::PathBuf, ContinuationCryptoError> {
        use windows_sys::Win32::Storage::FileSystem::{
            GetFinalPathNameByHandleW, FILE_NAME_NORMALIZED,
        };
        let mut buffer = vec![0u16; 32_768];
        let length = unsafe {
            GetFinalPathNameByHandleW(
                file.as_raw_handle(),
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                FILE_NAME_NORMALIZED,
            )
        };
        if length == 0 || length as usize >= buffer.len() {
            return Err(ContinuationCryptoError::io(
                "resolving Windows staging file handle",
                std::io::Error::last_os_error(),
            ));
        }
        buffer.truncate(length as usize);
        let path = String::from_utf16(&buffer).map_err(|_| {
            ContinuationCryptoError::InvalidStaging("Windows staging path is not UTF-16")
        })?;
        let path = path.strip_prefix(r"\\?\").unwrap_or(&path);
        Ok(std::path::PathBuf::from(path))
    }

    fn wide_path(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }

    fn to_io(error: ContinuationCryptoError) -> std::io::Error {
        std::io::Error::other(error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;

    #[test]
    fn cleanup_is_scoped_to_one_validated_job() {
        let temp = tempfile::tempdir().unwrap();
        let staging = PrivateStagingDirectory::create(temp.path()).unwrap();
        let mut first = staging.named_ciphertext("job-one").unwrap();
        first.write_all(b"ciphertext-one").unwrap();
        let (_first_file, first_path) = first.keep().unwrap();
        let mut second = staging.named_ciphertext("job-two").unwrap();
        second.write_all(b"ciphertext-two").unwrap();
        let (_second_file, second_path) = second.keep().unwrap();
        std::fs::write(temp.path().join("unrelated.txt"), b"keep").unwrap();

        assert_eq!(staging.cleanup_job("job-one").unwrap(), 1);
        assert!(!first_path.exists());
        assert!(second_path.exists());
        assert!(temp.path().join("unrelated.txt").exists());
        assert_eq!(staging.cleanup_job("job-two").unwrap(), 1);
        assert!(!second_path.exists());
    }

    #[test]
    fn destination_capability_uses_a_lowercase_single_component_allowlist() {
        let temp = tempfile::tempdir().unwrap();
        let staging = PrivateStagingDirectory::create(temp.path()).unwrap();
        assert!(staging
            .validate_destination(&temp.path().join("checkpoint-01.age"))
            .is_ok());
        for name in [
            "Checkpoint.age",
            ".hidden.age",
            "checkpoint..age",
            "checkpoint age",
            "checkpoint$.age",
        ] {
            assert!(staging
                .validate_destination(&temp.path().join(name))
                .is_err());
        }
        assert!(staging
            .validate_destination(&temp.path().join("..").join("outside.age"))
            .is_err());
    }

    #[cfg(windows)]
    #[test]
    fn windows_creates_and_verifies_owner_only_dacl_for_every_staging_handle() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("app-private-continuation");
        assert!(!root.exists());
        let staging = PrivateStagingDirectory::create(&root).unwrap();
        windows_security::verify_owner_only_acl(staging.path(), true).unwrap();

        let named = staging.named_ciphertext("windows-test").unwrap();
        windows_security::verify_owner_only_acl(named.path(), false).unwrap();
        let anonymous = staging.anonymous_ciphertext().unwrap();
        windows_security::verify_owner_only_file_handle(&anonymous).unwrap();
        let lock = staging
            .transaction_lock_file("30000000-0000-0000-0000-000000000001")
            .unwrap();
        windows_security::verify_owner_only_file_handle(&lock).unwrap();
    }
}
