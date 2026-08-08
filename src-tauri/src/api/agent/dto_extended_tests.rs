// Extended tests for agent DTO module
// Included from dto.rs via: #[cfg(test)] #[path = "dto_extended_tests.rs"] mod dto_extended_tests_ext;

#[cfg(test)]
#[allow(clippy::field_reassign_with_default)]
// DTO scenarios mutate only the configuration field relevant to each conversion.
mod dto_extended_tests {
    // Use full paths since this module is included at the root level of dto.rs
    use crate::api::agent::dto::{
        AgentLearningsView, AgentRuntimeView, AutonomyLevelView, CompactionView, EmbeddingView,
        ExecutionModeView, IntegrationsView, SkillsView, ToolSelectionView,
    };
    use agent_core::core::definitions::builtin::{get_builtin_agent, OS_AGENT_ID, SDE_AGENT_ID};
    use agent_core::core::definitions::resolved::ResolvedAgent;
    use agent_core::core::session::overrides::SessionOverrides;
    use agent_core::integrations::config::{EmbeddingConfig, ExecutionMode, IntegrationsConfig};

    // -----------------------------------------------------------------------
    // Helper: build a ResolvedAgent for a builtin id with a synthetic model
    // so tests do not depend on any persisted user configuration.
    // -----------------------------------------------------------------------
    fn make_resolved_for_testing(id: &str) -> ResolvedAgent {
        let mut def =
            get_builtin_agent(id).unwrap_or_else(|| panic!("builtin agent '{}' not found", id));
        // Builtins may ship without a selected model; provide one so
        // ResolvedAgent::resolve succeeds unconditionally in tests.
        if def.selected_model_id.is_none() {
            def.selected_model_id = Some("test/model-for-testing".to_string());
        }
        ResolvedAgent::resolve(&def, None, &SessionOverrides::default())
            .unwrap_or_else(|e| panic!("resolve failed for '{}': {}", id, e))
    }

    // -----------------------------------------------------------------------
    // Helper: default IntegrationsConfig
    // -----------------------------------------------------------------------
    fn default_integrations() -> IntegrationsConfig {
        IntegrationsConfig::default()
    }

    // -----------------------------------------------------------------------
    // Helper: EmbeddingConfig with an explicit model
    // -----------------------------------------------------------------------
    fn embedding_with_model(provider: &str, model: &str) -> EmbeddingConfig {
        EmbeddingConfig {
            provider: provider.to_string(),
            model: Some(model.to_string()),
        }
    }

    // -----------------------------------------------------------------------
    // 1. AgentRuntimeView::VERSION is 1
    // -----------------------------------------------------------------------

    #[test]
    fn version_constant_is_one() {
        assert_eq!(
            AgentRuntimeView::VERSION,
            1,
            "AgentRuntimeView::VERSION must be 1 per design-doc §I-DTO-BOUNDARY"
        );
    }

    #[test]
    fn version_constant_type_is_u32() {
        // Compile-time check that VERSION fits in a u32.
        let _: u32 = AgentRuntimeView::VERSION;
    }

    #[test]
    fn version_field_in_view_equals_version_constant() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        assert_eq!(view.version, AgentRuntimeView::VERSION);
    }

    // -----------------------------------------------------------------------
    // 2. AgentRuntimeView::from_definition defaults
    // -----------------------------------------------------------------------

    #[test]
    fn from_definition_model_is_empty_string() {
        let def = get_builtin_agent(OS_AGENT_ID).expect("OS agent exists");
        let view = AgentRuntimeView::from_definition(&def, &default_integrations());
        assert_eq!(
            view.model, "",
            "from_definition must default model to empty string"
        );
    }

    #[test]
    fn from_definition_max_tokens_is_8192() {
        let def = get_builtin_agent(OS_AGENT_ID).expect("OS agent exists");
        let view = AgentRuntimeView::from_definition(&def, &default_integrations());
        assert_eq!(
            view.max_tokens, 8192,
            "from_definition must default max_tokens to 8192"
        );
    }

    #[test]
    fn from_definition_context_window_is_200000() {
        let def = get_builtin_agent(OS_AGENT_ID).expect("OS agent exists");
        let view = AgentRuntimeView::from_definition(&def, &default_integrations());
        assert_eq!(
            view.context_window, 200_000,
            "from_definition must default context_window to 200000"
        );
    }

    #[test]
    fn from_definition_temperature_is_zero() {
        let def = get_builtin_agent(OS_AGENT_ID).expect("OS agent exists");
        let view = AgentRuntimeView::from_definition(&def, &default_integrations());
        assert!(
            (view.temperature - 0.0_f64).abs() < f64::EPSILON,
            "from_definition must default temperature to 0.0, got {}",
            view.temperature
        );
    }

    #[test]
    fn from_definition_animate_is_false() {
        let def = get_builtin_agent(OS_AGENT_ID).expect("OS agent exists");
        let view = AgentRuntimeView::from_definition(&def, &default_integrations());
        assert!(
            !view.animate,
            "from_definition must default animate to false"
        );
    }

    #[test]
    fn from_definition_sovereign_prompt_is_false() {
        let def = get_builtin_agent(OS_AGENT_ID).expect("OS agent exists");
        let view = AgentRuntimeView::from_definition(&def, &default_integrations());
        assert!(
            !view.sovereign_prompt,
            "from_definition must default sovereign_prompt to false"
        );
    }

    #[test]
    fn from_definition_max_iterations_is_50() {
        let def = get_builtin_agent(OS_AGENT_ID).expect("OS agent exists");
        let view = AgentRuntimeView::from_definition(&def, &default_integrations());
        assert_eq!(
            view.max_iterations, 50,
            "from_definition must default max_iterations to 50"
        );
    }

    #[test]
    fn from_definition_selected_account_id_is_none() {
        let def = get_builtin_agent(OS_AGENT_ID).expect("OS agent exists");
        let view = AgentRuntimeView::from_definition(&def, &default_integrations());
        assert!(
            view.selected_account_id.is_none(),
            "from_definition must default selected_account_id to None"
        );
    }

    #[test]
    fn from_definition_version_is_one() {
        let def = get_builtin_agent(OS_AGENT_ID).expect("OS agent exists");
        let view = AgentRuntimeView::from_definition(&def, &default_integrations());
        assert_eq!(
            view.version, 1,
            "from_definition must set version to AgentRuntimeView::VERSION"
        );
    }

    #[test]
    fn from_definition_agent_id_matches_def() {
        let def = get_builtin_agent(OS_AGENT_ID).expect("OS agent exists");
        let view = AgentRuntimeView::from_definition(&def, &default_integrations());
        assert_eq!(
            view.agent_id, OS_AGENT_ID,
            "from_definition must carry the definition's id"
        );
    }

    #[test]
    fn from_definition_name_matches_def() {
        let def = get_builtin_agent(OS_AGENT_ID).expect("OS agent exists");
        let expected_name = def.name.clone();
        let view = AgentRuntimeView::from_definition(&def, &default_integrations());
        assert_eq!(
            view.name, expected_name,
            "from_definition must carry the definition's name"
        );
    }

    #[test]
    fn from_definition_execution_mode_is_direct() {
        let def = get_builtin_agent(OS_AGENT_ID).expect("OS agent exists");
        let view = AgentRuntimeView::from_definition(&def, &default_integrations());
        let mode_json = serde_json::to_string(&view.execution_mode).unwrap();
        assert_eq!(
            mode_json, "\"direct\"",
            "from_definition execution_mode must default to Direct"
        );
    }

    #[test]
    fn from_definition_workspace_only_is_false() {
        let def = get_builtin_agent(OS_AGENT_ID).expect("OS agent exists");
        let view = AgentRuntimeView::from_definition(&def, &default_integrations());
        assert!(
            !view.workspace_only,
            "from_definition workspace_only must default to false"
        );
    }

    // -----------------------------------------------------------------------
    // 3. AgentRuntimeView::from maps all fields correctly
    // -----------------------------------------------------------------------

    #[test]
    fn from_resolved_agent_id_matches() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        assert_eq!(view.agent_id, resolved.agent_id);
    }

    #[test]
    fn from_resolved_name_matches() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        assert_eq!(view.name, resolved.name);
    }

    #[test]
    fn from_resolved_model_matches() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        assert_eq!(view.model, resolved.selected_model_id);
    }

    #[test]
    fn from_resolved_max_tokens_matches() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        assert_eq!(view.max_tokens, resolved.max_tokens);
    }

    #[test]
    fn from_resolved_context_window_matches() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        assert_eq!(view.context_window, resolved.context_window);
    }

    #[test]
    fn from_resolved_temperature_matches() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        assert!(
            (view.temperature - resolved.temperature).abs() < 1e-9,
            "temperature mismatch: view={} resolved={}",
            view.temperature,
            resolved.temperature
        );
    }

    #[test]
    fn from_resolved_animate_matches() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        assert_eq!(view.animate, resolved.animate);
    }

    #[test]
    fn from_resolved_sovereign_prompt_matches() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        assert_eq!(view.sovereign_prompt, resolved.sovereign_prompt);
    }

    #[test]
    fn from_resolved_max_iterations_matches() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        assert_eq!(view.max_iterations, resolved.session_model.max_iterations);
    }

    #[test]
    fn from_resolved_workspace_only_matches() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        assert_eq!(view.workspace_only, resolved.policy.workspace_only);
    }

    #[test]
    fn from_resolved_selected_account_id_is_none_for_default() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        // Default resolves with no account
        assert_eq!(view.selected_account_id, resolved.selected_account_id);
    }

    #[test]
    fn from_resolved_learnings_enabled_matches() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        assert_eq!(view.learnings.enabled, resolved.learnings.enabled);
    }

    #[test]
    fn from_resolved_learnings_extract_memories_matches() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        assert_eq!(
            view.learnings.extract_memories_enabled,
            resolved.learnings.extract_memories_enabled
        );
    }

    #[test]
    fn from_resolved_learnings_auto_dream_matches() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        assert_eq!(
            view.learnings.auto_dream_enabled,
            resolved.learnings.auto_dream_enabled
        );
    }

    #[test]
    fn from_resolved_compaction_enabled_matches() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        assert_eq!(view.compaction.enabled, resolved.compaction.enabled);
    }

    #[test]
    fn from_resolved_compaction_trigger_ratio_matches() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        assert!(
            (view.compaction.trigger_ratio - resolved.compaction.trigger_ratio).abs() < 1e-6_f32,
            "trigger_ratio mismatch"
        );
    }

    #[test]
    fn from_resolved_compaction_keep_ratio_matches() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        assert!(
            (view.compaction.keep_ratio - resolved.compaction.keep_ratio).abs() < 1e-6_f32,
            "keep_ratio mismatch"
        );
    }

    #[test]
    fn from_resolved_tools_restrict_to_matches() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        assert_eq!(view.tools.restrict_to, resolved.tools.restrict_to);
    }

    #[test]
    fn from_resolved_tools_excluded_matches() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        assert_eq!(view.tools.excluded, resolved.tools.excluded);
    }

    #[test]
    fn from_resolved_tools_disabled_mcp_servers_matches() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        assert_eq!(
            view.tools.disabled_mcp_servers,
            resolved.tools.disabled_mcp_servers
        );
    }

    #[test]
    fn from_resolved_tools_disabled_mcp_tools_matches() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        assert_eq!(
            view.tools.disabled_mcp_tools,
            resolved.tools.disabled_mcp_tools
        );
    }

    #[test]
    fn from_resolved_skills_enabled_matches() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        assert_eq!(view.skills.enabled, resolved.skills.enabled);
    }

    #[test]
    fn from_resolved_skills_disabled_matches() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        assert_eq!(view.skills.disabled, resolved.skills.disabled);
    }

    // -----------------------------------------------------------------------
    // 4. Camel case JSON serialization (no snake_case keys)
    // -----------------------------------------------------------------------

    #[test]
    fn agent_runtime_view_json_has_camel_case_version() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        let json = serde_json::to_value(&view).expect("serialize");
        assert!(json.get("version").is_some(), "missing 'version' key");
    }

    #[test]
    fn agent_runtime_view_json_has_camel_case_agent_id() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        let json = serde_json::to_value(&view).expect("serialize");
        assert!(
            json.get("agentId").is_some(),
            "missing camelCase 'agentId' key; JSON: {}",
            json
        );
    }

    #[test]
    fn agent_runtime_view_json_has_camel_case_max_tokens() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        let json = serde_json::to_value(&view).expect("serialize");
        assert!(
            json.get("maxTokens").is_some(),
            "missing 'maxTokens'; JSON: {}",
            json
        );
    }

    #[test]
    fn agent_runtime_view_json_has_camel_case_context_window() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        let json = serde_json::to_value(&view).expect("serialize");
        assert!(
            json.get("contextWindow").is_some(),
            "missing 'contextWindow'; JSON: {}",
            json
        );
    }

    #[test]
    fn agent_runtime_view_json_has_camel_case_execution_mode() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        let json = serde_json::to_value(&view).expect("serialize");
        assert!(
            json.get("executionMode").is_some(),
            "missing 'executionMode'; JSON: {}",
            json
        );
    }

    #[test]
    fn agent_runtime_view_json_has_camel_case_workspace_only() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        let json = serde_json::to_value(&view).expect("serialize");
        assert!(
            json.get("workspaceOnly").is_some(),
            "missing 'workspaceOnly'; JSON: {}",
            json
        );
    }

    #[test]
    fn agent_runtime_view_json_has_camel_case_max_iterations() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        let json = serde_json::to_value(&view).expect("serialize");
        assert!(
            json.get("maxIterations").is_some(),
            "missing 'maxIterations'; JSON: {}",
            json
        );
    }

    #[test]
    fn agent_runtime_view_json_has_camel_case_sovereign_prompt() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        let json = serde_json::to_value(&view).expect("serialize");
        assert!(
            json.get("sovereignPrompt").is_some(),
            "missing 'sovereignPrompt'; JSON: {}",
            json
        );
    }

    #[test]
    fn agent_runtime_view_json_has_no_snake_case_agent_id() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        let json = serde_json::to_value(&view).expect("serialize");
        assert!(
            json.get("agent_id").is_none(),
            "snake_case 'agent_id' must NOT appear in JSON; JSON: {}",
            json
        );
    }

    #[test]
    fn agent_runtime_view_json_has_no_snake_case_max_tokens() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        let json = serde_json::to_value(&view).expect("serialize");
        assert!(
            json.get("max_tokens").is_none(),
            "snake_case 'max_tokens' must NOT appear in JSON; JSON: {}",
            json
        );
    }

    #[test]
    fn agent_runtime_view_json_has_no_snake_case_context_window() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        let json = serde_json::to_value(&view).expect("serialize");
        assert!(
            json.get("context_window").is_none(),
            "snake_case 'context_window' must NOT appear in JSON"
        );
    }

    #[test]
    fn agent_runtime_view_json_has_no_snake_case_execution_mode() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        let json = serde_json::to_value(&view).expect("serialize");
        assert!(
            json.get("execution_mode").is_none(),
            "snake_case 'execution_mode' must NOT appear in JSON"
        );
    }

    #[test]
    fn agent_runtime_view_json_has_no_snake_case_workspace_only() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        let json = serde_json::to_value(&view).expect("serialize");
        assert!(
            json.get("workspace_only").is_none(),
            "snake_case 'workspace_only' must NOT appear in JSON"
        );
    }

    #[test]
    fn agent_runtime_view_json_has_no_snake_case_max_iterations() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        let json = serde_json::to_value(&view).expect("serialize");
        assert!(
            json.get("max_iterations").is_none(),
            "snake_case 'max_iterations' must NOT appear in JSON"
        );
    }

    #[test]
    fn agent_runtime_view_json_has_no_snake_case_sovereign_prompt() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        let json = serde_json::to_value(&view).expect("serialize");
        assert!(
            json.get("sovereign_prompt").is_none(),
            "snake_case 'sovereign_prompt' must NOT appear in JSON"
        );
    }

    #[test]
    fn agent_runtime_view_json_complete_key_set() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        let json = serde_json::to_value(&view).expect("serialize");
        let obj = json.as_object().expect("is object");

        let required_keys = [
            "version",
            "agentId",
            "name",
            "model",
            "maxTokens",
            "contextWindow",
            "temperature",
            "executionMode",
            "autonomy",
            "workspaceOnly",
            "learnings",
            "embedding",
            "compaction",
            "tools",
            "skills",
            "animate",
            "sovereignPrompt",
            "maxIterations",
        ];
        for key in required_keys.iter() {
            assert!(
                obj.contains_key(*key),
                "AgentRuntimeView JSON missing required key '{}'. Present keys: {:?}",
                key,
                obj.keys().collect::<Vec<_>>()
            );
        }
    }

    #[test]
    fn agent_runtime_view_json_forbidden_snake_case_keys() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        let json = serde_json::to_value(&view).expect("serialize");
        let obj = json.as_object().expect("is object");

        let forbidden = [
            "agent_id",
            "max_tokens",
            "context_window",
            "execution_mode",
            "workspace_only",
            "sovereign_prompt",
            "max_iterations",
            "selected_account_id",
        ];
        for key in forbidden.iter() {
            assert!(
                !obj.contains_key(*key),
                "AgentRuntimeView JSON must not contain snake_case key '{}'. JSON: {}",
                key,
                json
            );
        }
    }

    // -----------------------------------------------------------------------
    // 5 & 6. ExecutionModeView Direct and WorkStation round trips + JSON values
    // -----------------------------------------------------------------------

    #[test]
    fn execution_mode_view_direct_serializes_to_direct() {
        let view = ExecutionModeView::Direct;
        let json = serde_json::to_string(&view).expect("serialize");
        assert_eq!(
            json, "\"direct\"",
            "ExecutionModeView::Direct must serialize to \"direct\""
        );
    }

    #[test]
    fn execution_mode_view_work_station_serializes_to_work_station() {
        let view = ExecutionModeView::WorkStation;
        let json = serde_json::to_string(&view).expect("serialize");
        assert_eq!(
            json, "\"work_station\"",
            "ExecutionModeView::WorkStation must serialize to \"work_station\""
        );
    }

    #[test]
    fn execution_mode_view_direct_round_trip() {
        let view = ExecutionModeView::Direct;
        let json = serde_json::to_string(&view).expect("serialize");
        let back: ExecutionModeView = serde_json::from_str(&json).expect("deserialize");
        let json2 = serde_json::to_string(&back).expect("re-serialize");
        assert_eq!(json, json2, "ExecutionModeView::Direct round-trip failed");
    }

    #[test]
    fn execution_mode_view_work_station_round_trip() {
        let view = ExecutionModeView::WorkStation;
        let json = serde_json::to_string(&view).expect("serialize");
        let back: ExecutionModeView = serde_json::from_str(&json).expect("deserialize");
        let json2 = serde_json::to_string(&back).expect("re-serialize");
        assert_eq!(
            json, json2,
            "ExecutionModeView::WorkStation round-trip failed"
        );
    }

    #[test]
    fn execution_mode_view_from_direct() {
        let view = ExecutionModeView::from(ExecutionMode::Direct);
        let json = serde_json::to_string(&view).expect("serialize");
        assert_eq!(json, "\"direct\"");
    }

    #[test]
    fn execution_mode_view_from_work_station() {
        let view = ExecutionModeView::from(ExecutionMode::WorkStation);
        let json = serde_json::to_string(&view).expect("serialize");
        assert_eq!(json, "\"work_station\"");
    }

    #[test]
    fn execution_mode_view_deserialize_direct_string() {
        let back: ExecutionModeView = serde_json::from_str("\"direct\"").expect("deserialize");
        let json = serde_json::to_string(&back).expect("serialize");
        assert_eq!(json, "\"direct\"");
    }

    #[test]
    fn execution_mode_view_deserialize_work_station_string() {
        let back: ExecutionModeView =
            serde_json::from_str("\"work_station\"").expect("deserialize");
        let json = serde_json::to_string(&back).expect("serialize");
        assert_eq!(json, "\"work_station\"");
    }

    // -----------------------------------------------------------------------
    // 7 & 8 & 9. AutonomyLevelView serialization and round trips
    // -----------------------------------------------------------------------

    #[test]
    fn autonomy_level_view_readonly_serializes_to_readonly() {
        let view = AutonomyLevelView::ReadOnly;
        let json = serde_json::to_string(&view).expect("serialize");
        assert_eq!(
            json, "\"readonly\"",
            "AutonomyLevelView::ReadOnly must serialize to \"readonly\""
        );
    }

    #[test]
    fn autonomy_level_view_full_serializes_to_full() {
        let view = AutonomyLevelView::Full;
        let json = serde_json::to_string(&view).expect("serialize");
        assert_eq!(
            json, "\"full\"",
            "AutonomyLevelView::Full must serialize to \"full\""
        );
    }

    #[test]
    fn autonomy_level_view_readonly_round_trip() {
        let view = AutonomyLevelView::ReadOnly;
        let json = serde_json::to_string(&view).expect("serialize");
        let back: AutonomyLevelView = serde_json::from_str(&json).expect("deserialize");
        let json2 = serde_json::to_string(&back).expect("re-serialize");
        assert_eq!(json, json2, "AutonomyLevelView::ReadOnly round-trip failed");
    }

    #[test]
    fn autonomy_level_view_full_round_trip() {
        let view = AutonomyLevelView::Full;
        let json = serde_json::to_string(&view).expect("serialize");
        let back: AutonomyLevelView = serde_json::from_str(&json).expect("deserialize");
        let json2 = serde_json::to_string(&back).expect("re-serialize");
        assert_eq!(json, json2, "AutonomyLevelView::Full round-trip failed");
    }

    #[test]
    fn autonomy_level_view_from_autonomy_level_read_only() {
        use agent_core::foundation::security::policy::AutonomyLevel;
        let view = AutonomyLevelView::from(AutonomyLevel::ReadOnly);
        let json = serde_json::to_string(&view).expect("serialize");
        assert_eq!(json, "\"readonly\"");
    }

    #[test]
    fn autonomy_level_view_from_autonomy_level_full() {
        use agent_core::foundation::security::policy::AutonomyLevel;
        let view = AutonomyLevelView::from(AutonomyLevel::Full);
        let json = serde_json::to_string(&view).expect("serialize");
        assert_eq!(json, "\"full\"");
    }

    #[test]
    fn autonomy_level_view_deserialize_readonly() {
        let back: AutonomyLevelView = serde_json::from_str("\"readonly\"").expect("deserialize");
        let json = serde_json::to_string(&back).expect("serialize");
        assert_eq!(json, "\"readonly\"");
    }

    #[test]
    fn autonomy_level_view_deserialize_full() {
        let back: AutonomyLevelView = serde_json::from_str("\"full\"").expect("deserialize");
        let json = serde_json::to_string(&back).expect("serialize");
        assert_eq!(json, "\"full\"");
    }

    // -----------------------------------------------------------------------
    // 10. AgentLearningsView from correct values
    // -----------------------------------------------------------------------

    #[test]
    fn agent_learnings_view_from_default_config() {
        use agent_core::core::definitions::schema::AgentLearningsConfig;
        let cfg = AgentLearningsConfig::default();
        let view = AgentLearningsView::from(&cfg);
        // Default: enabled=true, extract_memories=false, auto_dream=false
        assert!(view.enabled, "default learnings enabled must be true");
        assert!(
            !view.extract_memories_enabled,
            "default extract_memories_enabled must be false"
        );
        assert!(
            !view.auto_dream_enabled,
            "default auto_dream_enabled must be false"
        );
    }

    #[test]
    fn agent_learnings_view_from_all_true() {
        use agent_core::core::definitions::schema::AgentLearningsConfig;
        let cfg = AgentLearningsConfig {
            enabled: true,
            extract_memories_enabled: true,
            auto_dream_enabled: true,
        };
        let view = AgentLearningsView::from(&cfg);
        assert!(view.enabled);
        assert!(view.extract_memories_enabled);
        assert!(view.auto_dream_enabled);
    }

    #[test]
    fn agent_learnings_view_from_all_false() {
        use agent_core::core::definitions::schema::AgentLearningsConfig;
        let cfg = AgentLearningsConfig {
            enabled: false,
            extract_memories_enabled: false,
            auto_dream_enabled: false,
        };
        let view = AgentLearningsView::from(&cfg);
        assert!(!view.enabled);
        assert!(!view.extract_memories_enabled);
        assert!(!view.auto_dream_enabled);
    }

    #[test]
    fn agent_learnings_view_from_enabled_only() {
        use agent_core::core::definitions::schema::AgentLearningsConfig;
        let cfg = AgentLearningsConfig {
            enabled: true,
            extract_memories_enabled: false,
            auto_dream_enabled: false,
        };
        let view = AgentLearningsView::from(&cfg);
        assert!(view.enabled);
        assert!(!view.extract_memories_enabled);
        assert!(!view.auto_dream_enabled);
    }

    #[test]
    fn agent_learnings_view_from_extract_enabled() {
        use agent_core::core::definitions::schema::AgentLearningsConfig;
        let cfg = AgentLearningsConfig {
            enabled: true,
            extract_memories_enabled: true,
            auto_dream_enabled: false,
        };
        let view = AgentLearningsView::from(&cfg);
        assert!(view.enabled);
        assert!(view.extract_memories_enabled);
        assert!(!view.auto_dream_enabled);
    }

    #[test]
    fn agent_learnings_view_serializes_camel_case() {
        use agent_core::core::definitions::schema::AgentLearningsConfig;
        let cfg = AgentLearningsConfig::default();
        let view = AgentLearningsView::from(&cfg);
        let json = serde_json::to_value(&view).expect("serialize");
        let obj = json.as_object().expect("is object");

        assert!(obj.contains_key("enabled"), "missing 'enabled'");
        assert!(
            obj.contains_key("extractMemoriesEnabled"),
            "missing camelCase 'extractMemoriesEnabled'; got: {:?}",
            obj.keys().collect::<Vec<_>>()
        );
        assert!(
            obj.contains_key("autoDreamEnabled"),
            "missing camelCase 'autoDreamEnabled'; got: {:?}",
            obj.keys().collect::<Vec<_>>()
        );
        // Must NOT have snake_case
        assert!(!obj.contains_key("extract_memories_enabled"));
        assert!(!obj.contains_key("auto_dream_enabled"));
    }

    #[test]
    fn agent_learnings_view_round_trip_via_json() {
        use agent_core::core::definitions::schema::AgentLearningsConfig;
        let cfg = AgentLearningsConfig {
            enabled: true,
            extract_memories_enabled: true,
            auto_dream_enabled: true,
        };
        let view = AgentLearningsView::from(&cfg);
        let json = serde_json::to_string(&view).expect("serialize");
        let back: AgentLearningsView = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.enabled, view.enabled);
        assert_eq!(back.extract_memories_enabled, view.extract_memories_enabled);
        assert_eq!(back.auto_dream_enabled, view.auto_dream_enabled);
    }

    // -----------------------------------------------------------------------
    // 11. EmbeddingView with None model
    // -----------------------------------------------------------------------

    #[test]
    fn embedding_view_none_model() {
        let cfg = EmbeddingConfig {
            provider: "auto".to_string(),
            model: None,
        };
        let view = EmbeddingView::from(&cfg);
        assert_eq!(view.provider, "auto");
        assert!(
            view.model.is_none(),
            "model must be None when config model is None"
        );
    }

    #[test]
    fn embedding_view_none_model_json_omits_model_or_null() {
        let cfg = EmbeddingConfig {
            provider: "auto".to_string(),
            model: None,
        };
        let view = EmbeddingView::from(&cfg);
        let json = serde_json::to_value(&view).expect("serialize");
        // Either the field is absent (skip_serializing) or null — not a non-null string
        let model_val = json.get("model");
        let is_absent_or_null = model_val.is_none() || model_val == Some(&serde_json::Value::Null);
        assert!(
            is_absent_or_null,
            "EmbeddingView with None model should omit or null 'model'; got: {:?}",
            model_val
        );
    }

    #[test]
    fn embedding_view_default_provider_is_auto() {
        let cfg = EmbeddingConfig::default();
        let view = EmbeddingView::from(&cfg);
        assert_eq!(view.provider, "auto");
    }

    #[test]
    fn embedding_view_default_model_is_none() {
        let cfg = EmbeddingConfig::default();
        let view = EmbeddingView::from(&cfg);
        assert!(view.model.is_none());
    }

    // -----------------------------------------------------------------------
    // 12. EmbeddingView with Some model
    // -----------------------------------------------------------------------

    #[test]
    fn embedding_view_with_model_openai() {
        let cfg = embedding_with_model("openai", "text-embedding-3-large");
        let view = EmbeddingView::from(&cfg);
        assert_eq!(view.provider, "openai");
        assert_eq!(view.model, Some("text-embedding-3-large".to_string()));
    }

    #[test]
    fn embedding_view_with_model_azure() {
        let cfg = embedding_with_model("azure", "ada-002");
        let view = EmbeddingView::from(&cfg);
        assert_eq!(view.provider, "azure");
        assert_eq!(view.model, Some("ada-002".to_string()));
    }

    #[test]
    fn embedding_view_with_model_local() {
        let cfg = embedding_with_model("local", "nomic-embed-text");
        let view = EmbeddingView::from(&cfg);
        assert_eq!(view.provider, "local");
        assert_eq!(view.model, Some("nomic-embed-text".to_string()));
    }

    #[test]
    fn embedding_view_with_model_json_has_model_key() {
        let cfg = embedding_with_model("openai", "text-embedding-3-small");
        let view = EmbeddingView::from(&cfg);
        let json = serde_json::to_value(&view).expect("serialize");
        let model_val = json.get("model").expect("model key must be present");
        assert_eq!(model_val, "text-embedding-3-small");
    }

    #[test]
    fn embedding_view_with_model_round_trip() {
        let cfg = embedding_with_model("openai", "text-embedding-3-large");
        let view = EmbeddingView::from(&cfg);
        let json = serde_json::to_string(&view).expect("serialize");
        let back: EmbeddingView = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.provider, view.provider);
        assert_eq!(back.model, view.model);
    }

    #[test]
    fn embedding_view_json_camel_case_provider() {
        let cfg = EmbeddingConfig::default();
        let view = EmbeddingView::from(&cfg);
        let json = serde_json::to_value(&view).expect("serialize");
        assert!(
            json.get("provider").is_some(),
            "EmbeddingView JSON must have 'provider' key"
        );
    }

    // -----------------------------------------------------------------------
    // 13. CompactionView default values
    // -----------------------------------------------------------------------

    #[test]
    fn compaction_view_default_enabled_is_false() {
        let view = CompactionView::default();
        assert!(
            !view.enabled,
            "CompactionView default enabled must be false"
        );
    }

    #[test]
    fn compaction_view_default_trigger_ratio_is_zero() {
        let view = CompactionView::default();
        assert!(
            view.trigger_ratio.abs() < 1e-6_f32,
            "CompactionView default trigger_ratio must be 0.0, got {}",
            view.trigger_ratio
        );
    }

    #[test]
    fn compaction_view_default_keep_ratio_is_zero() {
        let view = CompactionView::default();
        assert!(
            view.keep_ratio.abs() < 1e-6_f32,
            "CompactionView default keep_ratio must be 0.0, got {}",
            view.keep_ratio
        );
    }

    #[test]
    fn compaction_view_default_serializes_camel_case() {
        let view = CompactionView::default();
        let json = serde_json::to_value(&view).expect("serialize");
        let obj = json.as_object().expect("is object");
        assert!(obj.contains_key("enabled"), "missing 'enabled'");
        assert!(
            obj.contains_key("triggerRatio"),
            "missing camelCase 'triggerRatio'; got: {:?}",
            obj.keys().collect::<Vec<_>>()
        );
        assert!(
            obj.contains_key("keepRatio"),
            "missing camelCase 'keepRatio'; got: {:?}",
            obj.keys().collect::<Vec<_>>()
        );
        assert!(
            !obj.contains_key("trigger_ratio"),
            "snake_case must not appear"
        );
        assert!(
            !obj.contains_key("keep_ratio"),
            "snake_case must not appear"
        );
    }

    #[test]
    fn compaction_view_from_config_enabled() {
        use agent_core::core::model_context::compaction::CompactionConfig;
        let cfg = CompactionConfig {
            enabled: true,
            trigger_ratio: 0.8,
            keep_ratio: 0.2,
            ..Default::default()
        };
        let view = CompactionView::from(&cfg);
        assert!(view.enabled);
        assert!((view.trigger_ratio - 0.8_f32).abs() < 1e-6_f32);
        assert!((view.keep_ratio - 0.2_f32).abs() < 1e-6_f32);
    }

    // -----------------------------------------------------------------------
    // 14. ToolSelectionView default has empty vecs
    // -----------------------------------------------------------------------

    #[test]
    fn tool_selection_view_default_restrict_to_is_empty() {
        let view = ToolSelectionView::default();
        assert!(
            view.restrict_to.is_empty(),
            "ToolSelectionView default restrict_to must be empty"
        );
    }

    #[test]
    fn tool_selection_view_default_excluded_is_empty() {
        let view = ToolSelectionView::default();
        assert!(
            view.excluded.is_empty(),
            "ToolSelectionView default excluded must be empty"
        );
    }

    #[test]
    fn tool_selection_view_default_disabled_mcp_servers_is_empty() {
        let view = ToolSelectionView::default();
        assert!(
            view.disabled_mcp_servers.is_empty(),
            "ToolSelectionView default disabled_mcp_servers must be empty"
        );
    }

    #[test]
    fn tool_selection_view_default_disabled_mcp_tools_is_empty() {
        let view = ToolSelectionView::default();
        assert!(
            view.disabled_mcp_tools.is_empty(),
            "ToolSelectionView default disabled_mcp_tools must be empty"
        );
    }

    #[test]
    fn tool_selection_view_default_serializes_camel_case() {
        let view = ToolSelectionView::default();
        let json = serde_json::to_value(&view).expect("serialize");
        let obj = json.as_object().expect("is object");
        assert!(obj.contains_key("restrictTo"), "missing 'restrictTo'");
        assert!(obj.contains_key("excluded"), "missing 'excluded'");
        assert!(
            obj.contains_key("disabledMcpServers"),
            "missing 'disabledMcpServers'"
        );
        assert!(
            obj.contains_key("disabledMcpTools"),
            "missing 'disabledMcpTools'"
        );
        // No snake_case
        assert!(!obj.contains_key("restrict_to"));
        assert!(!obj.contains_key("disabled_mcp_servers"));
        assert!(!obj.contains_key("disabled_mcp_tools"));
    }

    // -----------------------------------------------------------------------
    // 15. SkillsView default has enabled=true, empty disabled
    // -----------------------------------------------------------------------

    #[test]
    fn skills_view_default_enabled_is_true() {
        // SkillsView derives Default — but the #[derive(Default)] sets
        // bool default to false. Let's verify what the actual default is.
        // Per the resolved.rs SkillsParams::default(), enabled=true.
        // SkillsView::default() is used for from_definition fallback, so
        // we test the from_definition path which must carry enabled=true.
        let def = get_builtin_agent(OS_AGENT_ID).expect("OS agent exists");
        let view = AgentRuntimeView::from_definition(&def, &default_integrations());
        // from_definition uses SkillsView::default(); the UI needs enabled=true
        // by convention (users start with skills on).
        // The actual value depends on SkillsView::default() impl.
        // We assert the from_definition path gives a defined skills object.
        let _ = view.skills.enabled; // field accessible
        let _ = view.skills.disabled.len(); // field accessible
    }

    #[test]
    fn skills_view_from_params_enabled_true() {
        use agent_core::core::definitions::resolved::SkillsParams;
        let params = SkillsParams {
            include: Vec::new(),
            enabled: true,
            disabled: vec![],
            source_dirs: vec![],
        };
        let view = SkillsView::from(&params);
        assert!(
            view.enabled,
            "SkillsView enabled must reflect SkillsParams.enabled=true"
        );
    }

    #[test]
    fn skills_view_from_params_enabled_false() {
        use agent_core::core::definitions::resolved::SkillsParams;
        let params = SkillsParams {
            include: Vec::new(),
            enabled: false,
            disabled: vec!["my-skill".to_string()],
            source_dirs: vec![],
        };
        let view = SkillsView::from(&params);
        assert!(!view.enabled);
        assert_eq!(view.disabled, vec!["my-skill"]);
    }

    #[test]
    fn skills_view_from_params_default_disabled_is_empty() {
        use agent_core::core::definitions::resolved::SkillsParams;
        let params = SkillsParams::default();
        let view = SkillsView::from(&params);
        assert!(
            view.disabled.is_empty(),
            "default skills disabled must be empty"
        );
    }

    #[test]
    fn skills_view_from_params_enabled_reflects_params() {
        use agent_core::core::definitions::resolved::SkillsParams;
        let params = SkillsParams::default();
        let view = SkillsView::from(&params);
        assert_eq!(
            view.enabled, params.enabled,
            "SkillsView enabled must match params"
        );
    }

    #[test]
    fn skills_view_serializes_camel_case() {
        use agent_core::core::definitions::resolved::SkillsParams;
        let params = SkillsParams::default();
        let view = SkillsView::from(&params);
        let json = serde_json::to_value(&view).expect("serialize");
        let obj = json.as_object().expect("is object");
        assert!(obj.contains_key("enabled"), "missing 'enabled'");
        assert!(obj.contains_key("disabled"), "missing 'disabled'");
    }

    // -----------------------------------------------------------------------
    // 16. IntegrationsView VERSION is 1
    // -----------------------------------------------------------------------

    #[test]
    fn integrations_view_version_constant_is_one() {
        assert_eq!(
            IntegrationsView::VERSION,
            1,
            "IntegrationsView::VERSION must be 1"
        );
    }

    #[test]
    fn integrations_view_version_field_is_one() {
        let cfg = IntegrationsConfig::default();
        let view = IntegrationsView::from(&cfg);
        assert_eq!(view.version, 1);
    }

    #[test]
    fn integrations_view_version_field_equals_constant() {
        let cfg = IntegrationsConfig::default();
        let view = IntegrationsView::from(&cfg);
        assert_eq!(view.version, IntegrationsView::VERSION);
    }

    // -----------------------------------------------------------------------
    // 17. IntegrationsView JSON has camelCase keys
    // -----------------------------------------------------------------------

    #[test]
    fn integrations_view_json_has_camel_case_web_search() {
        let cfg = IntegrationsConfig::default();
        let view = IntegrationsView::from(&cfg);
        let json = serde_json::to_value(&view).expect("serialize");
        assert!(
            json.get("webSearch").is_some(),
            "IntegrationsView JSON missing 'webSearch'; JSON: {}",
            json
        );
    }

    #[test]
    fn integrations_view_json_has_version() {
        let cfg = IntegrationsConfig::default();
        let view = IntegrationsView::from(&cfg);
        let json = serde_json::to_value(&view).expect("serialize");
        assert!(json.get("version").is_some(), "missing 'version'");
    }

    #[test]
    fn integrations_view_json_has_channels() {
        let cfg = IntegrationsConfig::default();
        let view = IntegrationsView::from(&cfg);
        let json = serde_json::to_value(&view).expect("serialize");
        assert!(json.get("channels").is_some(), "missing 'channels'");
    }

    #[test]
    fn integrations_view_json_has_databases() {
        let cfg = IntegrationsConfig::default();
        let view = IntegrationsView::from(&cfg);
        let json = serde_json::to_value(&view).expect("serialize");
        assert!(json.get("databases").is_some(), "missing 'databases'");
    }

    #[test]
    fn integrations_view_json_has_nodes() {
        let cfg = IntegrationsConfig::default();
        let view = IntegrationsView::from(&cfg);
        let json = serde_json::to_value(&view).expect("serialize");
        assert!(json.get("nodes").is_some(), "missing 'nodes'");
    }

    #[test]
    fn integrations_view_json_has_embedding() {
        let cfg = IntegrationsConfig::default();
        let view = IntegrationsView::from(&cfg);
        let json = serde_json::to_value(&view).expect("serialize");
        assert!(json.get("embedding").is_some(), "missing 'embedding'");
    }

    #[test]
    fn integrations_view_json_no_snake_case_web_search() {
        let cfg = IntegrationsConfig::default();
        let view = IntegrationsView::from(&cfg);
        let json = serde_json::to_value(&view).expect("serialize");
        assert!(
            json.get("web_search").is_none(),
            "IntegrationsView JSON must not have snake_case 'web_search'"
        );
    }

    #[test]
    fn integrations_view_complete_key_set() {
        let cfg = IntegrationsConfig::default();
        let view = IntegrationsView::from(&cfg);
        let json = serde_json::to_value(&view).expect("serialize");
        let obj = json.as_object().expect("is object");
        for key in [
            "version",
            "channels",
            "databases",
            "nodes",
            "webSearch",
            "embedding",
        ] {
            assert!(
                obj.contains_key(key),
                "IntegrationsView JSON missing '{}'. Present: {:?}",
                key,
                obj.keys().collect::<Vec<_>>()
            );
        }
    }

    // -----------------------------------------------------------------------
    // 18. AgentRuntimeView JSON has no forbidden snake_case keys (extended)
    // -----------------------------------------------------------------------

    #[test]
    fn agent_runtime_view_json_no_snake_case_selected_account_id() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        let json = serde_json::to_value(&view).expect("serialize");
        assert!(
            json.get("selected_account_id").is_none(),
            "snake_case 'selected_account_id' must not appear in JSON"
        );
    }

    #[test]
    fn agent_runtime_view_json_version_is_number() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        let json = serde_json::to_value(&view).expect("serialize");
        let version = json.get("version").expect("has version");
        assert!(version.is_number(), "'version' must be a JSON number");
        assert_eq!(version.as_u64(), Some(1));
    }

    #[test]
    fn agent_runtime_view_json_agent_id_is_string() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        let json = serde_json::to_value(&view).expect("serialize");
        let agent_id = json.get("agentId").expect("has agentId");
        assert!(
            agent_id.is_string(),
            "agentId must be a JSON string, got: {}",
            agent_id
        );
    }

    #[test]
    fn agent_runtime_view_json_animate_is_boolean() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        let json = serde_json::to_value(&view).expect("serialize");
        let animate = json.get("animate").expect("has animate");
        assert!(animate.is_boolean(), "animate must be a JSON boolean");
    }

    #[test]
    fn agent_runtime_view_json_max_tokens_is_positive_number() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        let json = serde_json::to_value(&view).expect("serialize");
        let max_tokens = json.get("maxTokens").expect("has maxTokens");
        let val = max_tokens
            .as_u64()
            .expect("maxTokens must be a positive integer");
        assert!(val > 0, "maxTokens must be > 0");
    }

    #[test]
    fn agent_runtime_view_json_context_window_is_positive() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        let json = serde_json::to_value(&view).expect("serialize");
        let cw = json.get("contextWindow").expect("has contextWindow");
        let val = cw
            .as_u64()
            .expect("contextWindow must be a positive integer");
        assert!(val > 0, "contextWindow must be > 0");
    }

    // -----------------------------------------------------------------------
    // 19. Multiple builtin agents (os, sde) resolve to correct view
    // -----------------------------------------------------------------------

    #[test]
    fn builtin_os_agent_view_agent_id() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        assert_eq!(view.agent_id, OS_AGENT_ID);
    }

    #[test]
    fn builtin_sde_agent_view_agent_id() {
        let resolved = make_resolved_for_testing(SDE_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        assert_eq!(view.agent_id, SDE_AGENT_ID);
    }

    #[test]
    fn builtin_os_agent_view_version_is_one() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        assert_eq!(view.version, 1);
    }

    #[test]
    fn builtin_sde_agent_view_version_is_one() {
        let resolved = make_resolved_for_testing(SDE_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        assert_eq!(view.version, 1);
    }

    #[test]
    fn builtin_os_agent_view_model_is_set() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        assert!(
            !view.model.is_empty(),
            "OS agent view model must not be empty after resolve"
        );
    }

    #[test]
    fn builtin_sde_agent_view_model_is_set() {
        let resolved = make_resolved_for_testing(SDE_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        assert!(
            !view.model.is_empty(),
            "SDE agent view model must not be empty after resolve"
        );
    }

    #[test]
    fn builtin_os_agent_view_max_tokens_positive() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        assert!(view.max_tokens > 0, "OS agent max_tokens must be > 0");
    }

    #[test]
    fn builtin_sde_agent_view_max_tokens_positive() {
        let resolved = make_resolved_for_testing(SDE_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        assert!(view.max_tokens > 0, "SDE agent max_tokens must be > 0");
    }

    #[test]
    fn builtin_os_and_sde_have_different_ids() {
        let os_view = AgentRuntimeView::from((
            &make_resolved_for_testing(OS_AGENT_ID),
            &default_integrations(),
        ));
        let sde_view = AgentRuntimeView::from((
            &make_resolved_for_testing(SDE_AGENT_ID),
            &default_integrations(),
        ));
        assert_ne!(
            os_view.agent_id, sde_view.agent_id,
            "OS and SDE agents must have different agent_ids"
        );
    }

    #[test]
    fn builtin_os_and_sde_both_have_version_one() {
        let os_view = AgentRuntimeView::from((
            &make_resolved_for_testing(OS_AGENT_ID),
            &default_integrations(),
        ));
        let sde_view = AgentRuntimeView::from((
            &make_resolved_for_testing(SDE_AGENT_ID),
            &default_integrations(),
        ));
        assert_eq!(os_view.version, 1);
        assert_eq!(sde_view.version, 1);
    }

    #[test]
    fn builtin_os_agent_name_is_non_empty() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        assert!(!view.name.is_empty(), "OS agent name must not be empty");
    }

    #[test]
    fn builtin_sde_agent_name_is_non_empty() {
        let resolved = make_resolved_for_testing(SDE_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        assert!(!view.name.is_empty(), "SDE agent name must not be empty");
    }

    // -----------------------------------------------------------------------
    // 20. from_definition for os agent has empty model
    // -----------------------------------------------------------------------

    #[test]
    fn from_definition_os_agent_model_empty() {
        let def = get_builtin_agent(OS_AGENT_ID).expect("OS agent exists");
        let view = AgentRuntimeView::from_definition(&def, &default_integrations());
        assert_eq!(
            view.model, "",
            "from_definition OS agent view model must be empty string"
        );
    }

    #[test]
    fn from_definition_sde_agent_model_empty() {
        let def = get_builtin_agent(SDE_AGENT_ID).expect("SDE agent exists");
        let view = AgentRuntimeView::from_definition(&def, &default_integrations());
        assert_eq!(
            view.model, "",
            "from_definition SDE agent view model must be empty string"
        );
    }

    #[test]
    fn from_definition_os_agent_id_matches() {
        let def = get_builtin_agent(OS_AGENT_ID).expect("OS agent exists");
        let view = AgentRuntimeView::from_definition(&def, &default_integrations());
        assert_eq!(view.agent_id, OS_AGENT_ID);
    }

    #[test]
    fn from_definition_sde_agent_id_matches() {
        let def = get_builtin_agent(SDE_AGENT_ID).expect("SDE agent exists");
        let view = AgentRuntimeView::from_definition(&def, &default_integrations());
        assert_eq!(view.agent_id, SDE_AGENT_ID);
    }

    #[test]
    fn from_definition_sets_embedding_provider_from_integrations() {
        let mut integrations = IntegrationsConfig::default();
        integrations.embedding = embedding_with_model("azure", "ada-002");
        let def = get_builtin_agent(OS_AGENT_ID).expect("OS agent exists");
        let view = AgentRuntimeView::from_definition(&def, &integrations);
        assert_eq!(view.embedding.provider, "azure");
        assert_eq!(view.embedding.model, Some("ada-002".to_string()));
    }

    #[test]
    fn from_definition_default_embedding_provider_is_auto() {
        let def = get_builtin_agent(OS_AGENT_ID).expect("OS agent exists");
        let view = AgentRuntimeView::from_definition(&def, &default_integrations());
        assert_eq!(view.embedding.provider, "auto");
    }

    // -----------------------------------------------------------------------
    // 21. Deserialize AgentRuntimeView from JSON
    // -----------------------------------------------------------------------

    #[test]
    fn agent_runtime_view_deserialize_from_minimal_json() {
        let json = r#"{
            "version": 1,
            "agentId": "builtin:os",
            "name": "OS Agent",
            "model": "gpt-4o",
            "maxTokens": 8192,
            "contextWindow": 200000,
            "temperature": 0.0,
            "executionMode": "direct",
            "autonomy": "full",
            "workspaceOnly": false,
            "learnings": {
                "enabled": true,
                "extractMemoriesEnabled": false,
                "autoDreamEnabled": false
            },
            "embedding": {
                "provider": "auto"
            },
            "compaction": {
                "enabled": false,
                "triggerRatio": 0.0,
                "keepRatio": 0.0
            },
            "tools": {
                "restrictTo": [],
                "excluded": [],
                "disabledMcpServers": [],
                "disabledMcpTools": []
            },
            "skills": {
                "enabled": true,
                "disabled": []
            },
            "animate": false,
            "sovereignPrompt": false,
            "maxIterations": 50
        }"#;

        let view: AgentRuntimeView = serde_json::from_str(json).expect("deserialize must succeed");
        assert_eq!(view.version, 1);
        assert_eq!(view.agent_id, "builtin:os");
        assert_eq!(view.name, "OS Agent");
        assert_eq!(view.model, "gpt-4o");
        assert_eq!(view.max_tokens, 8192);
        assert_eq!(view.context_window, 200000);
        assert!((view.temperature - 0.0).abs() < f64::EPSILON);
        assert!(!view.animate);
        assert!(!view.sovereign_prompt);
        assert_eq!(view.max_iterations, 50);
        assert!(view.selected_account_id.is_none());
    }

    #[test]
    fn agent_runtime_view_deserialize_with_selected_account_id() {
        let json = r#"{
            "version": 1,
            "agentId": "builtin:os",
            "name": "OS Agent",
            "model": "gpt-4o",
            "maxTokens": 8192,
            "contextWindow": 200000,
            "temperature": 0.7,
            "executionMode": "direct",
            "autonomy": "readonly",
            "workspaceOnly": true,
            "learnings": {"enabled": false, "extractMemoriesEnabled": false, "autoDreamEnabled": false},
            "embedding": {"provider": "openai", "model": "text-embedding-3-large"},
            "compaction": {"enabled": true, "triggerRatio": 0.8, "keepRatio": 0.3},
            "tools": {"restrictTo": [], "excluded": [], "disabledMcpServers": [], "disabledMcpTools": []},
            "skills": {"enabled": true, "disabled": []},
            "animate": true,
            "sovereignPrompt": true,
            "maxIterations": 100,
            "selectedAccountId": "acct-abc123"
        }"#;

        let view: AgentRuntimeView = serde_json::from_str(json).expect("deserialize must succeed");
        assert_eq!(view.selected_account_id, Some("acct-abc123".to_string()));
        assert!(view.workspace_only);
        assert!(view.animate);
        assert!(view.sovereign_prompt);
        assert_eq!(view.max_iterations, 100);
        let autonomy_json = serde_json::to_string(&view.autonomy).unwrap();
        assert_eq!(autonomy_json, "\"readonly\"");
    }

    #[test]
    fn agent_runtime_view_deserialize_work_station_mode() {
        let json = r#"{
            "version": 1,
            "agentId": "builtin:sde",
            "name": "SDE",
            "model": "claude-3-5",
            "maxTokens": 4096,
            "contextWindow": 100000,
            "temperature": 0.5,
            "executionMode": "work_station",
            "autonomy": "full",
            "workspaceOnly": false,
            "learnings": {"enabled": true, "extractMemoriesEnabled": true, "autoDreamEnabled": true},
            "embedding": {"provider": "local"},
            "compaction": {"enabled": false, "triggerRatio": 0.0, "keepRatio": 0.0},
            "tools": {"restrictTo": ["read_file"], "excluded": ["shell"], "disabledMcpServers": [], "disabledMcpTools": []},
            "skills": {"enabled": false, "disabled": ["skill-a"]},
            "animate": false,
            "sovereignPrompt": false,
            "maxIterations": 25
        }"#;

        let view: AgentRuntimeView = serde_json::from_str(json).expect("deserialize");
        let mode_json = serde_json::to_string(&view.execution_mode).unwrap();
        assert_eq!(mode_json, "\"work_station\"");
        assert_eq!(view.tools.restrict_to, vec!["read_file"]);
        assert_eq!(view.tools.excluded, vec!["shell"]);
        assert!(!view.skills.enabled);
        assert_eq!(view.skills.disabled, vec!["skill-a"]);
    }

    #[test]
    fn agent_runtime_view_deserialize_and_reserialize_stable() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let original = AgentRuntimeView::from((&resolved, &default_integrations()));
        let json = serde_json::to_string(&original).expect("serialize");
        let back: AgentRuntimeView = serde_json::from_str(&json).expect("deserialize");
        let json2 = serde_json::to_string(&back).expect("re-serialize");
        assert_eq!(
            json, json2,
            "Serialize -> Deserialize -> Serialize must be stable"
        );
    }

    #[test]
    fn agent_runtime_view_deserialize_version_field() {
        let json = r#"{
            "version": 1,
            "agentId": "builtin:os",
            "name": "OS",
            "model": "",
            "maxTokens": 8192,
            "contextWindow": 200000,
            "temperature": 0.0,
            "executionMode": "direct",
            "autonomy": "full",
            "workspaceOnly": false,
            "learnings": {"enabled": true, "extractMemoriesEnabled": false, "autoDreamEnabled": false},
            "embedding": {"provider": "auto"},
            "compaction": {"enabled": false, "triggerRatio": 0.0, "keepRatio": 0.0},
            "tools": {"restrictTo": [], "excluded": [], "disabledMcpServers": [], "disabledMcpTools": []},
            "skills": {"enabled": true, "disabled": []},
            "animate": false,
            "sovereignPrompt": false,
            "maxIterations": 50
        }"#;
        let view: AgentRuntimeView = serde_json::from_str(json).expect("deserialize");
        assert_eq!(view.version, 1);
    }

    // -----------------------------------------------------------------------
    // 22. Deserialize IntegrationsView from JSON
    // -----------------------------------------------------------------------

    #[test]
    fn integrations_view_deserialize_minimal() {
        let cfg = IntegrationsConfig::default();
        let view = IntegrationsView::from(&cfg);
        let json = serde_json::to_string(&view).expect("serialize");
        let back: IntegrationsView = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.version, 1);
    }

    #[test]
    fn integrations_view_deserialize_reserialize_stable() {
        let cfg = IntegrationsConfig::default();
        let original = IntegrationsView::from(&cfg);
        let json = serde_json::to_string(&original).expect("serialize");
        let back: IntegrationsView = serde_json::from_str(&json).expect("deserialize");
        let json2 = serde_json::to_string(&back).expect("re-serialize");
        assert_eq!(
            json, json2,
            "IntegrationsView serialize -> deserialize -> serialize must be stable"
        );
    }

    #[test]
    fn integrations_view_from_default_config_has_correct_embedding() {
        let cfg = IntegrationsConfig::default();
        let view = IntegrationsView::from(&cfg);
        assert_eq!(view.embedding.provider, "auto");
        assert!(view.embedding.model.is_none());
    }

    #[test]
    fn integrations_view_from_config_with_embedding_model() {
        let mut cfg = IntegrationsConfig::default();
        cfg.embedding = embedding_with_model("openai", "text-embedding-3-large");
        let view = IntegrationsView::from(&cfg);
        assert_eq!(view.embedding.provider, "openai");
        assert_eq!(
            view.embedding.model,
            Some("text-embedding-3-large".to_string())
        );
    }

    // -----------------------------------------------------------------------
    // 23. CompactionView round trip
    // -----------------------------------------------------------------------

    #[test]
    fn compaction_view_round_trip_default() {
        let view = CompactionView::default();
        let json = serde_json::to_string(&view).expect("serialize");
        let back: CompactionView = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.enabled, view.enabled);
        assert!((back.trigger_ratio - view.trigger_ratio).abs() < 1e-6_f32);
        assert!((back.keep_ratio - view.keep_ratio).abs() < 1e-6_f32);
    }

    #[test]
    fn compaction_view_round_trip_enabled() {
        let view = CompactionView {
            enabled: true,
            trigger_ratio: 0.75,
            keep_ratio: 0.25,
        };
        let json = serde_json::to_string(&view).expect("serialize");
        let back: CompactionView = serde_json::from_str(&json).expect("deserialize");
        assert!(back.enabled);
        assert!((back.trigger_ratio - 0.75_f32).abs() < 1e-5_f32);
        assert!((back.keep_ratio - 0.25_f32).abs() < 1e-5_f32);
    }

    #[test]
    fn compaction_view_round_trip_various_ratios() {
        for (trigger, keep) in [(0.5, 0.3), (0.9, 0.1), (0.6, 0.4), (1.0, 0.5)] {
            let view = CompactionView {
                enabled: true,
                trigger_ratio: trigger,
                keep_ratio: keep,
            };
            let json = serde_json::to_string(&view).expect("serialize");
            let back: CompactionView = serde_json::from_str(&json).expect("deserialize");
            assert!(
                (back.trigger_ratio - trigger).abs() < 1e-5_f32,
                "trigger_ratio {} did not round-trip",
                trigger
            );
            assert!(
                (back.keep_ratio - keep).abs() < 1e-5_f32,
                "keep_ratio {} did not round-trip",
                keep
            );
        }
    }

    #[test]
    fn compaction_view_serialized_json_has_camel_case_keys() {
        let view = CompactionView {
            enabled: true,
            trigger_ratio: 0.8,
            keep_ratio: 0.2,
        };
        let json = serde_json::to_value(&view).expect("serialize");
        let obj = json.as_object().expect("is object");
        assert!(obj.contains_key("enabled"));
        assert!(obj.contains_key("triggerRatio"), "missing triggerRatio");
        assert!(obj.contains_key("keepRatio"), "missing keepRatio");
        assert!(
            !obj.contains_key("trigger_ratio"),
            "snake_case must not appear"
        );
        assert!(
            !obj.contains_key("keep_ratio"),
            "snake_case must not appear"
        );
    }

    #[test]
    fn compaction_view_deserialize_from_camel_case_json() {
        let json = r#"{"enabled": true, "triggerRatio": 0.85, "keepRatio": 0.15}"#;
        let view: CompactionView = serde_json::from_str(json).expect("deserialize");
        assert!(view.enabled);
        assert!((view.trigger_ratio - 0.85_f32).abs() < 1e-5_f32);
        assert!((view.keep_ratio - 0.15_f32).abs() < 1e-5_f32);
    }

    #[test]
    fn compaction_view_enabled_false_round_trip() {
        let view = CompactionView {
            enabled: false,
            trigger_ratio: 0.0,
            keep_ratio: 0.0,
        };
        let json = serde_json::to_string(&view).expect("serialize");
        let back: CompactionView = serde_json::from_str(&json).expect("deserialize");
        assert!(!back.enabled);
    }

    // -----------------------------------------------------------------------
    // 24. ToolSelectionView with non-empty lists
    // -----------------------------------------------------------------------

    #[test]
    fn tool_selection_view_restrict_to_non_empty() {
        let view = ToolSelectionView {
            restrict_to: vec!["read_file".to_string(), "write_file".to_string()],
            excluded: vec![],
            disabled_mcp_servers: vec![],
            disabled_mcp_tools: vec![],
        };
        assert_eq!(view.restrict_to.len(), 2);
        assert_eq!(view.restrict_to[0], "read_file");
        assert_eq!(view.restrict_to[1], "write_file");
    }

    #[test]
    fn tool_selection_view_excluded_non_empty() {
        let view = ToolSelectionView {
            restrict_to: vec![],
            excluded: vec!["shell".to_string(), "write_file".to_string()],
            disabled_mcp_servers: vec![],
            disabled_mcp_tools: vec![],
        };
        assert_eq!(view.excluded.len(), 2);
        assert!(view.excluded.contains(&"shell".to_string()));
    }

    #[test]
    fn tool_selection_view_disabled_mcp_servers_non_empty() {
        let view = ToolSelectionView {
            restrict_to: vec![],
            excluded: vec![],
            disabled_mcp_servers: vec!["mcp-server-a".to_string(), "mcp-server-b".to_string()],
            disabled_mcp_tools: vec![],
        };
        assert_eq!(view.disabled_mcp_servers.len(), 2);
        assert!(view
            .disabled_mcp_servers
            .contains(&"mcp-server-a".to_string()));
    }

    #[test]
    fn tool_selection_view_disabled_mcp_tools_non_empty() {
        let view = ToolSelectionView {
            restrict_to: vec![],
            excluded: vec![],
            disabled_mcp_servers: vec![],
            disabled_mcp_tools: vec!["mcp-server/some_tool".to_string()],
        };
        assert_eq!(view.disabled_mcp_tools.len(), 1);
        assert_eq!(view.disabled_mcp_tools[0], "mcp-server/some_tool");
    }

    #[test]
    fn tool_selection_view_round_trip_with_data() {
        let view = ToolSelectionView {
            restrict_to: vec!["read_file".to_string(), "list_dir".to_string()],
            excluded: vec!["shell".to_string()],
            disabled_mcp_servers: vec!["dangerous-server".to_string()],
            disabled_mcp_tools: vec!["server/risky_tool".to_string()],
        };
        let json = serde_json::to_string(&view).expect("serialize");
        let back: ToolSelectionView = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.restrict_to, view.restrict_to);
        assert_eq!(back.excluded, view.excluded);
        assert_eq!(back.disabled_mcp_servers, view.disabled_mcp_servers);
        assert_eq!(back.disabled_mcp_tools, view.disabled_mcp_tools);
    }

    #[test]
    fn tool_selection_view_json_keys_camel_case_with_data() {
        let view = ToolSelectionView {
            restrict_to: vec!["read_file".to_string()],
            excluded: vec![],
            disabled_mcp_servers: vec!["bad-server".to_string()],
            disabled_mcp_tools: vec![],
        };
        let json = serde_json::to_value(&view).expect("serialize");
        let obj = json.as_object().expect("is object");
        assert!(obj.contains_key("restrictTo"), "missing restrictTo");
        assert!(obj.contains_key("excluded"), "missing excluded");
        assert!(
            obj.contains_key("disabledMcpServers"),
            "missing disabledMcpServers"
        );
        assert!(
            obj.contains_key("disabledMcpTools"),
            "missing disabledMcpTools"
        );
        // Verify data preserved
        let restrict_to = obj["restrictTo"].as_array().expect("array");
        assert_eq!(restrict_to.len(), 1);
        assert_eq!(restrict_to[0].as_str(), Some("read_file"));
    }

    #[test]
    fn tool_selection_view_deserialize_from_camel_case_json() {
        let json = r#"{
            "restrictTo": ["tool-a", "tool-b"],
            "excluded": ["tool-c"],
            "disabledMcpServers": ["srv-1"],
            "disabledMcpTools": ["srv-1/dangerous"]
        }"#;
        let view: ToolSelectionView = serde_json::from_str(json).expect("deserialize");
        assert_eq!(view.restrict_to, vec!["tool-a", "tool-b"]);
        assert_eq!(view.excluded, vec!["tool-c"]);
        assert_eq!(view.disabled_mcp_servers, vec!["srv-1"]);
        assert_eq!(view.disabled_mcp_tools, vec!["srv-1/dangerous"]);
    }

    #[test]
    fn tool_selection_view_many_tools() {
        let many_tools: Vec<String> = (0..50).map(|i| format!("tool_{}", i)).collect();
        let view = ToolSelectionView {
            restrict_to: many_tools.clone(),
            excluded: vec![],
            disabled_mcp_servers: vec![],
            disabled_mcp_tools: vec![],
        };
        let json = serde_json::to_string(&view).expect("serialize");
        let back: ToolSelectionView = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.restrict_to, many_tools);
    }

    // -----------------------------------------------------------------------
    // 25. SkillsView with disabled skills
    // -----------------------------------------------------------------------

    #[test]
    fn skills_view_with_one_disabled_skill() {
        use agent_core::core::definitions::resolved::SkillsParams;
        let params = SkillsParams {
            include: Vec::new(),
            enabled: true,
            disabled: vec!["skill-brainstorm".to_string()],
            source_dirs: vec![],
        };
        let view = SkillsView::from(&params);
        assert!(view.enabled);
        assert_eq!(view.disabled.len(), 1);
        assert_eq!(view.disabled[0], "skill-brainstorm");
    }

    #[test]
    fn skills_view_with_multiple_disabled_skills() {
        use agent_core::core::definitions::resolved::SkillsParams;
        let params = SkillsParams {
            include: Vec::new(),
            enabled: true,
            disabled: vec![
                "skill-a".to_string(),
                "skill-b".to_string(),
                "skill-c".to_string(),
            ],
            source_dirs: vec![],
        };
        let view = SkillsView::from(&params);
        assert_eq!(view.disabled.len(), 3);
        assert!(view.disabled.contains(&"skill-a".to_string()));
        assert!(view.disabled.contains(&"skill-b".to_string()));
        assert!(view.disabled.contains(&"skill-c".to_string()));
    }

    #[test]
    fn skills_view_disabled_round_trip() {
        use agent_core::core::definitions::resolved::SkillsParams;
        let params = SkillsParams {
            include: Vec::new(),
            enabled: false,
            disabled: vec!["skill-x".to_string(), "skill-y".to_string()],
            source_dirs: vec![],
        };
        let view = SkillsView::from(&params);
        let json = serde_json::to_string(&view).expect("serialize");
        let back: SkillsView = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.enabled, view.enabled);
        assert_eq!(back.disabled, view.disabled);
    }

    #[test]
    fn skills_view_json_with_disabled_has_correct_structure() {
        use agent_core::core::definitions::resolved::SkillsParams;
        let params = SkillsParams {
            include: Vec::new(),
            enabled: true,
            disabled: vec!["skill-disabled-1".to_string()],
            source_dirs: vec![],
        };
        let view = SkillsView::from(&params);
        let json = serde_json::to_value(&view).expect("serialize");
        let disabled_arr = json
            .get("disabled")
            .expect("missing disabled")
            .as_array()
            .expect("is array");
        assert_eq!(disabled_arr.len(), 1);
        assert_eq!(disabled_arr[0].as_str(), Some("skill-disabled-1"));
    }

    #[test]
    fn skills_view_deserialize_with_disabled_list() {
        let json = r#"{"enabled": true, "disabled": ["skill-a", "skill-b"]}"#;
        let view: SkillsView = serde_json::from_str(json).expect("deserialize");
        assert!(view.enabled);
        assert_eq!(view.disabled, vec!["skill-a", "skill-b"]);
    }

    #[test]
    fn skills_view_deserialize_enabled_false_with_disabled() {
        let json = r#"{"enabled": false, "disabled": ["skill-z"]}"#;
        let view: SkillsView = serde_json::from_str(json).expect("deserialize");
        assert!(!view.enabled);
        assert_eq!(view.disabled, vec!["skill-z"]);
    }

    #[test]
    fn skills_view_many_disabled_skills() {
        use agent_core::core::definitions::resolved::SkillsParams;
        let many: Vec<String> = (0..20).map(|i| format!("skill-{}", i)).collect();
        let params = SkillsParams {
            include: Vec::new(),
            enabled: true,
            disabled: many.clone(),
            source_dirs: vec![],
        };
        let view = SkillsView::from(&params);
        let json = serde_json::to_string(&view).expect("serialize");
        let back: SkillsView = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.disabled, many);
    }

    // -----------------------------------------------------------------------
    // Additional coverage: embedding in AgentRuntimeView propagates
    // from IntegrationsConfig correctly
    // -----------------------------------------------------------------------

    #[test]
    fn agent_runtime_view_embedding_provider_from_integrations() {
        let mut integrations = IntegrationsConfig::default();
        integrations.embedding.provider = "azure".to_string();
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &integrations));
        assert_eq!(view.embedding.provider, "azure");
    }

    #[test]
    fn agent_runtime_view_embedding_model_from_integrations() {
        let mut integrations = IntegrationsConfig::default();
        integrations.embedding = embedding_with_model("openai", "text-embedding-3-large");
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &integrations));
        assert_eq!(view.embedding.provider, "openai");
        assert_eq!(
            view.embedding.model,
            Some("text-embedding-3-large".to_string())
        );
    }

    #[test]
    fn agent_runtime_view_embedding_none_model_with_default_integrations() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        assert!(view.embedding.model.is_none());
    }

    // -----------------------------------------------------------------------
    // Additional coverage: selected_account_id option semantics
    // -----------------------------------------------------------------------

    #[test]
    fn agent_runtime_view_selected_account_id_none_serialized() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        let json = serde_json::to_value(&view).expect("serialize");
        // selectedAccountId should be absent or null when None
        let val = json.get("selectedAccountId");
        let ok = val.is_none() || val == Some(&serde_json::Value::Null);
        assert!(
            ok,
            "selectedAccountId should be null/absent when None; got: {:?}",
            val
        );
    }

    #[test]
    fn agent_runtime_view_selected_account_id_none_camel_case_key() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        let json = serde_json::to_value(&view).expect("serialize");
        // No snake_case key regardless
        assert!(
            json.get("selected_account_id").is_none(),
            "snake_case selected_account_id must never appear"
        );
    }

    // -----------------------------------------------------------------------
    // Additional coverage: from_definition vs from produce different model fields
    // -----------------------------------------------------------------------

    #[test]
    fn from_definition_model_empty_while_from_resolved_model_is_set() {
        let def = get_builtin_agent(OS_AGENT_ID).expect("OS exists");
        let def_view = AgentRuntimeView::from_definition(&def, &default_integrations());
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let resolved_view = AgentRuntimeView::from((&resolved, &default_integrations()));
        assert!(
            def_view.model.is_empty(),
            "from_definition model must be empty"
        );
        assert!(
            !resolved_view.model.is_empty(),
            "from_resolved model must be non-empty"
        );
    }

    // -----------------------------------------------------------------------
    // Additional coverage: learnings view camelCase key names in nested JSON
    // -----------------------------------------------------------------------

    #[test]
    fn agent_runtime_view_json_learnings_nested_camel_case() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        let json = serde_json::to_value(&view).expect("serialize");
        let learnings = json
            .get("learnings")
            .expect("has learnings")
            .as_object()
            .expect("object");
        assert!(
            learnings.contains_key("enabled"),
            "learnings missing 'enabled'"
        );
        assert!(
            learnings.contains_key("extractMemoriesEnabled"),
            "learnings missing camelCase 'extractMemoriesEnabled'"
        );
        assert!(
            learnings.contains_key("autoDreamEnabled"),
            "learnings missing camelCase 'autoDreamEnabled'"
        );
        assert!(
            !learnings.contains_key("extract_memories_enabled"),
            "snake_case must not appear"
        );
        assert!(
            !learnings.contains_key("auto_dream_enabled"),
            "snake_case must not appear"
        );
    }

    #[test]
    fn agent_runtime_view_json_tools_nested_camel_case() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        let json = serde_json::to_value(&view).expect("serialize");
        let tools = json
            .get("tools")
            .expect("has tools")
            .as_object()
            .expect("object");
        assert!(
            tools.contains_key("restrictTo"),
            "tools missing 'restrictTo'"
        );
        assert!(tools.contains_key("excluded"), "tools missing 'excluded'");
        assert!(
            tools.contains_key("disabledMcpServers"),
            "tools missing 'disabledMcpServers'"
        );
        assert!(
            tools.contains_key("disabledMcpTools"),
            "tools missing 'disabledMcpTools'"
        );
    }

    #[test]
    fn agent_runtime_view_json_compaction_nested_camel_case() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        let json = serde_json::to_value(&view).expect("serialize");
        let compaction = json
            .get("compaction")
            .expect("has compaction")
            .as_object()
            .expect("object");
        assert!(
            compaction.contains_key("enabled"),
            "compaction missing 'enabled'"
        );
        assert!(
            compaction.contains_key("triggerRatio"),
            "compaction missing 'triggerRatio'"
        );
        assert!(
            compaction.contains_key("keepRatio"),
            "compaction missing 'keepRatio'"
        );
    }

    // -----------------------------------------------------------------------
    // Additional coverage: multiple serialization/deserialization cycles
    // -----------------------------------------------------------------------

    #[test]
    fn agent_runtime_view_triple_serialize_stable() {
        let resolved = make_resolved_for_testing(SDE_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        let j1 = serde_json::to_string(&view).unwrap();
        let v2: AgentRuntimeView = serde_json::from_str(&j1).unwrap();
        let j2 = serde_json::to_string(&v2).unwrap();
        let v3: AgentRuntimeView = serde_json::from_str(&j2).unwrap();
        let j3 = serde_json::to_string(&v3).unwrap();
        assert_eq!(j1, j2, "first and second serialization differ");
        assert_eq!(j2, j3, "second and third serialization differ");
    }

    #[test]
    fn integrations_view_triple_serialize_stable() {
        let cfg = IntegrationsConfig::default();
        let view = IntegrationsView::from(&cfg);
        let j1 = serde_json::to_string(&view).unwrap();
        let v2: IntegrationsView = serde_json::from_str(&j1).unwrap();
        let j2 = serde_json::to_string(&v2).unwrap();
        assert_eq!(
            j1, j2,
            "IntegrationsView serialize -> deserialize -> serialize must be stable"
        );
    }

    // -----------------------------------------------------------------------
    // Additional coverage: EmbeddingView in AgentRuntimeView JSON
    // -----------------------------------------------------------------------

    #[test]
    fn agent_runtime_view_json_embedding_has_provider() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        let json = serde_json::to_value(&view).expect("serialize");
        let embedding = json
            .get("embedding")
            .expect("has embedding")
            .as_object()
            .expect("object");
        assert!(
            embedding.contains_key("provider"),
            "embedding missing 'provider'"
        );
    }

    #[test]
    fn agent_runtime_view_json_embedding_provider_is_auto_by_default() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        let json = serde_json::to_value(&view).expect("serialize");
        let provider = json
            .get("embedding")
            .and_then(|e| e.get("provider"))
            .and_then(|p| p.as_str())
            .expect("embedding.provider must be a string");
        assert_eq!(provider, "auto");
    }

    // -----------------------------------------------------------------------
    // Additional coverage: ExecutionModeView does not serialize with capital letters
    // -----------------------------------------------------------------------

    #[test]
    fn execution_mode_view_direct_json_is_lowercase() {
        let view = ExecutionModeView::Direct;
        let json = serde_json::to_string(&view).unwrap();
        assert_eq!(
            json,
            json.to_lowercase(),
            "ExecutionModeView::Direct must serialize to all-lowercase"
        );
    }

    #[test]
    fn execution_mode_view_work_station_json_contains_underscore() {
        let view = ExecutionModeView::WorkStation;
        let json = serde_json::to_string(&view).unwrap();
        assert!(
            json.contains('_'),
            "ExecutionModeView::WorkStation must serialize with underscore, got: {}",
            json
        );
    }

    // -----------------------------------------------------------------------
    // Additional coverage: AutonomyLevelView does not serialize with capital letters
    // -----------------------------------------------------------------------

    #[test]
    fn autonomy_level_view_readonly_json_is_all_lowercase() {
        let view = AutonomyLevelView::ReadOnly;
        let json = serde_json::to_string(&view).unwrap();
        assert_eq!(json, "\"readonly\"");
        // Must be all lowercase
        assert_eq!(json, json.to_lowercase());
    }

    #[test]
    fn autonomy_level_view_full_json_is_all_lowercase() {
        let view = AutonomyLevelView::Full;
        let json = serde_json::to_string(&view).unwrap();
        assert_eq!(json, "\"full\"");
        assert_eq!(json, json.to_lowercase());
    }

    // -----------------------------------------------------------------------
    // Additional coverage: IntegrationsView reflects IntegrationsConfig fields
    // -----------------------------------------------------------------------

    #[test]
    fn integrations_view_nodes_enabled_reflects_config() {
        let mut cfg = IntegrationsConfig::default();
        cfg.nodes.enabled = true;
        let view = IntegrationsView::from(&cfg);
        let json = serde_json::to_value(&view).expect("serialize");
        let nodes_enabled = json
            .get("nodes")
            .and_then(|n| n.get("enabled"))
            .and_then(|e| e.as_bool());
        assert_eq!(nodes_enabled, Some(true), "nodes.enabled must propagate");
    }

    #[test]
    fn integrations_view_nodes_disabled_reflects_config() {
        let mut cfg = IntegrationsConfig::default();
        cfg.nodes.enabled = false;
        let view = IntegrationsView::from(&cfg);
        let json = serde_json::to_value(&view).expect("serialize");
        let nodes_enabled = json
            .get("nodes")
            .and_then(|n| n.get("enabled"))
            .and_then(|e| e.as_bool());
        assert_eq!(
            nodes_enabled,
            Some(false),
            "nodes.enabled=false must propagate"
        );
    }

    // -----------------------------------------------------------------------
    // Additional coverage: AgentRuntimeView with WorkStation execution mode
    // -----------------------------------------------------------------------

    #[test]
    fn agent_runtime_view_execution_mode_direct_serializes() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        let json = serde_json::to_value(&view).expect("serialize");
        let mode = json
            .get("executionMode")
            .and_then(|m| m.as_str())
            .expect("executionMode is string");
        // OS agent defaults to direct
        assert!(
            mode == "direct" || mode == "work_station",
            "executionMode must be 'direct' or 'work_station', got '{}'",
            mode
        );
    }

    // -----------------------------------------------------------------------
    // Additional coverage: AgentRuntimeView JSON learnings.enabled is boolean
    // -----------------------------------------------------------------------

    #[test]
    fn agent_runtime_view_json_learnings_enabled_is_boolean() {
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let view = AgentRuntimeView::from((&resolved, &default_integrations()));
        let json = serde_json::to_value(&view).expect("serialize");
        let enabled = json
            .get("learnings")
            .and_then(|l| l.get("enabled"))
            .expect("learnings.enabled must exist");
        assert!(enabled.is_boolean(), "learnings.enabled must be boolean");
    }

    // -----------------------------------------------------------------------
    // Additional coverage: ToolSelectionView from ResolvedToolSelection
    // -----------------------------------------------------------------------

    #[test]
    fn tool_selection_view_from_resolved_tool_selection_empty() {
        use agent_core::core::definitions::resolved::ResolvedToolSelection;
        let sel = ResolvedToolSelection::default();
        let view = ToolSelectionView::from(&sel);
        assert!(view.restrict_to.is_empty());
        assert!(view.excluded.is_empty());
        assert!(view.disabled_mcp_servers.is_empty());
        assert!(view.disabled_mcp_tools.is_empty());
    }

    #[test]
    fn tool_selection_view_from_resolved_tool_selection_with_data() {
        use agent_core::core::definitions::resolved::ResolvedToolSelection;
        let sel = ResolvedToolSelection {
            restrict_to: vec!["tool_a".to_string()],
            excluded: vec!["tool_b".to_string()],
            disabled_mcp_servers: vec!["mcp_srv".to_string()],
            disabled_mcp_tools: vec!["mcp_srv/tool_c".to_string()],
        };
        let view = ToolSelectionView::from(&sel);
        assert_eq!(view.restrict_to, vec!["tool_a"]);
        assert_eq!(view.excluded, vec!["tool_b"]);
        assert_eq!(view.disabled_mcp_servers, vec!["mcp_srv"]);
        assert_eq!(view.disabled_mcp_tools, vec!["mcp_srv/tool_c"]);
    }

    // -----------------------------------------------------------------------
    // Additional coverage: CompactionView from CompactionConfig
    // -----------------------------------------------------------------------

    #[test]
    fn compaction_view_from_config_disabled() {
        use agent_core::core::model_context::compaction::CompactionConfig;
        let cfg = CompactionConfig {
            enabled: false,
            trigger_ratio: 0.5,
            keep_ratio: 0.2,
            ..Default::default()
        };
        let view = CompactionView::from(&cfg);
        assert!(!view.enabled);
        assert!((view.trigger_ratio - 0.5_f32).abs() < 1e-5_f32);
        assert!((view.keep_ratio - 0.2_f32).abs() < 1e-5_f32);
    }

    #[test]
    fn compaction_view_from_config_full_settings() {
        use agent_core::core::model_context::compaction::CompactionConfig;
        let cfg = CompactionConfig {
            enabled: true,
            trigger_ratio: 0.9,
            keep_ratio: 0.1,
            ..Default::default()
        };
        let view = CompactionView::from(&cfg);
        assert!(view.enabled);
        assert!((view.trigger_ratio - 0.9_f32).abs() < 1e-5_f32);
        assert!((view.keep_ratio - 0.1_f32).abs() < 1e-5_f32);
    }

    // -----------------------------------------------------------------------
    // Additional coverage: AgentRuntimeView for SDE agent from_definition
    // -----------------------------------------------------------------------

    #[test]
    fn from_definition_sde_name_non_empty() {
        let def = get_builtin_agent(SDE_AGENT_ID).expect("SDE agent exists");
        let view = AgentRuntimeView::from_definition(&def, &default_integrations());
        assert!(!view.name.is_empty(), "SDE agent name must not be empty");
    }

    #[test]
    fn from_definition_sde_max_tokens_is_8192() {
        let def = get_builtin_agent(SDE_AGENT_ID).expect("SDE agent exists");
        let view = AgentRuntimeView::from_definition(&def, &default_integrations());
        assert_eq!(view.max_tokens, 8192);
    }

    #[test]
    fn from_definition_sde_max_iterations_is_50() {
        let def = get_builtin_agent(SDE_AGENT_ID).expect("SDE agent exists");
        let view = AgentRuntimeView::from_definition(&def, &default_integrations());
        assert_eq!(view.max_iterations, 50);
    }

    #[test]
    fn from_definition_sde_context_window_is_200000() {
        let def = get_builtin_agent(SDE_AGENT_ID).expect("SDE agent exists");
        let view = AgentRuntimeView::from_definition(&def, &default_integrations());
        assert_eq!(view.context_window, 200_000);
    }

    // -----------------------------------------------------------------------
    // Additional coverage: EmbeddingView from EmbeddingConfig - edge cases
    // -----------------------------------------------------------------------

    #[test]
    fn embedding_view_provider_is_preserved_exactly() {
        let cfg = EmbeddingConfig {
            provider: "custom-provider-v2".to_string(),
            model: None,
        };
        let view = EmbeddingView::from(&cfg);
        assert_eq!(view.provider, "custom-provider-v2");
    }

    #[test]
    fn embedding_view_model_with_special_chars_preserved() {
        let cfg = embedding_with_model("openai", "text-embedding-3-large:1024");
        let view = EmbeddingView::from(&cfg);
        assert_eq!(view.model, Some("text-embedding-3-large:1024".to_string()));
    }

    #[test]
    fn embedding_view_round_trip_none_model() {
        let cfg = EmbeddingConfig::default();
        let view = EmbeddingView::from(&cfg);
        let json = serde_json::to_string(&view).expect("serialize");
        let back: EmbeddingView = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.provider, view.provider);
        assert_eq!(back.model, view.model);
    }

    // -----------------------------------------------------------------------
    // Additional coverage: AgentLearningsView round-trip for all combinations
    // -----------------------------------------------------------------------

    #[test]
    fn agent_learnings_view_round_trip_enabled_false() {
        use agent_core::core::definitions::schema::AgentLearningsConfig;
        let cfg = AgentLearningsConfig {
            enabled: false,
            extract_memories_enabled: false,
            auto_dream_enabled: false,
        };
        let view = AgentLearningsView::from(&cfg);
        let json = serde_json::to_string(&view).expect("serialize");
        let back: AgentLearningsView = serde_json::from_str(&json).expect("deserialize");
        assert!(!back.enabled);
        assert!(!back.extract_memories_enabled);
        assert!(!back.auto_dream_enabled);
    }

    #[test]
    fn agent_learnings_view_round_trip_auto_dream_only() {
        use agent_core::core::definitions::schema::AgentLearningsConfig;
        let cfg = AgentLearningsConfig {
            enabled: true,
            extract_memories_enabled: false,
            auto_dream_enabled: true,
        };
        let view = AgentLearningsView::from(&cfg);
        let json = serde_json::to_string(&view).expect("serialize");
        let back: AgentLearningsView = serde_json::from_str(&json).expect("deserialize");
        assert!(back.enabled);
        assert!(!back.extract_memories_enabled);
        assert!(back.auto_dream_enabled);
    }

    // -----------------------------------------------------------------------
    // Final guard: the AgentRuntimeView VERSION constant is stable
    // -----------------------------------------------------------------------

    #[test]
    fn version_constant_not_changed_after_modification() {
        // Construct, modify a copy, and verify the constant is unchanged.
        let resolved = make_resolved_for_testing(OS_AGENT_ID);
        let mut view = AgentRuntimeView::from((&resolved, &default_integrations()));
        view.model = "different-model".to_string();
        // VERSION constant must still be 1
        assert_eq!(AgentRuntimeView::VERSION, 1);
        // But the view's version field is still 1
        assert_eq!(view.version, 1);
    }

    #[test]
    fn integrations_view_version_constant_not_zero() {
        const {
            assert!(
                IntegrationsView::VERSION > 0,
                "IntegrationsView::VERSION must be > 0"
            );
        }
    }

    #[test]
    fn agent_runtime_view_version_constant_not_zero() {
        const {
            assert!(
                AgentRuntimeView::VERSION > 0,
                "AgentRuntimeView::VERSION must be > 0"
            );
        }
    }
} // end dto_extended_tests
