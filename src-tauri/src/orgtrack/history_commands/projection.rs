use super::*;

pub(super) fn open_cache_conn() -> Result<database::db::PooledConnection, String> {
    get_connection().map_err(|err| format!("Failed to open orgtrack source cache DB: {err}"))
}

pub(super) const IMPORTED_TURN_PROJECTION_CACHE_CAPACITY: usize = 8;
pub(super) const IMPORTED_TURN_PROJECTION_LIMIT_PER_SESSION: usize = 4_096;
pub(super) const CODEX_INITIAL_RECENT_TURN_COUNT: usize = 1;
pub(super) const IMPORTED_INITIAL_RECENT_TURN_COUNT: usize = 1;
pub(super) const IMPORTED_CLOUD_TURN_WINDOW_LIMIT: usize = 50;

/// Fidelity of a projection entering the cache. Window pre-warms are built
/// without parsing every round body (empty `modified_files`, fabricated
/// statuses, placeholder counts) — `Reduced`. Projections computed from the
/// complete chunk stream are `Full`. The ordering matters: a `Reduced`
/// pre-warm must never replace a `Full` entry, and readers that need full
/// fidelity treat `Reduced` hits as misses — otherwise per-round metadata
/// quality would depend on whether the replay opened before or after the
/// metadata index was read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum ProjectionQuality {
    Reduced,
    Full,
}

#[derive(Debug)]
pub(super) struct ImportedTurnProjectionCacheEntry {
    session_id: String,
    signature: (i64, u64),
    quality: ProjectionQuality,
    projected: Vec<orgtrack_core::projectors::turn_metadata::ProjectedTurnMetadata>,
}

#[derive(Debug, Default)]
pub(super) struct ImportedTurnProjectionCache {
    pub(super) entries: VecDeque<ImportedTurnProjectionCacheEntry>,
}

impl ImportedTurnProjectionCache {
    pub(super) fn get(
        &mut self,
        session_id: &str,
        signature: (i64, u64),
        min_quality: ProjectionQuality,
    ) -> Option<Vec<orgtrack_core::projectors::turn_metadata::ProjectedTurnMetadata>> {
        let index = self
            .entries
            .iter()
            .position(|entry| entry.session_id == session_id)?;
        let entry = self.entries.remove(index)?;
        if entry.signature != signature {
            // A stale caller must miss without evicting the newer projection
            // that another reader already cached for this session.
            self.entries.push_back(entry);
            return None;
        }
        if entry.quality < min_quality {
            // Keep the entry (a lower-fidelity reader may still use it); the
            // caller recomputes at full fidelity and its insert upgrades us.
            self.entries.push_back(entry);
            return None;
        }
        let projected = entry.projected.clone();
        self.entries.push_back(entry);
        Some(projected)
    }

    pub(super) fn insert(
        &mut self,
        session_id: String,
        signature: (i64, u64),
        quality: ProjectionQuality,
        projected: Vec<orgtrack_core::projectors::turn_metadata::ProjectedTurnMetadata>,
    ) {
        if let Some(index) = self
            .entries
            .iter()
            .position(|entry| entry.session_id == session_id)
        {
            let existing = &self.entries[index];
            if existing.signature == signature && existing.quality > quality {
                // Never downgrade: a Reduced window pre-warm must not
                // replace the Full projection for the same transcript state.
                let existing = self.entries.remove(index).expect("indexed entry");
                self.entries.push_back(existing);
                return;
            }
            self.entries.remove(index);
        }
        let projected = if projected.len() > IMPORTED_TURN_PROJECTION_LIMIT_PER_SESSION {
            projected
                .into_iter()
                .rev()
                .take(IMPORTED_TURN_PROJECTION_LIMIT_PER_SESSION)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect()
        } else {
            projected
        };
        self.entries.push_back(ImportedTurnProjectionCacheEntry {
            session_id,
            signature,
            quality,
            projected,
        });
        while self.entries.len() > IMPORTED_TURN_PROJECTION_CACHE_CAPACITY {
            self.entries.pop_front();
        }
    }
}

fn imported_turn_projection_cache() -> &'static Mutex<ImportedTurnProjectionCache> {
    static CACHE: OnceLock<Mutex<ImportedTurnProjectionCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(ImportedTurnProjectionCache::default()))
}

pub(super) fn imported_transcript_signature(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> Result<Option<(i64, u64)>, String> {
    let Some((source, cached)) =
        imported_history::cache::query_cached_session_by_session_id_including_superseded_from_conn(
            conn, session_id,
        )?
    else {
        return Ok(None);
    };
    imported_transcript_signature_for_cached(conn, &source, &cached, session_id)
}

pub(super) fn imported_transcript_signature_for_cached(
    conn: &rusqlite::Connection,
    source: &str,
    cached: &imported_history::cache::ImportedHistoryCachedSession,
    session_id: &str,
) -> Result<Option<(i64, u64)>, String> {
    match source {
        imported_history::metadata::SOURCE_CURSOR_IDE => {
            let composer_id = session_id
                .strip_prefix(orgtrack_core::sources::cursor_ide::CURSORIDE_SESSION_PREFIX)
                .unwrap_or(session_id);
            Ok(
                cursor_disk_reads::cursor_composer_last_updated_at(composer_id)?
                    .map(|updated_at| (updated_at, 0)),
            )
        }
        imported_history::metadata::SOURCE_OPENCODE
        | imported_history::metadata::SOURCE_ZCODE
        | imported_history::metadata::SOURCE_MIMO_CODE => {
            imported_history::paths::sqlite_session_activity_signature(
                Path::new(&cached.source_path),
                &cached.source_record_key,
                source,
            )
            // Provider schema drift must not turn a cheap freshness probe into
            // a permanent error/reload loop. The file signature is broader
            // (unrelated sessions can invalidate it) but remains correct.
            .or_else(|_| {
                imported_history::cache::stat_imported_transcript_by_session_id_from_conn(
                    conn, source, session_id,
                )
            })
        }
        imported_history::metadata::SOURCE_WINDSURF => {
            windsurf_history::windsurf_session_activity_signature(
                Path::new(&cached.source_path),
                &cached.source_record_key,
            )
            .or_else(|_| {
                imported_history::cache::stat_imported_transcript_by_session_id_from_conn(
                    conn, source, session_id,
                )
            })
        }
        _ => imported_history::cache::stat_imported_transcript_by_session_id_from_conn(
            conn, source, session_id,
        ),
    }
}

pub(super) fn remember_imported_turn_projection(
    session_id: &str,
    signature_before: Option<(i64, u64)>,
    signature_after: Option<(i64, u64)>,
    quality: ProjectionQuality,
    projected: Vec<orgtrack_core::projectors::turn_metadata::ProjectedTurnMetadata>,
) {
    let (Some(before), Some(after)) = (signature_before, signature_after) else {
        return;
    };
    // Do not cache a parse that raced a transcript append. The next read will
    // parse the now-stable file instead of treating an incomplete projection
    // as current.
    if before != after {
        return;
    }
    imported_turn_projection_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(session_id.to_string(), after, quality, projected);
}

fn load_projected_turn_metadata(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> Result<Option<Vec<orgtrack_core::projectors::turn_metadata::ProjectedTurnMetadata>>, String> {
    // Claude's index pass deliberately projects user rows only (no full-body
    // parse), so Reduced is its native fidelity; every other source computes
    // from the complete chunk stream and must not serve a window pre-warm.
    let is_claude_code =
        session_id.starts_with(orgtrack_core::sources::claude_code::SESSION_PREFIX);
    let required_quality = if is_claude_code {
        ProjectionQuality::Reduced
    } else {
        ProjectionQuality::Full
    };
    let signature_before = imported_transcript_signature(conn, session_id)?;
    if let Some(signature) = signature_before {
        if let Some(projected) = imported_turn_projection_cache()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(session_id, signature, required_quality)
        {
            return Ok(Some(projected));
        }
    }

    if is_claude_code {
        let projected =
            claude_code_history::load_claude_code_turn_index_for_session(conn, session_id)?;
        let signature_after = imported_transcript_signature(conn, session_id)?;
        remember_imported_turn_projection(
            session_id,
            signature_before,
            signature_after,
            ProjectionQuality::Reduced,
            projected.clone(),
        );
        return Ok(Some(projected));
    }

    let Some(chunks) = imported_history::load_activity_chunks_for_session(conn, session_id)? else {
        return Ok(None);
    };
    let projected = orgtrack_core::projectors::turn_metadata::project_activity_chunks(&chunks);
    let signature_after = imported_transcript_signature(conn, session_id)?;
    remember_imported_turn_projection(
        session_id,
        signature_before,
        signature_after,
        ProjectionQuality::Full,
        projected.clone(),
    );
    Ok(Some(projected))
}

pub(super) fn projected_rounds_to_cached_turns(
    session_id: &str,
    projected: Vec<orgtrack_core::projectors::turn_metadata::ProjectedTurnMetadata>,
) -> Vec<CachedTurnSummary> {
    let turn_boundaries = projected
        .iter()
        .map(|round| (round.turn_id.clone(), round.start_sequence))
        .collect::<Vec<_>>();
    projected
        .into_iter()
        .enumerate()
        .map(|(index, round)| {
            let duration_ms =
                projected_round_duration_ms(&round.started_at, round.ended_at.as_deref());
            CachedTurnSummary {
                session_id: session_id.to_string(),
                turn_id: round.turn_id.clone(),
                start_sequence: round.start_sequence,
                end_sequence: turn_boundaries
                    .get(index + 1)
                    .map(|(_, sequence)| *sequence),
                next_turn_id: turn_boundaries
                    .get(index + 1)
                    .map(|(turn_id, _)| turn_id.clone()),
                started_at: round.started_at,
                ended_at: round.ended_at,
                duration_ms,
                user_event_ids: vec![round.turn_id],
                user_preview: round.user_preview,
                event_count: round.event_count,
                body_event_count: round.body_event_count,
                interrupted: round.status == "interrupted",
                status: round.status,
                modified_files: round.modified_files,
                resource_interactions: round.resource_interactions,
                git_artifacts: round.git_artifacts,
            }
        })
        .collect()
}

fn projected_round_duration_ms(started_at: &str, ended_at: Option<&str>) -> Option<i64> {
    let started_at = chrono::DateTime::parse_from_rfc3339(started_at).ok()?;
    let ended_at = chrono::DateTime::parse_from_rfc3339(ended_at?).ok()?;
    Some(
        ended_at
            .signed_duration_since(started_at)
            .num_milliseconds()
            .max(0),
    )
}

pub(super) fn cursor_turns_to_projected(
    turns: &[cursor_db_history::CursorIdeTurnSummary],
) -> Vec<orgtrack_core::projectors::turn_metadata::ProjectedTurnMetadata> {
    turns
        .iter()
        .map(
            |turn| orgtrack_core::projectors::turn_metadata::ProjectedTurnMetadata {
                turn_id: turn.turn_id.clone(),
                start_sequence: turn.turn_index as i64,
                started_at: turn.started_at.clone(),
                ended_at: turn.ended_at.clone(),
                status: "completed".to_string(),
                user_preview: turn.user_preview.clone(),
                event_count: turn.event_count as i64,
                body_event_count: turn.body_event_count as i64,
                modified_files: Vec::new(),
                resource_interactions: Vec::new(),
                git_artifacts: Vec::new(),
            },
        )
        .collect()
}

/// Unified per-round metadata read surface. Native/managed sessions use the
/// versioned local turn cache; read-only imported sessions are projected
/// directly from their existing provider loader and never copied into
/// `sessions.db.events`.
#[tauri::command]
pub async fn orgtrack_session_turn_metadata_index(
    session_id: String,
    turn_ids: Option<Vec<String>>,
) -> Result<Vec<CachedTurnSummary>, String> {
    tokio::task::spawn_blocking(move || {
        if turn_ids
            .as_ref()
            .is_some_and(|turn_ids| turn_ids.len() > 500)
        {
            return Err("At most 500 turn summaries can be loaded at once".to_string());
        }
        let conn = open_cache_conn()?;
        // Managed native-transcript sessions project from the CLI's own
        // store: remap the managed id to its imported transcript id first.
        let transcript_session_id =
            crate::agent_sessions::cli::native_transcript::imported_transcript_id_for_managed_session(
                &session_id,
            )
            .unwrap_or_else(|| session_id.clone());
        if let Some(projected) = load_projected_turn_metadata(&conn, &transcript_session_id)? {
            let mut turns = projected_rounds_to_cached_turns(&session_id, projected);
            if let Some(turn_ids) = turn_ids.as_ref() {
                let requested = turn_ids.iter().collect::<std::collections::HashSet<_>>();
                turns.retain(|turn| requested.contains(&turn.turn_id));
            }
            return Ok(turns);
        }
        if let Some(turn_ids) = turn_ids.as_ref() {
            return session_persistence::load_turn_summaries(&session_id, turn_ids)
                .map_err(|err| err.to_string());
        }
        session_persistence::load_turn_index(&session_id).map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}
