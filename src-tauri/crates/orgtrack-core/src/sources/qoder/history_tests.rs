use super::*;
use crate::sources::imported_history::metadata::ImportedHistoryRecordSignature;

fn fixture_projects_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src/sources/fixtures/qoder/projects")
}

fn fixture_record() -> ImportedHistoryDiscoveredRecord {
    let path =
        fixture_projects_dir().join("-work-orgii/11111111-2222-4333-8444-555555555555.jsonl");
    let (mtime, size) =
        imported_paths::file_metadata_signature(&path, "Qoder fixture").expect("fixture signature");
    ImportedHistoryDiscoveredRecord {
        source_session_id: "11111111-2222-4333-8444-555555555555".to_string(),
        source_path: path,
        source_record_key: "-work-orgii/11111111-2222-4333-8444-555555555555.jsonl".to_string(),
        source_mtime_ms: mtime,
        source_size_bytes: size,
        source_fingerprint: String::new(),
        parser_version: QODER_METADATA_PARSER_VERSION,
    }
}

#[test]
fn discovers_official_and_ide_companion_project_paths() {
    let paths = qoder_projects_dir_candidates_for_home(Path::new("/home/tester"));
    assert!(paths.iter().any(|path| path.ends_with(".qoder/projects")));
    assert!(paths.iter().any(|path| {
        path.ends_with(
            "Library/Application Support/Qoder/User/globalStorage/qoder.qoder-cli-vscode-ide-companion/projects",
        )
    }));
    assert!(paths.iter().any(|path| {
        path.ends_with(
            ".config/Qoder/User/globalStorage/qoder.qoder-cli-vscode-ide-companion/projects",
        )
    }));
}

#[test]
fn discovery_finds_real_shaped_fixture_and_missing_dirs_are_safe() {
    let files = collect_qoder_session_files(&fixture_projects_dir()).expect("fixture discovery");
    assert_eq!(files.len(), 3);
    assert!(files
        .iter()
        .any(|file| { file.source_session_id == "11111111-2222-4333-8444-555555555555" }));
    assert!(files
        .iter()
        .any(|file| file.source_session_id == "parent--agent-child"));
    assert!(files
        .iter()
        .any(|file| file.source_session_id == "transcript-session"));
    assert!(
        collect_qoder_session_files(Path::new("/definitely/missing/qoder/projects"))
            .expect("missing safe")
            .is_empty()
    );
}

#[test]
fn session_prefix_round_trips() {
    assert_eq!(
        qoder_source_id_from_session_id("qoderapp-11111111-2222-4333-8444-555555555555").unwrap(),
        "11111111-2222-4333-8444-555555555555"
    );
    assert!(qoder_source_id_from_session_id("qoderapp-").is_err());
    assert!(qoder_source_id_from_session_id("qoder-session").is_err());
}

#[test]
fn metadata_maps_title_model_repo_tokens_impact_and_timestamps() {
    let meta = parse_qoder_session_meta(&fixture_record())
        .expect("metadata")
        .expect("session");
    assert_eq!(meta.name, "Qoder history importer");
    assert_eq!(meta.model.as_deref(), Some("qoder-max"));
    assert_eq!(meta.repo_path.as_deref(), Some("/work/orgii"));
    assert_eq!(meta.branch.as_deref(), Some("feature/qoder"));
    assert_eq!(meta.input_tokens, 150);
    assert_eq!(meta.output_tokens, 30);
    assert_eq!(meta.impact.files_changed, 1);
    assert_eq!(meta.impact.lines_added, 2);
    assert_eq!(meta.impact.lines_removed, 1);
    assert_eq!(meta.impact.touched_files, vec!["src/qoder.rs"]);
    assert_eq!(meta.created_at_ms, 1_784_052_000_000);
    assert_eq!(meta.updated_at_ms, 1_784_066_400_000);
    assert!(meta.parent_session_id.is_none());
}

#[test]
fn transcript_maps_messages_thinking_tools_and_outputs() {
    let lines = read_qoder_lines(&fixture_record().source_path).expect("fixture lines");
    let chunks = qoder_chunks_from_lines("qoderapp-11111111-2222-4333-8444-555555555555", &lines);
    assert_eq!(chunks.len(), 6);
    assert_eq!(chunks[0].function, imported_history::FUNCTION_USER_MESSAGE);
    assert_eq!(chunks[1].function, imported_history::FUNCTION_THINKING);
    assert_eq!(chunks[2].function, imported_history::FUNCTION_ASSISTANT);
    assert_eq!(chunks[3].function, imported_history::FUNCTION_READ_FILE);
    assert_eq!(
        chunks[4].function,
        imported_history::FUNCTION_RUN_COMMAND_LINE
    );
    assert_eq!(chunks[5].function, imported_history::FUNCTION_EDIT_FILE);
    assert_eq!(chunks[3].args["file_path"], "src/importer.rs");
    assert_eq!(chunks[3].result["output"], "existing importer source");
    assert_eq!(
        chunks[4].args["command"],
        "cargo test -p orgtrack-core qoder"
    );
    assert!(chunks[5].result["diff"]
        .as_str()
        .unwrap_or_default()
        .contains("+second line"));
}

#[test]
fn parser_version_and_file_signature_invalidate_only_qoder_cache() {
    let record = fixture_record();
    let cached = ImportedHistoryRecordSignature {
        source_session_id: record.source_session_id.clone(),
        source_path: record.source_path.to_string_lossy().to_string(),
        source_mtime_ms: record.source_mtime_ms,
        source_size_bytes: record.source_size_bytes,
        source_fingerprint: record.source_fingerprint.clone(),
        parser_version: record.parser_version,
    };
    assert!(imported_cache::record_matches_cached_signature(
        &cached, &cached
    ));

    let mut parser_changed = cached.clone();
    parser_changed.parser_version += 1;
    assert!(!imported_cache::record_matches_cached_signature(
        &cached,
        &parser_changed
    ));

    let mut file_changed = cached.clone();
    file_changed.source_size_bytes += 1;
    assert!(!imported_cache::record_matches_cached_signature(
        &cached,
        &file_changed
    ));
    assert!(imported_history::metadata::is_imported_history_source(
        SOURCE_QODER
    ));
}

#[test]
fn child_session_uses_parent_linkage() {
    let file = collect_qoder_session_files(&fixture_projects_dir())
        .expect("fixture discovery")
        .into_iter()
        .find(|file| file.source_session_id == "parent--agent-child")
        .expect("child fixture");
    let (mtime, size) = imported_paths::file_metadata_signature(&file.path, "Qoder child")
        .expect("child signature");
    let record = ImportedHistoryDiscoveredRecord {
        source_session_id: file.source_session_id,
        source_path: file.path,
        source_record_key: file.source_record_key,
        source_mtime_ms: mtime,
        source_size_bytes: size,
        source_fingerprint: String::new(),
        parser_version: QODER_METADATA_PARSER_VERSION,
    };
    let meta = parse_qoder_session_meta(&record)
        .expect("metadata")
        .expect("child metadata");
    let input = qoder_meta_to_cache_input(meta);
    assert_eq!(input.parent_session_id.as_deref(), Some("qoderapp-parent"));
}
