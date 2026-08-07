use orgtrack_protocol::{
    ResourceAction, ResourceInteractionEnvelopeV1, SessionActorLifecycleEnvelopeV1,
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;

/// Live conformance entry point for vendor hooks.
///
/// Run explicitly after Claude Code, Codex, and Cursor have written hook
/// envelopes into an isolated inbox:
///
/// `ORGTRACK_LIVE_ENVELOPE_DIR=/path/to/inbox cargo test -p orgtrack_protocol --test live_vendor_envelopes -- --ignored`
#[test]
#[ignore = "requires live Claude Code, Codex, and Cursor hook output"]
fn validates_live_vendor_envelopes() {
    let inbox = PathBuf::from(
        std::env::var("ORGTRACK_LIVE_ENVELOPE_DIR")
            .expect("ORGTRACK_LIVE_ENVELOPE_DIR must point to the isolated hook inbox"),
    );
    let mut paths = fs::read_dir(&inbox)
        .expect("read live envelope directory")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect::<Vec<_>>();
    paths.sort();
    assert!(!paths.is_empty(), "live envelope directory is empty");

    let expected_keys = [
        "schemaVersion",
        "source",
        "sourceSessionId",
        "sessionId",
        "sourceEventId",
        "turnId",
        "actorId",
        "cwd",
        "filePath",
        "action",
        "outcome",
        "occurredAt",
        "attributionPrecision",
    ]
    .into_iter()
    .map(str::to_string)
    .collect::<BTreeSet<_>>();
    let expected_actor_keys = [
        "schemaVersion",
        "source",
        "sourceSessionId",
        "sessionId",
        "turnId",
        "actorId",
        "actorType",
        "phase",
        "occurredAt",
        "cwd",
        "transcriptPath",
    ]
    .into_iter()
    .map(str::to_string)
    .collect::<BTreeSet<_>>();
    let mut actions_by_source = BTreeMap::<String, Vec<ResourceAction>>::new();

    for path in paths {
        let bytes = fs::read(&path).expect("read live envelope");
        let value: Value = serde_json::from_slice(&bytes).expect("live envelope JSON");
        let actual_keys = value
            .as_object()
            .expect("live envelope object")
            .keys()
            .cloned()
            .collect::<BTreeSet<_>>();
        if value.get("phase").is_some() {
            assert_eq!(
                actual_keys, expected_actor_keys,
                "unexpected actor wire fields in {path:?}"
            );
            let envelope: SessionActorLifecycleEnvelopeV1 =
                serde_json::from_value(value.clone()).expect("strict actor envelope decode");
            envelope.validate().expect("live actor envelope invariants");
            assert_eq!(
                serde_json::to_value(&envelope).expect("serialize actor envelope"),
                value,
                "live actor envelope must round-trip exactly"
            );
        } else {
            assert_eq!(
                actual_keys, expected_keys,
                "unexpected resource wire fields in {path:?}"
            );
            let envelope: ResourceInteractionEnvelopeV1 =
                serde_json::from_value(value.clone()).expect("strict resource envelope decode");
            envelope
                .validate()
                .expect("live resource envelope invariants");
            assert_eq!(
                serde_json::to_value(&envelope).expect("serialize resource envelope"),
                value,
                "live resource envelope must round-trip exactly"
            );
            actions_by_source
                .entry(envelope.source.clone())
                .or_default()
                .push(envelope.action);
        }

        let serialized = String::from_utf8(bytes).expect("UTF-8 live envelope");
        for private_sentinel in [
            "CLAUDE_PROTOCOL_LIVE",
            "CODEX_PROTOCOL_LIVE",
            "CURSOR_PROTOCOL_LIVE",
        ] {
            assert!(
                !serialized.contains(private_sentinel),
                "file content leaked into {path:?}"
            );
        }
    }

    for source in ["claude_code", "codex_app", "cursor_ide"] {
        let actions = actions_by_source
            .get(source)
            .unwrap_or_else(|| panic!("missing live source {source}"));
        assert!(
            actions.contains(&ResourceAction::Read),
            "{source} read missing"
        );
        assert!(
            actions.contains(&ResourceAction::Write),
            "{source} write missing"
        );
    }
}
