use std::fs;

use tempfile::tempdir;

use crate::db::CodeMapDb;
use crate::extract::extract_file;
use crate::indexer::{collect_supported_files, index_workspace};
use crate::paths::workspace_key;
use crate::types::{
    CodeMapAction, CodeMapConfidence, CodeMapExtractionMethod, CodeMapLanguage, CodeMapNodeKind,
    CodeMapQueryRequest, CodeMapStatusKind,
};

#[test]
fn workspace_key_is_stable_sha256_hex() {
    let path = std::path::Path::new("/tmp/example");
    let first = workspace_key(path);
    let second = workspace_key(path);
    assert_eq!(first, second);
    assert_eq!(first.len(), 64);
}

#[test]
fn enums_serialize_as_snake_case() {
    assert_eq!(
        serde_json::to_string(&CodeMapNodeKind::TypeAlias).unwrap(),
        "\"type_alias\""
    );
    assert_eq!(
        serde_json::to_string(&CodeMapLanguage::TypeScript).unwrap(),
        "\"typescript\""
    );
}

#[test]
fn extracts_ast_and_regex_symbols_with_confidence() {
    let dir = tempdir().unwrap();
    let rust_path = dir.path().join("lib.rs");
    let ts_path = dir.path().join("App.tsx");
    let go_path = dir.path().join("main.go");
    fs::write(
        &rust_path,
        "pub struct Widget {}\npub fn build_widget() {}\n",
    )
    .unwrap();
    fs::write(
        &ts_path,
        "export interface Props {}\nexport function App() { return null; }\n",
    )
    .unwrap();
    fs::write(&go_path, "package main\nfunc main() {}\n").unwrap();

    let rust = extract_file(dir.path(), &rust_path).unwrap();
    let typescript = extract_file(dir.path(), &ts_path).unwrap();
    let go = extract_file(dir.path(), &go_path).unwrap();

    let rust_widget = rust
        .nodes
        .iter()
        .find(|node| node.name == "Widget")
        .unwrap();
    assert_eq!(
        rust_widget.extraction_method,
        CodeMapExtractionMethod::TreeSitter
    );
    assert_eq!(rust_widget.confidence, CodeMapConfidence::High);
    assert!(rust.nodes.iter().any(|node| node.name == "build_widget"));
    assert!(typescript.nodes.iter().any(|node| node.name == "Props"));
    assert!(typescript.nodes.iter().any(|node| node.name == "App"));
    assert_eq!(
        go.nodes
            .iter()
            .find(|node| node.name == "main")
            .unwrap()
            .extraction_method,
        CodeMapExtractionMethod::Regex
    );
}

#[test]
fn db_stores_searches_and_migrates_metadata() {
    let dir = tempdir().unwrap();
    let source_path = dir.path().join("main.go");
    fs::write(
        &source_path,
        "package main\nfunc main() {}\ntype Server struct {}\n",
    )
    .unwrap();
    let extracted = extract_file(dir.path(), &source_path).unwrap();

    let mut db = CodeMapDb::open(dir.path()).unwrap();
    db.apply_index_changes_with_cancellation(vec![extracted], &[], None)
        .unwrap();
    CodeMapDb::open(dir.path()).unwrap();

    let status = db.status().unwrap();
    assert_eq!(status.files, 1);
    assert!(status.symbols >= 3);
    assert!(!db
        .search_nodes("Server", 10, None, None, None)
        .unwrap()
        .is_empty());
}

#[test]
fn db_stores_cross_file_edges_after_all_nodes_exist() {
    let dir = tempdir().unwrap();
    let importer_path = dir.path().join("a_importer.ts");
    let target_path = dir.path().join("z_target.ts");
    fs::write(
        &importer_path,
        "import './z_target';\nexport function importer() { return 1; }\n",
    )
    .unwrap();
    fs::write(&target_path, "export function target() { return 1; }\n").unwrap();

    let mut extracted_files = vec![
        extract_file(dir.path(), &importer_path).unwrap(),
        extract_file(dir.path(), &target_path).unwrap(),
    ];
    crate::resolver::resolve_files(&mut extracted_files);

    let mut db = CodeMapDb::open(dir.path()).unwrap();
    db.apply_index_changes_with_cancellation(extracted_files, &[], None)
        .unwrap();

    let status = db.status().unwrap();
    assert_eq!(status.status, CodeMapStatusKind::Ready);
    assert_eq!(status.files, 2);
    assert!(status.relationships > 0);
}

#[test]
fn db_storage_respects_cancellation_before_commit() {
    let dir = tempdir().unwrap();
    let source_path = dir.path().join("main.go");
    fs::write(&source_path, "package main\nfunc main() {}\n").unwrap();
    let extracted = extract_file(dir.path(), &source_path).unwrap();
    let cancellation = std::sync::atomic::AtomicBool::new(true);

    let mut db = CodeMapDb::open(dir.path()).unwrap();
    let err = db
        .apply_index_changes_with_cancellation(vec![extracted], &[], Some(&cancellation))
        .unwrap_err();

    assert!(matches!(err, crate::CodeMapError::Cancelled(_)));
    assert_eq!(db.status().unwrap().files, 0);
}

#[test]
fn indexer_respects_supported_languages() {
    let dir = tempdir().unwrap();
    fs::write(dir.path().join("main.py"), "def hello():\n    pass\n").unwrap();
    fs::write(dir.path().join("README.md"), "# ignored\n").unwrap();
    let files = collect_supported_files(dir.path());
    let cancellation = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let indexed = index_workspace(
        dir.path().to_path_buf(),
        files,
        Vec::new(),
        1,
        0,
        cancellation,
        |_| {},
    )
    .unwrap();
    assert_eq!(indexed.extracted_files.len(), 1);
    assert_eq!(indexed.extracted_files[0].record.path, "main.py");
}

#[tokio::test]
async fn service_query_formats_search_explore_and_node_context() {
    let dir = tempdir().unwrap();
    let source_path = dir.path().join("lib.ts");
    fs::write(
        &source_path,
        "export function alpha() { return 1; }\nexport function beta() { return alpha(); }\n",
    )
    .unwrap();
    crate::start_index(None, dir.path().to_path_buf(), true)
        .await
        .unwrap();

    let search = crate::CodeMapService::query(
        CodeMapAction::Search,
        request(dir.path(), Some("alpha"), None),
    )
    .await
    .unwrap();
    assert!(search.contains("alpha"));
    assert!(search.contains("confidence"));

    let explore = crate::CodeMapService::query(
        CodeMapAction::Explore,
        request(dir.path(), Some("alpha"), None),
    )
    .await
    .unwrap();
    assert!(explore.contains("Code Map explore"));

    let node = crate::CodeMapService::query(
        CodeMapAction::Node,
        request(dir.path(), Some("alpha"), None),
    )
    .await
    .unwrap();
    assert!(node.contains("Source:"));
    assert!(node.contains("export function alpha"));
}

#[tokio::test]
async fn resolver_creates_same_file_call_edges() {
    let dir = tempdir().unwrap();
    let source_path = dir.path().join("lib.ts");
    fs::write(
        &source_path,
        "export function alpha() { return 1; }\nexport function beta() { return alpha(); }\n",
    )
    .unwrap();
    crate::start_index(None, dir.path().to_path_buf(), true)
        .await
        .unwrap();
    let callers = crate::CodeMapService::query(
        CodeMapAction::Callers,
        request(dir.path(), Some("alpha"), None),
    )
    .await
    .unwrap();
    assert!(callers.contains("beta") || callers.contains("lib.ts"));
}

#[tokio::test]
async fn stale_detection_tracks_modified_files() {
    let dir = tempdir().unwrap();
    let source_path = dir.path().join("lib.py");
    fs::write(&source_path, "def alpha():\n    return 1\n").unwrap();
    crate::start_index(None, dir.path().to_path_buf(), true)
        .await
        .unwrap();
    fs::write(&source_path, "def alpha():\n    return 2\n").unwrap();
    let status = crate::get_status(dir.path().to_path_buf()).await.unwrap();
    assert_eq!(status.status, CodeMapStatusKind::Stale);
    assert_eq!(status.stale_files, 1);
}

#[tokio::test]
async fn service_reindexes_modified_workspace() {
    let dir = tempdir().unwrap();
    let source_path = dir.path().join("lib.py");
    fs::write(&source_path, "def alpha():\n    return 1\n").unwrap();
    crate::start_index(None, dir.path().to_path_buf(), true)
        .await
        .unwrap();

    fs::write(&source_path, "def beta():\n    return 2\n").unwrap();
    let stale_status = crate::get_status(dir.path().to_path_buf()).await.unwrap();
    assert_eq!(stale_status.status, CodeMapStatusKind::Stale);

    let reindexed_status = crate::start_index(None, dir.path().to_path_buf(), false)
        .await
        .unwrap();
    assert_eq!(reindexed_status.status, CodeMapStatusKind::Ready);
    assert_eq!(reindexed_status.stale_files, 0);

    let search = crate::CodeMapService::query(
        CodeMapAction::Search,
        request(dir.path(), Some("beta"), None),
    )
    .await
    .unwrap();
    assert!(search.contains("beta"));
}

#[tokio::test]
async fn service_allows_forced_reindex_after_existing_index() {
    let dir = tempdir().unwrap();
    let source_path = dir.path().join("lib.ts");
    fs::write(&source_path, "export function alpha() { return 1; }\n").unwrap();
    crate::start_index(None, dir.path().to_path_buf(), true)
        .await
        .unwrap();

    let reindexed_status = crate::start_index(None, dir.path().to_path_buf(), true)
        .await
        .unwrap();
    assert_eq!(reindexed_status.status, CodeMapStatusKind::Ready);
    assert_eq!(reindexed_status.stale_files, 0);
    assert!(reindexed_status.symbols > 0);
}

#[tokio::test]
async fn status_recovers_orphaned_indexing_state() {
    let dir = tempdir().unwrap();
    let source_path = dir.path().join("lib.ts");
    fs::write(&source_path, "export function alpha() { return 1; }\n").unwrap();
    crate::start_index(None, dir.path().to_path_buf(), true)
        .await
        .unwrap();
    CodeMapDb::open(dir.path())
        .unwrap()
        .mark_indexing_for_test()
        .unwrap();

    let status = crate::get_status(dir.path().to_path_buf()).await.unwrap();
    assert_eq!(status.status, CodeMapStatusKind::Failed);
    assert!(status
        .error
        .as_deref()
        .is_some_and(|error| error.contains("stopped before completion")));
}

#[tokio::test]
async fn cancel_recovers_orphaned_indexing_state() {
    let dir = tempdir().unwrap();
    let source_path = dir.path().join("lib.ts");
    fs::write(&source_path, "export function alpha() { return 1; }\n").unwrap();
    crate::start_index(None, dir.path().to_path_buf(), true)
        .await
        .unwrap();
    CodeMapDb::open(dir.path())
        .unwrap()
        .mark_indexing_for_test()
        .unwrap();

    let cancelled = crate::cancel_index(dir.path().to_path_buf()).await.unwrap();
    assert!(cancelled);
    let status = crate::get_status(dir.path().to_path_buf()).await.unwrap();
    assert_eq!(status.status, CodeMapStatusKind::Cancelled);
}

fn request(
    workspace_path: &std::path::Path,
    query: Option<&str>,
    node_id: Option<&str>,
) -> CodeMapQueryRequest {
    CodeMapQueryRequest {
        workspace_path: workspace_path.to_path_buf(),
        query: query.map(str::to_string),
        node_id: node_id.map(str::to_string),
        file_path: None,
        kind: None,
        language: None,
        path_prefix: None,
        include_source: true,
        include_relationships: true,
        max_results: 10,
        max_depth: 2,
    }
}
