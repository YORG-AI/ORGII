use crate::detection::get_test_patterns;
use crate::types::{TestFramework, TestItem, TestItemType};
use ignore::WalkBuilder;
/**
 * Test Discovery
 *
 * Discovers test files in a project using glob patterns.
 * Uses the `ignore` crate for fast, gitignore-aware traversal.
 */
use std::path::Path;

/// Discover test files in a project
pub fn discover_tests(
    workspace_path: &Path,
    framework: &TestFramework,
) -> Result<Vec<TestItem>, String> {
    let patterns = get_test_patterns(framework);

    if patterns.is_empty() {
        tracing::info!(framework = ?framework, "[TestRunner] No patterns for framework");
        return Ok(vec![]);
    }

    tracing::info!(patterns = ?patterns, "[TestRunner] Discovering tests with patterns");

    let mut test_files: Vec<TestItem> = Vec::new();

    // Build the directory walker with gitignore support
    let walker = WalkBuilder::new(workspace_path)
        .hidden(true) // Skip hidden files
        .git_ignore(true) // Respect .gitignore
        .git_global(true) // Respect global gitignore
        .git_exclude(true) // Respect .git/info/exclude
        .ignore(true) // Respect .ignore files
        .parents(true) // Check parent directories for ignore files
        .build();

    let mut scanned_files = 0;
    let mut matched_files = 0;

    for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        // Skip directories
        if entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
            continue;
        }

        scanned_files += 1;
        let path = entry.path();
        let path_str = path.to_string_lossy();

        // Skip node_modules, target, __pycache__, etc.
        if path_str.contains("node_modules")
            || path_str.contains("/target/")
            || path_str.contains("/__pycache__/")
            || path_str.contains("/.git/")
        {
            continue;
        }

        // Check if file matches any test pattern
        let is_test_file = patterns
            .iter()
            .any(|pattern| matches_glob_pattern(&path_str, pattern));

        if is_test_file {
            matched_files += 1;
            let relative_path = path
                .strip_prefix(workspace_path)
                .unwrap_or(path)
                .to_string_lossy()
                .to_string();

            let file_name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            test_files.push(TestItem {
                id: relative_path.clone(),
                name: file_name,
                path: relative_path,
                item_type: TestItemType::File,
                children: vec![], // Individual tests are discovered when running
                line: None,
                column: None,
            });
        }
    }

    tracing::info!(
        scanned_files,
        matched_files,
        "[TestRunner] Finished scanning test files"
    );

    // Sort by path for consistent ordering
    test_files.sort_by(|a, b| a.path.cmp(&b.path));

    Ok(test_files)
}

/// Simple glob pattern matching
/// Supports: **, *, and literal paths
pub(crate) fn matches_glob_pattern(path: &str, pattern: &str) -> bool {
    // Remove leading **/ for simpler matching
    let pattern = pattern.trim_start_matches("**/");

    // Handle extension patterns like *.test.ts
    if pattern.starts_with("*.") {
        let suffix = &pattern[1..]; // Remove the *
        return path.ends_with(suffix);
    }

    // Handle directory patterns like __tests__/**/*.ts
    if pattern.contains("**/") {
        let parts: Vec<&str> = pattern.split("**/").collect();
        if parts.len() == 2 {
            let prefix = parts[0].trim_end_matches('/');
            let suffix = parts[1].trim_start_matches("*.");
            return path.contains(prefix) && path.ends_with(suffix);
        }
    }

    // Handle simple wildcard patterns
    if pattern.contains('*') {
        let parts: Vec<&str> = pattern.split('*').collect();
        if parts.len() == 2 {
            return path.contains(parts[0]) && path.ends_with(parts[1]);
        }
    }

    // Literal match
    path.ends_with(pattern)
}

/// Group test files into a tree structure by directory
pub fn build_test_tree(items: Vec<TestItem>, workspace_name: &str) -> Vec<TestItem> {
    use std::collections::HashMap;

    if items.is_empty() {
        return vec![];
    }

    // Group by first directory component
    let mut by_dir: HashMap<String, Vec<TestItem>> = HashMap::new();
    let mut root_files: Vec<TestItem> = Vec::new();

    for item in items {
        let path = std::path::Path::new(&item.path);
        let components: Vec<_> = path.components().collect();
        if components.len() > 1 {
            if let Some(std::path::Component::Normal(first)) = components.first() {
                let dir = first.to_string_lossy().to_string();
                by_dir.entry(dir).or_default().push(item);
            } else {
                root_files.push(item);
            }
        } else {
            root_files.push(item);
        }
    }

    // Build tree
    let mut tree: Vec<TestItem> = Vec::new();

    // Add directories first
    let mut dirs: Vec<_> = by_dir.into_iter().collect();
    dirs.sort_by(|a, b| a.0.cmp(&b.0));

    for (dir_name, dir_items) in dirs {
        tree.push(TestItem {
            id: dir_name.clone(),
            name: dir_name.clone(),
            path: dir_name,
            item_type: TestItemType::Suite,
            children: dir_items,
            line: None,
            column: None,
        });
    }

    // Add root files
    tree.extend(root_files);

    // Wrap in workspace root if we have items
    if !tree.is_empty() {
        vec![TestItem {
            id: workspace_name.to_string(),
            name: workspace_name.to_string(),
            path: ".".to_string(),
            item_type: TestItemType::Suite,
            children: tree,
            line: None,
            column: None,
        }]
    } else {
        vec![]
    }
}

#[cfg(test)]
#[path = "tests/discovery_tests.rs"]
mod tests;
