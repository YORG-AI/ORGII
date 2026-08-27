//! Environment injection for integrated subprocesses.

use tracing::warn;

/// Inject the orgtrack identity for agent-plane CLI calls (design M6):
/// `org2-pm` resolves actor/session/scope/mode from these instead of
/// trusting model-typed flags, and the host binary directory rides the
/// front of PATH so the bundled CLI always matches the app version.
///
/// Subagents resolve to their top-level ancestor: the workspace marker
/// (`agent_session_context.json`) is bound to the session that owns the
/// workspace, so the injected identity must match it or every CLI call
/// from a worker sharing that workspace would be refused as spoofing.
pub(super) fn configure_orgtrack_environment(cmd: &mut tokio::process::Command, session_id: &str) {
    let mut session_id = session_id.to_string();
    let mut record = match crate::session::persistence::get_session(&session_id) {
        Ok(Some(record)) => record,
        _ => return,
    };
    for _ in 0..16 {
        let Some(parent_id) = record.parent_session_id.clone() else {
            break;
        };
        match crate::session::persistence::get_session(&parent_id) {
            Ok(Some(parent)) => {
                session_id = parent_id;
                record = parent;
            }
            _ => break,
        }
    }
    cmd.env("ORGII_SESSION_REF", format!("org2:{session_id}"));
    let agent = record
        .agent_definition_id
        .as_deref()
        .unwrap_or("os")
        .trim_start_matches("builtin:")
        .to_string();
    cmd.env("ORGII_ACTOR", format!("agent:{agent}"));
    cmd.env(
        "ORGII_MODE",
        record.product_mode.as_deref().unwrap_or("build"),
    );
    if let Some(slug) = record.project_slug.as_deref() {
        cmd.env("ORGII_SCOPE", slug);
    }
    if let Some(org) =
        project_management::projects::io::resolve_local_org_scope(record.org_id.as_deref())
    {
        cmd.env("ORGII_ORG", org);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let base_path = cmd
                .as_std()
                .get_envs()
                .find(|(key, _)| *key == std::ffi::OsStr::new("PATH"))
                .and_then(|(_, value)| value.map(|value| value.to_os_string()))
                .or_else(|| std::env::var_os("PATH"));
            let mut paths = vec![dir.to_path_buf()];
            if let Some(existing_path) = base_path {
                paths.extend(std::env::split_paths(&existing_path));
            }
            if let Ok(joined_path) = std::env::join_paths(paths) {
                cmd.env("PATH", joined_path);
            }
        }
    }
}

pub(super) fn configure_git_environment(cmd: &mut tokio::process::Command) {
    let resolved = match git::resolved_git_executable_details() {
        Ok(resolved) => resolved,
        Err(err) => {
            warn!("[subprocess] Git executable resolution failed: {err}");
            return;
        }
    };
    if let Some(git_bin_dir) = resolved.path.parent() {
        let mut paths = vec![git_bin_dir.to_path_buf()];
        if let Some(existing_path) = std::env::var_os("PATH") {
            paths.extend(std::env::split_paths(&existing_path));
        }
        match std::env::join_paths(paths) {
            Ok(joined_path) => {
                cmd.env("PATH", joined_path);
            }
            Err(err) => warn!("[subprocess] failed to join PATH with Git directory: {err}"),
        }
    }
}
