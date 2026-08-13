//! Bounded retention for the in-memory benchmark registries.
//!
//! `BENCHMARK_RUNS` and `BENCHMARK_AGENT_BATCHES` are process-wide statics
//! that previously only ever grew. Active entries must stay resident for as
//! long as the run/batch is in flight, but terminal entries only serve status
//! polls issued shortly after completion, so we keep the most recently
//! finished `MAX_TERMINAL_*` terminal entries per registry and evict the rest.
//!
//! A count-based budget was chosen over a TTL because it bounds memory even
//! when many runs finish inside a short window, needs no sweep timer, and is
//! deterministic to test. Agent batches are persisted to disk on every
//! mutation and are reloaded from history on demand, so evicting them from
//! memory is lossless. Runs have no persistence layer; evicting a terminal
//! run only affects `benchmark_get_run_status` lookups for run ids older
//! than the retention budget.

use std::collections::HashMap;

use super::dto::{BenchmarkAgentBatchStatus, BenchmarkRunStatus};
use super::{
    BENCHMARK_AGENT_BATCH_STATUS_CANCELLED, BENCHMARK_AGENT_BATCH_STATUS_FAILED,
    BENCHMARK_AGENT_BATCH_STATUS_LAUNCHED, BENCHMARK_RUN_STATUS_APPLIED,
    BENCHMARK_RUN_STATUS_CANCELLED, BENCHMARK_RUN_STATUS_FAILED, BENCHMARK_RUN_STATUS_PASSED,
};

/// Terminal run entries kept in memory (most recently finished first).
pub(super) const MAX_TERMINAL_BENCHMARK_RUNS: usize = 50;
/// Terminal agent batch entries kept in memory (most recently finished first).
pub(super) const MAX_TERMINAL_BENCHMARK_AGENT_BATCHES: usize = 50;

/// Snapshot of one registry entry, as consumed by the eviction policy.
pub(super) struct RetentionEntry {
    pub key: String,
    /// Terminal entries are eviction candidates; active entries never are.
    pub terminal: bool,
    /// RFC3339 completion timestamp. Every writer uses
    /// `Utc::now().to_rfc3339()`, so lexicographic order matches
    /// chronological order. `None` sorts as oldest.
    pub finished_at: Option<String>,
}

/// Pure eviction policy: keep every active entry, keep the `budget` most
/// recently finished terminal entries, and return the keys of the remaining
/// terminal entries. Ties on `finished_at` break by key so the result is
/// deterministic and repeated applications are idempotent.
pub(super) fn terminal_keys_to_evict(entries: &[RetentionEntry], budget: usize) -> Vec<String> {
    let mut terminal: Vec<&RetentionEntry> =
        entries.iter().filter(|entry| entry.terminal).collect();
    if terminal.len() <= budget {
        return Vec::new();
    }
    terminal.sort_by(|left, right| {
        right
            .finished_at
            .cmp(&left.finished_at)
            .then_with(|| right.key.cmp(&left.key))
    });
    terminal[budget..]
        .iter()
        .map(|entry| entry.key.clone())
        .collect()
}

/// A run is terminal once it can no longer transition or hold a live
/// process. Unknown statuses are treated as active so they are never
/// evicted by mistake.
pub(super) fn is_terminal_run_status(status: &str) -> bool {
    matches!(
        status,
        BENCHMARK_RUN_STATUS_PASSED
            | BENCHMARK_RUN_STATUS_FAILED
            | BENCHMARK_RUN_STATUS_CANCELLED
            | BENCHMARK_RUN_STATUS_APPLIED
    )
}

/// A batch is terminal once no item is queued or running. Unknown statuses
/// are treated as active so they are never evicted by mistake.
pub(super) fn is_terminal_agent_batch_status(status: &str) -> bool {
    matches!(
        status,
        BENCHMARK_AGENT_BATCH_STATUS_LAUNCHED
            | BENCHMARK_AGENT_BATCH_STATUS_FAILED
            | BENCHMARK_AGENT_BATCH_STATUS_CANCELLED
    )
}

/// Evict terminal runs beyond the retention budget. Callers must hold the
/// `BENCHMARK_RUNS` lock and invoke this whenever an entry is inserted in or
/// transitions to a terminal status.
pub(super) fn prune_terminal_runs(runs: &mut HashMap<String, BenchmarkRunStatus>) {
    let entries: Vec<RetentionEntry> = runs
        .iter()
        .map(|(key, status)| RetentionEntry {
            key: key.clone(),
            terminal: is_terminal_run_status(&status.status),
            finished_at: status.finished_at.clone(),
        })
        .collect();
    for key in terminal_keys_to_evict(&entries, MAX_TERMINAL_BENCHMARK_RUNS) {
        runs.remove(&key);
    }
}

/// Evict terminal agent batches beyond the retention budget. Callers must
/// hold the `BENCHMARK_AGENT_BATCHES` lock and invoke this whenever an entry
/// is inserted in or transitions to a terminal status. Evicted batches stay
/// available through the on-disk batch history.
pub(super) fn prune_terminal_agent_batches(
    batches: &mut HashMap<String, BenchmarkAgentBatchStatus>,
) {
    let entries: Vec<RetentionEntry> = batches
        .iter()
        .map(|(key, status)| RetentionEntry {
            key: key.clone(),
            terminal: is_terminal_agent_batch_status(&status.status),
            finished_at: status.finished_at.clone(),
        })
        .collect();
    for key in terminal_keys_to_evict(&entries, MAX_TERMINAL_BENCHMARK_AGENT_BATCHES) {
        batches.remove(&key);
    }
}

#[cfg(test)]
mod tests {
    use super::super::{
        BENCHMARK_AGENT_BATCH_STATUS_QUEUED, BENCHMARK_AGENT_BATCH_STATUS_RUNNING,
        BENCHMARK_RUN_STATUS_RUNNING,
    };
    use super::*;

    fn entry(key: &str, terminal: bool, finished_at: Option<&str>) -> RetentionEntry {
        RetentionEntry {
            key: key.to_string(),
            terminal,
            finished_at: finished_at.map(ToOwned::to_owned),
        }
    }

    fn timestamp(index: usize) -> String {
        // Same shape as `Utc::now().to_rfc3339()`; later index == more recent.
        format!("2026-08-07T10:{:02}:00+00:00", index)
    }

    #[test]
    fn keeps_all_active_entries_even_over_budget() {
        let entries: Vec<RetentionEntry> = (0..10)
            .map(|index| entry(&format!("run-{index}"), false, Some(&timestamp(index))))
            .collect();
        assert!(terminal_keys_to_evict(&entries, 3).is_empty());
    }

    #[test]
    fn evicts_oldest_terminal_entries_beyond_budget() {
        let entries: Vec<RetentionEntry> = (0..5)
            .map(|index| entry(&format!("run-{index}"), true, Some(&timestamp(index))))
            .collect();
        let mut evicted = terminal_keys_to_evict(&entries, 3);
        evicted.sort();
        assert_eq!(evicted, vec!["run-0".to_string(), "run-1".to_string()]);
    }

    #[test]
    fn active_entries_do_not_count_toward_terminal_budget() {
        let mut entries: Vec<RetentionEntry> = (0..10)
            .map(|index| entry(&format!("active-{index}"), false, None))
            .collect();
        entries.extend(
            (0..4).map(|index| entry(&format!("done-{index}"), true, Some(&timestamp(index)))),
        );
        let evicted = terminal_keys_to_evict(&entries, 3);
        assert_eq!(evicted, vec!["done-0".to_string()]);
        assert!(!evicted.iter().any(|key| key.starts_with("active-")));
    }

    #[test]
    fn is_idempotent_when_reapplied() {
        let mut entries: Vec<RetentionEntry> = (0..6)
            .map(|index| entry(&format!("run-{index}"), true, Some(&timestamp(index))))
            .collect();
        let evicted = terminal_keys_to_evict(&entries, 2);
        assert_eq!(evicted.len(), 4);
        entries.retain(|entry| !evicted.contains(&entry.key));
        assert!(terminal_keys_to_evict(&entries, 2).is_empty());
    }

    #[test]
    fn missing_timestamps_are_evicted_first() {
        let entries = vec![
            entry("no-timestamp", true, None),
            entry("recent", true, Some(&timestamp(2))),
            entry("old", true, Some(&timestamp(1))),
        ];
        let evicted = terminal_keys_to_evict(&entries, 2);
        assert_eq!(evicted, vec!["no-timestamp".to_string()]);
    }

    #[test]
    fn equal_timestamps_break_ties_by_key_deterministically() {
        let shared = timestamp(1);
        let entries = vec![
            entry("b", true, Some(&shared)),
            entry("a", true, Some(&shared)),
            entry("c", true, Some(&shared)),
        ];
        assert_eq!(terminal_keys_to_evict(&entries, 2), vec!["a".to_string()]);
        assert_eq!(
            terminal_keys_to_evict(&entries, 2),
            terminal_keys_to_evict(&entries, 2)
        );
    }

    #[test]
    fn zero_budget_evicts_every_terminal_entry() {
        let entries = vec![
            entry("done", true, Some(&timestamp(1))),
            entry("active", false, None),
        ];
        assert_eq!(
            terminal_keys_to_evict(&entries, 0),
            vec!["done".to_string()]
        );
    }

    #[test]
    fn run_status_classification_matches_lifecycle() {
        assert!(!is_terminal_run_status(BENCHMARK_RUN_STATUS_RUNNING));
        assert!(is_terminal_run_status(BENCHMARK_RUN_STATUS_PASSED));
        assert!(is_terminal_run_status(BENCHMARK_RUN_STATUS_FAILED));
        assert!(is_terminal_run_status(BENCHMARK_RUN_STATUS_CANCELLED));
        assert!(is_terminal_run_status(BENCHMARK_RUN_STATUS_APPLIED));
        // Unknown statuses stay resident rather than risking eviction of an
        // entry that may still transition.
        assert!(!is_terminal_run_status("mystery"));
    }

    #[test]
    fn agent_batch_status_classification_matches_lifecycle() {
        assert!(!is_terminal_agent_batch_status(
            BENCHMARK_AGENT_BATCH_STATUS_QUEUED
        ));
        assert!(!is_terminal_agent_batch_status(
            BENCHMARK_AGENT_BATCH_STATUS_RUNNING
        ));
        assert!(is_terminal_agent_batch_status(
            BENCHMARK_AGENT_BATCH_STATUS_LAUNCHED
        ));
        assert!(is_terminal_agent_batch_status(
            BENCHMARK_AGENT_BATCH_STATUS_FAILED
        ));
        assert!(is_terminal_agent_batch_status(
            BENCHMARK_AGENT_BATCH_STATUS_CANCELLED
        ));
        assert!(!is_terminal_agent_batch_status("mystery"));
    }

    fn run_status(run_id: &str, status: &str, finished_at: Option<&str>) -> BenchmarkRunStatus {
        BenchmarkRunStatus {
            run_id: run_id.to_string(),
            benchmark_kind: "swe_bench_pro".to_string(),
            evaluation_mode: "local_docker".to_string(),
            task_id: "task".to_string(),
            status: status.to_string(),
            source_path: String::new(),
            repo_path: None,
            patch_path: String::new(),
            output_dir: String::new(),
            worktree_path: None,
            started_at: None,
            finished_at: finished_at.map(ToOwned::to_owned),
            exit_code: None,
            process_id: None,
            logs: Vec::new(),
            result: None,
            error: None,
        }
    }

    #[test]
    fn prune_terminal_runs_keeps_active_and_recent_terminal_entries() {
        let mut runs = HashMap::new();
        for index in 0..MAX_TERMINAL_BENCHMARK_RUNS + 5 {
            let run_id = format!("done-{index}");
            runs.insert(
                run_id.clone(),
                run_status(
                    &run_id,
                    BENCHMARK_RUN_STATUS_PASSED,
                    Some(&format!(
                        "2026-08-07T{:02}:{:02}:00+00:00",
                        index / 60,
                        index % 60
                    )),
                ),
            );
        }
        runs.insert(
            "active".to_string(),
            run_status("active", BENCHMARK_RUN_STATUS_RUNNING, None),
        );

        prune_terminal_runs(&mut runs);

        assert!(runs.contains_key("active"));
        assert_eq!(runs.len(), MAX_TERMINAL_BENCHMARK_RUNS + 1);
        assert!(!runs.contains_key("done-0"));
        assert!(runs.contains_key(&format!("done-{}", MAX_TERMINAL_BENCHMARK_RUNS + 4)));
    }

    fn batch_status(
        batch_id: &str,
        status: &str,
        finished_at: Option<&str>,
    ) -> BenchmarkAgentBatchStatus {
        BenchmarkAgentBatchStatus {
            batch_id: batch_id.to_string(),
            benchmark_kind: "swe_bench_pro".to_string(),
            source_path: String::new(),
            launch: None,
            master_session_id: String::new(),
            master_session_name: String::new(),
            status: status.to_string(),
            total_tasks: 0,
            queued: 0,
            running: 0,
            launched: 0,
            failed: 0,
            cancelled: 0,
            created_at: String::new(),
            started_at: None,
            finished_at: finished_at.map(ToOwned::to_owned),
            concurrency: 1,
            items: Vec::new(),
            error: None,
        }
    }

    #[test]
    fn prune_terminal_agent_batches_keeps_active_and_recent_terminal_entries() {
        let mut batches = HashMap::new();
        for index in 0..MAX_TERMINAL_BENCHMARK_AGENT_BATCHES + 3 {
            let batch_id = format!("done-{index}");
            batches.insert(
                batch_id.clone(),
                batch_status(
                    &batch_id,
                    BENCHMARK_AGENT_BATCH_STATUS_LAUNCHED,
                    Some(&format!(
                        "2026-08-07T{:02}:{:02}:00+00:00",
                        index / 60,
                        index % 60
                    )),
                ),
            );
        }
        batches.insert(
            "active".to_string(),
            batch_status("active", BENCHMARK_AGENT_BATCH_STATUS_RUNNING, None),
        );

        prune_terminal_agent_batches(&mut batches);

        assert!(batches.contains_key("active"));
        assert_eq!(batches.len(), MAX_TERMINAL_BENCHMARK_AGENT_BATCHES + 1);
        assert!(!batches.contains_key("done-0"));
    }
}
