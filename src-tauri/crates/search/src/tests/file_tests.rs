use app_utils::testing::temp_dir_with_files;

use crate::file::{build_file_index, default_excluded_dirs, fuzzy_search, FileEntry};

#[test]
fn test_fuzzy_matching() {
    let entries = vec![
        FileEntry {
            path: "/src/components/Button.tsx".to_string(),
            filename: "Button.tsx".to_string(),
            is_dir: false,
        },
        FileEntry {
            path: "/src/components/ComponentList.tsx".to_string(),
            filename: "ComponentList.tsx".to_string(),
            is_dir: false,
        },
        FileEntry {
            path: "/src/index.tsx".to_string(),
            filename: "index.tsx".to_string(),
            is_dir: false,
        },
    ];

    // Test fuzzy matching
    let results = fuzzy_search(&entries, "btn", 10, None);
    assert!(!results.is_empty());

    // "btn" should match "Button" better than others
    assert_eq!(results[0].0.filename, "Button.tsx");
}

#[test]
fn file_index_skips_runtime_worktrees_but_keeps_user_orgii_files() {
    let (_dir, root) = temp_dir_with_files(&[
        ("src/main.rs", "fn main() {}"),
        (".env", "SECRET=not-a-real-secret"),
        (".orgii/skills/example/SKILL.md", "# Example"),
        (".orgii/worktrees/session-a/generated.rs", "generated"),
        (".worktrees/session-b/generated.rs", "generated"),
    ]);

    let entries = build_file_index(root.to_str().unwrap(), &default_excluded_dirs());
    let paths: Vec<_> = entries
        .iter()
        .filter_map(|entry| {
            std::path::Path::new(&entry.path)
                .strip_prefix(&root)
                .ok()
                .map(|path| path.to_string_lossy().to_string())
        })
        .collect();

    assert!(paths.contains(&"src/main.rs".to_string()));
    assert!(paths.contains(&".env".to_string()));
    assert!(paths.contains(&".orgii/skills/example/SKILL.md".to_string()));
    assert!(!paths
        .iter()
        .any(|path| path.starts_with(".orgii/worktrees")));
    assert!(!paths.iter().any(|path| path.starts_with(".worktrees")));
}

#[test]
fn fuzzy_search_honors_zero_and_top_k_limits() {
    let entries: Vec<_> = (0..100)
        .map(|index| FileEntry {
            path: format!("src/component-{index}.tsx"),
            filename: format!("component-{index}.tsx"),
            is_dir: false,
        })
        .collect();

    assert!(fuzzy_search(&entries, "component", 0, None).is_empty());

    let results = fuzzy_search(&entries, "component", 5, None);
    assert_eq!(results.len(), 5);
    assert!(results.windows(2).all(|pair| pair[0].1 >= pair[1].1));
}
