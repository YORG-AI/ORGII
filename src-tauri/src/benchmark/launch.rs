//! Session launch helpers for benchmark agent batches.

use agent_core::session::persistence::{
    self as session_persistence, session_type, UnifiedSessionRecord,
};
use agent_core::state::commands::session::launch::SessionLaunchParams;
use chrono::{Local, Utc};
use core_types::key_source::KeySource;
use uuid::Uuid;

use super::dataset::string_value;
use super::dto::{BenchmarkAgentLaunchSelection, BenchmarkTaskDetail};
use super::{BENCHMARK_KIND_SWE_BENCH_PRO, BENCHMARK_KIND_TERMINAL_BENCH};

pub(super) fn benchmark_launch_params(
    launch: &BenchmarkAgentLaunchSelection,
    content: String,
    session_name: Option<String>,
    parent_session_id: Option<String>,
) -> SessionLaunchParams {
    SessionLaunchParams {
        category: launch.category.clone(),
        content,
        workspace_path: launch.workspace_path.clone(),
        key_source: launch.key_source.clone(),
        account_id: launch.account_id.clone(),
        model: launch.model.clone(),
        native_harness_type: launch.native_harness_type.clone(),
        platform: launch.platform.clone(),
        branch: launch.branch.clone(),
        worktree_base_ref: None,
        hosted_token: launch.hosted_token.clone(),
        tier: launch.tier.clone(),
        name: session_name,
        background: true,
        images: None,
        ide_context: None,
        agent_definition_id: launch.agent_definition_id.clone(),
        agent_org_id: launch.agent_org_id.clone(),
        agent_org_member_overrides: launch.agent_org_member_overrides.clone(),
        apply_agent_org_member_overrides_for_future: launch
            .apply_agent_org_member_overrides_for_future,
        isolate: launch.isolate,
        mode: launch.mode.clone(),
        org_id: None,
        project_id: None,
        project_name: None,
        work_item_id: None,
        agent_role: None,
        worktree_path: launch.worktree_path.clone(),
        project_slug: launch.project_slug.clone(),
        parent_session_id,
        additional_directories: launch.additional_directories.clone(),
    }
}

pub(super) fn benchmark_session_name(kind: &str) -> String {
    let benchmark_name = benchmark_display_name(kind);
    let timestamp = Local::now().format("%H:%M");
    format!("{benchmark_name} - {timestamp}")
}

fn benchmark_display_name(kind: &str) -> &'static str {
    match kind {
        BENCHMARK_KIND_SWE_BENCH_PRO => "SWE-bench Pro",
        BENCHMARK_KIND_TERMINAL_BENCH => "Terminal-Bench",
        _ => "Benchmark",
    }
}

pub(super) fn create_benchmark_master_session(
    name: &str,
    kind: &str,
    source_path: &str,
    launch: &BenchmarkAgentLaunchSelection,
) -> Result<String, String> {
    let session_id = format!("benchmark-{}", Uuid::new_v4());
    let now = Utc::now().to_rfc3339();
    let key_source = launch
        .key_source
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .and_then(KeySource::parse)
        .unwrap_or_default();
    let user_input = format!(
        "Benchmark run coordinator\n\nBenchmark: {}\nSource: {}",
        benchmark_display_name(kind),
        source_path
    );
    let session = UnifiedSessionRecord {
        session_id: session_id.clone(),
        name: name.to_string(),
        status: agent_core::session::SessionStatus::Running
            .as_str()
            .to_string(),
        model: launch.model.clone(),
        account_id: launch.account_id.clone(),
        user_input: Some(user_input),
        created_at: now.clone(),
        updated_at: now,
        session_type: session_type::CODING.to_string(),
        workspace_path: launch.workspace_path.clone(),
        project_slug: launch.project_slug.clone(),
        agent_definition_id: launch.agent_definition_id.clone(),
        key_source,
        agent_exec_mode: launch.mode.clone().filter(|mode| !mode.trim().is_empty()),
        native_harness_type: launch.native_harness_type.clone(),
        ..Default::default()
    };
    session_persistence::upsert_session(&session).map_err(|err| err.to_string())?;
    Ok(session_id)
}

pub(super) fn benchmark_agent_prompt(
    kind: &str,
    detail: &BenchmarkTaskDetail,
    submitted_patch_path: &str,
) -> String {
    let repo = detail
        .index
        .repo
        .as_deref()
        .unwrap_or("the target repository");
    let base_commit = detail
        .index
        .metadata
        .get("base_commit")
        .and_then(string_value)
        .unwrap_or_else(|| "the task base commit".to_string());
    format!(
        "You are running an official benchmark task. The final result will be evaluated by the benchmark harness, not by ORGII.\n\nBenchmark: {kind}\nTask ID: {task_id}\nRepository: {repo}\nBase commit: {base_commit}\nPatch submission path: {submitted_patch_path}\n\nInstructions:\n- Work inside the configured working directory. If the target repository is not already present there, clone it from its public upstream repository into that working directory before editing.\n- After cloning or locating the repository, check out the task base commit before applying changes.\n- Make the minimal code changes needed to satisfy the task.\n- Do not modify unrelated files.\n- Do not invent new tests or change benchmark tests unless the task explicitly requires it.\n- Before finishing, write your final unified diff patch to the patch submission path above. Create parent directories if needed.\n- The patch file must contain only the solution diff that should be evaluated.\n- When you finish, summarize the changed files, the validation you ran, and confirm that you wrote the patch file.\n- Leave the repository in a state where a git diff captures your solution patch.\n\nTask:\n{instruction}",
        task_id = detail.index.task_id,
        submitted_patch_path = submitted_patch_path,
        instruction = detail.instruction
    )
}
