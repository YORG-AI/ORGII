use std::collections::HashMap;
use std::sync::Arc;

use crate::file::{
    estimate_file_index_bytes, fuzzy_search, prune_file_index_cache, FileEntry, FileIndex,
};

#[test]
fn file_index_size_estimate_includes_paths_and_entry_storage() {
    let entries = vec![FileEntry {
        path: "C:/repo/src/main.rs".to_string(),
        filename: "main.rs".to_string(),
        is_dir: false,
    }];

    assert!(
        estimate_file_index_bytes(&entries)
            >= std::mem::size_of::<FileEntry>() + entries[0].path.len() + entries[0].filename.len()
    );
}

#[test]
fn file_index_cache_prunes_to_global_byte_budget() {
    let now = std::time::SystemTime::now();
    let mut cache = HashMap::new();
    for index in 0..3 {
        cache.insert(
            format!("repo-{index}"),
            FileIndex {
                entries: Arc::new(Vec::new()),
                _root_path: format!("repo-{index}"),
                indexed_at: now
                    .checked_sub(std::time::Duration::from_secs(3 - index))
                    .expect("test timestamp should be representable"),
                estimated_bytes: 24 * 1024 * 1024,
            },
        );
    }

    prune_file_index_cache(&mut cache);

    assert_eq!(cache.len(), 2);
    assert!(!cache.contains_key("repo-0"));
}

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
