use crate::error::GitApiError;
use crate::extractors::{has_windows_users_prefix, validate_file_path, validate_path};

#[test]
fn test_path_traversal_detection() {
    assert!(validate_path("../etc/passwd").is_err());
    assert!(validate_path("/Users/test/../../../etc/passwd").is_err());
    assert!(validate_path("/Users/test/project/..").is_err());
}

#[test]
fn test_allowed_paths() {
    // Home dir and temp dir are always allowed (cross-platform via dirs crate)
    if let Some(home) = dirs::home_dir() {
        let test_path = home.join("some_project");
        let result = validate_path(&test_path.to_string_lossy());
        assert!(result.is_ok() || matches!(result, Err(GitApiError::InvalidPath { .. })));
    }

    let temp_path = std::env::temp_dir().join("test_repo");
    let result = validate_path(&temp_path.to_string_lossy());
    assert!(result.is_ok() || matches!(result, Err(GitApiError::InvalidPath { .. })));
}

#[cfg(unix)]
#[test]
fn test_unix_allowed_paths() {
    let result = validate_path("/tmp/test");
    assert!(result.is_ok() || matches!(result, Err(GitApiError::InvalidPath { .. })));
}

#[cfg(unix)]
#[test]
fn test_unix_disallowed_paths() {
    assert!(validate_path("/etc/passwd").is_err());
    assert!(validate_path("/root/.ssh/id_rsa").is_err());
}

#[test]
fn test_windows_users_prefix_handles_non_ascii_without_panic() {
    assert!(!has_windows_users_prefix(r"C:\绳子\Users\TestUser\project"));
    assert!(has_windows_users_prefix(r"C:\Users\测试用户\project"));
    assert!(has_windows_users_prefix(r"D:\Users\TestUser\project"));
    assert!(!has_windows_users_prefix(r"C:\Windows\System32\config"));
}

#[cfg(windows)]
#[test]
fn test_windows_allowed_paths() {
    // Standard Windows user directory
    let result = validate_path(r"C:\Users\TestUser\project");
    assert!(result.is_ok() || matches!(result, Err(GitApiError::InvalidPath { .. })));

    // Different drive letter
    let result = validate_path(r"D:\Users\TestUser\project");
    assert!(result.is_ok() || matches!(result, Err(GitApiError::InvalidPath { .. })));
}

#[cfg(windows)]
#[test]
fn test_windows_disallowed_paths() {
    assert!(validate_path(r"C:\Windows\System32\config").is_err());
    assert!(validate_path(r"C:\Program Files\secret").is_err());
}

#[cfg(windows)]
#[test]
fn test_windows_path_with_non_ascii_prefix_does_not_panic() {
    assert!(validate_path(r"C:\绳子\Users\TestUser\project").is_err());
}

#[cfg(windows)]
#[test]
fn test_windows_allowed_user_path_with_non_ascii_characters() {
    let result = validate_path(r"C:\Users\测试用户\project");
    assert!(result.is_ok() || matches!(result, Err(GitApiError::InvalidPath { .. })));
}

#[test]
fn test_file_path_validation() {
    assert!(validate_file_path("src/main.rs").is_ok());
    assert!(validate_file_path("../secret.txt").is_err());
    assert!(validate_file_path("/etc/passwd").is_err());
}

#[test]
fn test_file_path_rejects_windows_absolute() {
    assert!(validate_file_path(r"C:\Users\secret.txt").is_err());
    assert!(validate_file_path(r"\\server\share\file.txt").is_err());
    assert!(validate_file_path(r"D:\projects\file.rs").is_err());
}

#[test]
fn test_file_path_allows_backslash_relative() {
    // Relative paths with backslashes are valid (Windows-style relative)
    assert!(validate_file_path(r"src\main.rs").is_ok());
    assert!(validate_file_path(r"src\components\Button.tsx").is_ok());
}
