//! Byte-bounded, rebuildable cache eviction for imported replay indexes.
//!
//! The provider transcript is never touched here. Every deletion is scoped to
//! the caller's ORGII-owned SQLite connection, which naturally isolates
//! separate homes/runtimes and lets the next bounded replay rebuild the index.

use std::collections::BTreeMap;
use std::time::Duration;

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};

pub const DEFAULT_REPLAY_CACHE_MAX_BYTES: u64 = 512 * 1024 * 1024;
pub const DEFAULT_REPLAY_CACHE_TARGET_BYTES: u64 = 384 * 1024 * 1024;
pub const DEFAULT_REPLAY_CACHE_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
pub const DEFAULT_REPLAY_CACHE_PROTECT_RECENT: Duration = Duration::from_secs(3 * 60);

const APPROX_ROW_OVERHEAD_BYTES: i64 = 32;
const MAX_EVICTION_SCOPES_PER_RUN: usize = 8;
const MAX_EVICTION_BYTES_PER_RUN: u64 = 128 * 1024 * 1024;

#[derive(Clone, Copy)]
enum ReplayCacheTableKind {
    SourceScoped,
    ShellManifest,
}

struct ReplayCacheTable {
    name: &'static str,
    kind: ReplayCacheTableKind,
}

const REPLAY_CACHE_TABLES: &[ReplayCacheTable] = &[
    ReplayCacheTable {
        name: "imported_replay_catalog_derivations",
        kind: ReplayCacheTableKind::SourceScoped,
    },
    ReplayCacheTable {
        name: "imported_replay_payload_artifact_refs",
        kind: ReplayCacheTableKind::SourceScoped,
    },
    ReplayCacheTable {
        name: "imported_replay_payload_artifacts",
        kind: ReplayCacheTableKind::SourceScoped,
    },
    ReplayCacheTable {
        name: "imported_replay_changes",
        kind: ReplayCacheTableKind::SourceScoped,
    },
    ReplayCacheTable {
        name: "imported_replay_structured_events",
        kind: ReplayCacheTableKind::SourceScoped,
    },
    ReplayCacheTable {
        name: "imported_replay_structured_rows",
        kind: ReplayCacheTableKind::SourceScoped,
    },
    ReplayCacheTable {
        name: "imported_replay_source_rows",
        kind: ReplayCacheTableKind::SourceScoped,
    },
    ReplayCacheTable {
        name: "imported_replay_events",
        kind: ReplayCacheTableKind::SourceScoped,
    },
    ReplayCacheTable {
        name: "imported_replay_turns",
        kind: ReplayCacheTableKind::SourceScoped,
    },
    ReplayCacheTable {
        name: "imported_replay_rejected_snapshots",
        kind: ReplayCacheTableKind::SourceScoped,
    },
    ReplayCacheTable {
        name: "imported_replay_shell_manifests",
        kind: ReplayCacheTableKind::ShellManifest,
    },
    ReplayCacheTable {
        name: "imported_replay_shell_segments",
        kind: ReplayCacheTableKind::SourceScoped,
    },
    ReplayCacheTable {
        name: "imported_replay_state",
        kind: ReplayCacheTableKind::SourceScoped,
    },
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReplayCachePolicy {
    pub max_bytes: u64,
    pub target_bytes: u64,
    pub ttl: Duration,
    pub protect_recent: Duration,
}

impl Default for ReplayCachePolicy {
    fn default() -> Self {
        Self {
            max_bytes: DEFAULT_REPLAY_CACHE_MAX_BYTES,
            target_bytes: DEFAULT_REPLAY_CACHE_TARGET_BYTES,
            ttl: DEFAULT_REPLAY_CACHE_TTL,
            protect_recent: DEFAULT_REPLAY_CACHE_PROTECT_RECENT,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReplayCacheEvictionReason {
    Ttl,
    ByteBudget,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReplayCacheEviction {
    pub source_id: String,
    pub source_session_id: String,
    pub last_accessed_at: String,
    pub approx_bytes: u64,
    pub reason: ReplayCacheEvictionReason,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReplayCachePruneReport {
    pub before_bytes: u64,
    pub after_bytes: u64,
    pub evicted_bytes: u64,
    pub evicted_entries: u64,
    pub ttl_evictions: u64,
    pub budget_evictions: u64,
    pub protected_entries: u64,
    pub over_budget: bool,
    pub evictions: Vec<ReplayCacheEviction>,
}

#[derive(Debug, Clone)]
struct CacheEntry {
    source: String,
    source_session_id: String,
    last_accessed_at: String,
    last_accessed_ms: i64,
    approx_bytes: u64,
    protected: bool,
}

#[derive(Debug)]
struct CacheScopeMeasurement {
    last_accessed_at: String,
    last_accessed_ms: i64,
    approx_bytes: u64,
}

type CacheScopeMeasurements = BTreeMap<(String, String), CacheScopeMeasurement>;

fn record_scope_access(
    scopes: &mut CacheScopeMeasurements,
    source: String,
    source_session_id: String,
    timestamp: String,
) {
    let timestamp_ms = DateTime::parse_from_rfc3339(&timestamp)
        .map(|value| value.timestamp_millis())
        .unwrap_or(i64::MIN);
    scopes
        .entry((source, source_session_id))
        .and_modify(|current| {
            if timestamp_ms > current.last_accessed_ms {
                current.last_accessed_at.clone_from(&timestamp);
                current.last_accessed_ms = timestamp_ms;
            }
        })
        .or_insert(CacheScopeMeasurement {
            last_accessed_at: timestamp,
            last_accessed_ms: timestamp_ms,
            approx_bytes: 0,
        });
}

fn try_select_eviction_candidate(
    entries: &[CacheEntry],
    selected: &mut Vec<(usize, ReplayCacheEvictionReason)>,
    selected_flags: &mut [bool],
    selected_bytes: &mut u64,
    projected_bytes: &mut u64,
    index: usize,
    reason: ReplayCacheEvictionReason,
) -> bool {
    if selected.len() >= MAX_EVICTION_SCOPES_PER_RUN {
        return false;
    }
    let next_bytes = selected_bytes.saturating_add(entries[index].approx_bytes);
    // An oversized oldest scope is allowed by itself so repeated maintenance
    // can always make progress. Once a scope is selected we preserve LRU order
    // instead of skipping a large old scope in favour of newer small ones.
    if !selected.is_empty() && next_bytes > MAX_EVICTION_BYTES_PER_RUN {
        return false;
    }
    selected.push((index, reason));
    selected_flags[index] = true;
    *selected_bytes = next_bytes;
    *projected_bytes = projected_bytes.saturating_sub(entries[index].approx_bytes);
    true
}

fn select_eviction_candidates(
    entries: &[CacheEntry],
    policy: ReplayCachePolicy,
    ttl_ms: i64,
    ttl_cutoff: i64,
) -> Vec<(usize, ReplayCacheEvictionReason)> {
    let mut selected = Vec::new();
    let mut selected_flags = vec![false; entries.len()];
    let mut selected_bytes = 0_u64;
    let mut projected_bytes = entries.iter().fold(0_u64, |total, entry| {
        total.saturating_add(entry.approx_bytes)
    });

    for (index, entry) in entries.iter().enumerate() {
        let expired = ttl_ms == 0 || entry.last_accessed_ms <= ttl_cutoff;
        if !entry.protected
            && expired
            && !try_select_eviction_candidate(
                entries,
                &mut selected,
                &mut selected_flags,
                &mut selected_bytes,
                &mut projected_bytes,
                index,
                ReplayCacheEvictionReason::Ttl,
            )
        {
            return selected;
        }
    }

    let target_bytes = policy.target_bytes.min(policy.max_bytes);
    if projected_bytes > policy.max_bytes {
        for (index, entry) in entries.iter().enumerate() {
            if projected_bytes <= target_bytes {
                break;
            }
            if entry.protected || selected_flags[index] {
                continue;
            }
            if !try_select_eviction_candidate(
                entries,
                &mut selected,
                &mut selected_flags,
                &mut selected_bytes,
                &mut projected_bytes,
                index,
                ReplayCacheEvictionReason::ByteBudget,
            ) {
                break;
            }
        }
    }
    selected
}

/// Prune only the rebuildable replay cache stored in `conn`.
///
/// TTL eviction is applied first, then byte-budget LRU eviction when usage is
/// above `max_bytes`. Recently touched entries are never removed; if they are
/// the only remaining entries, the cache may temporarily stay over budget.
/// One maintenance call handles at most eight scopes and approximately 128
/// MiB, using one short transaction per scope; an oversized oldest scope is
/// allowed to run alone so later calls can still make progress.
pub fn prune_cache(
    conn: &mut Connection,
    policy: ReplayCachePolicy,
) -> Result<ReplayCachePruneReport, String> {
    prune_cache_at(conn, policy, Utc::now().timestamp_millis())
}

fn prune_cache_at(
    conn: &mut Connection,
    policy: ReplayCachePolicy,
    now_ms: i64,
) -> Result<ReplayCachePruneReport, String> {
    prune_cache_at_with_hook(conn, policy, now_ms, |_| Ok(()))
}

fn prune_cache_at_with_hook<F>(
    conn: &mut Connection,
    policy: ReplayCachePolicy,
    now_ms: i64,
    before_delete: F,
) -> Result<ReplayCachePruneReport, String>
where
    F: FnOnce(&Connection) -> Result<(), String>,
{
    prune_cache_at_with_hooks(conn, policy, now_ms, before_delete, |_| Ok(()))
}

fn prune_cache_at_with_hooks<F, G>(
    conn: &mut Connection,
    policy: ReplayCachePolicy,
    now_ms: i64,
    before_delete: F,
    mut after_scope_transaction: G,
) -> Result<ReplayCachePruneReport, String>
where
    F: FnOnce(&Connection) -> Result<(), String>,
    G: FnMut(usize) -> Result<(), String>,
{
    let protect_ms = duration_millis(policy.protect_recent);
    let ttl_ms = duration_millis(policy.ttl);
    let protect_cutoff = now_ms.saturating_sub(protect_ms);
    let ttl_cutoff = now_ms.saturating_sub(ttl_ms);
    // Expensive byte accounting stays outside the writer critical section.
    let mut entries = load_cache_entries(conn)?;
    for entry in &mut entries {
        entry.protected = protect_ms > 0 && entry.last_accessed_ms >= protect_cutoff;
    }
    entries.sort_by(|left, right| {
        left.last_accessed_ms
            .cmp(&right.last_accessed_ms)
            .then_with(|| left.source.cmp(&right.source))
            .then_with(|| left.source_session_id.cmp(&right.source_session_id))
    });

    let before_bytes = entries.iter().fold(0_u64, |total, entry| {
        total.saturating_add(entry.approx_bytes)
    });
    let selected = select_eviction_candidates(&entries, policy, ttl_ms, ttl_cutoff);

    let protected_entries = entries.iter().filter(|entry| entry.protected).count() as u64;
    let had_candidates = !selected.is_empty();
    let mut evictions = Vec::with_capacity(selected.len());
    if had_candidates {
        // Tests use this hook to model a real delivery touching a selected
        // manifest after the cold measurement but before the writer lock.
        before_delete(conn)?;
        for (scope_index, (index, reason)) in selected.into_iter().enumerate() {
            let entry = &entries[index];
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|err| format!("start replay cache prune transaction: {err}"))?;
            let eviction =
                match load_scope_last_access(&tx, &entry.source, &entry.source_session_id)? {
                    Some((_, current_access_ms)) => {
                        let entered_protection =
                            protect_ms > 0 && current_access_ms >= protect_cutoff;
                        if current_access_ms > entry.last_accessed_ms || entered_protection {
                            None
                        } else {
                            delete_replay_entry(&tx, &entry.source, &entry.source_session_id)?;
                            Some(ReplayCacheEviction {
                                source_id: entry.source.clone(),
                                source_session_id: entry.source_session_id.clone(),
                                last_accessed_at: entry.last_accessed_at.clone(),
                                approx_bytes: entry.approx_bytes,
                                reason,
                            })
                        }
                    }
                    None => None,
                };
            tx.commit()
                .map_err(|err| format!("commit replay cache prune transaction: {err}"))?;
            if let Some(eviction) = eviction {
                evictions.push(eviction);
            }
            // The test hook runs only after the transaction has committed, so
            // a peer writer succeeding here proves the RESERVED lock was
            // released between source/session scopes.
            after_scope_transaction(scope_index + 1)?;
        }
    }

    // Recount only after a prune attempt, and never while holding the writer
    // lock. With no candidates the original snapshot is already the report.
    let after_bytes = if had_candidates {
        total_cache_bytes(conn)?
    } else {
        before_bytes
    };
    let ttl_evictions = evictions
        .iter()
        .filter(|eviction| eviction.reason == ReplayCacheEvictionReason::Ttl)
        .count() as u64;
    let budget_evictions = evictions.len() as u64 - ttl_evictions;
    Ok(ReplayCachePruneReport {
        before_bytes,
        after_bytes,
        evicted_bytes: before_bytes.saturating_sub(after_bytes),
        evicted_entries: evictions.len() as u64,
        ttl_evictions,
        budget_evictions,
        protected_entries,
        over_budget: after_bytes > policy.max_bytes,
        evictions,
    })
}

fn duration_millis(duration: Duration) -> i64 {
    duration.as_millis().min(i64::MAX as u128) as i64
}

fn load_scope_last_access(
    conn: &Connection,
    source: &str,
    source_session_id: &str,
) -> Result<Option<(String, i64)>, String> {
    // This is the short revalidation path used while holding the writer lock.
    // Every branch is keyed by compact metadata; payload BLOBs are not opened.
    let mut statement = conn
        .prepare(
            "WITH access_watermarks(accessed_at) AS (
                 SELECT updated_at
                 FROM imported_replay_state
                 WHERE source=?1 AND source_session_id=?2
                 UNION ALL
                 SELECT rejected_at
                 FROM imported_replay_rejected_snapshots
                 WHERE source=?1 AND source_session_id=?2
                 UNION ALL
                 SELECT updated_at
                 FROM imported_replay_catalog_derivations
                 WHERE source=?1 AND source_session_id=?2
                 UNION ALL
                 SELECT manifest.accessed_at
                 FROM imported_replay_shell_segments AS segment
                 JOIN imported_replay_shell_manifests AS manifest
                   ON manifest.session_id=segment.session_id
                  AND manifest.call_id=segment.call_id
                 WHERE segment.source=?1 AND segment.source_session_id=?2
             )
             SELECT accessed_at
             FROM access_watermarks
             ORDER BY julianday(accessed_at) DESC, accessed_at DESC
             LIMIT 1",
        )
        .map_err(|err| format!("prepare replay cache access revalidation: {err}"))?;
    let mut rows = statement
        .query(params![source, source_session_id])
        .map_err(|err| format!("query replay cache access revalidation: {err}"))?;
    let latest = if let Some(row) = rows
        .next()
        .map_err(|err| format!("read replay cache access revalidation: {err}"))?
    {
        let timestamp = row.get::<_, String>(0).map_err(|err| err.to_string())?;
        let timestamp_ms = DateTime::parse_from_rfc3339(&timestamp)
            .map(|value| value.timestamp_millis())
            .unwrap_or(i64::MIN);
        Some((timestamp, timestamp_ms))
    } else {
        None
    };
    Ok(latest)
}

fn load_cache_entries(conn: &Connection) -> Result<Vec<CacheEntry>, String> {
    // A rejected first snapshot can exist before a valid replay state, and a
    // catalog derivation is a defensive third base watermark. Normal replay
    // rows are transactionally published with state, so scanning large
    // event/artifact tables just to rediscover those scopes would turn pruning
    // into another full-history hotspot. Shell-only scopes are joined from
    // their compact manifest/segment tables below.
    let mut scopes = CacheScopeMeasurements::new();
    for (table, timestamp_column) in [
        ("imported_replay_state", "updated_at"),
        ("imported_replay_rejected_snapshots", "rejected_at"),
        ("imported_replay_catalog_derivations", "updated_at"),
    ] {
        let mut statement = conn
            .prepare(&format!(
                "SELECT source,source_session_id,{timestamp_column} FROM {table}"
            ))
            .map_err(|err| format!("prepare replay cache timestamps from {table}: {err}"))?;
        let mut rows = statement
            .query([])
            .map_err(|err| format!("query replay cache timestamps from {table}: {err}"))?;
        while let Some(row) = rows
            .next()
            .map_err(|err| format!("read replay cache timestamp from {table}: {err}"))?
        {
            let source = row.get::<_, String>(0).map_err(|err| err.to_string())?;
            let source_session_id = row.get::<_, String>(1).map_err(|err| err.to_string())?;
            let timestamp = row.get::<_, String>(2).map_err(|err| err.to_string())?;
            record_scope_access(&mut scopes, source, source_session_id, timestamp);
        }
    }

    // Managed readerless/collaboration delivery can own canonical replay
    // payloads and Shell manifests without ever creating replay state. Discover
    // those scopes through the compact locator tables and their ORGII access
    // watermark. This query never visits the payload BLOB table.
    let mut statement = conn
        .prepare(
            "SELECT segment.source,segment.source_session_id,MAX(manifest.accessed_at)
             FROM imported_replay_shell_segments AS segment
             JOIN imported_replay_shell_manifests AS manifest
               ON manifest.session_id=segment.session_id
              AND manifest.call_id=segment.call_id
             GROUP BY segment.source,segment.source_session_id",
        )
        .map_err(|err| format!("prepare readerless Shell cache timestamps: {err}"))?;
    let mut rows = statement
        .query([])
        .map_err(|err| format!("query readerless Shell cache timestamps: {err}"))?;
    while let Some(row) = rows
        .next()
        .map_err(|err| format!("read readerless Shell cache timestamp: {err}"))?
    {
        let source = row.get::<_, String>(0).map_err(|err| err.to_string())?;
        let source_session_id = row.get::<_, String>(1).map_err(|err| err.to_string())?;
        let timestamp = row.get::<_, String>(2).map_err(|err| err.to_string())?;
        record_scope_access(&mut scopes, source, source_session_id, timestamp);
    }
    drop(rows);
    drop(statement);

    aggregate_cache_bytes(conn, &mut scopes)?;

    let mut entries = Vec::with_capacity(scopes.len());
    for ((source, source_session_id), measurement) in scopes {
        entries.push(CacheEntry {
            source,
            source_session_id,
            last_accessed_at: measurement.last_accessed_at,
            last_accessed_ms: measurement.last_accessed_ms,
            approx_bytes: measurement.approx_bytes,
            protected: false,
        });
    }
    Ok(entries)
}

fn total_cache_bytes(conn: &Connection) -> Result<u64, String> {
    load_cache_entries(conn).map(|entries| {
        entries.into_iter().fold(0_u64, |total, entry| {
            total.saturating_add(entry.approx_bytes)
        })
    })
}

struct ReplayCacheByteAggregation {
    table: &'static str,
    query: &'static str,
}

// Each table is aggregated once for every maintenance snapshot. Adding source
// scopes therefore changes result rows, not the number of SQL statements.
const REPLAY_CACHE_BYTE_AGGREGATIONS: &[ReplayCacheByteAggregation] = &[
    ReplayCacheByteAggregation {
        table: "imported_replay_state",
        query: "SELECT source,source_session_id,COALESCE(SUM(
                    ?1 + 56
                    + LENGTH(CAST(source AS BLOB))
                    + LENGTH(CAST(source_session_id AS BLOB))
                    + LENGTH(CAST(generation AS BLOB))
                    + LENGTH(CAST(source_identity AS BLOB))
                    + LENGTH(CAST(driver_cursor_json AS BLOB))
                    + LENGTH(CAST(updated_at AS BLOB))
                ),0)
                FROM imported_replay_state
                GROUP BY source,source_session_id",
    },
    ReplayCacheByteAggregation {
        table: "imported_replay_turns",
        query: "SELECT source,source_session_id,COALESCE(SUM(
                    ?1 + 32
                    + LENGTH(CAST(source AS BLOB))
                    + LENGTH(CAST(source_session_id AS BLOB))
                    + LENGTH(CAST(generation AS BLOB))
                    + LENGTH(CAST(turn_id AS BLOB))
                    + LENGTH(CAST(started_at AS BLOB))
                    + COALESCE(LENGTH(CAST(ended_at AS BLOB)),0)
                ),0)
                FROM imported_replay_turns
                GROUP BY source,source_session_id",
    },
    ReplayCacheByteAggregation {
        table: "imported_replay_events",
        query: "SELECT source,source_session_id,COALESCE(SUM(
                    ?1 + 56
                    + LENGTH(CAST(source AS BLOB))
                    + LENGTH(CAST(source_session_id AS BLOB))
                    + LENGTH(CAST(generation AS BLOB))
                    + LENGTH(CAST(event_id AS BLOB))
                    + LENGTH(CAST(action_type AS BLOB))
                    + LENGTH(CAST(function_name AS BLOB))
                    + LENGTH(CAST(created_at AS BLOB))
                    + LENGTH(CAST(args_preview_json AS BLOB))
                    + LENGTH(CAST(result_preview_json AS BLOB))
                    + COALESCE(LENGTH(CAST(thread_id AS BLOB)),0)
                    + COALESCE(LENGTH(CAST(process_id AS BLOB)),0)
                    + LENGTH(CAST(payloads_json AS BLOB))
                    + LENGTH(CAST(content_hash AS BLOB))
                ),0)
                FROM imported_replay_events
                GROUP BY source,source_session_id",
    },
    ReplayCacheByteAggregation {
        table: "imported_replay_source_rows",
        query: "SELECT source,source_session_id,COALESCE(SUM(
                    ?1 + 24
                    + LENGTH(CAST(source AS BLOB))
                    + LENGTH(CAST(source_session_id AS BLOB))
                    + LENGTH(CAST(generation AS BLOB))
                    + LENGTH(CAST(source_key AS BLOB))
                    + LENGTH(CAST(content_hash AS BLOB))
                    + COALESCE(LENGTH(CAST(event_id AS BLOB)),0)
                ),0)
                FROM imported_replay_source_rows
                GROUP BY source,source_session_id",
    },
    ReplayCacheByteAggregation {
        table: "imported_replay_structured_rows",
        query: "SELECT source,source_session_id,COALESCE(SUM(
                    ?1 + 8
                    + LENGTH(CAST(source AS BLOB))
                    + LENGTH(CAST(source_session_id AS BLOB))
                    + LENGTH(CAST(generation AS BLOB))
                    + LENGTH(CAST(source_key AS BLOB))
                    + LENGTH(CAST(content_hash AS BLOB))
                ),0)
                FROM imported_replay_structured_rows
                GROUP BY source,source_session_id",
    },
    ReplayCacheByteAggregation {
        table: "imported_replay_structured_events",
        query: "SELECT source,source_session_id,COALESCE(SUM(
                    ?1 + 8
                    + LENGTH(CAST(source AS BLOB))
                    + LENGTH(CAST(source_session_id AS BLOB))
                    + LENGTH(CAST(generation AS BLOB))
                    + LENGTH(CAST(source_key AS BLOB))
                    + LENGTH(CAST(local_key AS BLOB))
                    + LENGTH(CAST(event_id AS BLOB))
                ),0)
                FROM imported_replay_structured_events
                GROUP BY source,source_session_id",
    },
    ReplayCacheByteAggregation {
        table: "imported_replay_changes",
        query: "SELECT source,source_session_id,COALESCE(SUM(
                    ?1 + 16
                    + LENGTH(CAST(source AS BLOB))
                    + LENGTH(CAST(source_session_id AS BLOB))
                    + LENGTH(CAST(generation AS BLOB))
                    + LENGTH(CAST(event_id AS BLOB))
                    + LENGTH(CAST(change_kind AS BLOB))
                ),0)
                FROM imported_replay_changes
                GROUP BY source,source_session_id",
    },
    ReplayCacheByteAggregation {
        table: "imported_replay_payload_artifact_refs",
        query: "SELECT source,source_session_id,COALESCE(SUM(
                    ?1
                    + LENGTH(CAST(source AS BLOB))
                    + LENGTH(CAST(source_session_id AS BLOB))
                    + LENGTH(CAST(generation AS BLOB))
                    + LENGTH(CAST(event_id AS BLOB))
                    + LENGTH(CAST(field_path AS BLOB))
                    + LENGTH(CAST(content_hash AS BLOB))
                ),0)
                FROM imported_replay_payload_artifact_refs
                GROUP BY source,source_session_id",
    },
    ReplayCacheByteAggregation {
        table: "imported_replay_payload_artifacts",
        query: "SELECT source,source_session_id,COALESCE(SUM(
                    ?1
                    + LENGTH(CAST(source AS BLOB))
                    + LENGTH(CAST(source_session_id AS BLOB))
                    + LENGTH(CAST(generation AS BLOB))
                    + LENGTH(CAST(content_hash AS BLOB))
                    + LENGTH(payload)
                ),0)
                FROM imported_replay_payload_artifacts
                GROUP BY source,source_session_id",
    },
    ReplayCacheByteAggregation {
        table: "imported_replay_shell_manifests",
        // DISTINCT collapses all segment ordinals/generations that point at
        // one manifest key before the join. The manifest payload columns are
        // therefore counted once per replay scope and no artifact BLOB is
        // selected into Rust.
        query: "SELECT scope.source,scope.source_session_id,COALESCE(SUM(
                    ?1 + 24
                    + LENGTH(CAST(manifest.session_id AS BLOB))
                    + LENGTH(CAST(manifest.logical_call_id AS BLOB))
                    + LENGTH(CAST(manifest.call_id AS BLOB))
                    + LENGTH(CAST(manifest.identity_hash AS BLOB))
                    + LENGTH(CAST(manifest.terminal_preview AS BLOB))
                    + COALESCE(LENGTH(CAST(manifest.completed_at AS BLOB)),0)
                    + LENGTH(CAST(manifest.accessed_at AS BLOB))
                ),0)
                FROM (
                    SELECT DISTINCT source,source_session_id,session_id,call_id
                    FROM imported_replay_shell_segments
                ) AS scope
                JOIN imported_replay_shell_manifests AS manifest
                  ON manifest.session_id=scope.session_id
                 AND manifest.call_id=scope.call_id
                GROUP BY scope.source,scope.source_session_id",
    },
    ReplayCacheByteAggregation {
        table: "imported_replay_shell_segments",
        query: "SELECT source,source_session_id,COALESCE(SUM(
                    ?1 + 48
                    + LENGTH(CAST(session_id AS BLOB))
                    + LENGTH(CAST(call_id AS BLOB))
                    + LENGTH(CAST(stream AS BLOB))
                    + LENGTH(CAST(source AS BLOB))
                    + LENGTH(CAST(source_session_id AS BLOB))
                    + LENGTH(CAST(generation AS BLOB))
                    + LENGTH(CAST(content_hash AS BLOB))
                ),0)
                FROM imported_replay_shell_segments
                GROUP BY source,source_session_id",
    },
    ReplayCacheByteAggregation {
        table: "imported_replay_rejected_snapshots",
        query: "SELECT source,source_session_id,COALESCE(SUM(
                    ?1 + 24
                    + LENGTH(CAST(source AS BLOB))
                    + LENGTH(CAST(source_session_id AS BLOB))
                    + LENGTH(CAST(source_identity AS BLOB))
                    + LENGTH(CAST(sample_fingerprint AS BLOB))
                    + LENGTH(CAST(rejection_kind AS BLOB))
                    + LENGTH(CAST(rejected_at AS BLOB))
                ),0)
                FROM imported_replay_rejected_snapshots
                GROUP BY source,source_session_id",
    },
    ReplayCacheByteAggregation {
        table: "imported_replay_catalog_derivations",
        query: "SELECT source,source_session_id,COALESCE(SUM(
                    ?1
                    + LENGTH(CAST(source AS BLOB))
                    + LENGTH(CAST(source_session_id AS BLOB))
                    + LENGTH(CAST(baseline_json AS BLOB))
                    + LENGTH(CAST(applied_json AS BLOB))
                    + LENGTH(CAST(updated_at AS BLOB))
                ),0)
                FROM imported_replay_catalog_derivations
                GROUP BY source,source_session_id",
    },
];

#[cfg(test)]
std::thread_local! {
    static CACHE_BYTE_AGGREGATION_QUERY_COUNT: std::cell::Cell<usize> =
        const { std::cell::Cell::new(0) };
}

fn aggregate_cache_bytes(
    conn: &Connection,
    scopes: &mut CacheScopeMeasurements,
) -> Result<(), String> {
    // TEXT values are cast to BLOB before LENGTH so multibyte UTF-8 is counted
    // in bytes. Integer values contribute their stored-cell approximation,
    // never their numeric value (notably `indexed_size_bytes`, which describes
    // the provider file and must not inflate the ORGII cache measurement).
    for aggregation in REPLAY_CACHE_BYTE_AGGREGATIONS {
        #[cfg(test)]
        CACHE_BYTE_AGGREGATION_QUERY_COUNT.with(|count| count.set(count.get() + 1));
        let mut statement = conn
            .prepare(aggregation.query)
            .map_err(|err| format!("prepare replay cache {} bytes: {err}", aggregation.table))?;
        let mut rows = statement
            .query([APPROX_ROW_OVERHEAD_BYTES])
            .map_err(|err| format!("query replay cache {} bytes: {err}", aggregation.table))?;
        while let Some(row) = rows
            .next()
            .map_err(|err| format!("read replay cache {} bytes: {err}", aggregation.table))?
        {
            let source = row.get::<_, String>(0).map_err(|err| err.to_string())?;
            let source_session_id = row.get::<_, String>(1).map_err(|err| err.to_string())?;
            let bytes = row.get::<_, i64>(2).map_err(|err| err.to_string())?.max(0) as u64;
            // Preserve the prior orphan-row semantics: only state/rejection/
            // catalog watermarks and Shell locator scopes are eligible cache
            // entries. A stray payload row cannot invent an entry without a
            // reliable last-access timestamp.
            if let Some(scope) = scopes.get_mut(&(source, source_session_id)) {
                scope.approx_bytes = scope.approx_bytes.saturating_add(bytes);
            }
        }
    }
    Ok(())
}

fn delete_replay_entry(
    tx: &Transaction<'_>,
    source: &str,
    source_session_id: &str,
) -> Result<(), String> {
    // The Shell manifest key is renderer-session/call, while its segments own
    // the replay source scope. Remove matching manifests before their segment
    // locators disappear; FK cascade handles segments when enabled and the
    // source-scoped pass below is the deterministic fallback. Native `.slog`
    // rows/files are intentionally outside this replay cache policy.
    tx.execute(
        "DELETE FROM imported_replay_shell_manifests AS manifest
         WHERE EXISTS (
             SELECT 1 FROM imported_replay_shell_segments AS segment
             WHERE segment.session_id=manifest.session_id
               AND segment.call_id=manifest.call_id
               AND segment.source=?1
               AND segment.source_session_id=?2
         )",
        params![source, source_session_id],
    )
    .map_err(|err| format!("delete replay Shell manifests: {err}"))?;

    // Keep the discovery/path binding so the next bounded open can rebuild
    // directly from the provider-owned source. The catalog helper restores the
    // pre-replay baseline only when no newer adapter refresh superseded it.
    super::super::catalog::clear_replay_projection_tx(tx, source, source_session_id)?;

    for table in REPLAY_CACHE_TABLES
        .iter()
        .filter(|table| matches!(table.kind, ReplayCacheTableKind::SourceScoped))
    {
        tx.execute(
            &format!(
                "DELETE FROM {} WHERE source=?1 AND source_session_id=?2",
                table.name
            ),
            params![source, source_session_id],
        )
        .map_err(|err| format!("delete replay cache row from {}: {err}", table.name))?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "tests/cache_policy.rs"]
mod tests;
