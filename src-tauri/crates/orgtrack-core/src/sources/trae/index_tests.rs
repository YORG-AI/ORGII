use super::*;

#[test]
fn agent_label_title_cases_ids() {
    assert_eq!(agent_display_label("solo_agent"), "Solo Agent");
    assert_eq!(agent_display_label("chat"), "Chat");
    assert_eq!(agent_display_label("my-custom_agent"), "My Custom Agent");
    assert_eq!(agent_display_label(""), "");
}

#[test]
fn parses_agent_map_and_drops_blanks() {
    let raw = r#"{"6a54":"solo_agent","6a35":"chat","6a00":"  "}"#;
    let mut pairs = parse_agent_map(raw);
    pairs.sort();
    assert_eq!(
        pairs,
        vec![
            ("6a35".to_string(), "chat".to_string()),
            ("6a54".to_string(), "solo_agent".to_string()),
        ]
    );
    assert!(parse_agent_map("not json").is_empty());
}

#[test]
fn parses_memento_list_order_and_current() {
    let raw = r#"{
        "list": [
            {"isCurrent": false, "sessionId": "6a54", "messages": []},
            {"isCurrent": true,  "sessionId": "6a53", "messages": []},
            {"isCurrent": false, "sessionId": "", "messages": []}
        ],
        "currentSessionId": "6a53"
    }"#;
    let parsed = parse_memento(raw);
    // Blank session id is dropped; order is list position.
    assert_eq!(
        parsed.entries,
        vec![
            ("6a54".to_string(), 0, false),
            ("6a53".to_string(), 1, true)
        ]
    );
    assert_eq!(parsed.current_session_id.as_deref(), Some("6a53"));

    let empty = parse_memento("nope");
    assert!(empty.entries.is_empty());
    assert!(empty.current_session_id.is_none());
}

#[test]
fn merge_combines_agent_and_memento() {
    // Simulate what merge_vscdb_index does with the two parsed keys.
    let mut index = TraeSessionIndex::new();
    for (session_id, agent) in parse_agent_map(r#"{"6a54":"solo_agent"}"#) {
        index.entry(session_id).or_default().agent = Some(agent);
    }
    let parsed = parse_memento(
        r#"{"list":[{"sessionId":"6a54","isCurrent":true}],"currentSessionId":"6a54"}"#,
    );
    for (session_id, order, is_current) in parsed.entries {
        let entry = index.entry(session_id).or_default();
        entry.order = Some(order);
        entry.is_current = entry.is_current || is_current;
    }

    let entry = index.get("6a54").expect("session present");
    assert_eq!(entry.agent.as_deref(), Some("solo_agent"));
    assert_eq!(entry.order, Some(0));
    assert!(entry.is_current);
    assert!(entry.is_meaningful());
    assert!(!TraeIndexEntry::default().is_meaningful());
}

#[test]
fn entry_serializes_only_present_fields() {
    let entry = TraeIndexEntry {
        agent: Some("solo_agent".to_string()),
        is_current: false,
        order: Some(2),
    };
    let json = serde_json::to_string(&entry).expect("serializes");
    assert!(json.contains("\"agent\":\"solo_agent\""));
    assert!(json.contains("\"order\":2"));
    // Falsy is_current is skipped.
    assert!(!json.contains("is_current"));
}
