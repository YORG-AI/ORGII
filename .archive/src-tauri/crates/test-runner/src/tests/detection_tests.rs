use crate::detection::*;
use crate::types::*;
use app_utils::testing::temp_dir_with_files;

#[test]
fn test_detect_vitest() {
    let (_dir, root) = temp_dir_with_files(&[(
        "package.json",
        r#"{"devDependencies": {"vitest": "^1.0.0"}}"#,
    )]);
    assert_eq!(detect_framework(&root), TestFramework::Vitest);
}

#[test]
fn test_detect_jest() {
    let (_dir, root) = temp_dir_with_files(&[(
        "package.json",
        r#"{"devDependencies": {"jest": "^29.0.0"}}"#,
    )]);
    assert_eq!(detect_framework(&root), TestFramework::Jest);
}

#[test]
fn test_detect_cargo() {
    let (_dir, root) = temp_dir_with_files(&[("Cargo.toml", r#"[package]\nname = "test""#)]);
    assert_eq!(detect_framework(&root), TestFramework::Cargo);
}

#[test]
fn test_detect_pytest_with_config() {
    let (_dir, root) = temp_dir_with_files(&[("pytest.ini", "[pytest]\n")]);
    assert_eq!(detect_framework(&root), TestFramework::Pytest);
}

#[test]
fn test_detect_pytest_from_requirements() {
    let (_dir, root) = temp_dir_with_files(&[("requirements.txt", "pytest>=7.0.0\nrequests\n")]);
    assert_eq!(detect_framework(&root), TestFramework::Pytest);
}

#[test]
fn test_detect_pytest_from_test_files() {
    let (_dir, root) = temp_dir_with_files(&[("test_main.py", "def test_example(): pass\n")]);
    assert_eq!(detect_framework(&root), TestFramework::Pytest);
}

#[test]
fn test_detect_pytest_from_tests_dir() {
    let (_dir, root) = temp_dir_with_files(&[("tests/test_utils.py", "def test_util(): pass\n")]);
    assert_eq!(detect_framework(&root), TestFramework::Pytest);
}

#[test]
fn test_no_framework_without_tests() {
    let (_dir, root) = temp_dir_with_files(&[("main.py", "print('hello')\n")]);
    assert_eq!(detect_framework(&root), TestFramework::Unknown);
}
