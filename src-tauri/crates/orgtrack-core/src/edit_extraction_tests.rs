use crate::canonical::{AgentMetadata, ArtifactQuality};
use crate::edit_extraction::{
    artifacts_from_extracted_edit, final_diff_from_chunks, EditArtifactContext,
};

fn context(sequence_index: i64) -> EditArtifactContext {
    EditArtifactContext {
        source: "test_source".to_string(),
        source_session_id: Some("source-session".to_string()),
        session_id: "session-1".to_string(),
        source_event_id: Some(format!("event-{sequence_index}")),
        turn_id: None,
        sequence_index,
        timestamp: None,
        workspace_path: Some("/repo".to_string()),
        metadata: AgentMetadata::default(),
    }
}

fn edit(
    file_path: &str,
    old_content: Option<&str>,
    new_content: Option<&str>,
    is_deleted: bool,
) -> core_types::extracted::ExtractedEditData {
    core_types::extracted::ExtractedEditData {
        file_path: file_path.to_string(),
        file_name: file_path
            .rsplit('/')
            .next()
            .unwrap_or(file_path)
            .to_string(),
        language: "typescript".to_string(),
        content: None,
        line_count: None,
        old_content: old_content.map(str::to_string),
        new_content: new_content.map(str::to_string),
        diff: None,
        old_start_line: None,
        new_start_line: None,
        lines_added: None,
        lines_removed: None,
        is_deleted,
        apply_patch_segments: Vec::new(),
    }
}

fn modify(
    file_path: &str,
    old_content: &str,
    new_content: &str,
) -> core_types::extracted::ExtractedEditData {
    edit(file_path, Some(old_content), Some(new_content), false)
}

#[test]
fn final_diff_omits_reverted_net_zero_changes() {
    let file_path = "src/example.ts";
    let first = artifacts_from_extracted_edit(&context(0), &modify(file_path, "a\n", "b\n"));
    let second = artifacts_from_extracted_edit(&context(1), &modify(file_path, "b\n", "a\n"));
    let chunks = first
        .chunks
        .into_iter()
        .chain(second.chunks)
        .collect::<Vec<_>>();

    let final_diff = final_diff_from_chunks("test_source", "session-1", file_path, &chunks);

    assert!(final_diff.is_none());
}

#[test]
fn final_diff_uses_net_baseline_to_latest_content_numstat() {
    let file_path = "src/example.ts";
    let first = artifacts_from_extracted_edit(
        &context(0),
        &modify(file_path, "one\ntwo\nthree\n", "one\ntwo changed\nthree\n"),
    );
    let second = artifacts_from_extracted_edit(
        &context(1),
        &modify(
            file_path,
            "one\ntwo changed\nthree\n",
            "one\ntwo changed\nthree\nfour\n",
        ),
    );
    let chunks = first
        .chunks
        .into_iter()
        .chain(second.chunks)
        .collect::<Vec<_>>();

    let final_diff = final_diff_from_chunks("test_source", "session-1", file_path, &chunks)
        .expect("net final diff");

    assert_eq!(final_diff.lines_added, 2);
    assert_eq!(final_diff.lines_removed, 1);
    assert!(matches!(final_diff.quality, ArtifactQuality::Exact));
    assert!(final_diff.differs_from_summed_chunks);
    assert!(final_diff.diff.unwrap_or_default().contains("two changed"));
}

#[test]
fn final_diff_counts_new_file_from_empty_baseline() {
    let file_path = "src/new_file.ts";
    let created = artifacts_from_extracted_edit(
        &context(0),
        &edit(file_path, None, Some("one\ntwo\nthree\n"), false),
    );

    let final_diff = final_diff_from_chunks("test_source", "session-1", file_path, &created.chunks)
        .expect("new file final diff");

    assert_eq!(final_diff.lines_added, 3);
    assert_eq!(final_diff.lines_removed, 0);
    assert_eq!(final_diff.old_content.as_deref(), Some(""));
    assert_eq!(final_diff.new_content.as_deref(), Some("one\ntwo\nthree\n"));
    assert!(matches!(final_diff.quality, ArtifactQuality::Exact));
}

#[test]
fn final_diff_counts_deleted_file_to_empty_final_content() {
    let file_path = "src/deleted_file.ts";
    let deleted = artifacts_from_extracted_edit(
        &context(0),
        &edit(file_path, Some("one\ntwo\nthree\n"), None, true),
    );

    let final_diff = final_diff_from_chunks("test_source", "session-1", file_path, &deleted.chunks)
        .expect("deleted file final diff");

    assert_eq!(final_diff.lines_added, 0);
    assert_eq!(final_diff.lines_removed, 3);
    assert_eq!(final_diff.old_content.as_deref(), Some("one\ntwo\nthree\n"));
    assert_eq!(final_diff.new_content.as_deref(), Some(""));
    assert!(matches!(final_diff.quality, ArtifactQuality::Exact));
}

// ---------------------------------------------------------------------------
// Cumulative multi-edit numstat (the Diff-panel "+4 instead of +105" bug).
//
// Real edit_file / edit_file_by_replace / apply_patch chunks carry a LOCAL
// old_string/new_string fragment plus a compact unified `diff`. The old
// `final_diff_from_chunks` diffed the first chunk's old fragment against the
// last chunk's new fragment, collapsing the cumulative numstat. These tests
// build chunks the realistic way (via a `diff` string) and assert the merge
// path recovers the true cumulative count.
// ---------------------------------------------------------------------------

fn diff_chunk(
    sequence_index: i64,
    file_path: &str,
    diff: &str,
    lines_added: i32,
    lines_removed: i32,
) -> crate::canonical::SessionDiffChunkRecord {
    crate::canonical::SessionDiffChunkRecord {
        schema_version: crate::privacy::ORGTRACK_SCHEMA_VERSION,
        record_id: format!("chunk-{sequence_index}"),
        edit_record_id: format!("edit-{sequence_index}"),
        source: "test_source".to_string(),
        session_id: "session-1".to_string(),
        source_event_id: Some(format!("event-{sequence_index}")),
        sequence_index,
        chunk_index: 0,
        file_path: file_path.to_string(),
        old_start_line: None,
        new_start_line: None,
        // LOCAL fragments, deliberately unrelated to each other -- this is what
        // made the old stitch path collapse to a tiny number.
        old_content: Some("local old fragment".to_string()),
        new_content: Some("local new fragment".to_string()),
        diff: Some(diff.to_string()),
        lines_added,
        lines_removed,
        is_deleted: false,
        quality: ArtifactQuality::PatchReversible,
    }
}

#[test]
fn final_diff_sums_disjoint_fragment_edits_instead_of_stitching() {
    let file_path = "tests/example.mjs";
    // Three edits at disjoint line ranges: +1, +37, +1  => cumulative +39.
    // The old behaviour stitched fragment-old vs fragment-new => a tiny wrong
    // value (the real-world report was +4).
    let chunks = vec![
        diff_chunk(
            0,
            file_path,
            "@@ -5,4 +5,5 @@\n ctxA\n ctxB\n+added near top\n ctxC\n ctxD",
            1,
            0,
        ),
        diff_chunk(
            1,
            file_path,
            &format!(
                "@@ -989,4 +989,41 @@\n }}\n \n{}\n ctxTail",
                (0..37)
                    .map(|i| format!("+inserted line {i}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            ),
            37,
            0,
        ),
        diff_chunk(
            2,
            file_path,
            "@@ -2013,4 +2013,5 @@\n ctxX\n ctxY\n+added near bottom\n ctxZ\n ctxW",
            1,
            0,
        ),
    ];

    let final_diff = final_diff_from_chunks("test_source", "session-1", file_path, &chunks)
        .expect("cumulative final diff");

    assert_eq!(
        final_diff.lines_added, 39,
        "disjoint fragment edits must sum (1+37+1), not collapse"
    );
    assert_eq!(final_diff.lines_removed, 0);
    // Merge path never exposes fragment content as whole-file content.
    assert!(final_diff.old_content.is_none());
    assert!(final_diff.new_content.is_none());
}

#[test]
fn final_diff_sums_repeated_insertions_at_the_same_anchor() {
    let file_path = "src/repeated.rs";
    let chunks = vec![
        diff_chunk(
            0,
            file_path,
            "@@ -252,4 +252,8 @@\n }\n \n+fn helper_one() {\n+    one();\n+}\n fn existing() {}",
            4,
            0,
        ),
        diff_chunk(
            1,
            file_path,
            "@@ -252,4 +252,7 @@\n }\n \n+fn helper_two() {\n+    two();\n+}\n fn existing() {}",
            3,
            0,
        ),
        diff_chunk(
            2,
            file_path,
            "@@ -252,6 +252,6 @@\n }\n \n-fn old_name() {}\n+fn new_name() {}\n fn existing() {}",
            1,
            1,
        ),
    ];

    let final_diff = final_diff_from_chunks("test_source", "session-1", file_path, &chunks)
        .expect("repeated insertion final diff");

    assert_eq!(final_diff.lines_added, 8);
    assert_eq!(final_diff.lines_removed, 1);
    assert!(!final_diff.differs_from_summed_chunks);
}

#[test]
fn final_diff_merge_path_lets_later_overlapping_edit_win() {
    let file_path = "src/overlap.ts";
    // The display diff lets the later hunk win, while the sidebar numstat stays
    // on the authoritative per-chunk counters.
    let chunks = vec![
        diff_chunk(
            0,
            file_path,
            "@@ -10,2 +10,3 @@\n keep\n-old tail\n+first attempt\n tail",
            1,
            1,
        ),
        diff_chunk(
            1,
            file_path,
            "@@ -10,2 +10,4 @@\n keep\n-old tail\n+second attempt a\n+second attempt b\n tail",
            2,
            1,
        ),
    ];

    let final_diff = final_diff_from_chunks("test_source", "session-1", file_path, &chunks)
        .expect("overlap final diff");

    assert_eq!(final_diff.lines_added, 3);
    assert_eq!(final_diff.lines_removed, 2);
    assert!(!final_diff.differs_from_summed_chunks);
}
