/// Install commands for each CLI agent.
///
/// Returns (program, args) tuples. For pipe-style installers (curl | bash),
/// the program is "bash" with a "-c" arg wrapping the full command.
fn cli_install_commands(agent: &str) -> Result<Vec<Vec<String>>, String> {
    let commands = match agent {
        "claude_code" => vec![
            vec![
                "bash".into(),
                "-c".into(),
                "curl -fsSL https://claude.ai/install.sh | bash".into(),
            ],
            vec![
                "npm".into(),
                "install".into(),
                "-g".into(),
                "@anthropic-ai/claude-code".into(),
            ],
        ],
        "codex" => vec![vec![
            "npm".into(),
            "install".into(),
            "-g".into(),
            "@openai/codex".into(),
        ]],
        "copilot" => vec![vec![
            "npm".into(),
            "install".into(),
            "-g".into(),
            "@github/copilot".into(),
        ]],
        "cursor_cli" => {
            if cfg!(windows) {
                vec![vec![
                    "powershell".into(),
                    "-Command".into(),
                    "irm 'https://cursor.com/install?win32=true' | iex".into(),
                ]]
            } else {
                vec![vec![
                    "bash".into(),
                    "-c".into(),
                    "curl -fsSL https://cursor.com/install | bash".into(),
                ]]
            }
        }
        "kiro" => {
            if cfg!(windows) {
                return Err("Kiro CLI auto-install is not supported on Windows. \
                    Download from https://kiro.dev/docs/cli/installation/"
                    .to_string());
            }
            vec![vec![
                "bash".into(),
                "-c".into(),
                "curl -fsSL https://cli.kiro.dev/install | bash".into(),
            ]]
        }
        other => {
            return Err(format!("No auto-install available for '{}'", other));
        }
    };
    Ok(commands)
}

/// Auto-install a CLI agent by name.
///
/// Tries each install command in order. Returns Ok(()) if any succeeds.
/// Called from the Settings > Agent > CLI config page.
#[tauri::command]
pub async fn auto_install_cli(agent: String) -> Result<(), String> {
    let commands = cli_install_commands(&agent)?;

    for cmd_parts in &commands {
        let program = &cmd_parts[0];
        let args = &cmd_parts[1..];

        tracing::info!("[auto_install_cli] Running: {} {}", program, args.join(" "));

        let which_cmd = if cfg!(windows) { "where" } else { "which" };
        let mut which_command = tokio::process::Command::new(which_cmd);
        which_command.arg(program);
        // Suppress the `where`/`which` console window on Windows.
        #[cfg(windows)]
        which_command.creation_flags(app_platform::CREATE_NO_WINDOW);
        let installer_exists = which_command
            .output()
            .await
            .map(|o| o.status.success())
            .unwrap_or(false);

        if !installer_exists {
            tracing::warn!(
                "[auto_install_cli] Installer '{}' not found, skipping",
                program
            );
            continue;
        }

        let install_future = async {
            let mut install_command = tokio::process::Command::new(program);
            install_command
                .args(args)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            // Suppress the installer's console window on Windows.
            #[cfg(windows)]
            install_command.creation_flags(app_platform::CREATE_NO_WINDOW);
            let child = install_command
                .spawn()
                .map_err(|e| format!("Failed to run {}: {}", program, e))?;

            child
                .wait_with_output()
                .await
                .map_err(|e| format!("Install process error: {}", e))
        };

        let result =
            tokio::time::timeout(tokio::time::Duration::from_secs(120), install_future).await;

        match result {
            Ok(Ok(output)) if output.status.success() => {
                tracing::info!("[auto_install_cli] Install succeeded via {}", program);
                return Ok(());
            }
            Ok(Ok(output)) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                tracing::warn!(
                    "[auto_install_cli] Install via {} failed (exit {}): {}",
                    program,
                    output.status.code().unwrap_or(-1),
                    stderr.trim()
                );
            }
            Ok(Err(err)) => {
                tracing::warn!("[auto_install_cli] Install via {} error: {}", program, err);
            }
            Err(_) => {
                tracing::warn!(
                    "[auto_install_cli] Install via {} timed out (120s)",
                    program
                );
            }
        }
    }

    Err(format!("All install methods failed for '{}'. Check that the required package manager (npm, brew, pipx, or curl) is available.", agent))
}
