use super::SkillsLoader;
use std::fs;
use std::path::PathBuf;

fn write_skill(workspace: &std::path::Path, name: &str, description: &str) {
    let dir = workspace.join("skills").join(name);
    fs::create_dir_all(&dir).expect("mkdir skill");
    fs::write(
        dir.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: {description}\n---\n\n# {name}\n\nbody\n"),
    )
    .expect("write SKILL.md");
}

fn temp_workspace(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "orgii_skills_listing_test_{}_{}",
        tag,
        std::process::id(),
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("mkdir workspace");
    dir
}

#[test]
fn listing_entries_are_sorted_by_name() {
    // fs scan order is platform-dependent; the listing is re-sent every
    // request, so it must be byte-stable across scans.
    let ws = temp_workspace("sorted");
    write_skill(&ws, "zeta", "last");
    write_skill(&ws, "alpha", "first");
    write_skill(&ws, "mid", "middle");

    let loader = SkillsLoader::new(&ws);
    let names: Vec<String> = loader
        .build_skill_listing_entries(&[], None)
        .into_iter()
        .map(|entry| entry.name)
        .collect();
    assert_eq!(names, vec!["alpha", "mid", "zeta"]);
}

#[test]
fn load_skill_with_path_returns_skill_md_location() {
    let ws = temp_workspace("with_path");
    write_skill(&ws, "pathy", "has a base dir");

    let loader = SkillsLoader::new(&ws);
    let (content, path) = loader.load_skill_with_path("pathy").expect("skill loads");
    assert!(content.contains("# pathy"));
    let path = path.expect("on-disk skill has a path");
    assert_eq!(path, ws.join("skills").join("pathy").join("SKILL.md"));
    assert_eq!(
        path.parent().expect("SKILL.md has a parent"),
        ws.join("skills").join("pathy"),
    );
}
