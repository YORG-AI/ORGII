use serde_json::json;
use test_helpers::test_env;

use super::*;

fn request(name: &str) -> ShareOrgSkillRequest {
    ShareOrgSkillRequest {
        org_id: "personal-org".to_string(),
        id: None,
        name: name.to_string(),
        description: "A shared helper".to_string(),
        skill_md: "---\ndescription: helper\n---\n\nDo the thing.".to_string(),
        files: vec![OrgSkillFile {
            relative_path: "references/notes.md".to_string(),
            content: "supporting notes".to_string(),
        }],
        provenance: Some(json!({ "id": "stable-1", "name": name })),
        shared_by: Some("member-1".to_string()),
    }
}

#[test]
fn share_materializes_and_unshare_removes_the_directory() {
    let _sandbox = test_env::sandbox();

    let shared = share(request("release-checklist")).expect("share");
    assert_eq!(shared.name, "release-checklist");

    let skill_dir = app_paths::org_skills_dir("personal-org")
        .expect("safe org id")
        .join("release-checklist");
    assert!(skill_dir.join("SKILL.md").exists(), "SKILL.md materialized");
    assert!(
        skill_dir.join("references/notes.md").exists(),
        "bundled file materialized"
    );
    assert!(
        skill_dir.join(".orgii-skill-origin.json").exists(),
        "provenance sidecar materialized"
    );

    let listed = list("personal-org").expect("list");
    assert_eq!(listed.len(), 1);

    unshare("personal-org", &shared.id).expect("unshare");
    assert!(list("personal-org").expect("list").is_empty());
    assert!(
        !skill_dir.exists(),
        "unshare removes the materialized directory"
    );
}

#[test]
fn share_rejects_oversized_and_unsafe_payloads() {
    let _sandbox = test_env::sandbox();

    let mut oversized = request("big");
    oversized.files = vec![OrgSkillFile {
        relative_path: "blob.txt".to_string(),
        content: "x".repeat(MAX_ORG_SKILL_BYTES + 1),
    }];
    let oversized_error = share(oversized).expect_err("size cap");
    assert!(oversized_error.contains("ORG_SKILL_TOO_LARGE_FILE"));

    let mut traversal = request("sneaky");
    traversal.files = vec![OrgSkillFile {
        relative_path: "../escape.md".to_string(),
        content: "nope".to_string(),
    }];
    assert!(share(traversal)
        .expect_err("path guard")
        .contains("ORG_SKILL_PATH_INVALID"));

    for path in [
        "/absolute.md",
        "\\windows-absolute.md",
        "C:/windows-drive.md",
        "references/./notes.md",
        "SKILL.md",
        "skill.md",
        "SKILL.md/nested.md",
        ".orgii-skill-origin.json",
        ".orgii-skill-origin.json/nested.md",
    ] {
        let mut unsafe_path = request("unsafe-path");
        unsafe_path.files[0].relative_path = path.to_string();
        assert!(
            share(unsafe_path)
                .expect_err("unsafe path")
                .contains("ORG_SKILL_PATH_INVALID"),
            "path should be rejected: {path}"
        );
    }

    let mut collision = request("colliding-paths");
    collision.files.push(OrgSkillFile {
        relative_path: "REFERENCES/NOTES.MD".to_string(),
        content: "case-insensitive collision".to_string(),
    });
    assert!(share(collision)
        .expect_err("path collision")
        .contains("ORG_SKILL_PATH_COLLISION"));

    let mut prefix_collision = request("prefix-collision");
    prefix_collision.files.push(OrgSkillFile {
        relative_path: "references/notes.md/more.txt".to_string(),
        content: "file-directory collision".to_string(),
    });
    assert!(share(prefix_collision)
        .expect_err("prefix collision")
        .contains("ORG_SKILL_PATH_COLLISION"));

    let mut too_many = request("too-many-files");
    too_many.files = (0..=MAX_ORG_SKILL_FILES)
        .map(|index| OrgSkillFile {
            relative_path: format!("references/{index}.md"),
            content: String::new(),
        })
        .collect();
    assert!(share(too_many)
        .expect_err("file-count cap")
        .contains("ORG_SKILL_TOO_MANY_FILES"));
}

#[test]
fn org_id_must_be_one_safe_storage_component() {
    let _sandbox = test_env::sandbox();

    for org_id in ["", "../escape", "/absolute", "nested/org", "C:", "space "] {
        let mut unsafe_org = request("safe-skill");
        unsafe_org.org_id = org_id.to_string();
        assert!(
            share(unsafe_org)
                .expect_err("unsafe org id")
                .contains("ORG_SKILL_ORG_ID_INVALID"),
            "org id should be rejected: {org_id:?}"
        );
    }
}

#[test]
fn wire_round_trip_applies_newer_snapshots_and_rematerializes() {
    let _sandbox = test_env::sandbox();

    let shared = share(request("triage-notes")).expect("share");
    let connection = crate::projects::io::helpers::conn().expect("conn");
    let exported = export_skills(&connection, "personal-org").expect("export");
    assert_eq!(exported.len(), 1);

    let mut remote = exported[0].clone();
    remote.skill_md = "---\ndescription: helper\n---\n\nUpdated remotely.".to_string();
    remote.updated_at += 1_000;
    apply_wire_skills(
        &connection,
        "personal-org",
        &json!({ "orgSkills": [remote] }),
    )
    .expect("apply");

    let materialized = std::fs::read_to_string(
        app_paths::org_skills_dir("personal-org")
            .expect("safe org id")
            .join("triage-notes")
            .join("SKILL.md"),
    )
    .expect("materialized SKILL.md");
    assert!(materialized.contains("Updated remotely."));
    assert_eq!(list("personal-org").expect("list")[0].id, shared.id);
}

#[test]
fn rematerialization_removes_deleted_files_and_provenance() {
    let _sandbox = test_env::sandbox();

    let shared = share(request("reconciled-skill")).expect("share");
    let skill_dir = app_paths::org_skills_dir("personal-org")
        .expect("safe org id")
        .join("reconciled-skill");
    assert!(skill_dir.join("references/notes.md").exists());
    assert!(skill_dir.join(".orgii-skill-origin.json").exists());

    let connection = crate::projects::io::helpers::conn().expect("conn");
    let mut updated = shared;
    updated.files.clear();
    updated.provenance = None;
    updated.updated_at += 1_000;
    apply_wire_skills(
        &connection,
        "personal-org",
        &json!({ "orgSkills": [updated] }),
    )
    .expect("apply reduced snapshot");

    assert!(!skill_dir.join("references").exists());
    assert!(!skill_dir.join(".orgii-skill-origin.json").exists());
    assert!(skill_dir.join("SKILL.md").exists());
}

#[test]
fn share_rejects_a_cross_org_id_collision_without_changing_the_original() {
    let _sandbox = test_env::sandbox();
    let mut original_request = request("original-skill");
    original_request.id = Some("shared-skill-id".to_string());
    let original = share(original_request).expect("share original");

    let mut colliding = request("replacement-skill");
    colliding.id = Some(original.id.clone());
    colliding.org_id = "other-org".to_string();
    colliding.skill_md = "---\ndescription: hostile replacement\n---\n".to_string();
    let error = share(colliding).expect_err("cross-org id collision");
    assert!(error.starts_with(ORG_SCOPE_MISMATCH), "{error}");

    let connection = crate::projects::io::helpers::conn().expect("conn");
    let stored = read(&connection, "personal-org", &original.id).expect("original remains");
    assert_eq!(
        serde_json::to_value(stored).expect("stored json"),
        serde_json::to_value(original).expect("original json"),
        "a rejected local collision must not mutate the row owned by the other org"
    );
}

#[test]
fn wire_rejects_a_cross_org_id_collision_without_changing_the_original() {
    let _sandbox = test_env::sandbox();
    let mut original_request = request("wire-original");
    original_request.id = Some("wire-shared-skill-id".to_string());
    let original = share(original_request).expect("share original");
    let connection = crate::projects::io::helpers::conn().expect("conn");

    let mut colliding = original.clone();
    colliding.org_id = "other-org".to_string();
    colliding.name = "wire-replacement".to_string();
    colliding.skill_md = "---\ndescription: hostile wire replacement\n---\n".to_string();
    colliding.updated_at += 1_000;
    let error = apply_wire_skills(
        &connection,
        "other-org",
        &json!({ "orgSkills": [colliding] }),
    )
    .expect_err("cross-org wire id collision");
    assert!(error.starts_with(ORG_SCOPE_MISMATCH), "{error}");

    let stored = read(&connection, "personal-org", &original.id).expect("original remains");
    assert_eq!(
        serde_json::to_value(stored).expect("stored json"),
        serde_json::to_value(original).expect("original json"),
        "a rejected wire collision must not mutate the row owned by the other org"
    );
}

#[test]
fn wire_validates_the_whole_batch_before_writing_any_row() {
    let _sandbox = test_env::sandbox();
    let connection = crate::projects::io::helpers::conn().expect("conn");
    let now = crate::projects::io::helpers::now_ms();

    let valid = OrgSkill {
        id: "remote-valid".to_string(),
        org_id: "personal-org".to_string(),
        name: "remote-valid".to_string(),
        description: String::new(),
        skill_md: "---\ndescription: valid\n---\n".to_string(),
        files: vec![],
        provenance: None,
        shared_by: None,
        archived_at: None,
        created_at: now,
        updated_at: now,
    };
    let mut invalid = valid.clone();
    invalid.id = "remote-invalid".to_string();
    invalid.files = vec![OrgSkillFile {
        relative_path: "../../escape.md".to_string(),
        content: "nope".to_string(),
    }];

    assert!(apply_wire_skills(
        &connection,
        "personal-org",
        &json!({ "orgSkills": [valid, invalid] }),
    )
    .expect_err("invalid remote batch")
    .contains("ORG_SKILL_PATH_INVALID"));
    assert!(list("personal-org").expect("list").is_empty());
}

#[cfg(unix)]
#[test]
fn materialization_refuses_preexisting_symlink_components() {
    use std::os::unix::fs::symlink;

    let sandbox = test_env::sandbox();
    let shared = share(request("symlink-guard")).expect("share");
    let skill_dir = app_paths::org_skills_dir("personal-org")
        .expect("safe org id")
        .join(&shared.name);
    let references = skill_dir.join("references");
    std::fs::remove_dir_all(&references).expect("remove materialized references");
    let outside = sandbox.path().join("outside");
    std::fs::create_dir(&outside).expect("outside directory");
    symlink(&outside, &references).expect("install hostile symlink");

    let connection = crate::projects::io::helpers::conn().expect("conn");
    let error = materialize_org(&connection, "personal-org").expect_err("symlink rejected");
    assert!(error.contains("ORG_SKILL_SYMLINK"), "{error}");
    assert!(
        !outside.join("notes.md").exists(),
        "materializer must not follow the symlink"
    );
}
