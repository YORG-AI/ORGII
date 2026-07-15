//! Unit tests for the external-import detector and apply pipeline.

use std::fs;
use std::path::Path;

use tempfile::TempDir;

use super::commands::apply_selections;
use super::detect::detect_all;
use super::external_import_detect;
use super::types::{
    readonly_excluded_tool_names, FidelityWarning, ImportSelection, ImportStatus, ItemKind,
    SourceAgent, SourceScope,
};
use crate::core::definitions::store::AgentDefinitionsStore;

fn write_file(path: &Path, contents: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, contents).unwrap();
}

#[test]
fn detects_cursor_rules_in_project() {
    let _env_lock = test_helpers::test_env::lock_home();
    let tmp = TempDir::new().unwrap();
    let repo = tmp.path();

    write_file(
        &repo.join(".cursor/rules/foo.mdc"),
        "---\ndescription: Foo\nalwaysApply: true\n---\nFoo body line\n",
    );
    write_file(&repo.join(".cursor/rules/bar.mdc"), "Plain body, no fm\n");

    let fake_home = tmp.path().join("fake-home");
    fs::create_dir_all(&fake_home).unwrap();
    let _home = UserHomeGuard::set(&fake_home);

    let items = detect_all(Some(repo));
    let cursor_items: Vec<_> = items
        .iter()
        .filter(|i| matches!(i.source_agent, SourceAgent::CursorIde))
        .collect();
    assert_eq!(cursor_items.len(), 2);

    let foo = cursor_items
        .iter()
        .find(|i| i.suggested_name == "foo")
        .expect("foo detected");
    assert_eq!(foo.kind, ItemKind::Policy);
    assert!(foo.fidelity_warnings.is_empty());
    assert_eq!(foo.preview.summary, "Foo body line");
    assert!(foo
        .preview
        .frontmatter
        .iter()
        .any(|(k, _)| k == "description"));

    let bar = cursor_items
        .iter()
        .find(|i| i.suggested_name == "bar")
        .expect("bar detected");
    assert!(bar.preview.frontmatter.is_empty());
}

#[test]
fn detects_claude_code_workspace_memory() {
    let tmp = TempDir::new().unwrap();
    let repo = tmp.path();
    write_file(&repo.join("CLAUDE.md"), "# Project\nbody\n");

    let items = detect_all(Some(repo));
    assert!(items
        .iter()
        .any(|i| matches!(i.source_agent, SourceAgent::ClaudeCode)
            && matches!(i.source_scope, SourceScope::WorkspaceLocal { .. })));
}

#[test]
fn detects_copilot_single_and_scoped_instructions() {
    let tmp = TempDir::new().unwrap();
    let repo = tmp.path();
    write_file(
        &repo.join(".github/copilot-instructions.md"),
        "Always be helpful.\n",
    );
    write_file(
        &repo.join(".github/instructions/rust.instructions.md"),
        "---\napplyTo: '**/*.rs'\n---\nrust body\n",
    );

    let items = detect_all(Some(repo));
    let copilot: Vec<_> = items
        .iter()
        .filter(|i| matches!(i.source_agent, SourceAgent::Copilot))
        .collect();
    assert_eq!(copilot.len(), 2);
    assert!(copilot
        .iter()
        .any(|i| i.suggested_name == "copilot-instructions"));
    assert!(copilot.iter().any(|i| i.suggested_name == "copilot-rust"));
}

#[test]
fn detects_kiro_steering_files() {
    let tmp = TempDir::new().unwrap();
    let repo = tmp.path();
    write_file(&repo.join(".kiro/steering/style.md"), "Style guide\n");

    let items = detect_all(Some(repo));
    let kiro: Vec<_> = items
        .iter()
        .filter(|i| matches!(i.source_agent, SourceAgent::Kiro))
        .collect();
    assert_eq!(kiro.len(), 1);
    assert_eq!(kiro[0].suggested_name, "kiro-style");
}

#[test]
fn skips_extension_bundles() {
    let _env_lock = test_helpers::test_env::lock_home();
    let tmp = TempDir::new().unwrap();
    let repo = tmp.path();
    write_file(
        &repo.join("extensions/some-pack/.cursor/rules/should-skip.mdc"),
        "---\ndescription: vendor\n---\nbody\n",
    );

    let fake_home = tmp.path().join("fake-home");
    fs::create_dir_all(&fake_home).unwrap();
    let _home = UserHomeGuard::set(&fake_home);

    let items = detect_all(Some(repo));
    let cursor: Vec<_> = items
        .iter()
        .filter(|i| matches!(i.source_agent, SourceAgent::CursorIde))
        .collect();
    assert!(
        cursor.is_empty(),
        "vendor extension rules must not be surfaced: {:?}",
        cursor
    );
}

#[tokio::test]
async fn detect_then_apply_policy_round_trip() {
    let tmp = TempDir::new().unwrap();
    let repo = tmp.path();

    write_file(
        &repo.join(".cursor/rules/foo.mdc"),
        "---\ndescription: Foo rule\n---\nactual body\n",
    );

    let detected = external_import_detect(Some(repo.to_string_lossy().into_owned()))
        .await
        .unwrap();
    let foo = detected
        .iter()
        .find(|i| matches!(i.source_agent, SourceAgent::CursorIde) && i.suggested_name == "foo")
        .expect("foo detected");

    let selection = ImportSelection {
        source_agent: foo.source_agent,
        source_scope: foo.source_scope.clone(),
        kind: foo.kind,
        source_path: foo.source_path.clone(),
        target_repo_path: Some(repo.to_path_buf()),
        target_name: "imported-foo".to_string(),
        overwrite: false,
    };
    let store = AgentDefinitionsStore::new();
    let report = apply_selections(vec![selection], &store);
    assert_eq!(report.items.len(), 1);
    assert_eq!(report.items[0].status, ImportStatus::Imported);

    let target = repo.join(".orgii/rules/imported-foo.md");
    assert!(target.is_file(), "target file not written: {:?}", target);
    let written = fs::read_to_string(&target).unwrap();
    assert!(written.contains("imported from"));
    assert!(written.contains("actual body"));

    let config_path = repo.join(".orgii/rules-config.json");
    let config: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(config_path).unwrap()).unwrap();
    assert_eq!(
        config["policies"]["imported-foo"]["scopeRepoPaths"],
        serde_json::json!([repo.to_string_lossy().to_string()])
    );
}

#[tokio::test]
async fn user_global_policy_import_lands_in_personal_rules() {
    let _env_lock = test_helpers::test_env::lock_home();
    let tmp = TempDir::new().unwrap();
    let orgii_home = tmp.path().join("orgii-home");
    fs::create_dir_all(&orgii_home).unwrap();
    let _orgii_home = OrgiiHomeGuard::set(&orgii_home);

    let source_path = tmp.path().join("source-rule.md");
    write_file(&source_path, "user rule body\n");

    let selection = ImportSelection {
        source_agent: SourceAgent::CursorIde,
        source_scope: SourceScope::UserGlobal,
        kind: ItemKind::Policy,
        source_path,
        target_repo_path: None,
        target_name: "imported-user-rule".to_string(),
        overwrite: false,
    };
    let store = AgentDefinitionsStore::new();
    let report = apply_selections(vec![selection], &store);
    assert_eq!(report.items.len(), 1);
    assert_eq!(report.items[0].status, ImportStatus::Imported);

    let personal_target = orgii_home
        .join("personal")
        .join("rules")
        .join("imported-user-rule.md");
    let global_target = orgii_home.join("rules").join("imported-user-rule.md");
    assert!(personal_target.is_file(), "personal target not written");
    assert!(
        !global_target.exists(),
        "user import must not become shared global"
    );
}

#[tokio::test]
async fn apply_rejects_unsafe_target_names() {
    let tmp = TempDir::new().unwrap();
    let repo = tmp.path();
    write_file(&repo.join(".cursor/rules/foo.mdc"), "body\n");

    let detected = external_import_detect(Some(repo.to_string_lossy().into_owned()))
        .await
        .unwrap();
    let foo = detected
        .iter()
        .find(|i| matches!(i.source_agent, SourceAgent::CursorIde) && i.suggested_name == "foo")
        .expect("foo detected");

    let bad = ImportSelection {
        source_agent: foo.source_agent,
        source_scope: foo.source_scope.clone(),
        kind: foo.kind,
        source_path: foo.source_path.clone(),
        target_repo_path: Some(repo.to_path_buf()),
        target_name: "../escape".to_string(),
        overwrite: false,
    };
    let store = AgentDefinitionsStore::new();
    let report = apply_selections(vec![bad], &store);
    assert_eq!(report.items[0].status, ImportStatus::Failed);
    assert!(report.items[0]
        .error
        .as_deref()
        .unwrap_or_default()
        .contains("Invalid target name"));
}

// ============================================================
// Phase 2 — Claude Code skills + agent definitions
// ============================================================

#[test]
fn detects_claude_code_subagents_in_project() {
    let _env_lock = test_helpers::test_env::lock_home();
    let tmp = TempDir::new().unwrap();
    let repo = tmp.path().join("repo");
    fs::create_dir_all(&repo).unwrap();
    write_file(
        &repo.join(".claude/agents/reviewer.md"),
        "---\nname: code-reviewer\ndescription: Reviews PRs\n---\nYou review code carefully.\n",
    );

    // Pin $HOME to a clean tmpdir so user-global vendor scans don't
    // pull in the developer's real `~/.cursor/agents`, `~/.claude/agents`,
    // etc. and break the `len == 1` assertion when other tests in the
    // same `cargo test` run hold the HOME guard concurrently.
    let fake_home = tmp.path().join("fake-home");
    fs::create_dir_all(&fake_home).unwrap();
    let _home = UserHomeGuard::set(&fake_home);

    let items = detect_all(Some(&repo));
    let agents: Vec<_> = items
        .iter()
        .filter(|i| i.kind == ItemKind::AgentDefinition)
        .collect();
    assert_eq!(agents.len(), 1);
    let agent = agents[0];
    assert_eq!(agent.suggested_name, "code-reviewer");
    assert_eq!(agent.preview.summary, "You review code carefully.");
    assert!(agent
        .preview
        .frontmatter
        .iter()
        .any(|(k, v)| k == "name" && v == "code-reviewer"));
    assert!(matches!(agent.source_agent, SourceAgent::ClaudeCode));
}

#[test]
fn detects_cursor_subagents_in_project_and_user_home() {
    let _env_lock = test_helpers::test_env::lock_home();
    // Cursor's own subagents docs (https://cursor.com/docs/subagents.md)
    // describe `<repo>/.cursor/agents/<name>.md` for workspace-scoped
    // subagents and `~/.cursor/agents/<name>.md` for user-global ones,
    // sharing Claude Code's frontmatter format.
    let tmp = TempDir::new().unwrap();
    let repo = tmp.path().join("repo");
    fs::create_dir_all(&repo).unwrap();

    write_file(
        &repo.join(".cursor/agents/scoped.md"),
        "---\nname: scoped-helper\ndescription: Scoped to this repo\n---\nProject-only subagent body.\n",
    );

    let fake_home = tmp.path().join("fake-home");
    fs::create_dir_all(&fake_home).unwrap();
    write_file(
        &fake_home.join(".cursor/agents/global.md"),
        "---\nname: global-helper\n---\nGlobal subagent body.\n",
    );
    let _home = UserHomeGuard::set(&fake_home);

    let repo_items = detect_all(Some(&repo));
    let cursor_repo_agents: Vec<_> = repo_items
        .iter()
        .filter(|item| {
            item.kind == ItemKind::AgentDefinition
                && matches!(item.source_agent, SourceAgent::CursorIde)
        })
        .collect();
    assert_eq!(
        cursor_repo_agents.len(),
        1,
        "repo scan should only show repo-local agents"
    );

    let scoped = cursor_repo_agents
        .iter()
        .find(|item| item.suggested_name == "scoped-helper")
        .expect("scoped-helper detected");
    assert!(matches!(
        scoped.source_scope,
        SourceScope::WorkspaceLocal { .. }
    ));
    assert_eq!(scoped.preview.summary, "Project-only subagent body.");

    let global_items = detect_all(None);
    let cursor_global_agents: Vec<_> = global_items
        .iter()
        .filter(|item| {
            item.kind == ItemKind::AgentDefinition
                && matches!(item.source_agent, SourceAgent::CursorIde)
        })
        .collect();
    assert_eq!(
        cursor_global_agents.len(),
        1,
        "global scan should only show user-global agents"
    );
    let global = cursor_global_agents
        .iter()
        .find(|item| item.suggested_name == "global-helper")
        .expect("global-helper detected");
    assert!(matches!(global.source_scope, SourceScope::UserGlobal));
}

#[test]
fn detects_copilot_agent_and_chatmode_files() {
    let _env_lock = test_helpers::test_env::lock_home();
    // Copilot: `<repo>/.github/agents/<name>.agent.md` (new) and
    // `<repo>/.github/chatmodes/<name>.chatmode.md` (back-compat).
    // Composite suffix must be stripped to recover the stem.
    let tmp = TempDir::new().unwrap();
    let repo = tmp.path().join("repo");
    fs::create_dir_all(&repo).unwrap();

    write_file(
        &repo.join(".github/agents/code-review.agent.md"),
        "---\ndescription: Reviews diffs\n---\nReview body.\n",
    );
    write_file(
        &repo.join(".github/chatmodes/research.chatmode.md"),
        "---\ndescription: Research mode\n---\nResearch body.\n",
    );
    // A plain README.md in the agents dir must be ignored — only files
    // ending in `.agent.md` count.
    write_file(
        &repo.join(".github/agents/README.md"),
        "Just docs, not an agent.\n",
    );

    let fake_home = tmp.path().join("fake-home");
    fs::create_dir_all(&fake_home).unwrap();
    let _home = UserHomeGuard::set(&fake_home);

    let items = detect_all(Some(&repo));
    let copilot_agents: Vec<_> = items
        .iter()
        .filter(|i| {
            i.kind == ItemKind::AgentDefinition && matches!(i.source_agent, SourceAgent::Copilot)
        })
        .collect();
    assert_eq!(
        copilot_agents.len(),
        2,
        "expected one .agent.md + one .chatmode.md"
    );
    assert!(copilot_agents
        .iter()
        .any(|i| i.suggested_name == "code-review"));
    assert!(copilot_agents
        .iter()
        .any(|i| i.suggested_name == "research"));
}

#[test]
fn detects_codex_subagents_in_project_and_user_home() {
    let _env_lock = test_helpers::test_env::lock_home();
    // Cursor's subagents docs explicitly call out `.codex/agents/`
    // alongside `.claude/agents/` and `.cursor/agents/` as a recognized
    // subagent layout — same on-disk shape, different brand.
    let tmp = TempDir::new().unwrap();
    let repo = tmp.path().join("repo");
    fs::create_dir_all(&repo).unwrap();

    write_file(
        &repo.join(".codex/agents/auditor.md"),
        "---\nname: auditor\ndescription: Audits code\n---\nAudit body.\n",
    );

    let fake_home = tmp.path().join("fake-home");
    fs::create_dir_all(&fake_home).unwrap();
    write_file(
        &fake_home.join(".codex/agents/researcher.md"),
        "---\nname: researcher\n---\nResearch body.\n",
    );
    let _home = UserHomeGuard::set(&fake_home);

    let repo_items = detect_all(Some(&repo));
    let codex_repo_agents: Vec<_> = repo_items
        .iter()
        .filter(|item| {
            item.kind == ItemKind::AgentDefinition
                && matches!(item.source_agent, SourceAgent::Codex)
        })
        .collect();
    assert_eq!(codex_repo_agents.len(), 1);
    assert!(codex_repo_agents
        .iter()
        .any(|item| item.suggested_name == "auditor"));

    let global_items = detect_all(None);
    let codex_global_agents: Vec<_> = global_items
        .iter()
        .filter(|item| {
            item.kind == ItemKind::AgentDefinition
                && matches!(item.source_agent, SourceAgent::Codex)
        })
        .collect();
    assert_eq!(codex_global_agents.len(), 1);
    assert!(codex_global_agents
        .iter()
        .any(|item| item.suggested_name == "researcher"));
}

#[test]
fn detects_claude_code_skills_dir_and_commands_file() {
    let _env_lock = test_helpers::test_env::lock_home();
    let tmp = TempDir::new().unwrap();
    let repo = tmp.path();
    write_file(
        &repo.join(".claude/skills/my-skill/SKILL.md"),
        "---\nname: my-skill\n---\nSkill body line\n",
    );
    write_file(
        &repo.join(".claude/commands/lint.md"),
        "Run linter against changed files.\n",
    );

    let fake_home = tmp.path().join("fake-home");
    fs::create_dir_all(&fake_home).unwrap();
    let _home = UserHomeGuard::set(&fake_home);

    let items = detect_all(Some(repo));
    let skills: Vec<_> = items.iter().filter(|i| i.kind == ItemKind::Skill).collect();
    assert_eq!(skills.len(), 2);
    assert!(skills.iter().any(|i| i.suggested_name == "my-skill"));
    assert!(skills.iter().any(|i| i.suggested_name == "lint"));
}

#[test]
fn skips_workspace_local_claude_skill_import_without_copying_to_orgii() {
    let _env_lock = test_helpers::test_env::lock_home();
    let tmp = TempDir::new().unwrap();
    let orgii_home = tmp.path().join("home");
    fs::create_dir_all(&orgii_home).unwrap();
    let repo = tmp.path().join("repo");
    fs::create_dir_all(&repo).unwrap();

    write_file(
        &repo.join(".claude/skills/refactor/SKILL.md"),
        "---\nname: refactor\n---\nDo refactors carefully.\n",
    );
    write_file(
        &repo.join(".claude/skills/refactor/examples/before.txt"),
        "before",
    );

    let _guard = OrgiiHomeGuard::set(&orgii_home);
    let items = detect_all(Some(&repo));
    let skill = items
        .iter()
        .find(|i| i.kind == ItemKind::Skill && i.suggested_name == "refactor")
        .expect("refactor skill detected");

    let selection = ImportSelection {
        source_agent: skill.source_agent,
        source_scope: skill.source_scope.clone(),
        kind: skill.kind,
        source_path: skill.source_path.parent().unwrap().to_path_buf(),
        target_repo_path: Some(repo.clone()),
        target_name: "refactor".to_string(),
        overwrite: false,
    };

    let store = AgentDefinitionsStore::new();
    let report = apply_selections(vec![selection], &store);
    assert_eq!(report.items[0].status, ImportStatus::Skipped);

    let target_skill = repo.join(".orgii/skills/refactor/SKILL.md");
    let target_example = repo.join(".orgii/skills/refactor/examples/before.txt");
    assert!(!target_skill.exists(), "workspace skill must not be copied");
    assert!(
        !target_example.exists(),
        "bundled example must not be copied"
    );
}

#[test]
fn applies_claude_code_agent_definition_via_store() {
    let _env_lock = test_helpers::test_env::lock_home();
    let tmp = TempDir::new().unwrap();
    let orgii_home = tmp.path().join("home");
    fs::create_dir_all(&orgii_home).unwrap();
    let repo = tmp.path().join("repo");
    fs::create_dir_all(&repo).unwrap();

    write_file(
        &repo.join(".claude/agents/poet.md"),
        "---\nname: poet\ndescription: Writes haikus\n---\nYou produce haikus on demand.\n",
    );

    let _guard = OrgiiHomeGuard::set(&orgii_home);
    let items = detect_all(Some(&repo));
    let agent = items
        .iter()
        .find(|i| i.kind == ItemKind::AgentDefinition && i.suggested_name == "poet")
        .expect("poet detected");

    let selection = ImportSelection {
        source_agent: agent.source_agent,
        source_scope: agent.source_scope.clone(),
        kind: agent.kind,
        source_path: agent.source_path.clone(),
        target_repo_path: None,
        target_name: "poet".to_string(),
        overwrite: false,
    };

    let store = AgentDefinitionsStore::new();
    let report = apply_selections(vec![selection], &store);
    assert_eq!(
        report.items[0].status,
        ImportStatus::Imported,
        "agent import failed: {:?}",
        report.items[0].error
    );

    // In-memory store contains the agent.
    let snapshot = store.snapshot();
    let imported = snapshot
        .iter()
        .find(|a| a.id == "poet")
        .expect("poet not in in-memory store");
    assert_eq!(imported.name, "poet");
    assert_eq!(imported.description.as_deref(), Some("Writes haikus"));
    assert!(imported
        .soul_content
        .as_deref()
        .unwrap_or_default()
        .contains("haikus on demand"));
    assert!(!imported.built_in);

    // On-disk JSON file contains the agent.
    let on_disk = orgii_home.join("agent-definitions.json");
    assert!(on_disk.is_file(), "agent-definitions.json not written");
    let raw = fs::read_to_string(&on_disk).unwrap();
    assert!(raw.contains("\"poet\""));
}

#[test]
fn agent_definition_import_rejects_collision_without_overwrite() {
    let _env_lock = test_helpers::test_env::lock_home();
    let tmp = TempDir::new().unwrap();
    let orgii_home = tmp.path().join("home");
    fs::create_dir_all(&orgii_home).unwrap();
    let repo = tmp.path().join("repo");
    fs::create_dir_all(&repo).unwrap();

    write_file(
        &repo.join(".claude/agents/poet.md"),
        "---\nname: poet\n---\nbody\n",
    );

    let _guard = OrgiiHomeGuard::set(&orgii_home);
    let items = detect_all(Some(&repo));
    let agent = items
        .iter()
        .find(|i| i.kind == ItemKind::AgentDefinition)
        .expect("poet detected");

    let mk = |overwrite: bool| ImportSelection {
        source_agent: agent.source_agent,
        source_scope: agent.source_scope.clone(),
        kind: agent.kind,
        source_path: agent.source_path.clone(),
        target_repo_path: None,
        target_name: "poet".to_string(),
        overwrite,
    };

    let store = AgentDefinitionsStore::new();
    let first = apply_selections(vec![mk(false)], &store);
    assert_eq!(first.items[0].status, ImportStatus::Imported);

    let second = apply_selections(vec![mk(false)], &store);
    assert_eq!(second.items[0].status, ImportStatus::Failed);
    assert!(second.items[0]
        .error
        .as_deref()
        .unwrap_or_default()
        .contains("already exists"));

    let third = apply_selections(vec![mk(true)], &store);
    assert_eq!(third.items[0].status, ImportStatus::Imported);
}

#[test]
fn readonly_subagent_emits_downgrade_warning_in_detect() {
    let _env_lock = test_helpers::test_env::lock_home();
    // Cursor / Codex subagents use a coarse-grained `readonly: true`
    // frontmatter flag instead of an explicit allowed-tools list. ORGII
    // has no top-level read-only switch on AgentDefinition, so detect
    // surfaces the constraint as a FidelityWarning so the wizard can
    // tell the user that we'll subtract the write-capable builtins on
    // import.
    let tmp = TempDir::new().unwrap();
    let repo = tmp.path().join("repo");
    fs::create_dir_all(&repo).unwrap();

    write_file(
        &repo.join(".cursor/agents/auditor.md"),
        "---\nname: auditor\ndescription: Read-only audit pass\nreadonly: true\n---\nYou audit; never write.\n",
    );

    let fake_home = tmp.path().join("fake-home");
    fs::create_dir_all(&fake_home).unwrap();
    let _home = UserHomeGuard::set(&fake_home);

    let items = detect_all(Some(&repo));
    let auditor = items
        .iter()
        .find(|i| i.kind == ItemKind::AgentDefinition && i.suggested_name == "auditor")
        .expect("auditor detected");

    let downgrade = auditor
        .fidelity_warnings
        .iter()
        .find_map(|w| match w {
            FidelityWarning::ReadonlyDowngraded { excluded_tools } => Some(excluded_tools),
            _ => None,
        })
        .expect("ReadonlyDowngraded warning emitted");
    assert_eq!(downgrade, &readonly_excluded_tool_names());
}

#[test]
fn readonly_apply_excludes_write_tools_on_imported_agent() {
    let _env_lock = test_helpers::test_env::lock_home();
    // The complement of the detect test: when the apply pipeline sees
    // `readonly: true`, the persisted AgentDefinition must carry the
    // exact same `excluded_tools` list. Both detect and apply consume
    // the same source-of-truth helper so this test guards against
    // silent drift between what we *announce* in the wizard and what
    // we *enforce* on the runtime agent.
    let tmp = TempDir::new().unwrap();
    let orgii_home = tmp.path().join("home");
    fs::create_dir_all(&orgii_home).unwrap();
    let repo = tmp.path().join("repo");
    fs::create_dir_all(&repo).unwrap();

    write_file(
        &repo.join(".cursor/agents/auditor.md"),
        "---\nname: auditor\nreadonly: true\n---\nYou audit; never write.\n",
    );

    let fake_home = tmp.path().join("fake-home");
    fs::create_dir_all(&fake_home).unwrap();
    let _home = UserHomeGuard::set(&fake_home);
    let _guard = OrgiiHomeGuard::set(&orgii_home);

    let items = detect_all(Some(&repo));
    let agent = items
        .iter()
        .find(|i| i.kind == ItemKind::AgentDefinition && i.suggested_name == "auditor")
        .expect("auditor detected");

    let selection = ImportSelection {
        source_agent: agent.source_agent,
        source_scope: agent.source_scope.clone(),
        kind: agent.kind,
        source_path: agent.source_path.clone(),
        target_repo_path: None,
        target_name: "auditor".to_string(),
        overwrite: false,
    };

    let store = AgentDefinitionsStore::new();
    let report = apply_selections(vec![selection], &store);
    assert_eq!(
        report.items[0].status,
        ImportStatus::Imported,
        "import failed: {:?}",
        report.items[0].error
    );

    let snapshot = store.snapshot();
    let imported = snapshot
        .iter()
        .find(|a| a.id == "auditor")
        .expect("auditor not persisted to in-memory store");
    assert_eq!(
        imported.tools.excluded_tools,
        readonly_excluded_tool_names()
    );

    // A non-readonly companion gets an empty excluded_tools list — we
    // don't want to over-restrict ordinary imports.
    write_file(
        &repo.join(".cursor/agents/normal.md"),
        "---\nname: normal\n---\nnormal body\n",
    );
    let items2 = detect_all(Some(&repo));
    let normal = items2
        .iter()
        .find(|i| i.kind == ItemKind::AgentDefinition && i.suggested_name == "normal")
        .expect("normal detected");
    let normal_sel = ImportSelection {
        source_agent: normal.source_agent,
        source_scope: normal.source_scope.clone(),
        kind: normal.kind,
        source_path: normal.source_path.clone(),
        target_repo_path: None,
        target_name: "normal".to_string(),
        overwrite: false,
    };
    let report2 = apply_selections(vec![normal_sel], &store);
    assert_eq!(report2.items[0].status, ImportStatus::Imported);
    let snapshot2 = store.snapshot();
    let imported_normal = snapshot2
        .iter()
        .find(|a| a.id == "normal")
        .expect("normal not persisted");
    assert!(imported_normal.tools.excluded_tools.is_empty());
}

// ============================================================
// Phase 3 — Cursor IDE skills
// ============================================================

#[test]
fn detects_cursor_skills_in_project() {
    let _env_lock = test_helpers::test_env::lock_home();
    let tmp = TempDir::new().unwrap();
    let repo = tmp.path();
    write_file(
        &repo.join(".cursor/skills/architecture-audit/SKILL.md"),
        "---\nname: architecture-audit\ndescription: Systematic audit\n---\nAudit body line\n",
    );
    write_file(
        &repo.join(".cursor/skills/wiring-checklist/SKILL.md"),
        "Plain skill body\n",
    );
    // Sibling that lacks SKILL.md must NOT show up.
    write_file(
        &repo.join(".cursor/skills/orphaned/notes.md"),
        "no skill md here\n",
    );

    let fake_home = tmp.path().join("fake-home");
    fs::create_dir_all(&fake_home).unwrap();
    let _home = UserHomeGuard::set(&fake_home);

    let items = detect_all(Some(repo));
    let cursor_skills: Vec<_> = items
        .iter()
        .filter(|i| i.kind == ItemKind::Skill && matches!(i.source_agent, SourceAgent::CursorIde))
        .collect();

    assert_eq!(
        cursor_skills.len(),
        2,
        "expected 2 cursor skills, got {:?}",
        cursor_skills
    );
    assert!(cursor_skills
        .iter()
        .any(|i| i.suggested_name == "architecture-audit"));
    assert!(cursor_skills
        .iter()
        .any(|i| i.suggested_name == "wiring-checklist"));

    let audit = cursor_skills
        .iter()
        .find(|i| i.suggested_name == "architecture-audit")
        .unwrap();
    assert!(audit
        .preview
        .frontmatter
        .iter()
        .any(|(k, _)| k == "description"));
    assert!(matches!(
        audit.source_scope,
        SourceScope::WorkspaceLocal { .. }
    ));
}

#[test]
fn cursor_skill_loose_md_in_skills_dir_is_ignored() {
    let _env_lock = test_helpers::test_env::lock_home();
    // Cursor skills MUST live in a `<name>/SKILL.md` bundle. A loose
    // `.cursor/skills/foo.md` file is not a valid skill and must not
    // be surfaced (otherwise we'd accidentally import random notes).
    let tmp = TempDir::new().unwrap();
    let repo = tmp.path();
    write_file(
        &repo.join(".cursor/skills/loose.md"),
        "---\nname: loose\n---\nThis is not a skill bundle\n",
    );

    let fake_home = tmp.path().join("fake-home");
    fs::create_dir_all(&fake_home).unwrap();
    let _home = UserHomeGuard::set(&fake_home);

    let items = detect_all(Some(repo));
    let cursor_skills: Vec<_> = items
        .iter()
        .filter(|i| i.kind == ItemKind::Skill && matches!(i.source_agent, SourceAgent::CursorIde))
        .collect();

    assert!(
        cursor_skills.is_empty(),
        "loose .md must be ignored, got: {:?}",
        cursor_skills
    );
}

#[test]
fn skips_workspace_local_cursor_skill_import_without_copying_to_orgii() {
    let _env_lock = test_helpers::test_env::lock_home();
    let tmp = TempDir::new().unwrap();
    let orgii_home = tmp.path().join("home");
    fs::create_dir_all(&orgii_home).unwrap();
    let repo = tmp.path().join("repo");
    fs::create_dir_all(&repo).unwrap();

    write_file(
        &repo.join(".cursor/skills/babysit/SKILL.md"),
        "---\nname: babysit\ndescription: Keep PR merge-ready\n---\nBabysit the PR.\n",
    );
    write_file(
        &repo.join(".cursor/skills/babysit/examples/checklist.md"),
        "1. fix CI\n2. resolve conflicts\n",
    );

    let fake_home = tmp.path().join("fake-home");
    fs::create_dir_all(&fake_home).unwrap();
    let _home = UserHomeGuard::set(&fake_home);
    let _guard = OrgiiHomeGuard::set(&orgii_home);
    let items = detect_all(Some(&repo));
    let skill = items
        .iter()
        .find(|i| {
            i.kind == ItemKind::Skill
                && matches!(i.source_agent, SourceAgent::CursorIde)
                && i.suggested_name == "babysit"
        })
        .expect("babysit cursor skill detected");

    let selection = ImportSelection {
        source_agent: skill.source_agent,
        source_scope: skill.source_scope.clone(),
        kind: skill.kind,
        source_path: skill.source_path.parent().unwrap().to_path_buf(),
        target_repo_path: Some(repo.clone()),
        target_name: "babysit".to_string(),
        overwrite: false,
    };

    let store = AgentDefinitionsStore::new();
    let report = apply_selections(vec![selection], &store);
    assert_eq!(report.items[0].status, ImportStatus::Skipped);

    let target_skill = repo.join(".orgii/skills/babysit/SKILL.md");
    let target_example = repo.join(".orgii/skills/babysit/examples/checklist.md");
    assert!(!target_skill.exists(), "workspace skill must not be copied");
    assert!(
        !target_example.exists(),
        "bundled sibling must not be copied"
    );
}

#[test]
fn detects_workspace_mcp_config_servers() {
    let tmp = TempDir::new().unwrap();
    let repo = tmp.path();
    write_file(
        &repo.join(".cursor/mcp.json"),
        r#"{
  "mcpServers": {
    "docs": {
      "command": "docs-mcp",
      "args": ["--stdio"]
    }
  }
}"#,
    );

    let items = detect_all(Some(repo));
    let server = items
        .iter()
        .find(|item| item.kind == ItemKind::Mcp && item.suggested_name == "docs")
        .expect("workspace MCP server detected");
    assert!(matches!(server.source_agent, SourceAgent::CursorIde));
    assert!(matches!(
        server.source_scope,
        SourceScope::WorkspaceLocal { .. }
    ));
    assert_eq!(server.preview.summary, "docs-mcp");
}

#[test]
fn apply_workspace_mcp_import_writes_workspace_config() {
    let _env_lock = test_helpers::test_env::lock_home();
    let tmp = TempDir::new().unwrap();
    let repo = tmp.path().join("repo");
    fs::create_dir_all(&repo).unwrap();
    let orgii_home = tmp.path().join("orgii-home");
    let _guard = OrgiiHomeGuard::set(&orgii_home);
    let source_path = repo.join(".cursor/mcp.json");
    write_file(
        &source_path,
        r#"{
  "mcpServers": {
    "docs": {
      "command": "docs-mcp",
      "args": ["--stdio"]
    }
  }
}"#,
    );

    let selection = ImportSelection {
        source_agent: SourceAgent::CursorIde,
        source_scope: SourceScope::WorkspaceLocal {
            repo_path: repo.clone(),
        },
        kind: ItemKind::Mcp,
        source_path,
        target_repo_path: Some(repo.clone()),
        target_name: "docs".to_string(),
        overwrite: false,
    };

    let store = AgentDefinitionsStore::new();
    let report = apply_selections(vec![selection], &store);
    assert_eq!(
        report.items[0].status,
        ImportStatus::Imported,
        "import failed: {:?}",
        report.items[0].error
    );

    let target_raw = fs::read_to_string(repo.join(".orgii/mcp-servers.json")).unwrap();
    let target_json: serde_json::Value = serde_json::from_str(&target_raw).unwrap();
    assert_eq!(
        target_json["mcpServers"]["docs"]["command"].as_str(),
        Some("docs-mcp")
    );
    assert_eq!(
        target_json["mcpServers"]["docs"]["type"].as_str(),
        Some("stdio")
    );
}

/// RAII helper that overrides `ORGII_HOME` for the duration of one test.
///
/// `paths::orgii_root()` consults this env var, so setting it isolates
/// every disk write made through the canonical path helpers from the
/// real `~/.orgii/` of the developer running the test. Process-global
/// env state means parallel tests would race; we serialise around a
/// shared mutex held for the lifetime of the guard.
struct OrgiiHomeGuard {
    prev: Option<String>,
    _lock: std::sync::MutexGuard<'static, ()>,
}

static ORGII_HOME_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

impl OrgiiHomeGuard {
    fn set(path: &Path) -> Self {
        let lock = ORGII_HOME_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let prev = std::env::var("ORGII_HOME").ok();
        std::env::set_var("ORGII_HOME", path);
        Self { prev, _lock: lock }
    }
}

impl Drop for OrgiiHomeGuard {
    fn drop(&mut self) {
        match &self.prev {
            Some(prev) => std::env::set_var("ORGII_HOME", prev),
            None => std::env::remove_var("ORGII_HOME"),
        }
    }
}

/// RAII helper that points `$HOME` at a tmpdir for the duration of one test.
///
/// Several detector branches (`~/.cursor/rules`, `~/.cursor/skills-cursor`,
/// `~/.claude/...`, `~/.codex/...`) consult the user's
/// home directory and therefore see the developer's real artifacts when
/// tests run locally. That bleeds counts into `assert_eq!(len, …)`
/// assertions made on `detect_all` output — pinning `$HOME` to a clean
/// tmpdir makes these tests deterministic across machines.
///
/// We use a dedicated mutex (separate from `ORGII_HOME_LOCK`) so a test
/// can hold both guards simultaneously without recursively locking the
/// same `Mutex` (which would panic).
struct UserHomeGuard {
    prev: Option<String>,
    _lock: std::sync::MutexGuard<'static, ()>,
}

static USER_HOME_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

impl UserHomeGuard {
    fn set(path: &Path) -> Self {
        let lock = USER_HOME_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let prev = std::env::var("HOME").ok();
        std::env::set_var("HOME", path);
        Self { prev, _lock: lock }
    }
}

impl Drop for UserHomeGuard {
    fn drop(&mut self) {
        match &self.prev {
            Some(prev) => std::env::set_var("HOME", prev),
            None => std::env::remove_var("HOME"),
        }
    }
}
