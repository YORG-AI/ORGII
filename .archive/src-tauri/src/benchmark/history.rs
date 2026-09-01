//! On-disk persistence for benchmark agent batch history.

use std::fs;

use super::dto::BenchmarkAgentBatchStatus;
use super::paths::{benchmark_agent_batch_histories_dir, benchmark_agent_batch_history_path};
use super::BENCHMARK_AGENT_BATCHES;

pub(super) fn persist_agent_batch_status(status: &BenchmarkAgentBatchStatus) -> Result<(), String> {
    let dir = benchmark_agent_batch_histories_dir();
    fs::create_dir_all(&dir).map_err(|err| {
        format!(
            "Failed to create benchmark agent batch history dir {}: {err}",
            dir.display()
        )
    })?;
    let path = benchmark_agent_batch_history_path(&status.batch_id);
    let tmp_path = path.with_extension("json.tmp");
    let serialized = serde_json::to_string_pretty(status)
        .map_err(|err| format!("Failed to serialize benchmark agent batch history: {err}"))?;
    fs::write(&tmp_path, serialized).map_err(|err| {
        format!(
            "Failed to write benchmark agent batch history tmp file {}: {err}",
            tmp_path.display()
        )
    })?;
    fs::rename(&tmp_path, &path).map_err(|err| {
        format!(
            "Failed to replace benchmark agent batch history file {}: {err}",
            path.display()
        )
    })
}

pub(super) async fn persist_agent_batch_by_id(batch_id: &str) -> Result<(), String> {
    let status = BENCHMARK_AGENT_BATCHES
        .lock()
        .await
        .get(batch_id)
        .cloned()
        .ok_or_else(|| format!("Benchmark agent batch not found: {batch_id}"))?;
    persist_agent_batch_status(&status)
}

pub(super) fn load_agent_batch_history(
    batch_id: &str,
) -> Result<BenchmarkAgentBatchStatus, String> {
    let path = benchmark_agent_batch_history_path(batch_id);
    let raw = fs::read_to_string(&path)
        .map_err(|err| format!("Benchmark agent batch not found: {batch_id} ({})", err))?;
    serde_json::from_str(&raw).map_err(|err| {
        format!(
            "Failed to parse benchmark agent batch history {}: {err}",
            path.display()
        )
    })
}

pub(super) fn load_agent_batch_histories() -> Result<Vec<BenchmarkAgentBatchStatus>, String> {
    let dir = benchmark_agent_batch_histories_dir();
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let entries = fs::read_dir(&dir).map_err(|err| {
        format!(
            "Failed to read benchmark agent batch history dir {}: {err}",
            dir.display()
        )
    })?;
    let mut histories = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|err| format!("Failed to read history dir entry: {err}"))?;
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let raw = fs::read_to_string(&path).map_err(|err| {
            format!(
                "Failed to read benchmark agent batch history {}: {err}",
                path.display()
            )
        })?;
        histories.push(serde_json::from_str(&raw).map_err(|err| {
            format!(
                "Failed to parse benchmark agent batch history {}: {err}",
                path.display()
            )
        })?);
    }
    Ok(histories)
}
