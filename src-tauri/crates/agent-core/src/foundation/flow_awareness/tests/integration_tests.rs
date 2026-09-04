//! Integration tests for Flow Awareness system.
//!
//! Each test uses its own `FlowStore::new()` instance. `cargo test` runs tests
//! in parallel threads, and `FlowStore::global()` is process-wide: any test
//! recording session-less activity (which lands in the global queue that
//! `summarize`'s `get_combined` merges into every summary) or calling
//! `clear_global` mid-run bleeds into every other test's summary. A single
//! stray `Error` activity flips `infer_intent` to `Debugging` — that was a
//! real intermittent CI failure, not a hypothetical. Production writes go
//! through the `flow_record_activity` command, which calls
//! `FlowStore::global().record(...)` — the same `record` exercised here on
//! local stores.

use super::types::*;
use super::FlowStore;

#[test]
fn test_complete_flow_workflow() {
    let store = FlowStore::new();

    store.record(Activity::file_edit_with_lines(
        "src/components/Button.tsx",
        FileEditType::Modify,
        15,
    ));
    store.record(Activity::file_open("src/utils/helpers.ts"));
    store.record(Activity::file_edit_with_lines(
        "src/api/client.ts",
        FileEditType::Modify,
        8,
    ));
    store.record(Activity::terminal_command(
        "npm test",
        Some("/project".to_string()),
        Some(0),
    ));
    store.record(Activity::terminal_command(
        "npm run build",
        Some("/project".to_string()),
        Some(1),
    ));

    store.record(Activity::error(
        ErrorType::TypeCheck,
        "Cannot find name 'foo'",
        Some("src/api/client.ts"),
        Some(42),
    ));
    store.record(Activity::error(
        ErrorType::Lint,
        "Unexpected token",
        Some("src/components/Button.tsx"),
        Some(15),
    ));
    store.record(Activity::debug(
        DebugAction::SetBreakpoint,
        Some("src/api/client.ts"),
        Some(42),
    ));
    store.record(Activity::file_edit_with_lines(
        "src/api/client.ts",
        FileEditType::Modify,
        3,
    ));
    store.record(Activity::terminal_command(
        "npm run type-check",
        Some("/project".to_string()),
        Some(0),
    ));

    let context = store.format_context(None, 20);
    assert!(!context.is_empty());

    let summary = store.summarize(None, 20);
    assert!(summary.intent.is_some());
}

#[test]
fn test_intent_inference_debugging() {
    let store = FlowStore::new();
    let session_id = "debug-test";

    store.record(
        Activity::error(
            ErrorType::TypeCheck,
            "Type error",
            Some("file.ts"),
            Some(10),
        )
        .with_session(session_id),
    );
    store.record(
        Activity::error(ErrorType::Lint, "Lint error", Some("file.ts"), Some(15))
            .with_session(session_id),
    );
    store.record(
        Activity::debug(DebugAction::SetBreakpoint, Some("file.ts"), Some(10))
            .with_session(session_id),
    );

    let summary = store.summarize(Some(session_id), 10);
    assert_eq!(summary.intent, Some(InferredIntent::Debugging));
    assert!(!summary.current_errors.is_empty());
}

#[test]
fn test_intent_inference_writing() {
    let store = FlowStore::new();
    let session_id = "writing-test";

    for idx in 1..=10 {
        store.record(
            Activity::file_edit_with_lines(format!("file{}.ts", idx), FileEditType::Modify, 20)
                .with_session(session_id),
        );
    }

    let summary = store.summarize(Some(session_id), 15);
    assert_eq!(summary.intent, Some(InferredIntent::Writing));
    assert!(!summary.recent_edits.is_empty());
}

#[test]
fn test_memory_limits() {
    let store = FlowStore::new();
    let session_id = "memory-test";

    for idx in 1..=200 {
        store.record(
            Activity::file_edit_with_lines(format!("file{}.ts", idx), FileEditType::Create, 1)
                .with_session(session_id),
        );
    }

    let summary = store.summarize(Some(session_id), 200);
    assert!(summary.recent_edits.len() <= 100);
}
