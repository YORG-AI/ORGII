use super::text_search::{search_code_fast_inner, search_code_fast_inner_with_handlers};
use super::types::SearchFilters;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

struct TempSearchDir {
    path: PathBuf,
}

impl TempSearchDir {
    fn new(name: &str) -> Self {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after Unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "orgii-search-test-{name}-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("test temp directory should be created");
        Self { path }
    }

    fn path_str(&self) -> String {
        self.path.to_string_lossy().to_string()
    }

    fn write_file(&self, relative_path: &str, content: &str) {
        let path = self.path.join(relative_path);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("test file parent should be created");
        }
        fs::write(path, content).expect("test file should be written");
    }
}

impl Drop for TempSearchDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn test_filters(max_results: usize) -> SearchFilters {
    SearchFilters {
        file_extensions: Some(vec!["rs".to_string()]),
        exclude_dirs: None,
        case_sensitive: Some(false),
        whole_word: Some(false),
        use_regex: Some(false),
        max_results: Some(max_results),
    }
}

fn total_result_matches(results: &[super::types::CodeSearchResult]) -> usize {
    results.iter().map(|result| result.matches.len()).sum()
}

#[test]
fn fast_search_inner_finds_literal_case_insensitive_matches() {
    let temp_dir = TempSearchDir::new("literal");
    temp_dir.write_file("src/lib.rs", "AlphaNeedle\nbeta needle\n");
    temp_dir.write_file("src/ignored.txt", "needle\n");

    let outcome = search_code_fast_inner("needle", &temp_dir.path_str(), test_filters(10), None)
        .expect("fast search should succeed");

    assert_eq!(outcome.total_matches, 2);
    assert_eq!(outcome.total_files, 1);
    assert_eq!(total_result_matches(&outcome.results), 2);
    assert!(!outcome.limit_hit);
    assert!(!outcome.cancelled);

    let result = outcome
        .results
        .iter()
        .find(|result| Path::new(&result.file_path).ends_with("src/lib.rs"))
        .expect("Rust file should have matches");
    assert_eq!(result.matches[0].line, 1);
    assert_eq!(result.matches[0].text, "Needle");
    assert_eq!(result.matches[1].line, 2);
    assert_eq!(result.matches[1].text, "needle");
}

#[test]
fn fast_search_inner_respects_max_results() {
    let temp_dir = TempSearchDir::new("limit");
    temp_dir.write_file("src/lib.rs", "needle one\nneedle two\nneedle three\n");

    let outcome = search_code_fast_inner("needle", &temp_dir.path_str(), test_filters(2), None)
        .expect("fast search should succeed");

    assert_eq!(outcome.total_matches, 2);
    assert_eq!(total_result_matches(&outcome.results), 2);
    assert!(outcome.limit_hit);
}

#[test]
fn fast_search_inner_handlers_receive_file_count_and_progress() {
    let temp_dir = TempSearchDir::new("callbacks");
    temp_dir.write_file("src/lib.rs", "needle\n");
    temp_dir.write_file("src/main.rs", "needle\n");

    let file_count_seen = Arc::new(Mutex::new(None));
    let progress_seen = Arc::new(Mutex::new(Vec::new()));

    let file_count_for_callback = Arc::clone(&file_count_seen);
    let progress_for_callback = Arc::clone(&progress_seen);
    let outcome = search_code_fast_inner_with_handlers(
        "needle",
        &temp_dir.path_str(),
        test_filters(10),
        None,
        move |total_files| {
            *file_count_for_callback.lock().unwrap() = Some(total_files);
        },
        move |_result, total_matches, total_files| {
            progress_for_callback
                .lock()
                .unwrap()
                .push((total_matches, total_files));
        },
    )
    .expect("fast search should succeed");

    assert_eq!(*file_count_seen.lock().unwrap(), Some(2));
    assert_eq!(outcome.total_matches, 2);
    assert_eq!(outcome.total_files, 2);

    let progress = progress_seen.lock().unwrap();
    assert_eq!(progress.len(), 2);
    assert!(progress.iter().all(|(total_matches, total_files)| {
        (1..=outcome.total_matches).contains(total_matches)
            && (1..=outcome.total_files).contains(total_files)
    }));
    assert!(progress
        .iter()
        .any(|(total_matches, total_files)| { *total_matches == 2 && *total_files == 2 }));
}
