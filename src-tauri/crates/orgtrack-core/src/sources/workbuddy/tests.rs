use super::*;

#[test]
fn discovers_agent_transcripts_and_derives_parent_session() {
    let path = PathBuf::from(
        "/tmp/project/58c5651c-1111-2222-3333-444444444444/subagents/agent-2b89c425.jsonl",
    );
    let mut files = Vec::new();

    push_workbuddy_session_file(&path, &mut files);

    assert_eq!(files.len(), 1);
    assert_eq!(files[0].file_stem, "agent-2b89c425");
    assert_eq!(
        workbuddy_parent_source_session_id(&path).as_deref(),
        Some("58c5651c-1111-2222-3333-444444444444")
    );
}

#[test]
fn top_level_transcript_has_no_derived_parent() {
    let path = Path::new("/tmp/project/58c5651c-1111-2222-3333-444444444444.jsonl");
    assert!(workbuddy_parent_source_session_id(path).is_none());
}

#[test]
fn agent_source_id_prefers_embedded_session_id() {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let path = std::env::temp_dir().join(format!("agent-orgii-{unique}.jsonl"));
    fs::write(
        &path,
        r#"{"sessionId":"child-session-id","type":"message","role":"user"}"#,
    )
    .expect("write child transcript");

    assert_eq!(
        workbuddy_source_session_id("agent-orgii", &path),
        "child-session-id"
    );

    fs::remove_file(path).expect("remove child transcript");
}
