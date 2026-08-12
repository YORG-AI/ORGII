//! Provider-neutral lifecycle hooks for opaque CLI harnesses.
//!
//! Native/Rust agents can stop and resume inside their tool loop. An external
//! CLI is an opaque subprocess, so ORGII owns the lifecycle events around that
//! process while provider-native hooks continue to own individual tool calls.

use std::path::PathBuf;

use agent_core::specialization::hooks::events::HookContext;
use agent_core::specialization::hooks::executor::HookResult;
use agent_core::specialization::hooks::{HookEvent, HookExecutor};
use key_vault::key_store::ModelType;

const HOOK_CONTEXT_MAX_CHARS: usize = 10_000;

fn workspace_root(repo_path: Option<&str>) -> PathBuf {
    repo_path
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(app_paths::orgii_root)
}

fn executor(repo_path: Option<&str>) -> HookExecutor {
    let root = workspace_root(repo_path);
    HookExecutor::load_with_workspace_scope(&root, repo_path.is_some())
}

fn additional_context_from_stdout(stdout: &str) -> Option<String> {
    let stdout = stdout.trim();
    if stdout.is_empty() {
        return None;
    }

    let parsed = serde_json::from_str::<serde_json::Value>(stdout).ok();
    let context = parsed.as_ref().and_then(|value| {
        value
            .get("additionalContext")
            .or_else(|| value.get("additional_context"))
            .and_then(serde_json::Value::as_str)
            .or_else(|| {
                value
                    .get("hookSpecificOutput")
                    .and_then(|output| output.get("additionalContext"))
                    .and_then(serde_json::Value::as_str)
            })
    });

    // JSON hook protocols use an explicit additionalContext field. Plain
    // stdout remains useful for simple shell hooks and matches common CLI
    // harness behavior, so preserve it when the output is not JSON.
    let context = context.or_else(|| parsed.is_none().then_some(stdout))?;
    Some(agent_core::utils::safe_truncate_chars_to_string(
        context,
        HOOK_CONTEXT_MAX_CHARS,
    ))
}

fn collect_context(
    event: HookEvent,
    prompt: Option<String>,
    results: &[HookResult],
) -> Option<String> {
    let mut sections = Vec::new();
    if let Some(prompt) = prompt.filter(|value| !value.trim().is_empty()) {
        sections.push(prompt);
    }
    for result in results {
        if result.success {
            if let Some(context) = additional_context_from_stdout(&result.stdout) {
                sections.push(context);
            }
        } else {
            tracing::warn!(
                event = %event,
                stderr = %result.stderr,
                "[cli-hooks] lifecycle hook failed"
            );
        }
    }
    (!sections.is_empty()).then(|| sections.join("\n\n"))
}

fn base_context(
    session_id: &str,
    agent: &ModelType,
    model: Option<&str>,
    repo_path: Option<&str>,
) -> HookContext {
    HookContext::for_session(session_id)
        .with_var("ORGII_PROVIDER", agent.as_str())
        .with_var("ORGII_MODEL", model.unwrap_or(""))
        .with_var(
            "ORGII_WORKSPACE_ROOT",
            workspace_root(repo_path).to_string_lossy(),
        )
}

/// Fire inbound-message notification hooks on every turn and synchronously
/// collect SessionStart context for a fresh provider conversation.
pub(super) async fn prepare_turn(
    session_id: &str,
    agent: &ModelType,
    model: Option<&str>,
    repo_path: Option<&str>,
    user_input: &str,
    is_fresh_session: bool,
) -> Option<String> {
    let executor = executor(repo_path);
    let notification_context = base_context(session_id, agent, model, repo_path).with_var(
        "ORGII_USER_MESSAGE",
        agent_core::utils::safe_truncate_chars_to_string(user_input, 5_000),
    );
    if executor.has_hooks_for(HookEvent::NotificationReceived) {
        let notification_executor = executor.clone();
        tokio::spawn(async move {
            notification_executor
                .run(HookEvent::NotificationReceived, &notification_context)
                .await;
        });
    }

    if !is_fresh_session || !executor.has_hooks_for(HookEvent::SessionStart) {
        return None;
    }

    let prompt = executor.collect_prompt_hooks(HookEvent::SessionStart);
    let results = executor
        .run(
            HookEvent::SessionStart,
            &base_context(session_id, agent, model, repo_path),
        )
        .await;
    collect_context(HookEvent::SessionStart, prompt, &results)
}

/// Fire the provider-neutral Stop event once the opaque CLI turn has ended.
/// Tool-level blocking remains the provider's native hook responsibility.
pub(super) async fn finish_turn(
    session_id: &str,
    agent: &ModelType,
    model: Option<&str>,
    repo_path: Option<&str>,
    status: &str,
    exit_code: i32,
) {
    let executor = executor(repo_path);
    if !executor.has_hooks_for(HookEvent::Stop) {
        return;
    }
    let context = base_context(session_id, agent, model, repo_path)
        .with_var("ORGII_STATUS", status)
        .with_var("ORGII_EXIT_CODE", exit_code.to_string());
    executor.run(HookEvent::Stop, &context).await;
}

/// Fire SessionStop before persistent session state is deleted.
pub(crate) async fn stop_session(
    session_id: &str,
    agent: &ModelType,
    model: Option<&str>,
    repo_path: Option<&str>,
) {
    let executor = executor(repo_path);
    if !executor.has_hooks_for(HookEvent::SessionStop) {
        return;
    }
    executor
        .run(
            HookEvent::SessionStop,
            &base_context(session_id, agent, model, repo_path),
        )
        .await;
}

#[cfg(test)]
mod tests {
    use super::{additional_context_from_stdout, prepare_turn};
    use key_vault::key_store::ModelType;

    #[test]
    fn extracts_common_additional_context_contracts() {
        assert_eq!(
            additional_context_from_stdout(r#"{"additionalContext":"alpha"}"#).as_deref(),
            Some("alpha")
        );
        assert_eq!(
            additional_context_from_stdout(
                r#"{"hookSpecificOutput":{"additionalContext":"beta"}}"#
            )
            .as_deref(),
            Some("beta")
        );
        assert_eq!(
            additional_context_from_stdout("plain context").as_deref(),
            Some("plain context")
        );
        assert_eq!(additional_context_from_stdout(r#"{"ok":true}"#), None);
    }

    #[tokio::test]
    async fn session_start_prompt_hook_reaches_the_cli_turn() {
        let workspace = tempfile::tempdir().expect("workspace");
        std::fs::create_dir_all(workspace.path().join(".orgii")).expect("create .orgii");
        std::fs::write(
            workspace.path().join(".orgii/hooks.json"),
            r#"{
                "hooks": {
                    "session_start": [
                        { "type": "prompt", "content": "SESSION_HOOK_SENTINEL" }
                    ]
                }
            }"#,
        )
        .expect("write hook config");

        let context = prepare_turn(
            "hook-session",
            &ModelType::Codex,
            Some("gpt-test"),
            workspace.path().to_str(),
            "hello",
            true,
        )
        .await
        .expect("session hook context");
        assert!(context.contains("SESSION_HOOK_SENTINEL"));
    }
}
