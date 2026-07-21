//! External process helpers and the managed benchmark Python environment.

use std::fs;
use std::path::{Path, PathBuf};

use tokio::process::Command;

use super::paths::{benchmark_python_env_dir, benchmark_python_path};
use super::BENCHMARK_PYTHON_PACKAGES;

pub(super) async fn command_version(command: &str, args: &[&str]) -> Result<String, String> {
    run_command_for_stdout(None, command, args).await
}

pub(super) async fn command_version_in_dir(
    cwd: &Path,
    command: &str,
    args: &[&str],
) -> Result<String, String> {
    run_command_for_stdout(Some(cwd), command, args).await
}

async fn run_command_for_stdout(
    cwd: Option<&Path>,
    command: &str,
    args: &[&str],
) -> Result<String, String> {
    let mut command_builder = Command::new(command);
    command_builder.args(args);
    if let Some(current_dir) = cwd {
        command_builder.current_dir(current_dir);
    }
    let output = command_builder
        .output()
        .await
        .map_err(|error| format!("Failed to run {command}: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("{command} exited with {}", output.status)
        } else {
            stderr
        });
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(stdout)
}

pub(super) async fn ensure_benchmark_python_env() -> Result<PathBuf, String> {
    let env_dir = benchmark_python_env_dir();
    let python_path = benchmark_python_path();
    if !python_path.is_file() {
        fs::create_dir_all(
            env_dir
                .parent()
                .ok_or_else(|| "Invalid benchmark Python environment path".to_string())?,
        )
        .map_err(|error| format!("Failed to create benchmark Python env directory: {error}"))?;

        let uv_result = Command::new("uv")
            .arg("venv")
            .arg("--python")
            .arg("python3")
            .arg(&env_dir)
            .output()
            .await;
        let created_with_uv = uv_result
            .as_ref()
            .map(|output| output.status.success())
            .unwrap_or(false);
        if !created_with_uv {
            let output = Command::new("python3")
                .arg("-m")
                .arg("venv")
                .arg(&env_dir)
                .output()
                .await
                .map_err(|error| format!("Failed to create benchmark Python venv: {error}"))?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                return Err(if stderr.is_empty() {
                    format!("python3 -m venv exited with {}", output.status)
                } else {
                    stderr
                });
            }
        }
    }

    if benchmark_python_packages_ready(&python_path).await {
        return Ok(python_path);
    }

    install_benchmark_python_packages(&python_path).await?;
    if benchmark_python_packages_ready(&python_path).await {
        Ok(python_path)
    } else {
        Err("Benchmark Python packages were installed but import checks still fail".to_string())
    }
}

async fn benchmark_python_packages_ready(python_path: &Path) -> bool {
    for package_name in BENCHMARK_PYTHON_PACKAGES {
        if run_python_import(python_path, package_name).await.is_err() {
            return false;
        }
    }
    true
}

async fn install_benchmark_python_packages(python_path: &Path) -> Result<(), String> {
    let uv_output = Command::new("uv")
        .arg("pip")
        .arg("install")
        .arg("--python")
        .arg(python_path)
        .arg("--upgrade")
        .arg("--force-reinstall")
        .args(BENCHMARK_PYTHON_PACKAGES.iter().copied())
        .output()
        .await;
    if let Ok(output) = uv_output {
        if output.status.success() {
            return Ok(());
        }
    }

    let ensurepip_output = Command::new(python_path)
        .arg("-m")
        .arg("ensurepip")
        .arg("--upgrade")
        .output()
        .await
        .map_err(|error| format!("Failed to bootstrap benchmark Python pip: {error}"))?;
    if !ensurepip_output.status.success() {
        let stderr = String::from_utf8_lossy(&ensurepip_output.stderr)
            .trim()
            .to_string();
        return Err(if stderr.is_empty() {
            format!("ensurepip exited with {}", ensurepip_output.status)
        } else {
            stderr
        });
    }

    let output = Command::new(python_path)
        .arg("-m")
        .arg("pip")
        .arg("install")
        .arg("--upgrade")
        .arg("--force-reinstall")
        .args(BENCHMARK_PYTHON_PACKAGES.iter().copied())
        .output()
        .await
        .map_err(|error| format!("Failed to install benchmark Python packages: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        format!(
            "Benchmark Python package install exited with {}",
            output.status
        )
    } else {
        stderr
    })
}

pub(super) async fn run_python_import(
    python_path: &Path,
    package_name: &str,
) -> Result<String, String> {
    let output = Command::new(python_path)
        .arg("-c")
        .arg(format!(
            "import {package_name}; print(getattr({package_name}, '__version__', 'ok'))"
        ))
        .output()
        .await
        .map_err(|error| format!("Failed to run {}: {error}", python_path.display()))?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        format!("{} exited with {}", python_path.display(), output.status)
    } else {
        stderr
    })
}

pub(super) async fn terminate_process(process_id: u32) -> Result<(), String> {
    #[cfg(unix)]
    let output = Command::new("kill")
        .arg("-TERM")
        .arg(process_id.to_string())
        .output()
        .await;

    #[cfg(windows)]
    let output = Command::new("taskkill")
        .arg("/PID")
        .arg(process_id.to_string())
        .arg("/T")
        .arg("/F")
        .output()
        .await;

    let output =
        output.map_err(|error| format!("Failed to terminate process {process_id}: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("Process termination exited with {}", output.status)
        } else {
            stderr
        })
    }
}
