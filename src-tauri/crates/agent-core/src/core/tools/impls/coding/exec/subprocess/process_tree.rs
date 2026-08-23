//! Platform-specific subprocess-tree termination.

use super::super::registry;

pub(super) async fn terminate_child_tree(
    pid: u32,
    child: &mut tokio::process::Child,
) -> Result<(), String> {
    if pid == 0 {
        child
            .kill()
            .await
            .map_err(|error| format!("failed to kill child without PID: {error}"))?;
        return child
            .wait()
            .await
            .map(|_| ())
            .map_err(|error| format!("failed to reap child without PID: {error}"));
    }

    let (tree_result, child_result) =
        tokio::join!(registry::terminate_shell_process_tree(pid), child.wait());
    let mut failures = Vec::new();
    if let Err(error) = tree_result {
        failures.push(error);
    }
    if let Err(error) = child_result {
        failures.push(format!("failed to reap shell process {pid}: {error}"));
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}
