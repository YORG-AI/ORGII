//! E2E scenarios for worktree runtime contracts.

use super::tmp_workspace_path;
use crate::config::Config;
use crate::harness;
use std::path::Path;

/// Worktree Tool — verify the agent can list git worktrees.
pub async fn worktree_list(cfg: &Config) -> bool {
    let session_id = format!("{}-worktree-list", cfg.session_prefix);
    let project = tmp_workspace_path("worktree-list");
    let _ = std::fs::create_dir_all(&project);

    std::fs::write(Path::new(&project).join("README.md"), "# Worktree Test\n").ok();

    let git_init = tokio::process::Command::new("git")
        .args(["init"])
        .current_dir(&project)
        .output()
        .await;

    if git_init.is_err() || !git_init.as_ref().unwrap().status.success() {
        return harness::print_error("Worktree List", "Failed to git init test project");
    }

    let _ = tokio::process::Command::new("git")
        .args(["add", "."])
        .current_dir(&project)
        .output()
        .await;
    let _ = tokio::process::Command::new("git")
        .args(["commit", "-m", "init", "--allow-empty"])
        .current_dir(&project)
        .env("GIT_AUTHOR_NAME", "e2e")
        .env("GIT_AUTHOR_EMAIL", "e2e@test")
        .env("GIT_COMMITTER_NAME", "e2e")
        .env("GIT_COMMITTER_EMAIL", "e2e@test")
        .output()
        .await;

    match harness::send_sde_message(
        cfg,
        "Use the worktree tool with action 'list' to show me the current git worktrees in this project.",
        &session_id,
        "build",
        &project,
        None,
        false,
    )
    .await
    {
        Err(err) => harness::print_error("Worktree List", &err),
        Ok(resp) => {
            let content = resp.content.to_lowercase();
            let used_worktree_tool = harness::assert_sde_tool_used(&resp, "worktree");
            let used_shell_git =
                harness::assert_sde_tool_used(&resp, "run_shell") && content.contains("worktree");
            harness::print_result(
                "Worktree List",
                &resp.content,
                &[
                    ("Got response", !resp.content.is_empty()),
                    (
                        "Used worktree tool or git worktree via shell",
                        used_worktree_tool || used_shell_git,
                    ),
                    (
                        "Response mentions worktree(s)",
                        content.contains("worktree") || content.contains("branch"),
                    ),
                    (
                        "No error in response",
                        !content.contains("error") || content.contains("worktree"),
                    ),
                ],
            )
        }
    }
}

/// Worktree Tool — verify enter/exit worktree cycle.
pub async fn worktree_enter_exit(cfg: &Config) -> bool {
    let session_id = format!("{}-worktree-ee", cfg.session_prefix);
    let project = tmp_workspace_path("worktree-ee");
    let _ = std::fs::create_dir_all(&project);

    std::fs::write(Path::new(&project).join("main.rs"), "fn main() {}\n").ok();

    let _ = tokio::process::Command::new("git")
        .args(["init"])
        .current_dir(&project)
        .output()
        .await;
    let _ = tokio::process::Command::new("git")
        .args(["add", "."])
        .current_dir(&project)
        .output()
        .await;
    let _ = tokio::process::Command::new("git")
        .args(["commit", "-m", "init"])
        .current_dir(&project)
        .env("GIT_AUTHOR_NAME", "e2e")
        .env("GIT_AUTHOR_EMAIL", "e2e@test")
        .env("GIT_COMMITTER_NAME", "e2e")
        .env("GIT_COMMITTER_EMAIL", "e2e@test")
        .output()
        .await;

    match harness::send_sde_message(
        cfg,
        "Use the worktree tool to enter a new worktree with branch name 'feature-e2e-test'. \
         Then create a file called 'worktree_proof.txt' with content 'inside-worktree'. \
         Then use the worktree tool to list worktrees. \
         Finally, exit the worktree.",
        &session_id,
        "build",
        &project,
        None,
        false,
    )
    .await
    {
        Err(err) => harness::print_error("Worktree Enter/Exit", &err),
        Ok(resp) => {
            let content = resp.content.to_lowercase();
            let worktree_calls = resp
                .tool_calls
                .iter()
                .filter(|tool| tool.contains("worktree"))
                .count();
            let shell_worktree_calls = resp
                .tool_calls
                .iter()
                .filter(|tool| tool.contains("run_shell"))
                .count();

            harness::print_result(
                "Worktree Enter/Exit",
                &resp.content,
                &[
                    ("Got response", !resp.content.is_empty()),
                    (
                        &format!(
                            "Used worktree/shell tools (worktree={}, shell={})",
                            worktree_calls, shell_worktree_calls
                        ),
                        worktree_calls >= 2 || (worktree_calls + shell_worktree_calls) >= 2,
                    ),
                    (
                        "Mentions branch or worktree creation",
                        content.contains("feature-e2e")
                            || content.contains("worktree")
                            || content.contains("branch"),
                    ),
                    (
                        "Agent completed enter/exit cycle",
                        content.contains("exit")
                            || content.contains("removed")
                            || content.contains("done")
                            || content.contains("success")
                            || content.contains("complet"),
                    ),
                ],
            )
        }
    }
}

/// `worktree` requires coding capability, so OS Agent sessions must not see it.
pub async fn worktree_tool_hidden_from_os_agent(cfg: &Config) -> bool {
    let session_id = format!("{}-wt-hidden-os", cfg.session_prefix);

    println!("  [step 1] Initialising OS Agent session...");
    if let Err(err) = harness::send_os_message(cfg, "Say hello briefly.", &session_id).await {
        return harness::print_error("Worktree Hidden From OS Agent", &err);
    }

    println!("  [step 2] Fetching session-scoped effective tools for OS Agent session...");
    match harness::fetch_effective_tools(cfg, &session_id, "build").await {
        Err(err) => harness::print_error("Worktree Hidden From OS Agent", &err),
        Ok(effective_tools) => {
            let prompt_tool_names = effective_tools.prompt_tool_names;
            let worktree_absent = !prompt_tool_names.iter().any(|name| name == "worktree");
            let manage_workspace_present = prompt_tool_names
                .iter()
                .any(|name| name == "manage_workspace");

            println!(
                "    OS Agent effective prompt tools ({} total): {}",
                prompt_tool_names.len(),
                prompt_tool_names.join(", ")
            );

            harness::print_result(
                "Worktree Hidden From OS Agent",
                &format!(
                    "tools={}, worktree_absent={}, manage_workspace_present={}",
                    prompt_tool_names.len(),
                    worktree_absent,
                    manage_workspace_present
                ),
                &[
                    (
                        "`worktree` absent from OS Agent effective prompt tools (CapCoding gate)",
                        worktree_absent,
                    ),
                    (
                        "`manage_workspace` present (positive control — OS Agent has Core tools)",
                        manage_workspace_present,
                    ),
                ],
            )
        }
    }
}
