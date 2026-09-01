//! SWE-bench Pro dataset resolution, JSONL parsing, and row projection.

use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::dto::{BenchmarkTaskDetail, BenchmarkTaskIndexRow};
use super::{
    BENCHMARK_KIND_SWE_BENCH_PRO, EVALUATION_MODE_LOCAL_DOCKER, EVALUATION_MODE_PATCH_ONLY,
    SWE_BENCH_PRO_DATASET_CANDIDATES,
};

pub(super) fn ensure_swe_bench_pro(kind: &str) -> Result<(), String> {
    if kind == BENCHMARK_KIND_SWE_BENCH_PRO {
        Ok(())
    } else {
        Err(format!("Unsupported benchmark kind: {kind}"))
    }
}

pub(super) fn ensure_supported_swe_bench_mode(evaluation_mode: &str) -> Result<(), String> {
    if matches!(
        evaluation_mode,
        EVALUATION_MODE_LOCAL_DOCKER | EVALUATION_MODE_PATCH_ONLY
    ) {
        Ok(())
    } else {
        Err(format!(
            "Unsupported benchmark run mode: {evaluation_mode}. Supported modes: local_docker, patch_only."
        ))
    }
}

pub(super) fn resolve_swe_bench_source_path(source_path: &str) -> Result<PathBuf, String> {
    let path = Path::new(source_path);
    if path.is_file() {
        return Ok(path.to_path_buf());
    }
    if !path.is_dir() {
        return Err(format!(
            "SWE-bench Pro source does not exist: {source_path}"
        ));
    }

    for candidate in SWE_BENCH_PRO_DATASET_CANDIDATES {
        let candidate_path = path.join(candidate);
        if candidate_path.is_file() {
            return Ok(candidate_path);
        }
    }

    let mut jsonl_files = Vec::new();
    collect_jsonl_files(path, &mut jsonl_files)?;
    if jsonl_files.len() == 1 {
        return Ok(jsonl_files.remove(0));
    }

    if jsonl_files.is_empty() {
        return Err(format!(
            "No SWE-bench Pro JSONL dataset found in folder: {source_path}"
        ));
    }

    let candidate_list = jsonl_files
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    Err(format!(
        "Multiple JSONL files found in benchmark folder. Use a folder containing one dataset file or one of the known SWE-bench Pro paths. Found: {candidate_list}"
    ))
}

fn collect_jsonl_files(dir: &Path, jsonl_files: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|error| format!("Failed to read folder: {error}"))? {
        let entry = entry.map_err(|error| format!("Failed to read folder entry: {error}"))?;
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl_files(&path, jsonl_files)?;
        } else if path
            .extension()
            .is_some_and(|extension| extension.to_string_lossy() == "jsonl")
        {
            jsonl_files.push(path);
        }
    }
    Ok(())
}

pub(super) fn read_swe_bench_rows(source_path: &str) -> Result<Vec<Value>, String> {
    let path = resolve_swe_bench_source_path(source_path)?;
    let file = File::open(&path).map_err(|error| {
        format!(
            "Failed to open SWE-bench Pro dataset {}: {error}",
            path.display()
        )
    })?;
    let reader = BufReader::new(file);
    let mut rows = Vec::new();
    for (line_index, line) in reader.lines().enumerate() {
        let line =
            line.map_err(|error| format!("Failed to read line {}: {error}", line_index + 1))?;
        if line.trim().is_empty() {
            continue;
        }
        let row: Value = serde_json::from_str(&line)
            .map_err(|error| format!("Invalid JSONL line {}: {error}", line_index + 1))?;
        rows.push(row);
    }
    Ok(rows)
}

pub(super) fn read_swe_bench_task(
    source_path: &str,
    task_id: &str,
) -> Result<BenchmarkTaskDetail, String> {
    swe_bench_row_to_detail(source_path, find_swe_bench_row(source_path, task_id)?)
}

pub(super) fn find_swe_bench_row(source_path: &str, task_id: &str) -> Result<Value, String> {
    for row in read_swe_bench_rows(source_path)? {
        let instance_id = string_field(&row, "instance_id").unwrap_or_default();
        if instance_id == task_id {
            return Ok(row);
        }
    }
    Err(format!("SWE-bench Pro task not found: {task_id}"))
}

pub(super) fn swe_bench_row_to_detail(
    source_path: &str,
    row: Value,
) -> Result<BenchmarkTaskDetail, String> {
    let task_id = string_field(&row, "instance_id")
        .ok_or_else(|| "SWE-bench Pro row is missing instance_id".to_string())?;
    let problem_statement = string_field(&row, "problem_statement").unwrap_or_default();
    let requirements = string_field(&row, "requirements").unwrap_or_default();
    let interface = string_field(&row, "interface").unwrap_or_default();
    let instruction = compose_swe_bench_instruction(&problem_statement, &requirements, &interface);
    let title = first_non_empty_line(&problem_statement).unwrap_or_else(|| task_id.clone());
    let repo = string_field(&row, "repo").or_else(|| string_field(&row, "repo_name"));
    let char_count = instruction.chars().count();
    let word_count = instruction.split_whitespace().count();

    let metadata = serde_json::json!({
        "baseCommit": string_field(&row, "base_commit"),
        "imageName": string_field(&row, "image_name"),
        "dockerhubTag": string_field(&row, "dockerhub_tag"),
        "selectedTestFilesToRun": row.get("selected_test_files_to_run").cloned(),
        "failToPass": row.get("FAIL_TO_PASS").cloned(),
        "passToPass": row.get("PASS_TO_PASS").cloned(),
    });

    Ok(BenchmarkTaskDetail {
        index: BenchmarkTaskIndexRow {
            benchmark_kind: BENCHMARK_KIND_SWE_BENCH_PRO.to_string(),
            task_id,
            title,
            source_path: source_path.to_string(),
            repo,
            word_count,
            char_count,
            tags: vec!["swe-bench-pro".to_string()],
            difficulty: None,
            metadata,
        },
        instruction,
    })
}

fn compose_swe_bench_instruction(
    problem_statement: &str,
    requirements: &str,
    interface: &str,
) -> String {
    let mut parts = Vec::new();
    if !problem_statement.trim().is_empty() {
        parts.push(problem_statement.trim().to_string());
    }
    if !requirements.trim().is_empty() {
        parts.push(format!("Requirements:\n{}", requirements.trim()));
    }
    if !interface.trim().is_empty() {
        parts.push(format!("New interfaces introduced:\n{}", interface.trim()));
    }
    parts.join("\n\n")
}

fn first_non_empty_line(value: &str) -> Option<String> {
    value
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.chars().take(120).collect())
}

pub(super) fn task_matches_query(detail: &BenchmarkTaskDetail, query: &str) -> bool {
    detail.index.task_id.to_lowercase().contains(query)
        || detail.index.title.to_lowercase().contains(query)
        || detail
            .index
            .repo
            .as_ref()
            .map(|repo| repo.to_lowercase().contains(query))
            .unwrap_or(false)
}

pub(super) fn string_field(row: &Value, key: &str) -> Option<String> {
    row.get(key).and_then(string_value)
}

pub(super) fn string_value(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}
