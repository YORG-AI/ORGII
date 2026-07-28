//! Pin the `include_filter` whitelist on
//! `SkillsLoader::build_skill_listing_attachment` and
//! `build_always_skills_section`. The wiring path is
//! `AgentSkillsConfig.include` → `processor::prompt` →
//! `SkillsListingSection` → these helpers; the tests below lock
//! that contract regardless of whether a UI editor is present.
use super::SkillsLoader;
use std::fs;
use std::path::PathBuf;

fn write_skill(workspace: &std::path::Path, name: &str, body: &str) {
    let dir = workspace.join("skills").join(name);
    fs::create_dir_all(&dir).expect("mkdir skill");
    fs::write(dir.join("SKILL.md"), body).expect("write SKILL.md");
}

fn skill_doc(name: &str, description: &str) -> String {
    format!("---\nname: {name}\ndescription: {description}\n---\n\n# {name}\n\nbody\n")
}

fn always_skill_doc(name: &str, description: &str, body: &str) -> String {
    format!(
        "---\nname: {name}\ndescription: {description}\nalways: true\n---\n\n# {name}\n\n{body}\n"
    )
}

fn unavailable_skill_doc(name: &str, description: &str) -> String {
    format!(
        "---\nname: {name}\ndescription: {description}\nenv:\n  - ORGII_E2E_MISSING_SKILL_ENV\n---\n\n# {name}\n\nbody\n"
    )
}

fn temp_workspace(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "orgii_skills_include_test_{}_{}",
        tag,
        std::process::id(),
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("mkdir workspace");
    dir
}

#[test]
fn no_include_filter_means_every_undisabled_skill_is_listed() {
    let ws = temp_workspace("no_filter");
    write_skill(&ws, "alpha", &skill_doc("alpha", "first"));
    write_skill(&ws, "beta", &skill_doc("beta", "second"));
    write_skill(&ws, "gamma", &skill_doc("gamma", "third"));

    let loader = SkillsLoader::new(&ws);
    let attachment = loader
        .build_skill_listing_attachment(&[], None)
        .expect("listing populated");
    assert!(attachment.contains("alpha"));
    assert!(attachment.contains("beta"));
    assert!(attachment.contains("gamma"));
}

#[test]
fn include_filter_narrows_listing_to_named_skills() {
    let ws = temp_workspace("narrows");
    write_skill(&ws, "alpha", &skill_doc("alpha", "first"));
    write_skill(&ws, "beta", &skill_doc("beta", "second"));
    write_skill(&ws, "gamma", &skill_doc("gamma", "third"));

    let loader = SkillsLoader::new(&ws);
    let include = vec!["alpha".to_string(), "gamma".to_string()];
    let attachment = loader
        .build_skill_listing_attachment(&[], Some(&include))
        .expect("listing populated");
    assert!(attachment.contains("alpha"));
    assert!(attachment.contains("gamma"));
    assert!(
        !attachment.contains("\nbeta") && !attachment.contains(" beta "),
        "beta must be filtered out by include_filter; got:\n{attachment}",
    );
}

#[test]
fn empty_include_filter_means_no_skills() {
    // The prompt code only passes `Some(&[..])` when the slice is
    // non-empty (`!sc.include.is_empty()`), so `Some(&[])` is a
    // boundary case that the loader still has to handle correctly:
    // an explicit empty whitelist excludes everything.
    let ws = temp_workspace("empty_filter");
    write_skill(&ws, "alpha", &skill_doc("alpha", "first"));

    let loader = SkillsLoader::new(&ws);
    let empty: Vec<String> = Vec::new();
    let attachment = loader.build_skill_listing_attachment(&[], Some(&empty));
    assert!(
        attachment.is_none(),
        "explicit empty include_filter must produce no listing; got: {attachment:?}",
    );
}

#[test]
fn frontmatter_agent_scope_filters_skills() {
    let ws = temp_workspace("agent_scope");
    write_skill(
        &ws,
        "included",
        "---\nname: included\ndescription: included skill\ninclude-agent:\n  - agent-a\n---\nbody",
    );
    write_skill(
        &ws,
        "excluded",
        "---\nname: excluded\ndescription: excluded skill\nexclude-agent:\n  - agent-a\n---\nbody",
    );
    write_skill(
        &ws,
        "other",
        "---\nname: other\ndescription: other skill\ninclude-agent: [agent-b]\n---\nbody",
    );

    let loader = SkillsLoader::new(&ws).with_agent_id("agent-a");
    let names = loader
        .list_skills()
        .into_iter()
        .map(|skill| skill.name)
        .collect::<Vec<_>>();

    assert_eq!(names, vec!["included"]);
}

#[test]
fn workspace_toggle_skips_workspace_skills() {
    let ws = temp_workspace("workspace_toggle");
    write_skill(
        &ws,
        "workspace-only",
        &skill_doc("workspace-only", "workspace skill"),
    );

    let loader = SkillsLoader::new(&ws).with_load_workspace_resources(false);

    assert!(loader.list_skills().is_empty());
}

#[test]
fn workspace_source_skills_are_auto_loaded() {
    let repo = temp_workspace("workspace_sources_repo");
    let cursor_skill_dir = repo.join(".cursor/skills/cursor-audit");
    fs::create_dir_all(&cursor_skill_dir).expect("mkdir cursor skill");
    fs::write(
        cursor_skill_dir.join("SKILL.md"),
        skill_doc("cursor-audit", "Cursor repo skill"),
    )
    .expect("write cursor skill");
    let opencode_skill_dir = repo.join(".opencode/skills/opencode-review");
    fs::create_dir_all(&opencode_skill_dir).expect("mkdir opencode skill");
    fs::write(
        opencode_skill_dir.join("SKILL.md"),
        skill_doc("opencode-review", "OpenCode repo skill"),
    )
    .expect("write opencode skill");
    let agents_skill_dir = repo.join(".agents/skills/agent-review");
    fs::create_dir_all(&agents_skill_dir).expect("mkdir agent skill");
    fs::write(
        agents_skill_dir.join("SKILL.md"),
        skill_doc("agent-review", "Agent repo skill"),
    )
    .expect("write agent skill");
    let unknown_skill_dir = repo.join(".windsurf/skills/windsurf-review");
    fs::create_dir_all(&unknown_skill_dir).expect("mkdir unknown skill");
    fs::write(
        unknown_skill_dir.join("SKILL.md"),
        skill_doc("windsurf-review", "Unknown repo skill"),
    )
    .expect("write unknown skill");
    let ignored_skill_dir = repo.join(".cache/skills/cache-review");
    fs::create_dir_all(&ignored_skill_dir).expect("mkdir ignored skill");
    fs::write(
        ignored_skill_dir.join("SKILL.md"),
        skill_doc("cache-review", "Ignored repo skill"),
    )
    .expect("write ignored skill");
    let vscode_skill_dir = repo.join(".vscode/skills/vscode-review");
    fs::create_dir_all(&vscode_skill_dir).expect("mkdir vscode skill");
    fs::write(
        vscode_skill_dir.join("SKILL.md"),
        skill_doc("vscode-review", "Editor metadata skill"),
    )
    .expect("write vscode skill");
    let root_skill_dir = repo.join("skills/root-review");
    fs::create_dir_all(&root_skill_dir).expect("mkdir root skill");
    fs::write(
        root_skill_dir.join("SKILL.md"),
        skill_doc("root-review", "Root repo skill"),
    )
    .expect("write root skill");

    let loader = SkillsLoader::new(&repo.join(".orgii"));
    let names = loader
        .list_skills()
        .into_iter()
        .map(|skill| (skill.name, skill.source))
        .collect::<Vec<_>>();

    assert_eq!(
        names,
        vec![
            ("agent-review".to_string(), "external-source".to_string()),
            ("cursor-audit".to_string(), "external-source".to_string()),
            ("opencode-review".to_string(), "external-source".to_string()),
            ("windsurf-review".to_string(), "external-source".to_string()),
            ("root-review".to_string(), "external-source".to_string()),
        ]
    );
    assert!(loader
        .load_skill("cursor-audit")
        .unwrap_or_default()
        .contains("Cursor repo skill"));
    assert!(loader
        .load_skill("opencode-review")
        .unwrap_or_default()
        .contains("OpenCode repo skill"));
    assert!(loader
        .load_skill("agent-review")
        .unwrap_or_default()
        .contains("Agent repo skill"));
    assert!(loader
        .load_skill("windsurf-review")
        .unwrap_or_default()
        .contains("Unknown repo skill"));
    assert!(loader
        .load_skill("root-review")
        .unwrap_or_default()
        .contains("Root repo skill"));
    assert!(loader.load_skill("cache-review").is_none());
    assert!(loader.load_skill("vscode-review").is_none());
}

#[test]
fn workspace_toggle_skips_workspace_source_skills() {
    let repo = temp_workspace("workspace_sources_toggle");
    let cursor_skill_dir = repo.join(".cursor/skills/cursor-audit");
    fs::create_dir_all(&cursor_skill_dir).expect("mkdir cursor skill");
    fs::write(
        cursor_skill_dir.join("SKILL.md"),
        skill_doc("cursor-audit", "Cursor repo skill"),
    )
    .expect("write cursor skill");

    let loader = SkillsLoader::new(&repo.join(".orgii")).with_load_workspace_resources(false);

    assert!(loader.list_skills().is_empty());
}

#[test]
fn always_skills_render_manifest_without_body() {
    let ws = temp_workspace("always_manifest");
    write_skill(
        &ws,
        "cache-audit",
        &always_skill_doc("cache-audit", "Audit prompt cache", "SECRET BODY DETAIL"),
    );

    let loader = SkillsLoader::new(&ws);
    let sections = loader.build_always_skills_manifest_section(&[], None);
    assert_eq!(sections.len(), 1);
    let manifest = &sections[0];
    assert!(manifest.contains("cache-audit"));
    assert!(manifest.contains("Audit prompt cache"));
    assert!(manifest.contains("SKILL.md"));
    assert!(manifest.contains("`skill` tool"));
    assert!(
        !manifest.contains("SECRET BODY DETAIL"),
        "always skill body must be loaded on demand, not inlined: {manifest}",
    );
}

#[test]
fn listing_excludes_unavailable_skills() {
    let ws = temp_workspace("unavailable_hidden");
    write_skill(&ws, "alpha", &skill_doc("alpha", "first"));
    write_skill(
        &ws,
        "blocked",
        &unavailable_skill_doc("blocked", "missing env"),
    );

    let loader = SkillsLoader::new(&ws);
    let attachment = loader
        .build_skill_listing_attachment(&[], None)
        .expect("listing populated");
    assert!(attachment.contains("alpha"));
    assert!(
        !attachment.contains("blocked"),
        "unavailable skills must not appear in LLM listing; got:\n{attachment}",
    );
}

#[test]
fn disabled_skills_take_precedence_over_include_filter() {
    let ws = temp_workspace("disabled_wins");
    write_skill(&ws, "alpha", &skill_doc("alpha", "first"));
    write_skill(&ws, "beta", &skill_doc("beta", "second"));

    let loader = SkillsLoader::new(&ws);
    let include = vec!["alpha".to_string(), "beta".to_string()];
    let disabled = vec!["alpha".to_string()];
    let attachment = loader
        .build_skill_listing_attachment(&disabled, Some(&include))
        .expect("listing populated");
    assert!(
        !attachment.contains("\nalpha") && !attachment.contains(" alpha "),
        "alpha is disabled and must NOT appear; got:\n{attachment}",
    );
    assert!(attachment.contains("beta"));
}
