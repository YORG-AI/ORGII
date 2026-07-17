use super::*;

#[test]
fn parses_trae_time_as_local_wall_clock() {
    use chrono::TimeZone;
    let ms = parse_trae_time_ms("2026-07-13 12:42:20").expect("parses");
    assert!(ms > 0);
    // The source is local wall-clock time, so the recovered instant must render
    // back to the same wall clock in the local zone (timezone-independent, so
    // this holds on a UTC CI runner and a UTC+8 dev machine alike).
    let expected = chrono::Local
        .with_ymd_and_hms(2026, 7, 13, 12, 42, 20)
        .unwrap()
        .timestamp_millis();
    assert_eq!(ms, expected);
    assert!(parse_trae_time_ms("not a time").is_none());
    assert!(parse_trae_time_ms("").is_none());
}

#[test]
fn source_id_round_trips_through_prefix() {
    let sid = format!("{TRAE_SESSION_PREFIX}abc123");
    assert_eq!(trae_source_id_from_session_id(&sid).unwrap(), "abc123");
    assert!(trae_source_id_from_session_id("bogus").is_err());
    assert!(trae_source_id_from_session_id(TRAE_SESSION_PREFIX).is_err());
}

#[test]
fn composes_turn_body_from_outcome_actions_learned() {
    let line = TraeMemoryLine {
        intent: "do a thing".to_string(),
        actions: vec!["step one".to_string(), "step two".to_string()],
        outcome: "did the thing".to_string(),
        learned: vec!["a fact".to_string()],
        message_summary_time: "2026-07-13 12:42:20".to_string(),
    };
    let body = compose_turn_body(&line);
    assert!(body.contains("did the thing"));
    assert!(body.contains("Actions:"));
    assert!(body.contains("- step one"));
    assert!(body.contains("Learned:"));
    assert!(body.contains("- a fact"));
}

#[test]
fn decode_project_path_rejects_nonexistent() {
    // A slug that decodes to a path that does not exist yields None.
    assert!(decode_project_path("-no-such-dir-anywhere-xyz").is_none());
}

#[test]
fn decode_project_path_anchors_on_home() {
    // The home dir's own slug must round-trip even when the home path contains a
    // '-' (e.g. `/Users/laptop-h`), which the naive `-`->`/` decode would split
    // into a non-existent `/Users/laptop/h`. Home-anchoring resolves it; without
    // the fix this returns None and the session's repo_path is dropped.
    if let Some(home) = dirs::home_dir() {
        let home_str = home.to_string_lossy().to_string();
        let slug = home_str.replace('/', "-");
        assert_eq!(decode_project_path(&slug), Some(home_str));
    }
}

#[test]
fn object_id_created_ms_reads_embedded_timestamp() {
    // 0x6a546c49 = 1783917641 seconds → milliseconds.
    let ms = object_id_created_ms("6a546c493934825c28f92b42").expect("valid object id");
    assert_eq!(ms, 1_783_917_641_000);
    // Wrong length / non-hex / all-zero timestamp are rejected.
    assert!(object_id_created_ms("short").is_none());
    assert!(object_id_created_ms("zzzz6c493934825c28f92b42").is_none());
    assert!(object_id_created_ms("00000000000000000000000z").is_none());
}

#[test]
fn projects_dir_candidates_cover_cn_and_intl() {
    let home = std::path::Path::new("/home/u");
    let dirs = trae_projects_dir_candidates(home);
    assert!(dirs.contains(&home.join(".trae-cn").join("memory").join("projects")));
    assert!(dirs.contains(&home.join(".trae").join("memory").join("projects")));
}
