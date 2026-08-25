use crate::types::TestFramework;
/**
 * Test Framework Detection
 *
 * Detects the test framework used in a project by analyzing:
 * - package.json dependencies (JS/TS)
 * - Cargo.toml (Rust)
 * - pyproject.toml / pytest.ini (Python)
 */
use std::path::Path;
use std::sync::OnceLock;

// Cache the Python command to avoid repeated checks
static PYTHON_CMD: OnceLock<&'static str> = OnceLock::new();

/// Detect which Python command is available
fn get_python_command() -> &'static str {
    PYTHON_CMD.get_or_init(|| {
        // Try python3 first (common on macOS/Linux)
        if std::process::Command::new("python3")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
        {
            return "python3";
        }

        // Fallback to python (Windows, some Linux, virtual environments)
        if std::process::Command::new("python")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
        {
            return "python";
        }

        // Default to python3 if neither works
        "python3"
    })
}

/// Detect test framework from project structure
pub fn detect_framework(workspace_path: &Path) -> TestFramework {
    // Check for JavaScript/TypeScript projects (package.json)
    let package_json = workspace_path.join("package.json");
    if package_json.exists() {
        if let Ok(content) = std::fs::read_to_string(&package_json) {
            // Check in order of specificity

            // Vitest (modern, often preferred)
            if content.contains("\"vitest\"") || content.contains("'vitest'") {
                return TestFramework::Vitest;
            }

            // Jest (most common)
            if content.contains("\"jest\"") || content.contains("'jest'") {
                return TestFramework::Jest;
            }

            // Mocha
            if content.contains("\"mocha\"") || content.contains("'mocha'") {
                return TestFramework::Mocha;
            }
        }
    }

    // Check for Rust projects (Cargo.toml)
    if workspace_path.join("Cargo.toml").exists() {
        return TestFramework::Cargo;
    }

    // Check for Python projects
    // Strategy: Look for pytest config files first, then fallback to detecting Python project with tests

    // 1. Explicit pytest config files
    if workspace_path.join("pytest.ini").exists() || workspace_path.join("conftest.py").exists() {
        return TestFramework::Pytest;
    }

    // 2. Check pyproject.toml for pytest
    let pyproject = workspace_path.join("pyproject.toml");
    if pyproject.exists() {
        if let Ok(content) = std::fs::read_to_string(&pyproject) {
            if content.contains("[tool.pytest") || content.contains("pytest") {
                return TestFramework::Pytest;
            }
        }
    }

    // 3. Check requirements.txt for pytest
    let requirements = workspace_path.join("requirements.txt");
    if requirements.exists() {
        if let Ok(content) = std::fs::read_to_string(&requirements) {
            if content.contains("pytest") {
                return TestFramework::Pytest;
            }
        }
    }

    // 4. Check setup.py or setup.cfg for pytest
    if workspace_path.join("setup.py").exists() || workspace_path.join("setup.cfg").exists() {
        // Likely Python project, assume pytest
        if workspace_path.join("tests").exists() || workspace_path.join("test").exists() {
            return TestFramework::Pytest;
        }
    }

    // 5. Fallback: Check if there are Python test files present
    // This is more lenient - if we see test files, assume pytest
    if has_python_test_files(workspace_path) {
        return TestFramework::Pytest;
    }

    TestFramework::Unknown
}

/// Check if directory contains Python test files
/// Performs a shallow scan (only top-level and common test directories)
fn has_python_test_files(workspace_path: &Path) -> bool {
    use std::fs;

    // Check common test directories
    let test_dirs = [
        workspace_path.join("tests"),
        workspace_path.join("test"),
        workspace_path.to_path_buf(), // root directory
    ];

    for dir in &test_dirs {
        if !dir.exists() || !dir.is_dir() {
            continue;
        }

        // Read directory entries
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                if let Ok(file_name) = entry.file_name().into_string() {
                    // Check for test_*.py or *_test.py patterns
                    if (file_name.starts_with("test_") || file_name.ends_with("_test.py"))
                        && file_name.ends_with(".py")
                    {
                        return true;
                    }
                }
            }
        }
    }

    false
}

/// Get the test command and arguments for a framework
pub fn get_test_command(framework: &TestFramework) -> (&'static str, Vec<&'static str>) {
    match framework {
        TestFramework::Vitest => ("npx", vec!["vitest", "run", "--reporter=json"]),
        TestFramework::Jest => ("npx", vec!["jest", "--json", "--testLocationInResults"]),
        TestFramework::Pytest => (
            get_python_command(),
            vec!["-m", "pytest", "--tb=short", "-v"],
        ),
        TestFramework::Cargo => (
            "cargo",
            vec!["test", "--", "--format=json", "-Z", "unstable-options"],
        ),
        TestFramework::Mocha => ("npx", vec!["mocha", "--reporter", "json"]),
        TestFramework::Unknown => ("echo", vec!["No test framework detected"]),
    }
}

/// Get the list command for discovering tests (without running them)
pub fn get_list_command(framework: &TestFramework) -> Option<(&'static str, Vec<&'static str>)> {
    match framework {
        TestFramework::Vitest => Some(("npx", vec!["vitest", "list", "--reporter=json"])),
        TestFramework::Jest => Some(("npx", vec!["jest", "--listTests", "--json"])),
        TestFramework::Pytest => Some((
            get_python_command(),
            vec!["-m", "pytest", "--collect-only", "-q"],
        )),
        TestFramework::Cargo => Some(("cargo", vec!["test", "--", "--list"])),
        TestFramework::Mocha => None, // Mocha doesn't have a list command
        TestFramework::Unknown => None,
    }
}

/// Get file patterns to search for test files
pub fn get_test_patterns(framework: &TestFramework) -> Vec<&'static str> {
    match framework {
        TestFramework::Jest | TestFramework::Vitest => vec![
            "**/*.test.ts",
            "**/*.test.tsx",
            "**/*.test.js",
            "**/*.test.jsx",
            "**/*.spec.ts",
            "**/*.spec.tsx",
            "**/*.spec.js",
            "**/*.spec.jsx",
            "**/__tests__/**/*.ts",
            "**/__tests__/**/*.tsx",
            "**/__tests__/**/*.js",
            "**/__tests__/**/*.jsx",
        ],
        TestFramework::Pytest => vec![
            "**/test_*.py",
            "**/*_test.py",
            "**/tests/**/*.py",
            "**/test/**/*.py",
        ],
        TestFramework::Cargo => vec!["**/src/**/*.rs", "**/tests/**/*.rs"],
        TestFramework::Mocha => vec![
            "**/test/**/*.js",
            "**/test/**/*.ts",
            "**/tests/**/*.js",
            "**/tests/**/*.ts",
        ],
        TestFramework::Unknown => vec![],
    }
}

#[cfg(test)]
#[path = "tests/detection_tests.rs"]
mod tests;
