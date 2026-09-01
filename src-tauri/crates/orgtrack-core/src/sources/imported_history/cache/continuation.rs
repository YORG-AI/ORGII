use std::collections::{HashMap, HashSet};

use rusqlite::Connection;

use super::lookup::query_cached_session_by_session_id_including_superseded_from_conn;
use super::session_row::ImportedHistoryCachedSession;

/**
 * Continuation-family status for one cached session id: its elected lineage
 * (when stamped) and whether a strictly newer continuation sibling exists.
 * `None` = the id is not in the imported cache at all — callers must treat
 * that as "unknown", never as superseded (a rebuilding cache reads absent).
 */
pub fn cached_session_continuation_status_from_conn(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<(Option<String>, bool)>, String> {
    let Some((source, session)) =
        query_cached_session_by_session_id_including_superseded_from_conn(conn, session_id)?
    else {
        return Ok(None);
    };
    let lineage = session
        .source_metadata_json
        .as_deref()
        .and_then(continuation_lineage_id_from_metadata_json);
    let superseded = has_newer_continuation_sibling(conn, &source, &session)?;
    Ok(Some((lineage, superseded)))
}

/// True when this top-level row belongs to a continuation family and a
/// strictly newer sibling exists, mirroring the demotion election's ordering
/// (`updated_at_ms`, then `source_session_id`) so exact-id resolution and the
/// paginated listing agree on which sibling represents the conversation.
/// Recomputed from content rather than read off `listable` so the answer
/// stays correct mid-sync (a freshly parsed loser is `listable = 1` until the
/// same sync's election runs) and never conflates managed-mirror hiding with
/// supersession.
pub(super) fn has_newer_continuation_sibling(
    conn: &Connection,
    source: &str,
    session: &ImportedHistoryCachedSession,
) -> Result<bool, String> {
    if session.parent_session_id.is_some() {
        return Ok(false);
    }
    let Some(metadata) = session
        .source_metadata_json
        .as_deref()
        .and_then(parse_continuation_metadata)
    else {
        return Ok(false);
    };
    // Normal post-sync lookups use the elected lineage id. The group-key
    // fallback preserves the pre-election/legacy behavior for rows written by
    // older parsers that have not yet been reindexed.
    let (field, family_key) = if let Some(lineage_id) = metadata.lineage_id {
        (CONTINUATION_LINEAGE_ID_FIELD, lineage_id)
    } else if let Some(group_key) = metadata.group_key {
        (CONTINUATION_GROUP_KEY_FIELD, group_key)
    } else {
        return Ok(false);
    };
    conn.query_row(
        &format!(
            "SELECT EXISTS(
                SELECT 1 FROM imported_history_session_cache
                WHERE source = ?1
                  AND source_session_id != ?2
                  AND COALESCE(parent_session_id, '') = ''
                  AND CASE WHEN json_valid(source_metadata_json)
                       THEN json_extract(source_metadata_json, '$.{field}')
                       END = ?3
                  AND (updated_at_ms > ?4
                       OR (updated_at_ms = ?4 AND source_session_id > ?2))
            )"
        ),
        rusqlite::params![
            source,
            session.source_session_id,
            family_key,
            session.updated_at_ms
        ],
        |row| Ok(row.get::<_, i64>(0)? != 0),
    )
    .map_err(|err| format!("Failed to query continuation siblings for {source}: {err}"))
}

/// `source_metadata_json` field naming the continuation-family group key.
///
/// Context-window continuations rewrite a conversation into a NEW session
/// file with no link field, so readers derive a family key from content that
/// the rewrite preserves (Claude: the first user message's uuid).
pub const CONTINUATION_GROUP_KEY_FIELD: &str = "continuationGroupKey";
/// Bounded ancestry markers preserved across Claude Code compact rewrites.
pub const CONTINUATION_MARKERS_FIELD: &str = "continuationMarkers";
/// Stable component id elected after every source sync.
pub const CONTINUATION_LINEAGE_ID_FIELD: &str = "continuationLineageId";
/// Hard cap for source-controlled marker arrays read from cache metadata.
pub const MAX_CONTINUATION_MARKERS: usize = 64;

#[derive(Debug, Clone)]
struct ContinuationMetadata {
    value: serde_json::Value,
    group_key: Option<String>,
    markers: Vec<String>,
    lineage_id: Option<String>,
}

fn metadata_string(value: Option<&serde_json::Value>) -> Option<String> {
    value
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn parse_continuation_metadata(metadata_json: &str) -> Option<ContinuationMetadata> {
    let value = serde_json::from_str::<serde_json::Value>(metadata_json).ok()?;
    if !value.is_object() {
        return None;
    }
    let group_key = metadata_string(value.get(CONTINUATION_GROUP_KEY_FIELD));
    let lineage_id = metadata_string(value.get(CONTINUATION_LINEAGE_ID_FIELD));
    let mut markers = Vec::with_capacity(MAX_CONTINUATION_MARKERS);
    let mut seen = HashSet::new();
    if let Some(group_key) = group_key.as_ref() {
        seen.insert(group_key.clone());
        markers.push(group_key.clone());
    }
    if let Some(values) = value
        .get(CONTINUATION_MARKERS_FIELD)
        .and_then(serde_json::Value::as_array)
    {
        for marker in values {
            if markers.len() >= MAX_CONTINUATION_MARKERS {
                break;
            }
            let Some(marker) = metadata_string(Some(marker)) else {
                continue;
            };
            if seen.insert(marker.clone()) {
                markers.push(marker);
            }
        }
    }
    if markers.is_empty() {
        return None;
    }
    Some(ContinuationMetadata {
        value,
        group_key,
        markers,
        lineage_id,
    })
}

pub fn continuation_lineage_id_from_metadata_json(metadata_json: &str) -> Option<String> {
    parse_continuation_metadata(metadata_json)?.lineage_id
}

/// Serialize the continuation group key into `source_metadata_json` shape.
pub fn continuation_group_metadata_json(group_key: Option<&str>) -> Option<String> {
    let group_key = group_key.map(str::trim).filter(|key| !key.is_empty())?;
    Some(serde_json::json!({ CONTINUATION_GROUP_KEY_FIELD: group_key }).to_string())
}

/// Serialize the legacy group key plus a bounded set of continuation ancestry
/// markers. The group key is always included as the first marker when present.
pub fn continuation_metadata_json(
    group_key: Option<&str>,
    ancestry_markers: &[String],
) -> Option<String> {
    let group_key = group_key
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(str::to_string);
    let mut markers = Vec::with_capacity(MAX_CONTINUATION_MARKERS);
    let mut seen = HashSet::new();
    if let Some(group_key) = group_key.as_ref() {
        seen.insert(group_key.clone());
        markers.push(group_key.clone());
    }
    for marker in ancestry_markers {
        if markers.len() >= MAX_CONTINUATION_MARKERS {
            break;
        }
        let marker = marker.trim();
        if !marker.is_empty() && seen.insert(marker.to_string()) {
            markers.push(marker.to_string());
        }
    }
    if markers.is_empty() {
        return None;
    }
    let mut value = serde_json::Map::new();
    if let Some(group_key) = group_key {
        value.insert(
            CONTINUATION_GROUP_KEY_FIELD.to_string(),
            serde_json::Value::String(group_key),
        );
    }
    value.insert(
        CONTINUATION_MARKERS_FIELD.to_string(),
        serde_json::Value::Array(markers.into_iter().map(serde_json::Value::String).collect()),
    );
    Some(serde_json::Value::Object(value).to_string())
}

/// Demote continuation-superseded sessions: within each group of top-level
/// sessions whose bounded ancestry markers form a connected component, only
/// the newest sibling (by
/// `updated_at_ms`, then `source_session_id`) stays listable; every other
/// currently-listable sibling flips to `listable = 0`.
///
/// Demote-only by design: winners are never promoted here, so a winner that
/// is unlistable for another reason (managed mirror, subagent) stays hidden.
/// Runs after every sync; if a demoted file later changes on disk its
/// re-parse resets `listable = 1` and the next election re-demotes it.
pub fn demote_superseded_continuations_from_conn(
    conn: &Connection,
    source: &str,
) -> Result<usize, String> {
    let mut stmt = conn
        .prepare(
            "SELECT source_session_id, source_metadata_json, created_at_ms, updated_at_ms, listable
             FROM imported_history_session_cache
             WHERE source = ?1
               AND COALESCE(parent_session_id, '') = ''
               AND COALESCE(source_metadata_json, '') != ''",
        )
        .map_err(|err| format!("Failed to prepare continuation election query: {err}"))?;
    let rows = stmt
        .query_map([source], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)? != 0,
            ))
        })
        .map_err(|err| format!("Failed to query continuation election rows: {err}"))?;

    struct ElectionRow {
        source_session_id: String,
        metadata: ContinuationMetadata,
        created_at_ms: i64,
        updated_at_ms: i64,
        listable: bool,
    }

    struct DisjointSet {
        parent: Vec<usize>,
    }

    impl DisjointSet {
        fn new(len: usize) -> Self {
            Self {
                parent: (0..len).collect(),
            }
        }

        fn find(&mut self, index: usize) -> usize {
            // Iterative with path compression: a pathological union order can
            // chain O(component) parents, and recursing that deep on the sync
            // thread is an avoidable stack risk.
            let mut root = index;
            while self.parent[root] != root {
                root = self.parent[root];
            }
            let mut current = index;
            while self.parent[current] != root {
                let next = self.parent[current];
                self.parent[current] = root;
                current = next;
            }
            root
        }

        fn union(&mut self, left: usize, right: usize) {
            let left_root = self.find(left);
            let right_root = self.find(right);
            if left_root != right_root {
                self.parent[right_root] = left_root;
            }
        }
    }

    let mut election_rows = Vec::new();
    for row in rows {
        let (source_session_id, metadata_json, created_at_ms, updated_at_ms, listable) =
            row.map_err(|err| format!("Failed to read continuation election row: {err}"))?;
        let Some(metadata) = parse_continuation_metadata(&metadata_json) else {
            continue;
        };
        election_rows.push(ElectionRow {
            source_session_id,
            metadata,
            created_at_ms,
            updated_at_ms,
            listable,
        });
    }

    let mut sets = DisjointSet::new(election_rows.len());
    let mut marker_owner: HashMap<String, usize> = HashMap::new();
    for (index, row) in election_rows.iter().enumerate() {
        // A stamped lineage id joins the connectivity keys alongside the raw
        // ancestry markers. Deleting an intermediate transcript can split a
        // family's marker graph into disconnected halves AFTER both halves
        // were stamped; without this key the election would list both halves'
        // winners (the duplicate row returns) while the exact-id lookup keeps
        // treating them as one family via the shared lineage. Lineage ids are
        // themselves member uuids (a canonical group key), so they share the
        // marker namespace without colliding across conversations.
        for marker in row
            .metadata
            .markers
            .iter()
            .chain(row.metadata.lineage_id.as_ref())
        {
            if let Some(owner) = marker_owner.get(marker).copied() {
                sets.union(index, owner);
            } else {
                marker_owner.insert(marker.clone(), index);
            }
        }
    }

    let mut families: HashMap<usize, Vec<usize>> = HashMap::new();
    for index in 0..election_rows.len() {
        families.entry(sets.find(index)).or_default().push(index);
    }

    let mut losers = Vec::new();
    let mut metadata_updates = Vec::new();
    for member_indices in families.values() {
        let winner_index = *member_indices
            .iter()
            .max_by_key(|index| {
                let row = &election_rows[**index];
                (row.updated_at_ms, row.source_session_id.as_str())
            })
            .expect("continuation family has at least one member");
        let canonical_index = *member_indices
            .iter()
            .min_by_key(|index| {
                let row = &election_rows[**index];
                (row.created_at_ms, row.source_session_id.as_str())
            })
            .expect("continuation family has at least one member");
        // Preserve an already-elected id when a new continuation joins the
        // component. That keeps a force-revealed row already held by the
        // frontend comparable with the newly elected roster winner. A parser
        // migration has no elected ids yet, so it falls back to one canonical
        // member and stamps the whole component once.
        let lineage_id = member_indices
            .iter()
            .filter_map(|index| election_rows[*index].metadata.lineage_id.as_ref())
            .min()
            .cloned()
            .or_else(|| election_rows[canonical_index].metadata.group_key.clone())
            .unwrap_or_else(|| election_rows[canonical_index].metadata.markers[0].clone());

        for index in member_indices {
            let row = &election_rows[*index];
            if row.listable && *index != winner_index {
                losers.push(row.source_session_id.clone());
            }
            if row.metadata.lineage_id.as_deref() != Some(lineage_id.as_str()) {
                let mut metadata = row.metadata.value.clone();
                if let Some(object) = metadata.as_object_mut() {
                    object.insert(
                        CONTINUATION_LINEAGE_ID_FIELD.to_string(),
                        serde_json::Value::String(lineage_id.clone()),
                    );
                    metadata_updates.push((row.source_session_id.clone(), metadata.to_string()));
                }
            }
        }
    }

    for (source_session_id, metadata_json) in metadata_updates {
        conn.execute(
            "UPDATE imported_history_session_cache
             SET source_metadata_json = ?3
             WHERE source = ?1 AND source_session_id = ?2",
            rusqlite::params![source, source_session_id, metadata_json],
        )
        .map_err(|err| format!("Failed to stamp continuation lineage: {err}"))?;
    }
    for source_session_id in &losers {
        conn.execute(
            "UPDATE imported_history_session_cache
             SET listable = 0
             WHERE source = ?1 AND source_session_id = ?2",
            rusqlite::params![source, source_session_id],
        )
        .map_err(|err| format!("Failed to demote superseded continuation: {err}"))?;
    }
    Ok(losers.len())
}
