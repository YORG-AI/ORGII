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
mod tests {
    use std::path::Path;

    use rusqlite::Connection;
    use serde_json::json;

    use super::*;
    use crate::sources::imported_history::replay::{
        open_window, ImportedHistorySourceId, ReplayLimits,
    };
    use crate::store::sqlite::SqliteRecordStore;

    fn cache() -> Connection {
        let conn = Connection::open_in_memory().expect("replay cache");
        SqliteRecordStore::init_tables(&conn).expect("core schema");
        SqliteRecordStore::init_source_cache_tables(&conn).expect("replay schema");
        conn
    }

    fn cache_at(path: &Path) -> Connection {
        let conn = Connection::open(path).expect("file-backed replay cache");
        SqliteRecordStore::init_tables(&conn).expect("core schema");
        SqliteRecordStore::init_source_cache_tables(&conn).expect("replay schema");
        conn
    }

    fn iso(ms: i64) -> String {
        DateTime::from_timestamp_millis(ms)
            .expect("test timestamp")
            .to_rfc3339()
    }

    fn bind_catalog(
        conn: &Connection,
        source: &str,
        source_session_id: &str,
        session_id: &str,
        path: &str,
    ) {
        conn.execute(
            "INSERT INTO imported_history_session_cache(
                 source,source_session_id,session_id,source_path,source_record_key,
                 source_mtime_ms,source_size_bytes,source_fingerprint,parser_version,
                 name,created_at_ms,updated_at_ms,model,input_tokens,output_tokens,
                 cache_read_tokens,cache_write_tokens,repo_path,branch,files_changed,
                 lines_added,lines_removed,touched_files_json,listable,
                 source_metadata_json,parent_session_id,updated_at
             ) VALUES(?1,?2,?3,?4,?2,123,456,'provider-fingerprint',1,
                      'replay title',111,222,'model',10,20,3,4,'/repo','branch',1,
                      2,3,'[\"src/lib.rs\"]',1,'{\"continuationGroupKey\":\"g\"}',
                      'parent',?5)",
            params![
                source,
                source_session_id,
                session_id,
                path,
                Utc::now().to_rfc3339()
            ],
        )
        .expect("catalog binding");
    }

    fn seed_entry(
        conn: &mut Connection,
        source: &str,
        source_session_id: &str,
        updated_at_ms: i64,
        payload_bytes: usize,
        provider_size: i64,
    ) {
        let session_id = format!("{source}-{source_session_id}");
        bind_catalog(
            conn,
            source,
            source_session_id,
            &session_id,
            "/provider/truth",
        );
        let generation = format!("generation-{source_session_id}");
        conn.execute(
            "INSERT INTO imported_replay_state(
                 source,source_session_id,generation,revision,parser_version,
                 source_identity,driver_cursor_json,indexed_size_bytes,indexed_mtime_ns,
                 total_events,total_turns,valid,updated_at
             ) VALUES(?1,?2,?3,1,1,'identity','{\"cursor\":1}',?4,10,1,1,1,?5)",
            params![
                source,
                source_session_id,
                generation,
                provider_size,
                iso(updated_at_ms)
            ],
        )
        .expect("replay state");
        conn.execute(
            "INSERT INTO imported_replay_turns(
                 source,source_session_id,generation,turn_index,turn_id,
                 start_sequence,end_sequence,started_at,ended_at,event_count
             ) VALUES(?1,?2,?3,0,'turn',0,0,'start','end',1)",
            params![source, source_session_id, generation],
        )
        .expect("replay turn");
        conn.execute(
            "INSERT INTO imported_replay_events(
                 source,source_session_id,generation,sequence,event_id,turn_index,
                 action_type,function_name,created_at,args_preview_json,result_preview_json,
                 args_size_bytes,result_size_bytes,source_start,source_end,payloads_json,
                 content_hash,event_revision
             ) VALUES(?1,?2,?3,0,'event',0,'tool_call','Shell','now',
                      '{\"command\":\"echo\"}','{\"output\":\"preview\"}',10,20,0,10,
                      '[{\"fieldPath\":\"result.output\"}]','hash',1)",
            params![source, source_session_id, generation],
        )
        .expect("replay event");
        conn.execute(
            "INSERT INTO imported_replay_source_rows(
                 source,source_session_id,generation,source_key,content_hash,
                 event_id,sequence,source_order,seen_revision
             ) VALUES(?1,?2,?3,'source-key','hash','event',0,0,1)",
            params![source, source_session_id, generation],
        )
        .expect("replay source row");
        conn.execute(
            "INSERT INTO imported_replay_structured_rows(
                 source,source_session_id,generation,source_key,content_hash,seen_revision
             ) VALUES(?1,?2,?3,'structured-key','hash',1)",
            params![source, source_session_id, generation],
        )
        .expect("structured row");
        conn.execute(
            "INSERT INTO imported_replay_structured_events(
                 source,source_session_id,generation,source_key,local_key,event_id,sequence
             ) VALUES(?1,?2,?3,'structured-key','local','event',0)",
            params![source, source_session_id, generation],
        )
        .expect("structured event");
        conn.execute(
            "INSERT INTO imported_replay_changes(
                 source,source_session_id,generation,change_revision,event_id,change_kind,sequence
             ) VALUES(?1,?2,?3,1,'event','upsert',0)",
            params![source, source_session_id, generation],
        )
        .expect("replay change");
        conn.execute(
            "INSERT INTO imported_replay_payload_artifacts(
                 source,source_session_id,generation,content_hash,payload
             ) VALUES(?1,?2,?3,'hash',?4)",
            params![
                source,
                source_session_id,
                generation,
                vec![b'x'; payload_bytes]
            ],
        )
        .expect("payload artifact");
        conn.execute(
            "INSERT INTO imported_replay_payload_artifact_refs(
                 source,source_session_id,generation,event_id,field_path,content_hash
             ) VALUES(?1,?2,?3,'event','result.output','hash')",
            params![source, source_session_id, generation],
        )
        .expect("payload artifact ref");
        conn.execute(
            "INSERT INTO imported_replay_shell_manifests(
                 session_id,logical_call_id,call_id,identity_hash,total_bytes,
                 last_sequence,terminal_preview,completed_at,accessed_at
             ) VALUES(?1,'logical-shell','shell-call','identity',?2,0,
                      'preview','now',?3)",
            params![session_id, provider_size, iso(updated_at_ms)],
        )
        .expect("replay Shell manifest");
        conn.execute(
            "INSERT INTO imported_replay_shell_segments(
                 session_id,call_id,ordinal,stream,source,source_session_id,
                 generation,content_hash,output_byte_start,total_bytes,
                 first_sequence,frame_count
             ) VALUES(?1,'shell-call',0,'stdout',?2,?3,?4,'hash',0,?5,0,1)",
            params![
                session_id,
                source,
                source_session_id,
                generation,
                provider_size
            ],
        )
        .expect("replay Shell segment");
        conn.execute(
            "INSERT INTO imported_replay_rejected_snapshots(
                 source,source_session_id,parser_version,source_identity,
                 source_size_bytes,source_mtime_ns,sample_fingerprint,
                 rejection_kind,rejected_at
             ) VALUES(?1,?2,1,'identity',99,100,'sample','test',?3)",
            params![source, source_session_id, iso(updated_at_ms)],
        )
        .expect("rejected watermark");

        // Replay overlays only its compact projection onto the mixed-ownership
        // catalog row. Prune must later restore this adapter-owned baseline.
        let cursor = json!({
            "catalog": {
                "model": "replay-model",
                "inputTokens": 100,
                "outputTokens": 20,
                "tokensObserved": true,
                "continuationGroupKey": "replay-group",
                "continuationObserved": true
            }
        })
        .to_string();
        let tx = conn.transaction().expect("catalog projection transaction");
        crate::sources::imported_history::catalog::publish_from_replay_tx(
            &tx,
            ImportedHistorySourceId::parse(source).expect("registered replay source"),
            source_session_id,
            &generation,
            1,
            true,
            10_000_000,
            &cursor,
        )
        .expect("publish replay catalog projection");
        tx.commit().expect("commit replay catalog projection");
    }

    fn seed_shell_only_scope(
        conn: &Connection,
        source_session_id: &str,
        accessed_at_ms: i64,
        payload_bytes: usize,
    ) {
        let source = "managed_readerless";
        let session_id = format!("managed-{source_session_id}");
        let call_id = format!("call-{source_session_id}");
        let generation = format!("generation-{source_session_id}");
        let content_hash = format!("hash-{source_session_id}");
        conn.execute(
            "INSERT INTO imported_replay_payload_artifacts(
                 source,source_session_id,generation,content_hash,payload
             ) VALUES(?1,?2,?3,?4,?5)",
            params![
                source,
                source_session_id,
                generation,
                content_hash,
                vec![b'x'; payload_bytes]
            ],
        )
        .expect("readerless payload artifact");
        conn.execute(
            "INSERT INTO imported_replay_shell_manifests(
                 session_id,logical_call_id,call_id,identity_hash,total_bytes,
                 last_sequence,terminal_preview,completed_at,accessed_at
             ) VALUES(?1,?2,?3,'identity',?4,1,'preview',
                      '2000-01-01T00:00:00Z',?5)",
            params![
                session_id,
                format!("logical-{source_session_id}"),
                call_id,
                payload_bytes as i64,
                iso(accessed_at_ms)
            ],
        )
        .expect("readerless Shell manifest");
        conn.execute(
            "INSERT INTO imported_replay_shell_segments(
                 session_id,call_id,ordinal,stream,source,source_session_id,
                 generation,content_hash,output_byte_start,total_bytes,
                 first_sequence,frame_count
             ) VALUES(?1,?2,0,'stdout',?3,?4,?5,?6,0,?7,1,1)",
            params![
                session_id,
                call_id,
                source,
                source_session_id,
                generation,
                content_hash,
                payload_bytes as i64
            ],
        )
        .expect("readerless Shell segment");
    }

    fn count(conn: &Connection, table: &str, source_session_id: &str) -> i64 {
        conn.query_row(
            &format!("SELECT COUNT(*) FROM {table} WHERE source_session_id=?1"),
            [source_session_id],
            |row| row.get(0),
        )
        .expect("count replay rows")
    }

    fn no_protection_policy(max_bytes: u64, target_bytes: u64) -> ReplayCachePolicy {
        ReplayCachePolicy {
            max_bytes,
            target_bytes,
            ttl: Duration::from_secs(365 * 24 * 60 * 60),
            protect_recent: Duration::ZERO,
        }
    }

    fn candidate_entry(source_session_id: &str, last_accessed_ms: i64, bytes: u64) -> CacheEntry {
        CacheEntry {
            source: "cline".to_string(),
            source_session_id: source_session_id.to_string(),
            last_accessed_at: iso(last_accessed_ms),
            last_accessed_ms,
            approx_bytes: bytes,
            protected: false,
        }
    }

    #[test]
    fn cache_table_registry_is_exhaustive() {
        let conn = cache();
        let mut statement = conn
            .prepare(
                "SELECT name FROM sqlite_master
                 WHERE type='table' AND name LIKE 'imported_replay_%'
                 ORDER BY name",
            )
            .expect("prepare replay cache table registry");
        let mut actual = statement
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query replay cache table registry")
            .collect::<Result<Vec<_>, _>>()
            .expect("read replay cache table registry");
        let mut expected = REPLAY_CACHE_TABLES
            .iter()
            .map(|table| table.name.to_string())
            .collect::<Vec<_>>();
        actual.sort();
        expected.sort();
        assert_eq!(actual, expected, "new replay tables need prune coverage");

        let mut accounted = REPLAY_CACHE_BYTE_AGGREGATIONS
            .iter()
            .map(|aggregation| aggregation.table.to_string())
            .collect::<Vec<_>>();
        accounted.sort();
        assert_eq!(
            actual, accounted,
            "new replay tables need set-based byte accounting"
        );
    }

    #[test]
    fn maintenance_selection_is_bounded_by_scope_count_and_approximate_bytes() {
        let now = 1_800_000_000_000_i64;
        let ten_small = (0..10)
            .map(|index| candidate_entry(&format!("scope-{index}"), now + index, 1024))
            .collect::<Vec<_>>();
        let selected = select_eviction_candidates(&ten_small, no_protection_policy(0, 0), 0, now);
        assert_eq!(selected.len(), MAX_EVICTION_SCOPES_PER_RUN);

        let seventy_mib = 70 * 1024 * 1024;
        let two_large = vec![
            candidate_entry("oldest", now, seventy_mib),
            candidate_entry("newer", now + 1, seventy_mib),
        ];
        let selected = select_eviction_candidates(&two_large, no_protection_policy(0, 0), 0, now);
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].0, 0);

        let oversized = vec![
            candidate_entry("oversized", now, MAX_EVICTION_BYTES_PER_RUN + 1),
            candidate_entry("later", now + 1, 1),
        ];
        let selected = select_eviction_candidates(&oversized, no_protection_policy(0, 0), 0, now);
        assert_eq!(selected.len(), 1, "oversized oldest scope runs alone");
        assert_eq!(selected[0].0, 0);
    }

    #[test]
    fn byte_accounting_runs_one_query_per_table_independent_of_scope_count() {
        let now = 1_800_000_000_000_i64;
        let mut conn = cache();
        seed_entry(&mut conn, "cline", "one", now, 32, 1);
        CACHE_BYTE_AGGREGATION_QUERY_COUNT.with(|count| count.set(0));
        let one_scope = load_cache_entries(&conn).expect("measure one replay scope");
        assert_eq!(one_scope.len(), 1);
        let one_scope_queries = CACHE_BYTE_AGGREGATION_QUERY_COUNT.with(|count| count.get());

        for index in 2..=12 {
            seed_entry(
                &mut conn,
                "cline",
                &format!("scope-{index}"),
                now + index,
                32,
                1,
            );
        }
        CACHE_BYTE_AGGREGATION_QUERY_COUNT.with(|count| count.set(0));
        let many_scopes = load_cache_entries(&conn).expect("measure many replay scopes");
        let many_scope_queries = CACHE_BYTE_AGGREGATION_QUERY_COUNT.with(|count| count.get());

        assert_eq!(many_scopes.len(), 12);
        assert_eq!(one_scope_queries, REPLAY_CACHE_BYTE_AGGREGATIONS.len());
        assert_eq!(many_scope_queries, one_scope_queries);
    }

    #[test]
    fn default_policy_matches_the_global_cache_contract() {
        assert_eq!(
            ReplayCachePolicy::default(),
            ReplayCachePolicy {
                max_bytes: 512 * 1024 * 1024,
                target_bytes: 384 * 1024 * 1024,
                ttl: Duration::from_secs(7 * 24 * 60 * 60),
                protect_recent: Duration::from_secs(3 * 60),
            }
        );
    }

    #[test]
    fn ttl_prune_deletes_every_rebuildable_table_but_keeps_provider_binding() {
        let now = 1_800_000_000_000_i64;
        let mut conn = cache();
        seed_entry(
            &mut conn,
            "cline",
            "expired",
            now - duration_millis(DEFAULT_REPLAY_CACHE_TTL) - 1,
            4096,
            10 * 1024 * 1024 * 1024,
        );
        seed_entry(&mut conn, "cline", "fresh", now - 60_000, 64, 1);

        let report =
            prune_cache_at(&mut conn, ReplayCachePolicy::default(), now).expect("TTL replay prune");
        assert_eq!(report.ttl_evictions, 1);
        assert_eq!(report.budget_evictions, 0);
        assert_eq!(report.evictions[0].source_session_id, "expired");
        assert!(
            report.evictions[0].approx_bytes < 1024 * 1024,
            "provider indexed_size_bytes must not count as cache bytes"
        );
        for table in [
            "imported_replay_state",
            "imported_replay_turns",
            "imported_replay_events",
            "imported_replay_source_rows",
            "imported_replay_structured_rows",
            "imported_replay_structured_events",
            "imported_replay_changes",
            "imported_replay_payload_artifact_refs",
            "imported_replay_payload_artifacts",
            "imported_replay_rejected_snapshots",
            "imported_replay_catalog_derivations",
            "imported_replay_shell_segments",
        ] {
            assert_eq!(count(&conn, table, "expired"), 0, "{table}");
            assert_eq!(count(&conn, table, "fresh"), 1, "{table}");
        }
        let manifest_count = |session_id: &str| {
            conn.query_row(
                "SELECT COUNT(*) FROM imported_replay_shell_manifests
                 WHERE session_id=?1",
                [session_id],
                |row| row.get::<_, i64>(0),
            )
            .expect("count replay Shell manifests")
        };
        assert_eq!(manifest_count("cline-expired"), 0);
        assert_eq!(manifest_count("cline-fresh"), 1);
        let catalog = conn
            .query_row(
                "SELECT source_path,name,model,files_changed,touched_files_json,
                        source_metadata_json,parent_session_id
                 FROM imported_history_session_cache
                 WHERE source='cline' AND source_session_id='expired'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                    ))
                },
            )
            .expect("pruned catalog binding");
        assert_eq!(catalog.0, "/provider/truth");
        assert_eq!(catalog.1, "replay title");
        assert_eq!(catalog.2, "model");
        assert_eq!(catalog.3, 1);
        assert_eq!(catalog.4, r#"["src/lib.rs"]"#);
        assert_eq!(catalog.5, r#"{"continuationGroupKey":"g"}"#);
        assert_eq!(catalog.6, "parent");
    }

    #[test]
    fn ttl_prunes_rejected_snapshot_without_valid_generation() {
        let now = 1_800_000_000_000_i64;
        let mut conn = cache();
        conn.execute(
            "INSERT INTO imported_replay_rejected_snapshots(
                 source,source_session_id,parser_version,source_identity,
                 source_size_bytes,source_mtime_ns,sample_fingerprint,
                 rejection_kind,rejected_at
             ) VALUES('cline','never-valid',1,'identity',99,100,'sample','json',?1)",
            [iso(now - duration_millis(DEFAULT_REPLAY_CACHE_TTL) - 1)],
        )
        .expect("standalone rejected snapshot");

        let report = prune_cache_at(&mut conn, ReplayCachePolicy::default(), now)
            .expect("prune standalone rejected snapshot");

        assert_eq!(report.ttl_evictions, 1);
        assert_eq!(report.evictions[0].source_session_id, "never-valid");
        assert_eq!(
            count(&conn, "imported_replay_rejected_snapshots", "never-valid"),
            0
        );
    }

    #[test]
    fn shell_only_managed_scopes_are_counted_and_evicted_by_orgii_access_time() {
        let now = 1_800_000_000_000_i64;
        let mut conn = cache();
        seed_shell_only_scope(
            &conn,
            "expired",
            now - duration_millis(DEFAULT_REPLAY_CACHE_TTL) - 1,
            8192,
        );
        seed_shell_only_scope(&conn, "fresh", now - 60_000, 4096);
        assert_eq!(count(&conn, "imported_replay_state", "expired"), 0);
        assert_eq!(count(&conn, "imported_replay_state", "fresh"), 0);

        let report = prune_cache_at(&mut conn, ReplayCachePolicy::default(), now)
            .expect("prune readerless Shell cache");

        assert!(report.before_bytes >= 8192 + 4096);
        assert_eq!(report.ttl_evictions, 1);
        assert_eq!(report.protected_entries, 1);
        assert_eq!(report.evictions[0].source_id, "managed_readerless");
        assert_eq!(report.evictions[0].source_session_id, "expired");
        assert_eq!(
            count(&conn, "imported_replay_payload_artifacts", "expired"),
            0
        );
        assert_eq!(
            count(&conn, "imported_replay_payload_artifacts", "fresh"),
            1
        );
        assert_eq!(count(&conn, "imported_replay_shell_segments", "expired"), 0);
        assert_eq!(count(&conn, "imported_replay_shell_segments", "fresh"), 1);
        let manifest_count = |session_id: &str| {
            conn.query_row(
                "SELECT COUNT(*) FROM imported_replay_shell_manifests
                 WHERE session_id=?1",
                [session_id],
                |row| row.get::<_, i64>(0),
            )
            .expect("count readerless Shell manifest")
        };
        assert_eq!(manifest_count("managed-expired"), 0);
        assert_eq!(manifest_count("managed-fresh"), 1);
    }

    #[test]
    fn selected_shell_scope_touched_before_writer_lock_is_not_evicted() {
        let now = 1_800_000_000_000_i64;
        let mut conn = cache();
        seed_shell_only_scope(
            &conn,
            "became-active",
            now - duration_millis(DEFAULT_REPLAY_CACHE_TTL) - 1,
            4096,
        );
        let touched_at = iso(now - 60_000);

        let report =
            prune_cache_at_with_hook(&mut conn, ReplayCachePolicy::default(), now, |conn| {
                conn.execute(
                    "UPDATE imported_replay_shell_manifests SET accessed_at=?1
                     WHERE session_id='managed-became-active'",
                    [&touched_at],
                )
                .map(|_| ())
                .map_err(|err| format!("simulate manifest delivery touch: {err}"))
            })
            .expect("revalidate touched Shell scope");

        assert_eq!(report.evicted_entries, 0);
        assert_eq!(report.ttl_evictions, 0);
        assert_eq!(
            count(&conn, "imported_replay_payload_artifacts", "became-active"),
            1
        );
        assert_eq!(
            count(&conn, "imported_replay_shell_segments", "became-active"),
            1
        );
    }

    #[test]
    fn shell_only_managed_scopes_participate_in_byte_lru() {
        let now = 1_800_000_000_000_i64;
        let mut conn = cache();
        seed_shell_only_scope(&conn, "older", now - 30_000, 8192);
        seed_shell_only_scope(&conn, "newer", now - 10_000, 4096);
        let entries = load_cache_entries(&conn).expect("measure readerless Shell scopes");
        let total = entries.iter().map(|entry| entry.approx_bytes).sum::<u64>();
        let older_bytes = entries
            .iter()
            .find(|entry| entry.source_session_id == "older")
            .expect("older readerless scope")
            .approx_bytes;

        let report = prune_cache_at(
            &mut conn,
            no_protection_policy(total - 1, total.saturating_sub(older_bytes)),
            now,
        )
        .expect("byte-LRU readerless Shell cache");

        assert_eq!(report.ttl_evictions, 0);
        assert_eq!(report.budget_evictions, 1);
        assert_eq!(report.evictions[0].source_session_id, "older");
        assert_eq!(
            count(&conn, "imported_replay_payload_artifacts", "older"),
            0
        );
        assert_eq!(
            count(&conn, "imported_replay_payload_artifacts", "newer"),
            1
        );
    }

    #[test]
    fn manifest_accounting_deduplicates_segment_scope_and_manifest_key() {
        let now = 1_800_000_000_000_i64;
        let conn = cache();
        seed_shell_only_scope(&conn, "dedup", now, 64);
        let before = load_cache_entries(&conn)
            .expect("measure one Shell segment")
            .into_iter()
            .find(|entry| entry.source_session_id == "dedup")
            .expect("readerless scope")
            .approx_bytes;

        conn.execute(
            "INSERT INTO imported_replay_shell_segments(
                 session_id,call_id,ordinal,stream,source,source_session_id,
                 generation,content_hash,output_byte_start,total_bytes,
                 first_sequence,frame_count
             ) VALUES('managed-dedup','call-dedup',1,'stdout','managed_readerless',
                      'dedup','generation-dedup','hash-dedup',64,64,2,1)",
            [],
        )
        .expect("second segment for the same Shell manifest");
        let after = load_cache_entries(&conn)
            .expect("measure two Shell segments")
            .into_iter()
            .find(|entry| entry.source_session_id == "dedup")
            .expect("readerless scope")
            .approx_bytes;

        let second_segment_bytes = APPROX_ROW_OVERHEAD_BYTES as u64
            + 48
            + "managed-dedup".len() as u64
            + "call-dedup".len() as u64
            + "stdout".len() as u64
            + "managed_readerless".len() as u64
            + "dedup".len() as u64
            + "generation-dedup".len() as u64
            + "hash-dedup".len() as u64;
        assert_eq!(
            after - before,
            second_segment_bytes,
            "adding a locator must not count the shared manifest a second time"
        );
    }

    #[test]
    fn byte_budget_uses_oldest_unprotected_entry_until_target() {
        let now = 1_800_000_000_000_i64;
        let mut conn = cache();
        seed_entry(&mut conn, "cline", "oldest", now - 30_000, 16_384, 1);
        seed_entry(&mut conn, "cline", "middle", now - 20_000, 8192, 1);
        seed_entry(&mut conn, "cline", "newest", now - 10_000, 4096, 1);
        let entries = load_cache_entries(&conn).expect("measure seeded replay entries");
        let total = entries.iter().map(|entry| entry.approx_bytes).sum::<u64>();
        let oldest_bytes = entries
            .iter()
            .find(|entry| entry.source_session_id == "oldest")
            .expect("oldest entry")
            .approx_bytes;
        let policy = no_protection_policy(total - 1, total.saturating_sub(oldest_bytes));

        let report = prune_cache_at(&mut conn, policy, now).expect("byte LRU prune");
        assert_eq!(report.ttl_evictions, 0);
        assert_eq!(report.budget_evictions, 1);
        assert_eq!(report.evictions[0].source_session_id, "oldest");
        assert!(report.after_bytes <= policy.target_bytes);
        assert_eq!(count(&conn, "imported_replay_state", "middle"), 1);
        assert_eq!(count(&conn, "imported_replay_state", "newest"), 1);
    }

    #[test]
    fn recent_entries_are_protected_even_when_cache_stays_over_budget() {
        let now = 1_800_000_000_000_i64;
        let mut conn = cache();
        seed_entry(&mut conn, "cline", "old", now - 10 * 60_000, 4096, 1);
        seed_entry(&mut conn, "cline", "active", now - 60_000, 4096, 1);
        let policy = ReplayCachePolicy {
            max_bytes: 0,
            target_bytes: 0,
            ttl: Duration::ZERO,
            protect_recent: DEFAULT_REPLAY_CACHE_PROTECT_RECENT,
        };

        let report = prune_cache_at(&mut conn, policy, now).expect("protected replay prune");
        assert_eq!(report.evicted_entries, 1);
        assert_eq!(report.protected_entries, 1);
        assert!(report.over_budget);
        assert_eq!(count(&conn, "imported_replay_state", "old"), 0);
        assert_eq!(count(&conn, "imported_replay_state", "active"), 1);
    }

    #[test]
    fn writer_lock_is_released_between_scope_transactions() {
        let now = 1_800_000_000_000_i64;
        let path = temp_path("writer-lock").with_extension("sqlite");
        let mut conn = cache_at(&path);
        conn.execute_batch(
            "CREATE TABLE cache_lock_probe(value INTEGER NOT NULL);
             INSERT INTO cache_lock_probe(value) VALUES(0);",
        )
        .expect("writer lock probe");
        seed_entry(&mut conn, "cline", "first", now - 20_000, 1024, 1);
        seed_entry(&mut conn, "cline", "second", now - 10_000, 1024, 1);

        let peer = Connection::open(&path).expect("peer cache writer");
        peer.busy_timeout(Duration::from_millis(50))
            .expect("short peer writer timeout");
        let report = prune_cache_at_with_hooks(
            &mut conn,
            no_protection_policy(0, 0),
            now,
            |_| Ok(()),
            |_| {
                peer.execute("UPDATE cache_lock_probe SET value=value+1", [])
                    .map(|_| ())
                    .map_err(|err| format!("peer writer remained blocked: {err}"))
            },
        )
        .expect("scope-local replay prune transactions");

        assert_eq!(report.evicted_entries, 2);
        let peer_writes: i64 = peer
            .query_row("SELECT value FROM cache_lock_probe", [], |row| row.get(0))
            .expect("peer writer count");
        assert_eq!(peer_writes, 2);
        drop(peer);
        drop(conn);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn failed_later_scope_keeps_prior_commit_and_rolls_back_failing_scope() {
        let now = 1_800_000_000_000_i64;
        let mut conn = cache();
        seed_entry(&mut conn, "cline", "a-first", now - 20_000, 1024, 1);
        seed_entry(&mut conn, "cline", "z-broken", now - 10_000, 1024, 1);
        conn.execute(
            "UPDATE imported_replay_catalog_derivations SET baseline_json='{'
             WHERE source='cline' AND source_session_id='z-broken'",
            [],
        )
        .expect("corrupt second derivation guard");

        let error = prune_cache_at(&mut conn, no_protection_policy(0, 0), now)
            .expect_err("malformed guard must abort prune");

        assert!(error.contains("decode replay catalog prune baseline"));
        assert_eq!(count(&conn, "imported_replay_state", "a-first"), 0);
        assert_eq!(
            count(&conn, "imported_replay_payload_artifacts", "a-first"),
            0
        );
        assert_eq!(count(&conn, "imported_replay_state", "z-broken"), 1);
        assert_eq!(
            count(&conn, "imported_replay_payload_artifacts", "z-broken"),
            1
        );
        let manifest_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM imported_replay_shell_manifests",
                [],
                |row| row.get(0),
            )
            .expect("count partially committed Shell manifests");
        assert_eq!(manifest_count, 1);
    }

    #[test]
    fn pruning_one_database_identity_cannot_touch_another() {
        let now = 1_800_000_000_000_i64;
        let mut first = cache();
        let mut second = cache();
        seed_entry(&mut first, "cline", "shared-id", now - 10_000, 1024, 1);
        seed_entry(&mut second, "cline", "shared-id", now - 10_000, 1024, 1);

        prune_cache_at(&mut first, no_protection_policy(0, 0), now)
            .expect("prune first database identity");
        assert_eq!(count(&first, "imported_replay_state", "shared-id"), 0);
        assert_eq!(count(&second, "imported_replay_state", "shared-id"), 1);
    }

    fn temp_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "orgii-replay-prune-{name}-{}-{}.json",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ))
    }

    #[test]
    fn pruned_entry_rebuilds_from_untouched_provider_truth() {
        let path = temp_path("rebuild");
        let transcript = json!({
            "messages":[
                {"role":"user","content":[{"type":"text","text":"hello"}]},
                {"role":"assistant","content":[{"type":"text","text":"world"}]}
            ]
        });
        std::fs::write(&path, transcript.to_string()).expect("provider Cline transcript");
        let mut conn = cache();
        let session_id = "clineapp-rebuild";
        bind_catalog(
            &conn,
            "cline",
            "rebuild",
            session_id,
            &path.to_string_lossy(),
        );
        let first = open_window(
            &mut conn,
            ImportedHistorySourceId::Cline,
            session_id,
            ReplayLimits::default(),
        )
        .expect("build initial replay cache");
        assert_eq!(first.chunks.len(), 2);
        conn.execute(
            "UPDATE imported_replay_state SET updated_at='2000-01-01T00:00:00Z'
             WHERE source='cline' AND source_session_id='rebuild'",
            [],
        )
        .expect("age replay cache entry");

        let report = prune_cache_at(
            &mut conn,
            ReplayCachePolicy {
                max_bytes: 0,
                target_bytes: 0,
                ttl: Duration::ZERO,
                protect_recent: Duration::ZERO,
            },
            1_800_000_000_000,
        )
        .expect("prune replay entry");
        assert_eq!(report.evicted_entries, 1);
        assert!(Path::new(&path).is_file(), "provider truth is untouched");
        assert_eq!(count(&conn, "imported_replay_state", "rebuild"), 0);

        let rebuilt = open_window(
            &mut conn,
            ImportedHistorySourceId::Cline,
            session_id,
            ReplayLimits::default(),
        )
        .expect("rebuild replay from provider truth");
        assert_eq!(rebuilt.chunks.len(), 2);
        assert_eq!(rebuilt.total_event_count, first.total_event_count);
        assert_eq!(count(&conn, "imported_replay_state", "rebuild"), 1);
        let _ = std::fs::remove_file(path);
    }
}
