use std::path::PathBuf;

use crate::tools::impls::coding::exec::registry::{self, JobStatus};

#[test]
fn test_list_running_shell_jobs_includes_running() {
    let pid = 88801;
    let _tx = registry::register_shell_replay(
        pid,
        "npm run dev".into(),
        PathBuf::from("/tmp/88801.log"),
        "session_recon_a".into(),
        "call_recon_a".into(),
    );

    let jobs = registry::list_running_shell_jobs();
    let found = jobs.iter().find(|j| j.pid == pid);
    assert!(found.is_some(), "running shell job should appear in list");

    let job = found.unwrap();
    assert_eq!(job.session_id, "session_recon_a");
    assert_eq!(job.call_id, "call_recon_a");
    assert_eq!(job.command, "npm run dev");

    registry::remove(&pid.to_string());
}

#[test]
fn test_list_running_shell_jobs_excludes_exited() {
    let pid = 88802;
    let _tx = registry::register_shell_replay(
        pid,
        "echo done".into(),
        PathBuf::from("/tmp/88802.log"),
        "session_recon_b".into(),
        "call_recon_b".into(),
    );
    registry::mark_exited(&pid.to_string(), JobStatus::Exited(0));

    let jobs = registry::list_running_shell_jobs();
    assert!(
        !jobs.iter().any(|j| j.pid == pid),
        "exited shell job should not appear in running list"
    );

    registry::remove(&pid.to_string());
}

#[test]
fn test_list_running_shell_jobs_excludes_legacy_job_without_call_id() {
    let pid = 88803;
    let _tx = registry::register_shell(
        pid,
        "legacy".into(),
        PathBuf::from("/tmp/88803.log"),
        "session_recon_legacy".into(),
    );
    assert!(!registry::list_running_shell_jobs()
        .iter()
        .any(|job| job.pid == pid));
    registry::remove(&pid.to_string());
}

#[test]
fn test_list_running_shell_jobs_keeps_concurrent_calls_exact() {
    let session_id = "session_recon_concurrent";
    let jobs = [(88811, "call-a"), (88812, "call-b")];
    for (pid, call_id) in jobs {
        let _tx = registry::register_shell_replay(
            pid,
            format!("emit {call_id}"),
            PathBuf::from(format!("/tmp/{pid}.slog")),
            session_id.into(),
            call_id.into(),
        );
    }

    let running = registry::list_running_shell_jobs();
    for (pid, call_id) in jobs {
        let exact = running
            .iter()
            .find(|job| job.pid == pid)
            .expect("concurrent job should be listed");
        assert_eq!(exact.session_id, session_id);
        assert_eq!(exact.call_id, call_id);
        registry::remove(&pid.to_string());
    }
}

#[test]
fn test_list_running_shell_jobs_excludes_subagents() {
    let handle = "agent-recon-test:explore-001".to_string();
    let (_tx, _cancel) = registry::register_subagent(
        handle.clone(),
        "explore".into(),
        "Explorer".into(),
        "session_recon_c".into(),
    );

    let jobs = registry::list_running_shell_jobs();
    assert!(
        !jobs.iter().any(|j| j.session_id == "session_recon_c"),
        "subagent should not appear in shell job list"
    );

    registry::remove(&handle);
}
