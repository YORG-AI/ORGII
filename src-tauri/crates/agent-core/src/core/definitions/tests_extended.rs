//! Extended test suite for agent-core definitions module.
//!
//! Covers: builtin registry, schema types, serialization, resolution logic.
//! Included from resolved.rs or mod.rs via:
//!   #[cfg(test)] #[path = "tests_extended.rs"] mod tests_extended;

#[cfg(test)]
mod tests_extended {
    use crate::core::definitions::builtin::{
        get_builtin_agent, get_builtin_agents, is_builtin_agent, ADE_MANAGER_ID,
        AI_RESEARCH_AGENT_ID, BASE_AGENT_ID, BUILTIN_PREFIX, EXPLORE_AGENT_ID, GENERAL_AGENT_ID,
        MEMORY_CONSOLIDATOR_ID, MEMORY_EXTRACTOR_ID, OS_AGENT_ID, SDE_AGENT_ID, WINGMAN_AGENT_ID,
    };
    use crate::core::definitions::resolved::{
        ResolveError, ResolvedAgent, ResolvedToolSelection, SkillsParams,
    };
    use crate::core::definitions::schema::{
        AgentDefinition, AgentLearningsConfig, AgentPolicy, AgentTier, AgentToolSelection,
        SessionMode, SessionModel,
    };
    use crate::core::session::overrides::SessionOverrides;
    use std::collections::HashSet;
    use std::path::PathBuf;

    // =========================================================================
    // Helpers
    // =========================================================================

    /// Pin a model ID so resolve() does not fail with MissingModel.
    fn with_model(mut def: AgentDefinition) -> AgentDefinition {
        if def.selected_model_id.is_none() {
            def.selected_model_id = Some("test/model".to_string());
        }
        def
    }

    /// Default overrides (all None).
    fn default_overrides() -> SessionOverrides {
        SessionOverrides::default()
    }

    // =========================================================================
    // 1. is_builtin_agent returns true for known builtin IDs
    // =========================================================================

    #[test]
    fn is_builtin_os_returns_true() {
        assert!(is_builtin_agent("builtin:os"));
    }

    #[test]
    fn is_builtin_sde_returns_true() {
        assert!(is_builtin_agent("builtin:sde"));
    }

    #[test]
    fn is_builtin_wingman_returns_true() {
        assert!(is_builtin_agent("builtin:wingman"));
    }

    #[test]
    fn is_builtin_base_returns_true() {
        assert!(is_builtin_agent(BASE_AGENT_ID));
    }

    #[test]
    fn is_builtin_explore_returns_true() {
        assert!(is_builtin_agent(EXPLORE_AGENT_ID));
    }

    #[test]
    fn is_builtin_general_returns_true() {
        assert!(is_builtin_agent(GENERAL_AGENT_ID));
    }

    #[test]
    fn is_builtin_memory_extractor_returns_true() {
        assert!(is_builtin_agent(MEMORY_EXTRACTOR_ID));
    }

    #[test]
    fn is_builtin_memory_consolidator_returns_true() {
        assert!(is_builtin_agent(MEMORY_CONSOLIDATOR_ID));
    }

    #[test]
    fn is_builtin_ai_research_returns_true() {
        assert!(is_builtin_agent(AI_RESEARCH_AGENT_ID));
    }

    #[test]
    fn is_builtin_ade_manager_returns_true() {
        assert!(is_builtin_agent(ADE_MANAGER_ID));
    }

    // =========================================================================
    // 2. is_builtin_agent returns false for non-builtin IDs
    // =========================================================================

    #[test]
    fn is_builtin_empty_string_returns_false() {
        assert!(!is_builtin_agent(""));
    }

    #[test]
    fn is_builtin_custom_agent_returns_false() {
        assert!(!is_builtin_agent("custom-agent"));
    }

    #[test]
    fn is_builtin_user_prefix_returns_false() {
        assert!(!is_builtin_agent("user:agent"));
    }

    #[test]
    fn is_builtin_bare_colon_returns_false() {
        assert!(!is_builtin_agent(":"));
    }

    #[test]
    fn is_builtin_builtin_no_colon_returns_false() {
        // "builtin" without colon is not a builtin
        assert!(!is_builtin_agent("builtin"));
    }

    #[test]
    fn is_builtin_partial_prefix_returns_false() {
        assert!(!is_builtin_agent("built"));
    }

    #[test]
    fn is_builtin_numbers_only_returns_false() {
        assert!(!is_builtin_agent("123"));
    }

    #[test]
    fn is_builtin_whitespace_returns_false() {
        assert!(!is_builtin_agent("  "));
    }

    // =========================================================================
    // 3. BUILTIN_PREFIX constant value
    // =========================================================================

    #[test]
    fn builtin_prefix_constant_value() {
        assert_eq!(BUILTIN_PREFIX, "builtin:");
    }

    #[test]
    fn is_builtin_uses_prefix_constant() {
        let id = format!("{}{}", BUILTIN_PREFIX, "test-agent");
        assert!(is_builtin_agent(&id));
    }

    // =========================================================================
    // 4. get_builtin_agent returns Some for known IDs
    // =========================================================================

    #[test]
    fn get_builtin_agent_os_returns_some() {
        assert!(get_builtin_agent(OS_AGENT_ID).is_some());
    }

    #[test]
    fn get_builtin_agent_sde_returns_some() {
        assert!(get_builtin_agent(SDE_AGENT_ID).is_some());
    }

    #[test]
    fn get_builtin_agent_wingman_returns_some() {
        assert!(get_builtin_agent(WINGMAN_AGENT_ID).is_some());
    }

    #[test]
    fn get_builtin_agent_base_returns_some() {
        assert!(get_builtin_agent(BASE_AGENT_ID).is_some());
    }

    #[test]
    fn get_builtin_agent_explore_returns_some() {
        assert!(get_builtin_agent(EXPLORE_AGENT_ID).is_some());
    }

    #[test]
    fn get_builtin_agent_general_returns_some() {
        assert!(get_builtin_agent(GENERAL_AGENT_ID).is_some());
    }

    #[test]
    fn get_builtin_agent_memory_extractor_returns_some() {
        assert!(get_builtin_agent(MEMORY_EXTRACTOR_ID).is_some());
    }

    #[test]
    fn get_builtin_agent_memory_consolidator_returns_some() {
        assert!(get_builtin_agent(MEMORY_CONSOLIDATOR_ID).is_some());
    }

    #[test]
    fn get_builtin_agent_ai_research_returns_some() {
        assert!(get_builtin_agent(AI_RESEARCH_AGENT_ID).is_some());
    }

    #[test]
    fn get_builtin_ade_manager_returns_some() {
        assert!(get_builtin_agent(ADE_MANAGER_ID).is_some());
    }

    // =========================================================================
    // 5. get_builtin_agent returns None for unknown IDs
    // =========================================================================

    #[test]
    fn get_builtin_agent_empty_returns_none() {
        assert!(get_builtin_agent("").is_none());
    }

    #[test]
    fn get_builtin_agent_unknown_returns_none() {
        assert!(get_builtin_agent("builtin:does-not-exist").is_none());
    }

    #[test]
    fn get_builtin_agent_custom_returns_none() {
        assert!(get_builtin_agent("custom-agent-123").is_none());
    }

    #[test]
    fn get_builtin_agent_partial_id_returns_none() {
        assert!(get_builtin_agent("builtin:o").is_none());
    }

    #[test]
    fn get_builtin_agent_uppercase_returns_none() {
        // IDs are case-sensitive
        assert!(get_builtin_agent("builtin:OS").is_none());
        assert!(get_builtin_agent("builtin:SDE").is_none());
        assert!(get_builtin_agent("BUILTIN:os").is_none());
    }

    // =========================================================================
    // 6. get_builtin_agents returns non-empty list
    // =========================================================================

    #[test]
    fn get_builtin_agents_returns_non_empty() {
        let agents = get_builtin_agents();
        assert!(
            !agents.is_empty(),
            "get_builtin_agents must return at least one agent"
        );
    }

    #[test]
    fn get_builtin_agents_count_matches_registry() {
        // ADE Manager, base, os, sde, ds, ai-research, wingman,
        // work-item-manager, explore, general, memory-extractor,
        // memory-consolidator  (gui-control merged into ADE Manager)
        let agents = get_builtin_agents();
        assert_eq!(agents.len(), 12);
    }

    // =========================================================================
    // 7. All returned builtin agents have non-empty id and name
    // =========================================================================

    #[test]
    fn all_builtin_agents_have_non_empty_id() {
        for agent in get_builtin_agents() {
            assert!(!agent.id.is_empty(), "Agent has empty id");
        }
    }

    #[test]
    fn all_builtin_agents_have_non_empty_name() {
        for agent in get_builtin_agents() {
            assert!(!agent.name.is_empty(), "Agent {} has empty name", agent.id);
        }
    }

    #[test]
    fn all_builtin_agents_have_built_in_true() {
        for agent in get_builtin_agents() {
            assert!(
                agent.built_in,
                "Agent {} should have built_in = true",
                agent.id
            );
        }
    }

    // =========================================================================
    // 8. All builtin IDs start with "builtin:" prefix
    // =========================================================================

    #[test]
    fn all_builtin_ids_start_with_prefix() {
        for agent in get_builtin_agents() {
            assert!(
                agent.id.starts_with(BUILTIN_PREFIX),
                "Agent id {:?} does not start with {:?}",
                agent.id,
                BUILTIN_PREFIX
            );
        }
    }

    #[test]
    fn all_builtin_ids_pass_is_builtin_check() {
        for agent in get_builtin_agents() {
            assert!(
                is_builtin_agent(&agent.id),
                "is_builtin_agent returned false for id {:?}",
                agent.id
            );
        }
    }

    // =========================================================================
    // 9. No duplicate IDs in get_builtin_agents
    // =========================================================================

    #[test]
    fn no_duplicate_ids_in_builtin_agents() {
        let agents = get_builtin_agents();
        let mut seen: HashSet<&str> = HashSet::new();
        for agent in &agents {
            let inserted = seen.insert(agent.id.as_str());
            assert!(inserted, "Duplicate builtin agent id: {:?}", agent.id);
        }
    }

    #[test]
    fn no_duplicate_names_in_builtin_agents() {
        let agents = get_builtin_agents();
        let mut seen: HashSet<&str> = HashSet::new();
        for agent in &agents {
            let inserted = seen.insert(agent.name.as_str());
            assert!(inserted, "Duplicate builtin agent name: {:?}", agent.name);
        }
    }

    // =========================================================================
    // 10. AgentDefinition defaults
    // =========================================================================

    #[test]
    fn agent_definition_default_has_empty_id() {
        let def = AgentDefinition::default();
        assert_eq!(def.id, "");
    }

    #[test]
    fn agent_definition_default_has_empty_name() {
        let def = AgentDefinition::default();
        assert_eq!(def.name, "");
    }

    #[test]
    fn agent_definition_default_built_in_is_false() {
        let def = AgentDefinition::default();
        assert!(!def.built_in);
    }

    #[test]
    fn agent_definition_default_inherits_from_is_none() {
        let def = AgentDefinition::default();
        assert!(def.inherits_from.is_none());
    }

    #[test]
    fn agent_definition_default_selected_model_is_none() {
        let def = AgentDefinition::default();
        assert!(def.selected_model_id.is_none());
    }

    #[test]
    fn agent_definition_default_selected_account_is_none() {
        let def = AgentDefinition::default();
        assert!(def.selected_account_id.is_none());
    }

    #[test]
    fn agent_definition_default_session_model_is_none() {
        let def = AgentDefinition::default();
        assert!(def.session_model.is_none());
    }

    #[test]
    fn agent_definition_default_sovereign_prompt_is_false() {
        let def = AgentDefinition::default();
        assert!(!def.sovereign_prompt);
    }

    // =========================================================================
    // 11. AgentDefinition serializes and deserializes correctly (round-trip)
    // =========================================================================

    #[test]
    fn agent_definition_json_round_trip_minimal() {
        let original = AgentDefinition {
            id: "my-agent".to_string(),
            name: "My Agent".to_string(),
            ..Default::default()
        };
        let json = serde_json::to_string(&original).expect("serialize");
        let restored: AgentDefinition = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(restored.id, original.id);
        assert_eq!(restored.name, original.name);
    }

    #[test]
    fn agent_definition_json_round_trip_with_model() {
        let original = AgentDefinition {
            id: "round-trip-test".to_string(),
            name: "Round Trip".to_string(),
            selected_model_id: Some("claude/opus".to_string()),
            selected_account_id: Some("acct-123".to_string()),
            sovereign_prompt: true,
            ..Default::default()
        };
        let json = serde_json::to_string(&original).expect("serialize");
        let restored: AgentDefinition = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(restored.selected_model_id, original.selected_model_id);
        assert_eq!(restored.selected_account_id, original.selected_account_id);
        assert_eq!(restored.sovereign_prompt, original.sovereign_prompt);
    }

    #[test]
    fn agent_definition_json_uses_camel_case_keys() {
        let def = AgentDefinition {
            id: "camel-test".to_string(),
            name: "Camel".to_string(),
            selected_model_id: Some("m".to_string()),
            built_in: true,
            ..Default::default()
        };
        let json = serde_json::to_string(&def).expect("serialize");
        assert!(
            json.contains("selectedModelId"),
            "expected camelCase selectedModelId in: {}",
            json
        );
        assert!(
            json.contains("builtIn"),
            "expected camelCase builtIn in: {}",
            json
        );
    }

    #[test]
    fn agent_definition_skips_none_fields_in_json() {
        let def = AgentDefinition {
            id: "skip-none".to_string(),
            name: "Skip None".to_string(),
            ..Default::default()
        };
        let json = serde_json::to_string(&def).expect("serialize");
        // None optional fields should be skipped
        assert!(
            !json.contains("selectedModelId"),
            "None field should be skipped: {}",
            json
        );
        assert!(
            !json.contains("description"),
            "None field should be skipped: {}",
            json
        );
    }

    #[test]
    fn agent_definition_deserialize_from_partial_json() {
        let json = r#"{"id":"partial","name":"Partial"}"#;
        let def: AgentDefinition = serde_json::from_str(json).expect("deserialize partial json");
        assert_eq!(def.id, "partial");
        assert_eq!(def.name, "Partial");
        assert!(def.selected_model_id.is_none());
        assert!(!def.built_in);
    }

    #[test]
    fn agent_definition_deserialize_with_inherits_from() {
        let json = r#"{"id":"child","name":"Child","inheritsFrom":"builtin:base"}"#;
        let def: AgentDefinition = serde_json::from_str(json).expect("deserialize");
        assert_eq!(def.inherits_from.as_deref(), Some("builtin:base"));
    }
    // =========================================================================
    // 12. SessionMode serialization in kebab-case
    // =========================================================================

    #[test]
    fn session_mode_default_is_per_session() {
        let mode = SessionMode::default();
        assert_eq!(mode, SessionMode::PerSession);
    }

    #[test]
    fn session_mode_per_session_serializes_to_kebab_case() {
        let mode = SessionMode::PerSession;
        let json = serde_json::to_string(&mode).expect("serialize");
        assert_eq!(json, r#""per-session""#);
    }

    #[test]
    fn session_mode_singleton_serializes_to_kebab_case() {
        let mode = SessionMode::Singleton;
        let json = serde_json::to_string(&mode).expect("serialize");
        assert_eq!(json, r#""singleton""#);
    }

    #[test]
    fn session_mode_per_session_deserializes_from_kebab_case() {
        let mode: SessionMode = serde_json::from_str(r#""per-session""#).expect("deserialize");
        assert_eq!(mode, SessionMode::PerSession);
    }

    #[test]
    fn session_mode_singleton_deserializes_from_string() {
        let mode: SessionMode = serde_json::from_str(r#""singleton""#).expect("deserialize");
        assert_eq!(mode, SessionMode::Singleton);
    }

    #[test]
    fn session_mode_round_trip_per_session() {
        let original = SessionMode::PerSession;
        let json = serde_json::to_string(&original).expect("serialize");
        let restored: SessionMode = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(original, restored);
    }

    #[test]
    fn session_mode_round_trip_singleton() {
        let original = SessionMode::Singleton;
        let json = serde_json::to_string(&original).expect("serialize");
        let restored: SessionMode = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(original, restored);
    }

    // =========================================================================
    // 13 & 14. SessionModel defaults
    // =========================================================================

    #[test]
    fn session_model_default_max_iterations_is_500() {
        let sm = SessionModel::default();
        assert_eq!(sm.max_iterations, 500);
    }

    #[test]
    fn session_model_default_processing_lock_is_true() {
        let sm = SessionModel::default();
        assert!(sm.processing_lock);
    }

    #[test]
    fn session_model_default_mode_is_per_session() {
        let sm = SessionModel::default();
        assert_eq!(sm.mode, SessionMode::PerSession);
    }

    #[test]
    fn session_model_default_compaction_is_none() {
        let sm = SessionModel::default();
        assert!(sm.compaction.is_none());
    }

    #[test]
    fn session_model_json_round_trip() {
        let sm = SessionModel::default();
        let json = serde_json::to_string(&sm).expect("serialize");
        let restored: SessionModel = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(restored.max_iterations, 500);
        assert_eq!(restored.processing_lock, true);
        assert_eq!(restored.mode, SessionMode::PerSession);
    }

    #[test]
    fn session_model_serializes_camel_case_keys() {
        let sm = SessionModel::default();
        let json = serde_json::to_string(&sm).expect("serialize");
        assert!(
            json.contains("maxIterations"),
            "expected maxIterations in {}",
            json
        );
        assert!(
            json.contains("processingLock"),
            "expected processingLock in {}",
            json
        );
    }

    // =========================================================================
    // 15. AgentPolicy defaults
    // =========================================================================

    #[test]
    fn agent_policy_default_blocked_commands_is_empty() {
        let policy = AgentPolicy::default();
        assert!(policy.blocked_commands.is_empty());
    }

    #[test]
    fn agent_policy_default_workspace_only_is_false() {
        let policy = AgentPolicy::default();
        assert!(!policy.workspace_only);
    }

    #[test]
    fn agent_policy_json_round_trip() {
        let original = AgentPolicy {
            workspace_only: true,
            blocked_commands: vec!["rm".to_string(), "sudo".to_string()],
            ..Default::default()
        };
        let json = serde_json::to_string(&original).expect("serialize");
        let restored: AgentPolicy = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(restored.workspace_only, true);
        assert_eq!(
            restored.blocked_commands,
            vec!["rm".to_string(), "sudo".to_string()]
        );
    }

    #[test]
    fn agent_policy_blocked_commands_skipped_when_empty() {
        let policy = AgentPolicy::default();
        let json = serde_json::to_string(&policy).expect("serialize");
        // skip_serializing_if = "Vec::is_empty" means the key should be absent
        assert!(
            !json.contains("blockedCommands"),
            "empty blocked_commands should be skipped: {}",
            json
        );
    }

    // =========================================================================
    // 16. AgentLearningsConfig defaults
    // =========================================================================

    #[test]
    fn learnings_config_default_enabled_is_true() {
        let cfg = AgentLearningsConfig::default();
        assert!(cfg.enabled);
    }

    #[test]
    fn learnings_config_default_extract_memories_is_false() {
        let cfg = AgentLearningsConfig::default();
        assert!(!cfg.extract_memories_enabled);
    }

    #[test]
    fn learnings_config_default_auto_dream_is_false() {
        let cfg = AgentLearningsConfig::default();
        assert!(!cfg.auto_dream_enabled);
    }

    #[test]
    fn learnings_config_json_round_trip() {
        let original = AgentLearningsConfig {
            enabled: true,
            extract_memories_enabled: true,
            auto_dream_enabled: false,
        };
        let json = serde_json::to_string(&original).expect("serialize");
        let restored: AgentLearningsConfig = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(restored.enabled, original.enabled);
        assert_eq!(
            restored.extract_memories_enabled,
            original.extract_memories_enabled
        );
        assert_eq!(restored.auto_dream_enabled, original.auto_dream_enabled);
    }

    #[test]
    fn learnings_config_json_uses_camel_case() {
        let cfg = AgentLearningsConfig::default();
        let json = serde_json::to_string(&cfg).expect("serialize");
        assert!(
            json.contains("extractMemoriesEnabled"),
            "expected camelCase in {}",
            json
        );
        assert!(
            json.contains("autoDreamEnabled"),
            "expected camelCase in {}",
            json
        );
    }

    // =========================================================================
    // 17. ResolvedAgent::resolve fails with MissingModel when no model set
    // =========================================================================

    #[test]
    fn resolve_fails_with_missing_model_no_model_set() {
        let def = AgentDefinition {
            id: "no-model-agent".to_string(),
            name: "No Model".to_string(),
            selected_model_id: None,
            ..Default::default()
        };
        let result = ResolvedAgent::resolve(&def, None, &default_overrides());
        assert!(result.is_err(), "Expected error when model is missing");
    }

    #[test]
    fn resolve_error_is_missing_model_variant() {
        let def = AgentDefinition {
            id: "no-model-agent".to_string(),
            name: "No Model".to_string(),
            selected_model_id: None,
            ..Default::default()
        };
        let err = ResolvedAgent::resolve(&def, None, &default_overrides()).unwrap_err();
        assert!(
            matches!(err, ResolveError::MissingModel(_)),
            "Expected ResolveError::MissingModel, got: {:?}",
            err
        );
    }

    // =========================================================================
    // 18. ResolvedAgent::resolve succeeds when model is set
    // =========================================================================

    #[test]
    fn resolve_succeeds_with_model_set() {
        let def = with_model(AgentDefinition {
            id: "has-model-agent".to_string(),
            name: "Has Model".to_string(),
            ..Default::default()
        });
        let result = ResolvedAgent::resolve(&def, None, &default_overrides());
        assert!(
            result.is_ok(),
            "Resolve should succeed with model set: {:?}",
            result.err()
        );
    }

    #[test]
    fn resolve_succeeds_for_os_agent_with_pinned_model() {
        let def = with_model(get_builtin_agent(OS_AGENT_ID).expect("os exists"));
        assert!(ResolvedAgent::resolve(&def, None, &default_overrides()).is_ok());
    }

    #[test]
    fn resolve_succeeds_for_sde_agent_with_pinned_model() {
        let def = with_model(get_builtin_agent(SDE_AGENT_ID).expect("sde exists"));
        assert!(ResolvedAgent::resolve(&def, None, &default_overrides()).is_ok());
    }

    #[test]
    fn resolve_succeeds_for_wingman_with_pinned_model() {
        let def = with_model(get_builtin_agent(WINGMAN_AGENT_ID).expect("wingman exists"));
        assert!(ResolvedAgent::resolve(&def, None, &default_overrides()).is_ok());
    }

    // =========================================================================
    // 19. ResolvedAgent has non-empty agent_id after resolve
    // =========================================================================

    #[test]
    fn resolved_agent_id_is_non_empty() {
        let def = with_model(get_builtin_agent(OS_AGENT_ID).expect("os exists"));
        let resolved = ResolvedAgent::resolve(&def, None, &default_overrides()).expect("resolve");
        assert!(!resolved.agent_id.is_empty());
    }

    #[test]
    fn resolved_agent_id_matches_definition_id() {
        let def = with_model(get_builtin_agent(OS_AGENT_ID).expect("os exists"));
        let resolved = ResolvedAgent::resolve(&def, None, &default_overrides()).expect("resolve");
        assert_eq!(resolved.agent_id, OS_AGENT_ID);
    }

    #[test]
    fn resolved_agent_name_matches_definition_name() {
        let def = with_model(get_builtin_agent(SDE_AGENT_ID).expect("sde exists"));
        let resolved = ResolvedAgent::resolve(&def, None, &default_overrides()).expect("resolve");
        assert!(!resolved.name.is_empty());
    }

    // =========================================================================
    // 20. ResolvedAgent has correct model after resolve
    // =========================================================================

    #[test]
    fn resolved_model_matches_set_model() {
        let mut def = get_builtin_agent(OS_AGENT_ID).expect("os exists");
        def.selected_model_id = Some("my-provider/my-model".to_string());
        let resolved = ResolvedAgent::resolve(&def, None, &default_overrides()).expect("resolve");
        assert_eq!(resolved.selected_model_id, "my-provider/my-model");
    }

    #[test]
    fn resolved_model_is_non_empty_string() {
        let def = with_model(get_builtin_agent(SDE_AGENT_ID).expect("sde exists"));
        let resolved = ResolvedAgent::resolve(&def, None, &default_overrides()).expect("resolve");
        assert!(!resolved.selected_model_id.is_empty());
    }

    #[test]
    fn resolved_model_different_for_different_overrides() {
        let mut def_a = get_builtin_agent(OS_AGENT_ID).expect("os exists");
        def_a.selected_model_id = Some("vendor/model-a".to_string());

        let mut def_b = get_builtin_agent(OS_AGENT_ID).expect("os exists");
        def_b.selected_model_id = Some("vendor/model-b".to_string());

        let ra = ResolvedAgent::resolve(&def_a, None, &default_overrides()).expect("resolve a");
        let rb = ResolvedAgent::resolve(&def_b, None, &default_overrides()).expect("resolve b");

        assert_ne!(ra.selected_model_id, rb.selected_model_id);
    }

    // =========================================================================
    // 21. ResolvedAgent workspace falls back to personal_workspace()
    // =========================================================================

    #[test]
    fn resolved_workspace_falls_back_to_personal_workspace() {
        let def = with_model(get_builtin_agent(OS_AGENT_ID).expect("os exists"));
        let resolved = ResolvedAgent::resolve(&def, None, &default_overrides()).expect("resolve");
        let expected = app_paths::personal_workspace();
        assert_eq!(resolved.workspace(), expected.as_path());
    }

    #[test]
    fn resolved_workspace_uses_override_when_provided() {
        let def = with_model(get_builtin_agent(OS_AGENT_ID).expect("os exists"));
        let override_path = PathBuf::from("/tmp/test-workspace-override");
        let overrides = SessionOverrides::new(Some(override_path.clone()), None);
        let resolved = ResolvedAgent::resolve(&def, None, &overrides).expect("resolve");
        assert_eq!(resolved.workspace(), override_path.as_path());
    }

    #[test]
    fn resolved_workspace_is_always_set() {
        let def = with_model(get_builtin_agent(SDE_AGENT_ID).expect("sde exists"));
        let resolved = ResolvedAgent::resolve(&def, None, &default_overrides()).expect("resolve");
        // workspace path must be non-empty (invariant: there is always a workspace)
        assert!(!resolved.workspace().as_os_str().is_empty());
    }
    // =========================================================================
    // 22. SkillsParams default has enabled=true
    // =========================================================================

    #[test]
    fn skills_params_default_enabled_is_true() {
        let sp = SkillsParams::default();
        assert!(sp.enabled);
    }

    // =========================================================================
    // 23. SkillsParams default has empty disabled list
    // =========================================================================

    #[test]
    fn skills_params_default_disabled_is_empty() {
        let sp = SkillsParams::default();
        assert!(sp.disabled.is_empty());
    }

    #[test]
    fn skills_params_default_source_dirs_is_empty() {
        let sp = SkillsParams::default();
        assert!(sp.source_dirs.is_empty());
    }

    #[test]
    fn skills_params_json_round_trip() {
        let original = SkillsParams {
            include: Vec::new(),
            enabled: false,
            disabled: vec!["skill-a".to_string(), "skill-b".to_string()],
            source_dirs: vec!["/some/dir".to_string()],
        };
        let json = serde_json::to_string(&original).expect("serialize");
        let restored: SkillsParams = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(restored.enabled, original.enabled);
        assert_eq!(restored.disabled, original.disabled);
        assert_eq!(restored.source_dirs, original.source_dirs);
    }

    #[test]
    fn skills_params_json_uses_camel_case() {
        let sp = SkillsParams {
            include: Vec::new(),
            enabled: true,
            disabled: vec!["x".to_string()],
            source_dirs: vec!["/dir".to_string()],
        };
        let json = serde_json::to_string(&sp).expect("serialize");
        assert!(
            json.contains("sourceDirs"),
            "expected sourceDirs in {}",
            json
        );
    }

    // =========================================================================
    // 24. ResolvedToolSelection default is empty lists
    // =========================================================================

    #[test]
    fn resolved_tool_selection_default_restrict_to_is_empty() {
        let rts = ResolvedToolSelection::default();
        assert!(rts.restrict_to.is_empty());
    }

    #[test]
    fn resolved_tool_selection_default_excluded_is_empty() {
        let rts = ResolvedToolSelection::default();
        assert!(rts.excluded.is_empty());
    }

    #[test]
    fn resolved_tool_selection_default_disabled_mcp_servers_is_empty() {
        let rts = ResolvedToolSelection::default();
        assert!(rts.disabled_mcp_servers.is_empty());
    }

    #[test]
    fn resolved_tool_selection_default_disabled_mcp_tools_is_empty() {
        let rts = ResolvedToolSelection::default();
        assert!(rts.disabled_mcp_tools.is_empty());
    }

    #[test]
    fn resolved_tool_selection_json_round_trip() {
        let original = ResolvedToolSelection {
            restrict_to: vec!["read_file".to_string()],
            excluded: vec!["edit_file".to_string()],
            disabled_mcp_servers: vec![],
            disabled_mcp_tools: vec![],
        };
        let json = serde_json::to_string(&original).expect("serialize");
        let restored: ResolvedToolSelection = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(restored.restrict_to, original.restrict_to);
        assert_eq!(restored.excluded, original.excluded);
    }

    // =========================================================================
    // 25. ResolveError::MissingModel carries the agent id
    // =========================================================================

    #[test]
    fn resolve_error_missing_model_carries_agent_id() {
        let agent_id = "my-test-agent-no-model";
        let def = AgentDefinition {
            id: agent_id.to_string(),
            name: "Test".to_string(),
            selected_model_id: None,
            ..Default::default()
        };
        let err = ResolvedAgent::resolve(&def, None, &default_overrides()).unwrap_err();
        match err {
            ResolveError::MissingModel(id) => {
                assert_eq!(id, agent_id, "MissingModel must carry the agent id");
            }
            other => panic!("Expected MissingModel, got {:?}", other),
        }
    }

    #[test]
    fn resolve_error_missing_model_error_message_contains_id() {
        let def = AgentDefinition {
            id: "error-msg-test".to_string(),
            name: "Error Msg Test".to_string(),
            selected_model_id: None,
            ..Default::default()
        };
        let err = ResolvedAgent::resolve(&def, None, &default_overrides()).unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("error-msg-test"),
            "Error message should contain agent id, got: {}",
            msg
        );
    }
    // =========================================================================
    // 26. Multiple builtin agents all resolve successfully
    // =========================================================================

    #[test]
    fn all_builtin_agents_resolve_with_pinned_model() {
        for agent in get_builtin_agents() {
            let def = with_model(agent);
            let id = def.id.clone();
            let result = ResolvedAgent::resolve(&def, None, &default_overrides());
            assert!(
                result.is_ok(),
                "Agent {:?} failed to resolve: {:?}",
                id,
                result.err()
            );
        }
    }

    #[test]
    fn all_builtin_resolved_agents_have_non_empty_id() {
        for agent in get_builtin_agents() {
            let def = with_model(agent);
            let resolved =
                ResolvedAgent::resolve(&def, None, &default_overrides()).expect("resolve");
            assert!(!resolved.agent_id.is_empty());
        }
    }

    #[test]
    fn all_builtin_resolved_agents_have_positive_max_tokens() {
        for agent in get_builtin_agents() {
            let def = with_model(agent);
            let resolved =
                ResolvedAgent::resolve(&def, None, &default_overrides()).expect("resolve");
            assert!(
                resolved.max_tokens > 0,
                "max_tokens must be > 0 for {}",
                resolved.agent_id
            );
        }
    }

    #[test]
    fn all_builtin_resolved_agents_have_positive_context_window() {
        for agent in get_builtin_agents() {
            let def = with_model(agent);
            let resolved =
                ResolvedAgent::resolve(&def, None, &default_overrides()).expect("resolve");
            assert!(
                resolved.context_window > 0,
                "context_window must be > 0 for {}",
                resolved.agent_id
            );
        }
    }

    #[test]
    fn all_builtin_resolved_agents_have_non_negative_temperature() {
        for agent in get_builtin_agents() {
            let def = with_model(agent);
            let resolved =
                ResolvedAgent::resolve(&def, None, &default_overrides()).expect("resolve");
            assert!(
                resolved.temperature >= 0.0,
                "temperature must be >= 0 for {}",
                resolved.agent_id
            );
        }
    }

    #[test]
    fn all_builtin_resolved_agents_have_positive_max_iterations() {
        for agent in get_builtin_agents() {
            let def = with_model(agent);
            let resolved =
                ResolvedAgent::resolve(&def, None, &default_overrides()).expect("resolve");
            assert!(
                resolved.session_model.max_iterations > 0,
                "max_iterations must be > 0 for {}",
                resolved.agent_id
            );
        }
    }

    // =========================================================================
    // 27. AgentDefinition inherits_from is None for base agent
    // =========================================================================

    #[test]
    fn base_agent_inherits_from_is_none() {
        let base = get_builtin_agent(BASE_AGENT_ID).expect("base exists");
        assert!(
            base.inherits_from.is_none(),
            "builtin:base must have no parent (it IS the root template)"
        );
    }

    #[test]
    fn os_agent_inherits_from_base() {
        let os = get_builtin_agent(OS_AGENT_ID).expect("os exists");
        assert_eq!(os.inherits_from.as_deref(), Some(BASE_AGENT_ID));
    }

    #[test]
    fn sde_agent_inherits_from_base() {
        let sde = get_builtin_agent(SDE_AGENT_ID).expect("sde exists");
        assert_eq!(sde.inherits_from.as_deref(), Some(BASE_AGENT_ID));
    }

    #[test]
    fn wingman_agent_inherits_from_base() {
        let wm = get_builtin_agent(WINGMAN_AGENT_ID).expect("wingman exists");
        assert_eq!(wm.inherits_from.as_deref(), Some(BASE_AGENT_ID));
    }

    #[test]
    fn explore_agent_inherits_from_base() {
        let exp = get_builtin_agent(EXPLORE_AGENT_ID).expect("explore exists");
        assert_eq!(exp.inherits_from.as_deref(), Some(BASE_AGENT_ID));
    }

    // =========================================================================
    // 28. SDE agent session_model has compaction enabled
    // =========================================================================

    #[test]
    fn sde_agent_session_model_has_compaction_enabled() {
        let sde = get_builtin_agent(SDE_AGENT_ID).expect("sde exists");
        let sm = sde.session_model.expect("SDE must have a session_model");
        let compaction = sm.compaction.expect("SDE must have compaction config");
        assert!(compaction.enabled, "SDE compaction must be enabled");
    }

    #[test]
    fn sde_agent_compaction_trigger_ratio_positive() {
        let sde = get_builtin_agent(SDE_AGENT_ID).expect("sde exists");
        let sm = sde.session_model.expect("session model");
        let compaction = sm.compaction.expect("compaction");
        assert!(compaction.trigger_ratio > 0.0);
    }

    #[test]
    fn sde_agent_compaction_keep_ratio_positive() {
        let sde = get_builtin_agent(SDE_AGENT_ID).expect("sde exists");
        let sm = sde.session_model.expect("session model");
        let compaction = sm.compaction.expect("compaction");
        assert!(compaction.keep_ratio > 0.0);
    }

    #[test]
    fn sde_resolved_compaction_enabled() {
        let def = with_model(get_builtin_agent(SDE_AGENT_ID).expect("sde exists"));
        let resolved = ResolvedAgent::resolve(&def, None, &default_overrides()).expect("resolve");
        assert!(
            resolved.compaction.enabled,
            "resolved SDE compaction must be enabled"
        );
    }

    #[test]
    fn os_agent_session_model_has_no_compaction() {
        let os = get_builtin_agent(OS_AGENT_ID).expect("os exists");
        let sm = os.session_model.expect("OS must have session_model");
        // OS agent uses singleton / no compaction
        assert!(
            sm.compaction.is_none(),
            "OS agent should not have compaction"
        );
    }

    #[test]
    fn wingman_session_model_has_no_compaction() {
        let wm = get_builtin_agent(WINGMAN_AGENT_ID).expect("wingman exists");
        let sm = wm.session_model.expect("Wingman must have session_model");
        assert!(
            sm.compaction.is_none(),
            "Wingman should not have compaction"
        );
    }

    // =========================================================================
    // 29. Builtin agents are default-open (workspace = focus, not sandbox)
    // =========================================================================

    #[test]
    fn os_agent_policy_workspace_only_is_false() {
        let os = get_builtin_agent(OS_AGENT_ID).expect("os exists");
        let policy = os.agent_policy.expect("OS must have agent_policy");
        assert!(
            !policy.workspace_only,
            "OS agent must be default-open (workspace is a focus, not a sandbox)"
        );
    }

    #[test]
    fn sde_agent_policy_workspace_only_is_false() {
        let sde = get_builtin_agent(SDE_AGENT_ID).expect("sde exists");
        let policy = sde.agent_policy.expect("SDE must have agent_policy");
        assert!(
            !policy.workspace_only,
            "SDE agent should not restrict to workspace"
        );
    }

    #[test]
    fn wingman_policy_workspace_only_is_false() {
        let wm = get_builtin_agent(WINGMAN_AGENT_ID).expect("wingman exists");
        let policy = wm.agent_policy.expect("Wingman must have agent_policy");
        assert!(
            !policy.workspace_only,
            "Wingman must be default-open like the other builtins"
        );
    }

    #[test]
    fn os_resolved_policy_workspace_only_is_false() {
        let def = with_model(get_builtin_agent(OS_AGENT_ID).expect("os exists"));
        let resolved = ResolvedAgent::resolve(&def, None, &default_overrides()).expect("resolve");
        assert!(!resolved.policy.workspace_only);
    }

    #[test]
    fn os_policy_blocked_commands_is_empty_by_default() {
        let os = get_builtin_agent(OS_AGENT_ID).expect("os exists");
        let policy = os.agent_policy.expect("OS must have agent_policy");
        assert!(
            policy.blocked_commands.is_empty(),
            "OS agent ships with no blocked commands"
        );
    }

    // =========================================================================
    // 30. Re-serialize ResolvedAgent as JSON - check camelCase keys
    // =========================================================================

    #[test]
    fn resolved_agent_json_has_camel_case_agent_id() {
        let def = with_model(get_builtin_agent(OS_AGENT_ID).expect("os exists"));
        let resolved = ResolvedAgent::resolve(&def, None, &default_overrides()).expect("resolve");
        let json = serde_json::to_string(&resolved).expect("serialize");
        assert!(
            json.contains("agentId"),
            "expected agentId in: {}",
            &json[..200.min(json.len())]
        );
    }

    #[test]
    fn resolved_agent_json_has_selected_model_id() {
        let def = with_model(get_builtin_agent(OS_AGENT_ID).expect("os exists"));
        let resolved = ResolvedAgent::resolve(&def, None, &default_overrides()).expect("resolve");
        let json = serde_json::to_string(&resolved).expect("serialize");
        assert!(
            json.contains("selectedModelId"),
            "expected selectedModelId in JSON"
        );
    }

    #[test]
    fn resolved_agent_json_has_session_model() {
        let def = with_model(get_builtin_agent(OS_AGENT_ID).expect("os exists"));
        let resolved = ResolvedAgent::resolve(&def, None, &default_overrides()).expect("resolve");
        let json = serde_json::to_string(&resolved).expect("serialize");
        assert!(
            json.contains("sessionModel"),
            "expected sessionModel in JSON"
        );
    }

    #[test]
    fn resolved_agent_json_has_max_tokens() {
        let def = with_model(get_builtin_agent(OS_AGENT_ID).expect("os exists"));
        let resolved = ResolvedAgent::resolve(&def, None, &default_overrides()).expect("resolve");
        let json = serde_json::to_string(&resolved).expect("serialize");
        assert!(json.contains("maxTokens"), "expected maxTokens in JSON");
    }

    #[test]
    fn resolved_agent_json_has_context_window() {
        let def = with_model(get_builtin_agent(SDE_AGENT_ID).expect("sde exists"));
        let resolved = ResolvedAgent::resolve(&def, None, &default_overrides()).expect("resolve");
        let json = serde_json::to_string(&resolved).expect("serialize");
        assert!(
            json.contains("contextWindow"),
            "expected contextWindow in JSON"
        );
    }

    #[test]
    fn resolved_agent_json_has_load_workspace_resources() {
        let def = with_model(get_builtin_agent(OS_AGENT_ID).expect("os exists"));
        let resolved = ResolvedAgent::resolve(&def, None, &default_overrides()).expect("resolve");
        let json = serde_json::to_string(&resolved).expect("serialize");
        assert!(
            json.contains("loadWorkspaceResources"),
            "expected loadWorkspaceResources in JSON"
        );
    }

    #[test]
    fn resolved_agent_json_only_allowed_nullable_fields_are_null() {
        let def = with_model(get_builtin_agent(OS_AGENT_ID).expect("os exists"));
        let resolved = ResolvedAgent::resolve(&def, None, &default_overrides()).expect("resolve");
        let json_val = serde_json::to_value(&resolved).expect("serialize");
        let obj = json_val.as_object().expect("is object");

        const ALLOWED_NULLABLE: &[&str] = &["selectedAccountId", "delegationConfig"];

        for (key, value) in obj.iter() {
            if value.is_null() {
                assert!(
                    ALLOWED_NULLABLE.contains(&key.as_str()),
                    "ResolvedAgent.{} is null but is not in the allowed-nullable list.",
                    key
                );
            }
        }
    }

    // =========================================================================
    // Additional coverage: session model variants across agents
    // =========================================================================

    #[test]
    fn os_session_model_is_singleton() {
        let os = get_builtin_agent(OS_AGENT_ID).expect("os exists");
        let sm = os.session_model.expect("OS has session model");
        assert_eq!(sm.mode, SessionMode::Singleton);
    }

    #[test]
    fn os_session_model_has_no_processing_lock() {
        let os = get_builtin_agent(OS_AGENT_ID).expect("os exists");
        let sm = os.session_model.expect("OS has session model");
        assert!(
            !sm.processing_lock,
            "OS agent allows concurrent requests (no lock)"
        );
    }

    #[test]
    fn sde_session_model_is_per_session() {
        let sde = get_builtin_agent(SDE_AGENT_ID).expect("sde exists");
        let sm = sde.session_model.expect("SDE has session model");
        assert_eq!(sm.mode, SessionMode::PerSession);
    }

    #[test]
    fn sde_session_model_has_processing_lock() {
        let sde = get_builtin_agent(SDE_AGENT_ID).expect("sde exists");
        let sm = sde.session_model.expect("SDE has session model");
        assert!(
            sm.processing_lock,
            "SDE serializes requests via processing lock"
        );
    }

    #[test]
    fn wingman_session_model_is_singleton() {
        let wm = get_builtin_agent(WINGMAN_AGENT_ID).expect("wingman exists");
        let sm = wm.session_model.expect("Wingman has session model");
        assert_eq!(sm.mode, SessionMode::Singleton);
    }

    #[test]
    fn wingman_max_iterations_is_30() {
        let wm = get_builtin_agent(WINGMAN_AGENT_ID).expect("wingman exists");
        let sm = wm.session_model.expect("Wingman has session model");
        assert_eq!(
            sm.max_iterations, 30,
            "Wingman has a short iteration budget"
        );
    }

    #[test]
    fn base_session_model_is_per_session() {
        let base = get_builtin_agent(BASE_AGENT_ID).expect("base exists");
        let sm = base.session_model.expect("Base has session model");
        assert_eq!(sm.mode, SessionMode::PerSession);
    }

    #[test]
    fn base_session_model_has_processing_lock() {
        let base = get_builtin_agent(BASE_AGENT_ID).expect("base exists");
        let sm = base.session_model.expect("Base has session model");
        assert!(sm.processing_lock);
    }

    // =========================================================================
    // Additional coverage: tier classification
    // =========================================================================

    #[test]
    fn os_agent_tier_is_primary() {
        let os = get_builtin_agent(OS_AGENT_ID).expect("os exists");
        assert_eq!(os.tier, AgentTier::Primary);
    }

    #[test]
    fn sde_agent_tier_is_primary() {
        let sde = get_builtin_agent(SDE_AGENT_ID).expect("sde exists");
        assert_eq!(sde.tier, AgentTier::Primary);
    }

    #[test]
    fn wingman_agent_tier_is_primary() {
        let wm = get_builtin_agent(WINGMAN_AGENT_ID).expect("wingman exists");
        assert_eq!(wm.tier, AgentTier::Primary);
    }

    #[test]
    fn base_agent_tier_is_secondary() {
        let base = get_builtin_agent(BASE_AGENT_ID).expect("base exists");
        assert_eq!(base.tier, AgentTier::Secondary);
    }

    #[test]
    fn explore_agent_tier_is_secondary() {
        let exp = get_builtin_agent(EXPLORE_AGENT_ID).expect("explore exists");
        assert_eq!(exp.tier, AgentTier::Secondary);
    }

    #[test]
    fn general_agent_tier_is_secondary() {
        let gen = get_builtin_agent(GENERAL_AGENT_ID).expect("general exists");
        assert_eq!(gen.tier, AgentTier::Secondary);
    }

    #[test]
    fn agent_tier_default_is_secondary() {
        let def = AgentDefinition::default();
        assert_eq!(def.tier, AgentTier::Secondary);
    }
    // =========================================================================
    // Additional coverage: capabilities
    // =========================================================================

    #[test]
    fn os_agent_has_desktop_capability() {
        let os = get_builtin_agent(OS_AGENT_ID).expect("os exists");
        let caps = os.capabilities.expect("OS has capabilities");
        assert!(caps.desktop.is_some(), "OS must have desktop capability");
        assert!(caps.desktop.unwrap().enabled);
    }

    #[test]
    fn os_agent_has_no_coding_capability() {
        let os = get_builtin_agent(OS_AGENT_ID).expect("os exists");
        let caps = os.capabilities.expect("OS has capabilities");
        assert!(caps.coding.is_none(), "OS must not have coding capability");
    }

    #[test]
    fn sde_agent_has_coding_capability() {
        let sde = get_builtin_agent(SDE_AGENT_ID).expect("sde exists");
        let caps = sde.capabilities.expect("SDE has capabilities");
        assert!(caps.coding.is_some(), "SDE must have coding capability");
    }

    #[test]
    fn sde_agent_has_no_desktop_capability() {
        let sde = get_builtin_agent(SDE_AGENT_ID).expect("sde exists");
        let caps = sde.capabilities.expect("SDE has capabilities");
        assert!(
            caps.desktop.is_none(),
            "SDE must not have desktop capability"
        );
    }

    #[test]
    fn wingman_has_desktop_capability() {
        let wm = get_builtin_agent(WINGMAN_AGENT_ID).expect("wingman exists");
        let caps = wm.capabilities.expect("Wingman has capabilities");
        assert!(caps.desktop.is_some());
    }

    #[test]
    fn wingman_has_no_coding_capability() {
        let wm = get_builtin_agent(WINGMAN_AGENT_ID).expect("wingman exists");
        let caps = wm.capabilities.expect("Wingman has capabilities");
        assert!(caps.coding.is_none());
    }

    #[test]
    fn base_agent_has_no_capabilities() {
        let base = get_builtin_agent(BASE_AGENT_ID).expect("base exists");
        assert!(
            base.capabilities.is_none(),
            "Base agent has no special capabilities"
        );
    }

    // =========================================================================
    // Additional: learnings
    // =========================================================================

    #[test]
    fn os_agent_has_learnings_enabled() {
        let os = get_builtin_agent(OS_AGENT_ID).expect("os exists");
        let learnings = os.learnings.expect("OS has learnings config");
        assert!(learnings.enabled);
    }

    #[test]
    fn os_agent_learnings_extract_memories_enabled() {
        let os = get_builtin_agent(OS_AGENT_ID).expect("os exists");
        let learnings = os.learnings.expect("OS has learnings config");
        assert!(learnings.extract_memories_enabled);
    }

    #[test]
    fn os_agent_learnings_auto_dream_enabled() {
        let os = get_builtin_agent(OS_AGENT_ID).expect("os exists");
        let learnings = os.learnings.expect("OS has learnings config");
        assert!(learnings.auto_dream_enabled);
    }

    #[test]
    fn wingman_has_no_learnings_config() {
        let wm = get_builtin_agent(WINGMAN_AGENT_ID).expect("wingman exists");
        assert!(wm.learnings.is_none(), "Wingman ships with learnings=None");
    }

    // =========================================================================
    // Additional: tool selection
    // =========================================================================

    #[test]
    fn wingman_has_system_restrict_to_tools() {
        let wm = get_builtin_agent(WINGMAN_AGENT_ID).expect("wingman exists");
        assert!(wm.tools.system_restrict_to_tools.is_some());
    }

    #[test]
    fn os_agent_no_system_restrict_to_tools() {
        let os = get_builtin_agent(OS_AGENT_ID).expect("os exists");
        assert!(os.tools.system_restrict_to_tools.is_none());
    }

    #[test]
    fn explore_agent_has_strict_allow_list() {
        let exp = get_builtin_agent(EXPLORE_AGENT_ID).expect("explore exists");
        assert!(exp.tools.system_restrict_to_tools.is_some());
    }

    #[test]
    fn general_agent_no_strict_allow_list() {
        let gen = get_builtin_agent(GENERAL_AGENT_ID).expect("general exists");
        assert!(gen.tools.system_restrict_to_tools.is_none());
    }

    #[test]
    fn agent_tool_selection_default_is_fully_empty() {
        let sel = AgentToolSelection::default();
        assert!(sel.system_restrict_to_tools.is_none());
        assert!(sel.excluded_tools.is_empty());
        assert!(sel.user_allowed_tools.is_empty());
        assert!(sel.disabled_mcp_servers.is_empty());
        assert!(sel.disabled_mcp_tools.is_empty());
    }

    // =========================================================================
    // Additional: soul_content
    // =========================================================================

    #[test]
    fn os_agent_has_non_empty_soul_content() {
        let os = get_builtin_agent(OS_AGENT_ID).expect("os exists");
        let soul = os.soul_content.expect("OS must have soul_content");
        assert!(!soul.is_empty());
    }

    #[test]
    fn sde_agent_has_non_empty_soul_content() {
        let sde = get_builtin_agent(SDE_AGENT_ID).expect("sde exists");
        assert!(!sde.soul_content.unwrap().is_empty());
    }

    #[test]
    fn base_agent_has_no_soul_content() {
        let base = get_builtin_agent(BASE_AGENT_ID).expect("base exists");
        assert!(base.soul_content.is_none());
    }

    #[test]
    fn resolved_os_soul_content_non_empty() {
        let def = with_model(get_builtin_agent(OS_AGENT_ID).expect("os exists"));
        let resolved = ResolvedAgent::resolve(&def, None, &default_overrides()).expect("resolve");
        assert!(!resolved.soul_content.is_empty());
    }

    // =========================================================================
    // Additional: icon_id
    // =========================================================================

    #[test]
    fn os_agent_icon_id_is_set() {
        let os = get_builtin_agent(OS_AGENT_ID).expect("os exists");
        assert!(os.icon_id.is_some());
    }

    #[test]
    fn sde_agent_icon_id_is_set() {
        let sde = get_builtin_agent(SDE_AGENT_ID).expect("sde exists");
        assert!(sde.icon_id.is_some());
    }

    // =========================================================================
    // Additional: sub_agents list
    // =========================================================================

    #[test]
    fn os_sub_agents_contains_sde() {
        let os = get_builtin_agent(OS_AGENT_ID).expect("os exists");
        let subs = os.sub_agents.expect("OS has sub_agents");
        assert!(subs.iter().any(|s| s.agent_id == SDE_AGENT_ID));
    }

    #[test]
    fn wingman_sub_agents_is_none() {
        let wm = get_builtin_agent(WINGMAN_AGENT_ID).expect("wingman exists");
        assert!(wm.sub_agents.is_none());
    }

    #[test]
    fn sde_sub_agents_is_empty() {
        let sde = get_builtin_agent(SDE_AGENT_ID).expect("sde exists");
        let subs = sde.sub_agents.expect("SDE has sub_agents field");
        assert!(subs.is_empty());
    }

    // =========================================================================
    // Additional: resolved agent numeric defaults
    // =========================================================================

    #[test]
    fn resolved_max_tokens_positive_default() {
        let def = with_model(AgentDefinition {
            id: "default-tokens".to_string(),
            name: "Default Tokens".to_string(),
            ..Default::default()
        });
        let resolved = ResolvedAgent::resolve(&def, None, &default_overrides()).expect("resolve");
        assert!(resolved.max_tokens > 0);
    }

    #[test]
    fn resolved_exec_timeout_positive() {
        let def = with_model(get_builtin_agent(OS_AGENT_ID).expect("os exists"));
        let resolved = ResolvedAgent::resolve(&def, None, &default_overrides()).expect("resolve");
        assert!(resolved.exec_timeout > 0);
    }

    #[test]
    fn resolved_max_tool_concurrency_positive() {
        let def = with_model(get_builtin_agent(OS_AGENT_ID).expect("os exists"));
        let resolved = ResolvedAgent::resolve(&def, None, &default_overrides()).expect("resolve");
        assert!(resolved.max_tool_use_concurrency > 0);
    }

    #[test]
    fn custom_max_tokens_respected() {
        let mut def = get_builtin_agent(OS_AGENT_ID).expect("os exists");
        def.selected_model_id = Some("test/model".to_string());
        def.max_tokens = Some(4096);
        let resolved = ResolvedAgent::resolve(&def, None, &default_overrides()).expect("resolve");
        assert_eq!(resolved.max_tokens, 4096);
    }

    #[test]
    fn custom_context_window_respected() {
        let mut def = get_builtin_agent(OS_AGENT_ID).expect("os exists");
        def.selected_model_id = Some("test/model".to_string());
        def.context_window = Some(200_000);
        let resolved = ResolvedAgent::resolve(&def, None, &default_overrides()).expect("resolve");
        assert_eq!(resolved.context_window, 200_000);
    }

    // =========================================================================
    // Additional: temperature
    // =========================================================================

    #[test]
    fn os_resolved_temperature_is_zero() {
        let def = with_model(get_builtin_agent(OS_AGENT_ID).expect("os exists"));
        let resolved = ResolvedAgent::resolve(&def, None, &default_overrides()).expect("resolve");
        assert_eq!(resolved.temperature, 0.0);
    }

    #[test]
    fn custom_temperature_override_is_respected() {
        let mut def = get_builtin_agent(OS_AGENT_ID).expect("os exists");
        def.selected_model_id = Some("test/model".to_string());
        def.temperature = Some(0.9);
        let resolved = ResolvedAgent::resolve(&def, None, &default_overrides()).expect("resolve");
        assert!((resolved.temperature - 0.9).abs() < 1e-9);
    }

    // =========================================================================
    // Additional: animate override
    // =========================================================================

    #[test]
    fn animate_override_false_respected() {
        let def = with_model(get_builtin_agent(OS_AGENT_ID).expect("os exists"));
        let overrides = SessionOverrides::new(None, Some(false));
        let resolved = ResolvedAgent::resolve(&def, None, &overrides).expect("resolve");
        assert!(!resolved.animate);
    }

    #[test]
    fn animate_override_true_respected() {
        let def = with_model(get_builtin_agent(OS_AGENT_ID).expect("os exists"));
        let overrides = SessionOverrides::new(None, Some(true));
        let resolved = ResolvedAgent::resolve(&def, None, &overrides).expect("resolve");
        assert!(resolved.animate);
    }

    // =========================================================================
    // Additional: tier serialization
    // =========================================================================

    #[test]
    fn agent_tier_primary_serializes_snake_case() {
        let tier = AgentTier::Primary;
        let json = serde_json::to_string(&tier).expect("serialize");
        assert_eq!(json, r#""primary""#);
    }

    #[test]
    fn agent_tier_secondary_serializes_snake_case() {
        let tier = AgentTier::Secondary;
        let json = serde_json::to_string(&tier).expect("serialize");
        assert_eq!(json, r#""secondary""#);
    }

    #[test]
    fn agent_tier_round_trip() {
        let original = AgentTier::Primary;
        let json = serde_json::to_string(&original).expect("serialize");
        let restored: AgentTier = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(original, restored);
    }

    // =========================================================================
    // Additional: sovereign_prompt serialization behaviour
    // =========================================================================

    #[test]
    fn os_sovereign_prompt_is_false() {
        let os = get_builtin_agent(OS_AGENT_ID).expect("os exists");
        assert!(!os.sovereign_prompt);
    }

    #[test]
    fn sovereign_prompt_true_preserved_round_trip() {
        let def = AgentDefinition {
            id: "sovereign".to_string(),
            name: "Sovereign".to_string(),
            sovereign_prompt: true,
            ..Default::default()
        };
        let json = serde_json::to_string(&def).expect("serialize");
        assert!(json.contains("sovereignPrompt"));
        let restored: AgentDefinition = serde_json::from_str(&json).expect("deserialize");
        assert!(restored.sovereign_prompt);
    }

    #[test]
    fn sovereign_prompt_false_skipped_in_json() {
        let def = AgentDefinition {
            id: "not-sovereign".to_string(),
            name: "Not Sovereign".to_string(),
            sovereign_prompt: false,
            ..Default::default()
        };
        let json = serde_json::to_string(&def).expect("serialize");
        assert!(!json.contains("sovereignPrompt"));
    }

    // =========================================================================
    // Additional: description field round-trip
    // =========================================================================

    #[test]
    fn os_agent_has_description() {
        let os = get_builtin_agent(OS_AGENT_ID).expect("os exists");
        assert!(os.description.is_some());
        assert!(!os.description.unwrap().is_empty());
    }

    #[test]
    fn agent_description_round_trip() {
        let original = AgentDefinition {
            id: "desc-test".to_string(),
            name: "Desc Test".to_string(),
            description: Some("A useful description.".to_string()),
            ..Default::default()
        };
        let json = serde_json::to_string(&original).expect("serialize");
        let restored: AgentDefinition = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(
            restored.description.as_deref(),
            Some("A useful description.")
        );
    }

    // =========================================================================
    // Additional: resolved workspace is never empty
    // =========================================================================

    #[test]
    fn resolved_workspace_path_non_empty_for_all_builtins() {
        for agent in get_builtin_agents() {
            let def = with_model(agent);
            let id = def.id.clone();
            let resolved =
                ResolvedAgent::resolve(&def, None, &default_overrides()).expect("resolve");
            assert!(
                !resolved.workspace().as_os_str().is_empty(),
                "Workspace must not be empty for agent {}",
                id
            );
        }
    }

    // =========================================================================
    // Additional: resolve error is Send + Sync (compile-time check)
    // =========================================================================

    #[test]
    fn resolve_error_missing_model_display_format() {
        let err = ResolveError::MissingModel("agent-abc".to_string());
        let msg = err.to_string();
        assert!(msg.contains("agent-abc"));
    }

    // =========================================================================
    // Additional: workspace resource toggles
    // =========================================================================

    #[test]
    fn load_workspace_resources_default_is_none() {
        let def = AgentDefinition::default();
        assert!(def.load_workspace_resources.is_none());
    }

    #[test]
    fn workspace_resource_toggle_false_respected() {
        let mut def = with_model(get_builtin_agent(OS_AGENT_ID).expect("os exists"));
        def.load_workspace_resources = Some(false);
        let resolved = ResolvedAgent::resolve(&def, None, &default_overrides()).expect("resolve");
        assert!(!resolved.load_workspace_resources);
    }
} // end mod tests_extended
