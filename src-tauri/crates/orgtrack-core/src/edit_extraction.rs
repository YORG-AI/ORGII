use chrono::Utc;
use core_types::extracted::ExtractedEditData;

use crate::canonical::{
    AgentMetadata, ArtifactQuality, SessionDiffChunkRecord, SessionEditArtifactRecord,
    SessionEditKind, SessionFinalDiffRecord,
};
use crate::privacy::ORGTRACK_SCHEMA_VERSION;
use crate::repo_sync::paths::{path_hash, record_id};

#[derive(Debug, Clone)]
pub struct EditArtifactContext {
    pub source: String,
    pub source_session_id: Option<String>,
    pub session_id: String,
    pub source_event_id: Option<String>,
    pub turn_id: Option<String>,
    pub sequence_index: i64,
    pub timestamp: Option<String>,
    pub workspace_path: Option<String>,
    pub metadata: AgentMetadata,
}

#[derive(Debug, Clone, Default)]
pub struct NormalizedEditArtifacts {
    pub edits: Vec<SessionEditArtifactRecord>,
    pub chunks: Vec<SessionDiffChunkRecord>,
}

pub fn artifacts_from_extracted_edit(
    context: &EditArtifactContext,
    edit: &ExtractedEditData,
) -> NormalizedEditArtifacts {
    let segments = if edit.apply_patch_segments.is_empty() {
        vec![edit]
    } else {
        edit.apply_patch_segments.iter().collect::<Vec<_>>()
    };
    let mut artifacts = NormalizedEditArtifacts::default();
    for (chunk_index, segment) in segments.into_iter().enumerate() {
        let file_path = if segment.file_path.is_empty() {
            edit.file_path.clone()
        } else {
            segment.file_path.clone()
        };
        if file_path.is_empty() {
            continue;
        }
        let edit_record_id = record_id(&[
            "edit",
            &context.source,
            &context.session_id,
            context.source_event_id.as_deref().unwrap_or(""),
            &context.sequence_index.to_string(),
            &chunk_index.to_string(),
            &file_path,
        ]);
        let quality = edit_quality(segment);
        let lines_added = segment.lines_added.unwrap_or(0) as i32;
        let lines_removed = segment.lines_removed.unwrap_or(0) as i32;
        let old_start_line = to_u32(segment.old_start_line);
        let new_start_line = to_u32(segment.new_start_line);
        artifacts.edits.push(SessionEditArtifactRecord {
            schema_version: ORGTRACK_SCHEMA_VERSION,
            record_id: edit_record_id.clone(),
            source: context.source.clone(),
            source_session_id: context.source_session_id.clone(),
            session_id: context.session_id.clone(),
            source_event_id: context.source_event_id.clone(),
            turn_id: context.turn_id.clone(),
            sequence_index: context.sequence_index,
            timestamp: context.timestamp.clone(),
            workspace_path: context.workspace_path.clone(),
            file_path: file_path.clone(),
            path_hash: path_hash(&file_path),
            edit_kind: edit_kind(segment),
            old_start_line,
            new_start_line,
            start_line: old_start_line.or(new_start_line),
            end_line: changed_end_line(old_start_line, new_start_line, lines_added, lines_removed),
            lines_added,
            lines_removed,
            quality: quality.clone(),
            metadata: context.metadata.clone(),
        });
        artifacts.chunks.push(SessionDiffChunkRecord {
            schema_version: ORGTRACK_SCHEMA_VERSION,
            record_id: record_id(&[
                "diff_chunk",
                &context.source,
                &context.session_id,
                context.source_event_id.as_deref().unwrap_or(""),
                &context.sequence_index.to_string(),
                &chunk_index.to_string(),
                &file_path,
            ]),
            edit_record_id,
            source: context.source.clone(),
            session_id: context.session_id.clone(),
            source_event_id: context.source_event_id.clone(),
            sequence_index: context.sequence_index,
            chunk_index: chunk_index as i64,
            file_path,
            old_start_line,
            new_start_line,
            old_content: segment.old_content.clone(),
            new_content: segment.new_content.clone(),
            diff: segment.diff.clone(),
            lines_added,
            lines_removed,
            is_deleted: segment.is_deleted,
            quality,
        });
    }
    artifacts
}

pub fn final_diff_from_chunks(
    source: &str,
    session_id: &str,
    file_path: &str,
    chunks: &[SessionDiffChunkRecord],
) -> Option<SessionFinalDiffRecord> {
    let file_chunks: Vec<&SessionDiffChunkRecord> = chunks
        .iter()
        .filter(|chunk| chunk.file_path == file_path)
        .collect();
    let baseline_chunk = file_chunks
        .iter()
        .copied()
        .find(|chunk| chunk.old_content.is_some());
    let final_chunk = file_chunks.iter().copied().rev().find(|chunk| {
        chunk.new_content.is_some() || chunk.old_content.is_some() || chunk.diff.is_some()
    })?;

    // A chunk's `old_content`/`new_content` is the LOCAL old_string/new_string
    // fragment of that single edit, NOT a whole-file snapshot. Stitching the
    // first chunk's old fragment to the last chunk's new fragment (the previous
    // behaviour) diffs two unrelated fragments and collapses the cumulative
    // numstat to a tiny, wrong value (issue: Diff panel shows +4 instead of
    // +105). The display diff is the union of every chunk's unified-diff hunks;
    // the sidebar numstat comes from the authoritative per-chunk counters.
    let raw_diffs: Vec<&str> = file_chunks
        .iter()
        .filter_map(|chunk| chunk.diff.as_deref())
        .filter(|diff| !diff.trim().is_empty())
        .collect();

    let summed_lines_added: i32 = file_chunks.iter().map(|chunk| chunk.lines_added).sum();
    let summed_lines_removed: i32 = file_chunks.iter().map(|chunk| chunk.lines_removed).sum();

    // Discriminator: if any chunk carries a unified-diff string we take the
    // MERGE path (fragment edits: edit_file / edit_file_by_replace / apply_
    // patch). Only when no chunk has a diff (create / delete / full overwrite,
    // which carry whole-file content instead) do we fall back to whole-file
    // content stitching, correct for that single-snapshot shape.
    let has_fragment_diffs = !raw_diffs.is_empty();
    let stitch_old_content = || {
        baseline_chunk
            .and_then(|chunk| chunk.old_content.clone())
            .or_else(|| final_chunk.new_content.as_ref().map(|_| String::new()))
    };
    let stitch_new_content = || {
        if final_chunk.is_deleted {
            Some(String::new())
        } else {
            final_chunk.new_content.clone()
        }
    };

    let (diff, final_numstat, old_content, new_content) = if has_fragment_diffs {
        match merge_unified_diff_hunks(&raw_diffs) {
            Some((merged_diff, _numstat)) => {
                if summed_lines_added == 0 && summed_lines_removed == 0 {
                    match exact_fragment_diff(&file_chunks) {
                        Some((diff, numstat, old_content, new_content)) => {
                            (Some(diff), numstat, Some(old_content), Some(new_content))
                        }
                        None => return None,
                    }
                } else {
                    (
                        Some(merged_diff),
                        (summed_lines_added, summed_lines_removed),
                        None,
                        None,
                    )
                }
            }
            None => {
                if let Some((diff, numstat, old_content, new_content)) =
                    exact_fragment_diff(&file_chunks)
                {
                    (Some(diff), numstat, Some(old_content), Some(new_content))
                } else if summed_lines_added == 0 && summed_lines_removed == 0 {
                    return None;
                } else {
                    (
                        final_chunk.diff.clone(),
                        (summed_lines_added, summed_lines_removed),
                        None,
                        None,
                    )
                }
            }
        }
    } else {
        let old_content = stitch_old_content();
        let new_content = stitch_new_content();
        match (&old_content, &new_content) {
            (Some(old_content), Some(new_content)) => {
                let text_diff = similar::TextDiff::from_lines(old_content, new_content);
                let unified_diff = text_diff.unified_diff().to_string();
                if unified_diff.trim().is_empty() {
                    return None;
                }
                let numstat = numstat_between_lines(old_content, new_content);
                (
                    Some(unified_diff),
                    numstat,
                    Some(old_content.clone()),
                    Some(new_content.clone()),
                )
            }
            _ => (
                final_chunk.diff.clone(),
                (final_chunk.lines_added, final_chunk.lines_removed),
                old_content,
                new_content,
            ),
        }
    };

    let quality = if old_content.is_some() && new_content.is_some() {
        ArtifactQuality::Exact
    } else if diff.is_some() {
        ArtifactQuality::PatchReversible
    } else {
        ArtifactQuality::Inferred
    };

    Some(SessionFinalDiffRecord {
        schema_version: ORGTRACK_SCHEMA_VERSION,
        record_id: record_id(&["final_diff", source, session_id, file_path]),
        source: source.to_string(),
        session_id: session_id.to_string(),
        file_path: file_path.to_string(),
        baseline_event_id: baseline_chunk.and_then(|chunk| chunk.source_event_id.clone()),
        final_event_id: final_chunk.source_event_id.clone(),
        old_content,
        new_content,
        diff,
        lines_added: final_numstat.0,
        lines_removed: final_numstat.1,
        is_deleted: final_chunk.is_deleted,
        quality,
        differs_from_summed_chunks: final_numstat.0 != summed_lines_added
            || final_numstat.1 != summed_lines_removed,
        computed_at: Utc::now().to_rfc3339(),
    })
}

/// A single parsed unified-diff hunk: header line numbers plus the raw body
/// lines (context / `+` / `-`), excluding the `@@` header itself.
struct DiffHunk {
    old_start: i64,
    old_count: i64,
    body: Vec<String>,
}

/// Parse the `@@ -a,b +c,d @@` header. `b`/`d` default to 1 when omitted,
/// matching unified-diff conventions and the frontend `mergeUnifiedDiffStrings`.
fn parse_hunk_header(line: &str) -> Option<(i64, i64, i64, i64)> {
    let rest = line.strip_prefix("@@ -")?;
    let (old_part, after_old) = rest.split_once(" +")?;
    let new_part = after_old.split(" @@").next()?;
    let parse_pair = |segment: &str| -> Option<(i64, i64)> {
        match segment.split_once(',') {
            Some((start, count)) => Some((start.trim().parse().ok()?, count.trim().parse().ok()?)),
            None => Some((segment.trim().parse().ok()?, 1)),
        }
    };
    let (old_start, old_count) = parse_pair(old_part)?;
    let (new_start, new_count) = parse_pair(new_part)?;
    Some((old_start, old_count, new_start, new_count))
}

/// Merge every chunk's unified-diff hunks into one cumulative diff and count
/// its `+`/`-` lines. Hunks are sorted by old-file start line; a later hunk
/// that overlaps an earlier one wins (edit-order / last-writer-wins), mirroring
/// the frontend `mergeUnifiedDiffStrings` so the panel and the stored final
/// diff agree. Returns the merged unified-diff string and its `(added, removed)`
/// numstat, or `None` when there are no parseable hunks.
fn merge_unified_diff_hunks(diffs: &[&str]) -> Option<(String, (i32, i32))> {
    let mut hunks: Vec<DiffHunk> = Vec::new();
    for diff in diffs {
        let mut current: Option<DiffHunk> = None;
        for line in diff.split('\n') {
            if line.starts_with("---") || line.starts_with("+++") {
                continue;
            }
            if line.starts_with("diff ") || line.starts_with("index ") {
                continue;
            }
            if let Some((old_start, old_count, _new_start, _new_count)) = parse_hunk_header(line) {
                if let Some(hunk) = current.take() {
                    hunks.push(hunk);
                }
                current = Some(DiffHunk {
                    old_start,
                    old_count,
                    body: Vec::new(),
                });
                continue;
            }
            if let Some(hunk) = current.as_mut() {
                hunk.body.push(line.to_string());
            }
        }
        if let Some(hunk) = current.take() {
            hunks.push(hunk);
        }
    }

    if hunks.is_empty() {
        return None;
    }

    // Stable sort by old-file start so equal-start hunks keep edit order.
    hunks.sort_by_key(|hunk| hunk.old_start);

    // Drop earlier hunks fully overlapped by a later one (last writer wins).
    let mut merged: Vec<DiffHunk> = Vec::new();
    for hunk in hunks {
        while let Some(prev) = merged.last() {
            if prev.old_start + prev.old_count > hunk.old_start {
                merged.pop();
            } else {
                break;
            }
        }
        merged.push(hunk);
    }

    let mut added = 0_i32;
    let mut removed = 0_i32;
    let mut parts: Vec<String> = Vec::new();
    for hunk in &merged {
        for body_line in &hunk.body {
            if body_line.starts_with('+') && !body_line.starts_with("+++") {
                added += 1;
            } else if body_line.starts_with('-') && !body_line.starts_with("---") {
                removed += 1;
            }
        }
        parts.push(format!("@@ -{},{} @@", hunk.old_start, hunk.old_count));
        parts.extend(hunk.body.iter().cloned());
    }

    Some((parts.join("\n"), (added, removed)))
}

fn exact_fragment_diff(
    chunks: &[&SessionDiffChunkRecord],
) -> Option<(String, (i32, i32), String, String)> {
    let baseline = chunks.iter().find_map(|chunk| chunk.old_content.clone())?;
    let final_content = chunks
        .iter()
        .rev()
        .find_map(|chunk| chunk.new_content.clone())?;
    let diff = similar::TextDiff::from_lines(&baseline, &final_content)
        .unified_diff()
        .to_string();
    if diff.trim().is_empty() {
        return None;
    }
    let numstat = numstat_between_lines(&baseline, &final_content);
    Some((diff, numstat, baseline, final_content))
}

fn numstat_between_lines(old_content: &str, new_content: &str) -> (i32, i32) {
    similar::TextDiff::from_lines(old_content, new_content)
        .iter_all_changes()
        .fold((0_i32, 0_i32), |(added, removed), change| {
            match change.tag() {
                similar::ChangeTag::Insert => (added + 1, removed),
                similar::ChangeTag::Delete => (added, removed + 1),
                similar::ChangeTag::Equal => (added, removed),
            }
        })
}

fn edit_quality(edit: &ExtractedEditData) -> ArtifactQuality {
    if edit.old_content.is_some() && edit.new_content.is_some() {
        ArtifactQuality::Exact
    } else if edit.diff.is_some() || edit.old_content.is_some() || edit.new_content.is_some() {
        ArtifactQuality::PatchReversible
    } else if edit.lines_added.is_some() || edit.lines_removed.is_some() {
        ArtifactQuality::StatsOnly
    } else {
        ArtifactQuality::Inferred
    }
}

fn edit_kind(edit: &ExtractedEditData) -> SessionEditKind {
    if edit.is_deleted {
        return SessionEditKind::Delete;
    }
    if !edit.apply_patch_segments.is_empty() || edit.diff.is_some() {
        return SessionEditKind::Patch;
    }
    if edit.new_content.is_some() || edit.content.is_some() {
        return SessionEditKind::Write;
    }
    SessionEditKind::Unknown
}

fn to_u32(value: Option<usize>) -> Option<u32> {
    value.and_then(|value| u32::try_from(value).ok())
}

fn changed_end_line(
    old_start_line: Option<u32>,
    new_start_line: Option<u32>,
    lines_added: i32,
    lines_removed: i32,
) -> Option<u32> {
    let start_line = old_start_line.or(new_start_line)?;
    let changed_lines = lines_added.max(lines_removed).max(1) as u32;
    Some(start_line + changed_lines.saturating_sub(1))
}
