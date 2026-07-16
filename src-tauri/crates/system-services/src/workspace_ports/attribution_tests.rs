use super::*;
use crate::workspace_ports::types::{WorkspacePortAttributionConfidence, WorkspacePortProbe};

#[test]
fn attributes_by_cwd_descendant() {
    let folders = normalize_workspace_port_probes(&[WorkspacePortProbe {
        id: "folder-1".to_string(),
        repo_id: "repo-1".to_string(),
        display_name: "app".to_string(),
        path: "/Users/dev/app".to_string(),
    }]);
    let owner = attribute_port_to_workspaces(Some("/Users/dev/app/packages/web"), None, &folders)
        .expect("cwd match");
    assert_eq!(owner.folder_id, "folder-1");
    assert_eq!(owner.confidence, WorkspacePortAttributionConfidence::Cwd);
}

#[test]
fn attributes_by_command_line_path_boundary() {
    let folders = normalize_workspace_port_probes(&[WorkspacePortProbe {
        id: "folder-1".to_string(),
        repo_id: "repo-1".to_string(),
        display_name: "app".to_string(),
        path: "/Users/dev/app".to_string(),
    }]);
    let owner = attribute_port_to_workspaces(
        None,
        Some("node /Users/dev/app/node_modules/.bin/vite"),
        &folders,
    )
    .expect("command match");
    assert_eq!(
        owner.confidence,
        WorkspacePortAttributionConfidence::Command
    );
}

#[test]
fn prefers_deepest_matching_folder() {
    let folders = normalize_workspace_port_probes(&[
        WorkspacePortProbe {
            id: "root".to_string(),
            repo_id: "repo-1".to_string(),
            display_name: "root".to_string(),
            path: "/Users/dev/monorepo".to_string(),
        },
        WorkspacePortProbe {
            id: "nested".to_string(),
            repo_id: "repo-2".to_string(),
            display_name: "nested".to_string(),
            path: "/Users/dev/monorepo/apps/web".to_string(),
        },
    ]);
    let owner =
        attribute_port_to_workspaces(Some("/Users/dev/monorepo/apps/web/src"), None, &folders)
            .expect("deepest match");
    assert_eq!(owner.folder_id, "nested");
}

#[test]
fn rejects_partial_path_prefix_without_boundary() {
    let folders = normalize_workspace_port_probes(&[WorkspacePortProbe {
        id: "folder-1".to_string(),
        repo_id: "repo-1".to_string(),
        display_name: "app".to_string(),
        path: "/Users/dev/app".to_string(),
    }]);
    let owner =
        attribute_port_to_workspaces(None, Some("node /Users/dev/apple/server.js"), &folders);
    assert!(owner.is_none());
}
