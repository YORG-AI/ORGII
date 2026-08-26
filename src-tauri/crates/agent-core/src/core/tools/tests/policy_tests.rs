use crate::tools::policy::*;

#[test]
fn test_layer_allow_all() {
    let layer = ToolPolicyLayer::allow_all();
    assert!(layer.is_allowed("run_shell"));
    assert!(layer.is_allowed("anything"));
}

#[test]
fn test_layer_deny_specific() {
    // `control_orgii` was used here as a second representative denied name.
    // The tool is disabled; any arbitrary name works for this layer test.
    let layer =
        ToolPolicyLayer::deny_only(vec!["run_shell".to_string(), "manage_nodes".to_string()]);
    assert!(!layer.is_allowed("run_shell"));
    assert!(!layer.is_allowed("manage_nodes"));
    assert!(layer.is_allowed("read_file"));
}

#[test]
fn test_layer_allow_specific() {
    let layer = ToolPolicyLayer {
        allow: Some(vec!["read_file".to_string(), "list_dir".to_string()]),
        deny: Vec::new(),
    };
    assert!(layer.is_allowed("read_file"));
    assert!(layer.is_allowed("list_dir"));
    assert!(!layer.is_allowed("run_shell"));
}

#[test]
fn test_deny_wins_over_allow() {
    let layer = ToolPolicyLayer {
        allow: Some(vec!["run_shell".to_string()]),
        deny: vec!["run_shell".to_string()],
    };
    assert!(!layer.is_allowed("run_shell"));
}

#[test]
fn test_group_expansion() {
    let layer = ToolPolicyLayer {
        allow: Some(vec![GROUP_WEB.to_string()]),
        deny: Vec::new(),
    };
    assert!(layer.is_allowed("web_search"));
    assert!(layer.is_allowed("web_fetch"));
    assert!(!layer.is_allowed("control_desktop_with_peekaboo"));
    assert!(!layer.is_allowed("run_shell"));
}

#[test]
fn test_desktop_group_expansion() {
    let layer = ToolPolicyLayer {
        allow: Some(vec![GROUP_DESKTOP.to_string()]),
        deny: Vec::new(),
    };
    assert!(layer.is_allowed("control_desktop_with_peekaboo"));
    assert!(!layer.is_allowed("list_apps"));
    assert!(!layer.is_allowed("click"));
    assert!(!layer.is_allowed("web_search"));
    assert!(!layer.is_allowed("run_shell"));
}

#[test]
fn test_group_deny() {
    let layer = ToolPolicyLayer {
        allow: None,
        deny: vec!["group:comms".to_string()],
    };
    assert!(!layer.is_allowed("send_message"));
    assert!(layer.is_allowed("run_shell"));
}

#[test]
fn test_wildcard_allow() {
    let layer = ToolPolicyLayer {
        allow: Some(vec!["*".to_string()]),
        deny: Vec::new(),
    };
    assert!(layer.is_allowed("anything"));
}

#[test]
fn test_glob_pattern() {
    let layer = ToolPolicyLayer {
        allow: Some(vec!["session_*".to_string()]),
        deny: Vec::new(),
    };
    assert!(layer.is_allowed("session_create"));
    assert!(layer.is_allowed("session_monitor"));
    assert!(!layer.is_allowed("run_shell"));
}

#[test]
fn test_empty_allow_denies_all() {
    let layer = ToolPolicyLayer {
        allow: Some(Vec::new()),
        deny: Vec::new(),
    };
    assert!(!layer.is_allowed("run_shell"));
}

#[test]
fn test_resolved_multi_layer() {
    let policy = ResolvedToolPolicy {
        layers: vec![
            ToolPolicyLayer {
                allow: Some(vec!["group:fs".to_string(), "group:runtime".to_string()]),
                deny: Vec::new(),
            },
            ToolPolicyLayer {
                allow: None,
                deny: vec!["run_shell".to_string()],
            },
        ],
        ask_tools: Vec::new(),
        agent_org_turn_profile: None,
    };

    assert!(policy.is_allowed("read_file"));
    assert!(!policy.is_allowed("run_shell"));
    assert!(!policy.is_allowed("send_message"));
}

#[test]
fn test_resolved_permissive() {
    let policy = ResolvedToolPolicy::permissive();
    assert!(policy.is_allowed("anything"));
    assert!(policy.is_allowed("run_shell"));
}

#[test]
fn test_permissive_default_allows_everything() {
    // `permissive()` is a no-op base policy (no layers). All tool access
    // flows through `excludedTools` (off at registration time) and
    // the runtime access-mode tool policy.
    let policy = ResolvedToolPolicy::permissive();
    assert_eq!(policy.verdict("run_shell"), ToolVerdict::Allow);
    assert_eq!(policy.verdict("read_file"), ToolVerdict::Allow);
    assert_eq!(policy.verdict("edit_file"), ToolVerdict::Allow);
    assert_eq!(policy.verdict("send_message"), ToolVerdict::Allow);
}

#[test]
fn user_directed_worker_hides_graph_but_keeps_real_work_tools() {
    let mut policy = ResolvedToolPolicy::permissive();
    policy.agent_org_turn_profile = Some(AgentOrgTurnToolProfile::UserDirectedWorker);

    assert!(!policy.is_allowed(crate::tools::names::TASK_CREATE));
    assert!(!policy.is_allowed(crate::tools::names::TASK_GRAPH_CREATE));
    assert!(!policy.is_allowed(crate::tools::names::TASK_UPDATE));
    assert!(policy.is_allowed("read_file"));
    assert!(policy.is_allowed("write_file"));
    assert!(policy.is_allowed("run_shell"));
}

#[test]
fn user_directed_writer_sees_only_graph_task_update_operations() {
    let mut policy = ResolvedToolPolicy::permissive();
    policy.agent_org_turn_profile = Some(AgentOrgTurnToolProfile::UserDirectedWriter);
    assert!(policy.is_allowed(crate::tools::names::TASK_CREATE));
    assert!(policy.is_allowed(crate::tools::names::TASK_GRAPH_CREATE));
    assert!(policy.is_allowed(crate::tools::names::TASK_UPDATE));
    assert!(!policy.is_allowed(crate::tools::names::ORG_RUN_COMPLETE));

    let filtered = policy.filter_definitions(vec![serde_json::json!({
        "type": "function",
        "function": {
            "name": crate::tools::names::TASK_UPDATE,
            "parameters": {
                "properties": {
                    "operation": {
                        "enum": [
                            "patch_pending",
                            "cancel",
                            "cancel_and_replace",
                            "append_audit_note",
                            "start",
                            "complete",
                            "fail"
                        ]
                    }
                }
            }
        }
    })]);
    let operations = filtered[0]
        .pointer("/function/parameters/properties/operation/enum")
        .and_then(serde_json::Value::as_array)
        .expect("filtered operation enum");
    assert_eq!(
        operations,
        serde_json::json!([
            "patch_pending",
            "cancel",
            "cancel_and_replace",
            "append_audit_note"
        ])
        .as_array()
        .unwrap()
    );
}

#[test]
fn test_filter_definitions() {
    let policy = ResolvedToolPolicy {
        layers: vec![ToolPolicyLayer {
            allow: Some(vec!["read_file".to_string()]),
            deny: Vec::new(),
        }],
        ask_tools: Vec::new(),
        agent_org_turn_profile: None,
    };

    let defs = vec![
        serde_json::json!({"function": {"name": "read_file"}}),
        serde_json::json!({"function": {"name": "run_shell"}}),
        serde_json::json!({"function": {"name": "web_search"}}),
    ];

    let filtered = policy.filter_definitions(defs);
    assert_eq!(filtered.len(), 1);
    assert_eq!(
        filtered[0]
            .pointer("/function/name")
            .unwrap()
            .as_str()
            .unwrap(),
        "read_file"
    );
}

#[test]
fn test_readonly_access_mode_denies_write_tools() {
    use crate::foundation::security::policy::AutonomyLevel;
    use crate::tools::policy::ToolPolicyLayer;

    let base = ResolvedToolPolicy::permissive();
    let policy = base.with_extra_layer(ToolPolicyLayer::deny_only(
        AutonomyLevel::ReadOnly.deny_tools(),
    ));

    assert_eq!(policy.verdict("run_shell"), ToolVerdict::Deny);
    assert_eq!(policy.verdict("edit_file"), ToolVerdict::Deny);
}

#[test]
fn test_with_ask_tools_full_autonomy() {
    use crate::foundation::security::policy::AutonomyLevel;

    let base = ResolvedToolPolicy::permissive();
    let policy = base.with_ask_tools(AutonomyLevel::Full.ask_tools());

    assert_eq!(policy.verdict("run_shell"), ToolVerdict::Allow);
    assert_eq!(policy.verdict("edit_file"), ToolVerdict::Allow);
}

// ============================================
// AgentExecMode layering via with_extra_layer
// --------------------------------------------
// These pin the 2026-04-13 audit fix: `AgentExecMode::policy_layer()`
// must be composable on top of the base `ResolvedToolPolicy` using
// `with_extra_layer`, because that's how `UnifiedProcessor` now
// enforces mode-specific restrictions at turn-execute time.
// ============================================

#[test]
fn with_extra_layer_applies_plan_mode_deny_delta() {
    use crate::session::AgentExecMode;

    let base = ResolvedToolPolicy::permissive();
    assert_eq!(
        base.verdict("edit_file"),
        ToolVerdict::Allow,
        "default policy must let edit_file through before the plan overlay"
    );

    let layer = AgentExecMode::Plan
        .policy_layer()
        .expect("plan mode must contribute a policy layer");
    assert!(
        layer.allow.is_none(),
        "plan mode must use deny-delta (allow=None), not an independent allow-list"
    );
    let planned = base.with_extra_layer(layer);

    assert_eq!(planned.verdict("edit_file"), ToolVerdict::Deny);
    assert_eq!(planned.verdict("run_shell"), ToolVerdict::Deny);
    assert_eq!(planned.verdict("read_file"), ToolVerdict::Allow);
    assert_eq!(planned.verdict("create_plan"), ToolVerdict::Allow);
}

#[test]
fn with_extra_layer_applies_ask_mode_deny_delta() {
    use crate::session::AgentExecMode;

    let base = ResolvedToolPolicy::permissive();
    let layer = AgentExecMode::Ask
        .policy_layer()
        .expect("ask mode must contribute a policy layer");
    let asked = base.with_extra_layer(layer);

    assert_eq!(asked.verdict("read_file"), ToolVerdict::Allow);
    assert_eq!(asked.verdict("code_search"), ToolVerdict::Allow);
    assert_eq!(asked.verdict("ask_user_questions"), ToolVerdict::Allow);
    assert_eq!(asked.verdict("edit_file"), ToolVerdict::Deny);
    assert_eq!(asked.verdict("run_shell"), ToolVerdict::Deny);
    assert_eq!(asked.verdict("create_plan"), ToolVerdict::Deny);
}

#[test]
fn build_mode_denies_create_plan_only() {
    use crate::session::AgentExecMode;

    let base = ResolvedToolPolicy::permissive();
    let layer = AgentExecMode::Build
        .policy_layer()
        .expect("build mode must deny create_plan");
    assert!(
        layer.allow.is_none(),
        "build mode must use deny-delta (allow=None)"
    );
    let build = base.with_extra_layer(layer);

    assert_eq!(build.verdict("create_plan"), ToolVerdict::Deny);
    assert_eq!(build.verdict("edit_file"), ToolVerdict::Allow);
    assert_eq!(build.verdict("run_shell"), ToolVerdict::Allow);
    assert_eq!(build.verdict("read_file"), ToolVerdict::Allow);
    assert_eq!(build.verdict("suggest_mode_switch"), ToolVerdict::Allow);
}
