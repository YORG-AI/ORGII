//! Fixed GitHub Star commands for the canonical ORG2 repository.
//!
//! These commands intentionally accept no endpoint or repository arguments. All
//! `gh` invocations use an explicit hostname and pass arguments directly without
//! a shell.

use std::{io, process::Output, time::Duration};

use serde::Serialize;
use tokio::process::Command;

const GITHUB_HOST: &str = "github.com";
const ORG2_STAR_ENDPOINT: &str = "/user/starred/yorgai/ORG2";
const GH_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum OrgiiStarResult {
    Starred,
    NotStarred,
    Unavailable { reason: OrgiiStarUnavailableReason },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OrgiiStarUnavailableReason {
    GhMissing,
    NotAuthenticated,
    Network,
    Permission,
    Timeout,
    Unexpected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StarOperation {
    Check,
    Star,
}

impl StarOperation {
    fn method(self) -> &'static str {
        match self {
            Self::Check => "GET",
            Self::Star => "PUT",
        }
    }

    fn args(self) -> [&'static str; 7] {
        [
            "api",
            "--hostname",
            GITHUB_HOST,
            "--method",
            self.method(),
            "--include",
            ORG2_STAR_ENDPOINT,
        ]
    }
}

#[derive(Debug)]
enum ExecutionResult {
    Completed(Output),
    SpawnFailed(io::ErrorKind),
    TimedOut,
}

/// Check whether the authenticated GitHub CLI account starred yorgai/ORG2.
#[tauri::command]
pub async fn check_orgii_star() -> OrgiiStarResult {
    execute(StarOperation::Check).await
}

/// Star yorgai/ORG2 with the authenticated GitHub CLI account.
#[tauri::command]
pub async fn star_orgii() -> OrgiiStarResult {
    execute(StarOperation::Star).await
}

async fn execute(operation: StarOperation) -> OrgiiStarResult {
    let mut command = Command::new("gh");
    command.args(operation.args()).kill_on_drop(true);
    hide_console(&mut command);

    let execution = match tokio::time::timeout(GH_TIMEOUT, command.output()).await {
        Ok(Ok(output)) => ExecutionResult::Completed(output),
        Ok(Err(error)) => ExecutionResult::SpawnFailed(error.kind()),
        Err(_) => ExecutionResult::TimedOut,
    };

    classify_execution(operation, execution)
}

#[cfg(windows)]
fn hide_console(command: &mut Command) {
    use std::os::windows::process::CommandExt;

    command.creation_flags(app_platform::CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console(_command: &mut Command) {}

fn classify_execution(operation: StarOperation, execution: ExecutionResult) -> OrgiiStarResult {
    match execution {
        ExecutionResult::TimedOut => unavailable(OrgiiStarUnavailableReason::Timeout),
        ExecutionResult::SpawnFailed(io::ErrorKind::NotFound) => {
            unavailable(OrgiiStarUnavailableReason::GhMissing)
        }
        ExecutionResult::SpawnFailed(io::ErrorKind::PermissionDenied) => {
            unavailable(OrgiiStarUnavailableReason::Permission)
        }
        ExecutionResult::SpawnFailed(_) => unavailable(OrgiiStarUnavailableReason::Unexpected),
        ExecutionResult::Completed(output) => classify_output(operation, &output),
    }
}

fn classify_output(operation: StarOperation, output: &Output) -> OrgiiStarResult {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let diagnostics = format!("{stdout}\n{stderr}").to_ascii_lowercase();
    let status = http_status(&diagnostics);

    if status == Some(404) {
        return OrgiiStarResult::NotStarred;
    }

    if output.status.success() {
        return match operation {
            StarOperation::Check | StarOperation::Star => OrgiiStarResult::Starred,
        };
    }

    let reason = if status == Some(401)
        || contains_any(
            &diagnostics,
            &[
                "gh auth login",
                "not logged into",
                "authentication required",
                "authentication token missing",
                "bad credentials",
            ],
        ) {
        OrgiiStarUnavailableReason::NotAuthenticated
    } else if status == Some(403)
        || contains_any(
            &diagnostics,
            &[
                "forbidden",
                "resource not accessible",
                "permission denied",
                "insufficient scope",
            ],
        )
    {
        OrgiiStarUnavailableReason::Permission
    } else if contains_any(
        &diagnostics,
        &[
            "could not resolve host",
            "connection refused",
            "connection reset",
            "error connecting",
            "network is unreachable",
            "tls handshake",
            "temporary failure in name resolution",
        ],
    ) {
        OrgiiStarUnavailableReason::Network
    } else {
        OrgiiStarUnavailableReason::Unexpected
    };

    unavailable(reason)
}

fn unavailable(reason: OrgiiStarUnavailableReason) -> OrgiiStarResult {
    OrgiiStarResult::Unavailable { reason }
}

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| haystack.contains(needle))
}

fn http_status(diagnostics: &str) -> Option<u16> {
    diagnostics.lines().find_map(|line| {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("http/") {
            return rest
                .split_whitespace()
                .nth(1)
                .and_then(|status| status.parse().ok());
        }

        let marker = "(http ";
        let start = line.find(marker)? + marker.len();
        let status = line.get(start..)?.split(')').next()?;
        status.parse().ok()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::ExitStatus;

    #[cfg(unix)]
    fn exit_status(code: i32) -> ExitStatus {
        use std::os::unix::process::ExitStatusExt;
        ExitStatus::from_raw(code << 8)
    }

    #[cfg(windows)]
    fn exit_status(code: i32) -> ExitStatus {
        use std::os::windows::process::ExitStatusExt;
        ExitStatus::from_raw(code as u32)
    }

    fn output(code: i32, stdout: &str, stderr: &str) -> Output {
        Output {
            status: exit_status(code),
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.as_bytes().to_vec(),
        }
    }

    #[test]
    fn commands_use_fixed_args_and_hostname() {
        assert_eq!(
            StarOperation::Check.args(),
            [
                "api",
                "--hostname",
                "github.com",
                "--method",
                "GET",
                "--include",
                "/user/starred/yorgai/ORG2",
            ]
        );
        assert_eq!(StarOperation::Star.args()[4], "PUT");
        assert_eq!(StarOperation::Star.args()[6], ORG2_STAR_ENDPOINT);
    }

    #[test]
    fn check_maps_200_and_204_to_starred() {
        for status in [200, 204] {
            let result = classify_output(
                StarOperation::Check,
                &output(0, &format!("HTTP/2 {status}\r\n"), ""),
            );
            assert_eq!(result, OrgiiStarResult::Starred);
        }
    }

    #[test]
    fn put_success_maps_to_starred() {
        assert_eq!(
            classify_output(StarOperation::Star, &output(0, "HTTP/2 204\r\n", "")),
            OrgiiStarResult::Starred
        );
    }

    #[test]
    fn only_404_maps_to_not_starred() {
        assert_eq!(
            classify_output(
                StarOperation::Check,
                &output(1, "", "gh: Not Found (HTTP 404)")
            ),
            OrgiiStarResult::NotStarred
        );
        assert_ne!(
            classify_output(
                StarOperation::Check,
                &output(1, "", "gh: server error (HTTP 500)")
            ),
            OrgiiStarResult::NotStarred
        );
    }

    #[test]
    fn classifies_unavailable_reasons() {
        let cases = [
            (
                "gh: authentication required; run gh auth login",
                OrgiiStarUnavailableReason::NotAuthenticated,
            ),
            (
                "gh: Resource not accessible by personal access token (HTTP 403)",
                OrgiiStarUnavailableReason::Permission,
            ),
            (
                "error connecting to api.github.com: network is unreachable",
                OrgiiStarUnavailableReason::Network,
            ),
            (
                "gh: server error (HTTP 500)",
                OrgiiStarUnavailableReason::Unexpected,
            ),
        ];

        for (stderr, reason) in cases {
            assert_eq!(
                classify_output(StarOperation::Check, &output(1, "", stderr)),
                unavailable(reason)
            );
        }
    }

    #[test]
    fn classifies_spawn_and_timeout_failures() {
        assert_eq!(
            classify_execution(
                StarOperation::Check,
                ExecutionResult::SpawnFailed(io::ErrorKind::NotFound)
            ),
            unavailable(OrgiiStarUnavailableReason::GhMissing)
        );
        assert_eq!(
            classify_execution(StarOperation::Check, ExecutionResult::TimedOut),
            unavailable(OrgiiStarUnavailableReason::Timeout)
        );
        assert_eq!(
            classify_execution(
                StarOperation::Check,
                ExecutionResult::SpawnFailed(io::ErrorKind::PermissionDenied)
            ),
            unavailable(OrgiiStarUnavailableReason::Permission)
        );
    }

    #[test]
    fn serialization_is_tagged_and_does_not_include_diagnostics() {
        assert_eq!(
            serde_json::to_value(OrgiiStarResult::Starred).unwrap(),
            serde_json::json!({ "status": "starred" })
        );
        assert_eq!(
            serde_json::to_value(unavailable(OrgiiStarUnavailableReason::Network)).unwrap(),
            serde_json::json!({ "status": "unavailable", "reason": "network" })
        );
    }
}
