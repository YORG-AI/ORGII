#![cfg(any(target_os = "linux", target_os = "macos"))]

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use conversation_portability::{
    PortableContentBlock, PortableConversation, PortableConversationSource, PortableEvent,
    PortableEventBody, PortableLossManifest, PortableRole, PortableSourceSnapshot,
    PortableSourceSnapshotAlgorithm, PortableToolCallState, PORTABLE_CONVERSATION_SCHEMA,
    PORTABLE_CONVERSATION_VERSION,
};
use serde_json::json;
use tempfile::TempDir;
use uuid::Uuid;

use crate::materializer::prepare_with_corruption_fault;
use crate::native::{reparse_native, NativeFormatContext};
use crate::semantic::{NativeSemanticEvent, NativeSemanticGroup};
use crate::*;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

const CREATED_AT: &str = "2026-08-25T13:00:00Z";
const IMAGE: &str = "data:image/png;base64,aGVsbG8=";

struct Harness {
    _temporary: TempDir,
    profile: PathBuf,
    workspace: PathBuf,
    recovery: PathBuf,
    executable: PathBuf,
}

impl Harness {
    fn new() -> Self {
        let temporary = tempfile::tempdir().expect("tempdir");
        let profile = temporary.path().join("profile");
        let workspace = temporary.path().join("workspace");
        let recovery = temporary.path().join("recovery");
        for path in [&profile, &workspace, &recovery] {
            fs::create_dir(path).expect("create harness directory");
        }
        let executable = temporary.path().join("fake-cli");
        fs::write(&executable, b"#!/bin/sh\nexit 99\n").expect("fake executable");
        #[cfg(unix)]
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700))
            .expect("executable mode");
        Self {
            _temporary: temporary,
            profile,
            workspace,
            recovery,
            executable,
        }
    }

    fn request<'a>(
        &'a self,
        conversation: &'a PortableConversation,
        runtime: NativeRuntimeTarget,
        target_session_id: Uuid,
        version: &'a str,
        source_native_path: Option<&'a Path>,
    ) -> NativeMaterializationRequest<'a> {
        NativeMaterializationRequest {
            conversation,
            target_session_id,
            runtime,
            account_id: "account-fixture",
            cli_executable: &self.executable,
            observed_cli_version: version,
            target_profile_root: &self.profile,
            target_workspace_root: &self.workspace,
            recovery_root: &self.recovery,
            created_at: CREATED_AT,
            source_native_path,
        }
    }
}

#[test]
fn codex_materializes_structured_history_and_returns_real_resume_plan() {
    let harness = Harness::new();
    let conversation = codex_conversation();
    let target_id = Uuid::new_v4();
    let candidate = prepare_native_materialization(harness.request(
        &conversation,
        NativeRuntimeTarget::Codex {
            model: "gpt-fixture".into(),
            model_provider: "openai".into(),
        },
        target_id,
        "0.144.5",
        None,
    ))
    .expect("prepare Codex candidate");

    assert_eq!(candidate.native_session_id, target_id.to_string());
    assert_eq!(candidate.resume_plan.model, "gpt-fixture");
    assert_ne!(
        candidate.native_session_id,
        conversation.source.source_session_id
    );
    assert_eq!(
        candidate.resume_plan.args,
        ["resume", &target_id.to_string()]
    );
    assert_eq!(
        candidate.resume_plan.cwd,
        fs::canonicalize(&harness.workspace).expect("canonical workspace")
    );
    assert_eq!(candidate.resume_plan.executable, harness.executable);
    assert_eq!(
        candidate.resume_plan.environment.get("CODEX_HOME"),
        fs::canonicalize(&harness.profile)
            .expect("canonical profile")
            .to_str()
            .map(str::to_string)
            .as_ref()
    );
    assert!(candidate.continuation_complete);
    let raw = fs::read_to_string(&candidate.target_path).expect("native transcript");
    assert!(raw.contains("\"role\":\"system\""));
    assert!(raw.contains("\"role\":\"developer\""));
    assert!(raw.contains("\"type\":\"function_call\""));
    assert!(raw.contains("\"type\":\"compacted\""));
    assert!(!raw.contains("FIRST REAL TURN MUST COME FROM THE RUNNER"));
    #[cfg(unix)]
    assert_eq!(
        fs::metadata(&candidate.target_path)
            .expect("metadata")
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}

#[test]
fn claude_materializes_error_tool_result_image_and_compaction_graph() {
    let harness = Harness::new();
    let conversation = claude_conversation();
    let target_id = Uuid::new_v4();
    let candidate = prepare_native_materialization(harness.request(
        &conversation,
        NativeRuntimeTarget::ClaudeCode {
            model: "claude-fixture".into(),
        },
        target_id,
        "2.1.226",
        None,
    ))
    .expect("prepare Claude candidate");

    assert_eq!(
        candidate.resume_plan.args,
        ["--resume", &target_id.to_string()]
    );
    assert_eq!(candidate.resume_plan.model, "claude-fixture");
    assert_eq!(
        candidate.resume_plan.environment.get("CLAUDE_CONFIG_DIR"),
        fs::canonicalize(&harness.profile)
            .expect("canonical profile")
            .to_str()
            .map(str::to_string)
            .as_ref()
    );
    let raw = fs::read_to_string(&candidate.target_path).expect("native transcript");
    assert!(raw.contains("\"is_error\":true"));
    assert!(raw.contains("\"subtype\":\"compact_boundary\""));
    assert!(raw.contains("\"isCompactSummary\":true"));
    assert!(raw
        .lines()
        .last()
        .is_some_and(|line| line.contains("last-prompt")));
}

#[test]
fn frozen_provider_fixtures_are_read_as_exact_structured_semantics() {
    let cases = [
        (
            NativeConversationRuntime::Codex,
            include_bytes!("../testdata/codex-0.144.4.jsonl").as_slice(),
            "20000000-0000-4000-8000-000000000000",
            "0.144.4",
            NativeRuntimeTarget::Codex {
                model: "gpt-fixture".into(),
                model_provider: "openai".into(),
            },
            codex_01444_fixture_semantics(),
        ),
        (
            NativeConversationRuntime::Codex,
            include_bytes!("../testdata/codex-0.144.5.jsonl").as_slice(),
            "21000000-0000-4000-8000-000000000000",
            "0.144.5",
            NativeRuntimeTarget::Codex {
                model: "gpt-fixture".into(),
                model_provider: "openai".into(),
            },
            codex_01445_fixture_semantics(),
        ),
        (
            NativeConversationRuntime::ClaudeCode,
            include_bytes!("../testdata/claude-2.1.209.jsonl").as_slice(),
            "10000000-0000-4000-8000-000000000000",
            "2.1.209",
            NativeRuntimeTarget::ClaudeCode {
                model: "fixture-model".into(),
            },
            claude_21209_fixture_semantics(),
        ),
        (
            NativeConversationRuntime::ClaudeCode,
            include_bytes!("../testdata/claude-2.1.226.jsonl").as_slice(),
            "11000000-0000-4000-8000-000000000000",
            "2.1.226",
            NativeRuntimeTarget::ClaudeCode {
                model: "fixture-model".into(),
            },
            claude_21226_fixture_semantics(),
        ),
    ];

    for (runtime, bytes, session_id, version, target, expected) in cases {
        let context = NativeFormatContext {
            session_id,
            workspace: Path::new("/work"),
            cli_version: version,
            target: &target,
            created_at: CREATED_AT,
        };
        assert_eq!(
            reparse_native(runtime, bytes, &context).expect("reparse frozen fixture"),
            expected,
            "fixture {version}"
        );
    }
}

#[test]
fn independent_target_reader_rejects_a_lossy_tool_error_field() {
    let original = std::str::from_utf8(include_bytes!("../testdata/claude-2.1.226.jsonl"))
        .expect("UTF-8 fixture");
    let corrupted = original.replace("\"is_error\":true", "\"is_error\":\"true\"");
    assert_ne!(corrupted, original);
    let target = NativeRuntimeTarget::ClaudeCode {
        model: "fixture-model".into(),
    };
    let context = NativeFormatContext {
        session_id: "11000000-0000-4000-8000-000000000000",
        workspace: Path::new("/work"),
        cli_version: "2.1.226",
        target: &target,
        created_at: CREATED_AT,
    };
    let error = reparse_native(
        NativeConversationRuntime::ClaudeCode,
        corrupted.as_bytes(),
        &context,
    )
    .expect_err("tool error type degradation must fail");
    assert_eq!(
        error.kind,
        NativeMaterializationFailureKind::NativeParityMismatch
    );
}

#[test]
fn unknown_version_fails_before_creating_a_native_target() {
    let harness = Harness::new();
    let conversation = codex_conversation();
    let error = prepare_native_materialization(harness.request(
        &conversation,
        NativeRuntimeTarget::Codex {
            model: "gpt-fixture".into(),
            model_provider: "openai".into(),
        },
        Uuid::new_v4(),
        "0.145.0",
        None,
    ))
    .expect_err("unknown version must fail");
    assert_eq!(
        error.kind,
        NativeMaterializationFailureKind::UnsupportedRuntimeVersion
    );
    assert!(!harness.profile.join("sessions").exists());
}

#[test]
fn publication_is_no_clobber() {
    let harness = Harness::new();
    let conversation = codex_conversation();
    let target_id = Uuid::new_v4();
    let first = prepare_native_materialization(harness.request(
        &conversation,
        NativeRuntimeTarget::Codex {
            model: "gpt-fixture".into(),
            model_provider: "openai".into(),
        },
        target_id,
        "0.144.5",
        None,
    ))
    .expect("first candidate");
    let original = fs::read(&first.target_path).expect("first bytes");
    let error = prepare_native_materialization(harness.request(
        &conversation,
        NativeRuntimeTarget::Codex {
            model: "gpt-fixture".into(),
            model_provider: "openai".into(),
        },
        target_id,
        "0.144.5",
        None,
    ))
    .expect_err("second candidate must not clobber");
    assert_eq!(error.kind, NativeMaterializationFailureKind::NoClobber);
    assert_eq!(fs::read(&first.target_path).expect("unchanged"), original);
}

#[test]
fn source_and_target_same_path_is_rejected_without_reading_or_overwriting_source() {
    let harness = Harness::new();
    let conversation = codex_conversation();
    let target_id = Uuid::new_v4();
    let target = harness
        .profile
        .join("sessions/2026/08/25")
        .join(format!("rollout-2026-08-25T13-00-00-{target_id}.jsonl"));
    fs::create_dir_all(target.parent().expect("target parent")).expect("target tree");
    fs::write(&target, b"source must remain untouched\n").expect("source sentinel");
    #[cfg(unix)]
    fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).expect("sentinel mode");

    let error = prepare_native_materialization(harness.request(
        &conversation,
        NativeRuntimeTarget::Codex {
            model: "gpt-fixture".into(),
            model_provider: "openai".into(),
        },
        target_id,
        "0.144.5",
        Some(&target),
    ))
    .expect_err("same source and target path must fail");
    assert_eq!(error.kind, NativeMaterializationFailureKind::InvalidRequest);
    assert_eq!(
        fs::read(&target).expect("sentinel remains"),
        b"source must remain untouched\n"
    );
}

#[test]
fn post_publish_parity_fault_leaves_no_active_file() {
    let harness = Harness::new();
    let conversation = codex_conversation();
    let target_id = Uuid::new_v4();
    let expected_target = harness
        .profile
        .join("sessions/2026/08/25")
        .join(format!("rollout-2026-08-25T13-00-00-{target_id}.jsonl"));
    let error = prepare_with_corruption_fault(harness.request(
        &conversation,
        NativeRuntimeTarget::Codex {
            model: "gpt-fixture".into(),
            model_provider: "openai".into(),
        },
        target_id,
        "0.144.5",
        None,
    ))
    .expect_err("fault must fail preparation");
    assert!(matches!(
        error.kind,
        NativeMaterializationFailureKind::NativeParityMismatch
            | NativeMaterializationFailureKind::FilesystemBoundary
    ));
    assert!(!expected_target.exists());
    let parent = expected_target.parent().expect("target parent");
    assert!(fs::read_dir(parent)
        .expect("target directory")
        .all(|entry| !entry
            .expect("directory entry")
            .file_name()
            .to_string_lossy()
            .contains("org2-materializing")));
}

#[test]
fn acceptance_requires_same_file_prefix_id_and_exact_first_real_turn() {
    let harness = Harness::new();
    let conversation = codex_conversation();
    let target_id = Uuid::new_v4();
    let candidate = prepare_native_materialization(harness.request(
        &conversation,
        NativeRuntimeTarget::Codex {
            model: "gpt-fixture".into(),
            model_provider: "openai".into(),
        },
        target_id,
        "0.144.5",
        None,
    ))
    .expect("candidate");
    let real_turn = "FIRST REAL TURN MUST COME FROM THE RUNNER";
    append(
        &candidate.target_path,
        format!(
            "{{\"timestamp\":\"{CREATED_AT}\",\"type\":\"event_msg\",\"payload\":{{\"type\":\"user_message\",\"message\":{}}}}}\n{{\"timestamp\":\"{CREATED_AT}\",\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"user\",\"content\":[{{\"type\":\"input_text\",\"text\":{}}}]}}}}\n",
            serde_json::to_string(real_turn).expect("turn JSON"),
            serde_json::to_string(real_turn).expect("turn JSON")
        )
        .as_bytes(),
    );

    let wrong_id = accept_native_resume(
        &candidate,
        NativeResumeObservation {
            observed_native_session_id: "wrong-id",
            first_real_user_turn: real_turn,
        },
    )
    .expect_err("wrong native id");
    assert_eq!(
        wrong_id.kind,
        NativeMaterializationFailureKind::AcceptanceFailed
    );
    let accepted = accept_native_resume(
        &candidate,
        NativeResumeObservation {
            observed_native_session_id: &candidate.native_session_id,
            first_real_user_turn: real_turn,
        },
    )
    .expect("accept real resume");
    assert!(
        accepted.transcript_bytes_after_resume
            > candidate.resume_plan.transcript_bytes_before_resume
    );
}

#[test]
fn rejection_moves_candidate_out_of_provider_store_into_recovery() {
    let harness = Harness::new();
    let conversation = claude_conversation();
    let candidate = prepare_native_materialization(harness.request(
        &conversation,
        NativeRuntimeTarget::ClaudeCode {
            model: "claude-fixture".into(),
        },
        Uuid::new_v4(),
        "2.1.226",
        None,
    ))
    .expect("candidate");
    let active_path = candidate.target_path.clone();
    let bytes = fs::read(&active_path).expect("candidate bytes");
    let rejected = reject_native_materialization(candidate).expect("reject candidate");
    assert!(!active_path.exists());
    assert_eq!(fs::read(&rejected.recovery_path).expect("recovered"), bytes);
    #[cfg(unix)]
    assert_eq!(
        fs::metadata(&rejected.recovery_path)
            .expect("metadata")
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}

#[test]
fn rejection_reconciles_matching_crash_recovery_and_rejects_mismatch() {
    let harness = Harness::new();
    let conversation = codex_conversation();
    let candidate = prepare_native_materialization(harness.request(
        &conversation,
        NativeRuntimeTarget::Codex {
            model: "gpt-fixture".into(),
            model_provider: "openai".into(),
        },
        Uuid::new_v4(),
        "0.144.5",
        None,
    ))
    .expect("candidate");
    let active_path = candidate.target_path.clone();
    let bytes = fs::read(&active_path).expect("candidate bytes");
    let recovery_directory = harness.recovery.join("rejected-native-sessions/codex");
    fs::create_dir_all(&recovery_directory).expect("recovery tree");
    let recovery_path = recovery_directory.join(format!("{}.jsonl", candidate.native_session_id));
    fs::write(&recovery_path, &bytes).expect("simulate recovery publish before crash");
    fs::set_permissions(&recovery_path, fs::Permissions::from_mode(0o600)).expect("recovery mode");
    let rejected = reject_native_materialization(candidate).expect("idempotent rejection");
    assert_eq!(
        rejected.recovery_path,
        fs::canonicalize(&recovery_path).expect("recovery")
    );
    assert!(!active_path.exists());

    let second = prepare_native_materialization(harness.request(
        &conversation,
        NativeRuntimeTarget::Codex {
            model: "gpt-fixture".into(),
            model_provider: "openai".into(),
        },
        Uuid::new_v4(),
        "0.144.5",
        None,
    ))
    .expect("second candidate");
    let second_recovery = recovery_directory.join(format!("{}.jsonl", second.native_session_id));
    fs::write(&second_recovery, b"different\n").expect("mismatch sentinel");
    fs::set_permissions(&second_recovery, fs::Permissions::from_mode(0o600))
        .expect("mismatch mode");
    let error = reject_native_materialization(second).expect_err("mismatch must fail");
    assert_eq!(error.kind, NativeMaterializationFailureKind::NoClobber);
}

#[test]
fn mixed_claude_source_record_is_emitted_as_one_ordered_native_message() {
    let harness = Harness::new();
    let first = source_record_event(
        event(
            0,
            PortableEventBody::Message {
                role: PortableRole::Assistant,
                content: text("before tool"),
            },
        ),
        7,
        "assistant",
        "mixed-record",
        0,
    );
    let call = source_record_event(
        event(
            1,
            PortableEventBody::ToolCall {
                call_id: "toolu-mixed".into(),
                name: "Read".into(),
                canonical_name: "read".into(),
                state: PortableToolCallState::Pending,
                input: json!({"file_path": "/tmp/example"}),
            },
        ),
        7,
        "assistant",
        "mixed-record",
        1,
    );
    let last = source_record_event(
        event(
            2,
            PortableEventBody::Message {
                role: PortableRole::Assistant,
                content: text("after tool"),
            },
        ),
        7,
        "assistant",
        "mixed-record",
        2,
    );
    let conversation = portable(vec![first, call, last]);
    let candidate = prepare_native_materialization(harness.request(
        &conversation,
        NativeRuntimeTarget::ClaudeCode {
            model: "claude-fixture".into(),
        },
        Uuid::new_v4(),
        "2.1.226",
        None,
    ))
    .expect("grouped Claude materialization");
    let records = fs::read_to_string(&candidate.target_path).expect("native transcript");
    let assistant = records
        .lines()
        .filter(|line| line.contains("\"type\":\"assistant\""))
        .collect::<Vec<_>>();
    assert_eq!(assistant.len(), 1);
    let before = assistant[0].find("before tool").expect("before text");
    let tool = assistant[0].find("toolu-mixed").expect("tool block");
    let after = assistant[0].find("after tool").expect("after text");
    assert!(before < tool && tool < after);
}

#[test]
fn codex_source_record_blocks_are_emitted_as_one_ordered_native_message() {
    let harness = Harness::new();
    let first = source_record_event(
        event(
            0,
            PortableEventBody::Message {
                role: PortableRole::User,
                content: text("before image"),
            },
        ),
        8,
        "message",
        "codex-mixed-record",
        0,
    );
    let image = source_record_event(
        event(
            1,
            PortableEventBody::Message {
                role: PortableRole::User,
                content: vec![PortableContentBlock::Image { uri: IMAGE.into() }],
            },
        ),
        8,
        "message",
        "codex-mixed-record",
        1,
    );
    let conversation = portable(vec![first, image]);
    let candidate = prepare_native_materialization(harness.request(
        &conversation,
        NativeRuntimeTarget::Codex {
            model: "gpt-fixture".into(),
            model_provider: "openai".into(),
        },
        Uuid::new_v4(),
        "0.144.5",
        None,
    ))
    .expect("grouped Codex materialization");
    let records = fs::read_to_string(&candidate.target_path).expect("native transcript");
    let messages = records
        .lines()
        .filter(|line| {
            line.contains("\"type\":\"response_item\"") && line.contains("\"type\":\"message\"")
        })
        .collect::<Vec<_>>();
    assert_eq!(messages.len(), 1);
    let text_index = messages[0].find("before image").expect("text block");
    let image_index = messages[0].find(IMAGE).expect("image block");
    assert!(text_index < image_index);
}

#[test]
fn account_model_provider_workspace_and_profile_are_mandatory() {
    let harness = Harness::new();
    let conversation = codex_conversation();

    let mut no_account = harness.request(
        &conversation,
        NativeRuntimeTarget::Codex {
            model: "gpt-fixture".into(),
            model_provider: "openai".into(),
        },
        Uuid::new_v4(),
        "0.144.5",
        None,
    );
    no_account.account_id = "";
    assert_eq!(
        prepare_native_materialization(no_account)
            .expect_err("missing account")
            .kind,
        NativeMaterializationFailureKind::InvalidRequest
    );

    let no_model = harness.request(
        &conversation,
        NativeRuntimeTarget::Codex {
            model: String::new(),
            model_provider: "openai".into(),
        },
        Uuid::new_v4(),
        "0.144.5",
        None,
    );
    assert_eq!(
        prepare_native_materialization(no_model)
            .expect_err("missing model")
            .kind,
        NativeMaterializationFailureKind::InvalidRequest
    );

    let no_provider = harness.request(
        &conversation,
        NativeRuntimeTarget::Codex {
            model: "gpt-fixture".into(),
            model_provider: String::new(),
        },
        Uuid::new_v4(),
        "0.144.5",
        None,
    );
    assert_eq!(
        prepare_native_materialization(no_provider)
            .expect_err("missing model provider")
            .kind,
        NativeMaterializationFailureKind::InvalidRequest
    );

    let missing_workspace = harness._temporary.path().join("not-authorized");
    let mut no_workspace = harness.request(
        &conversation,
        NativeRuntimeTarget::Codex {
            model: "gpt-fixture".into(),
            model_provider: "openai".into(),
        },
        Uuid::new_v4(),
        "0.144.5",
        None,
    );
    no_workspace.target_workspace_root = &missing_workspace;
    assert_eq!(
        prepare_native_materialization(no_workspace)
            .expect_err("missing workspace authorization")
            .kind,
        NativeMaterializationFailureKind::FilesystemBoundary
    );

    let missing_profile = harness._temporary.path().join("not-an-account-profile");
    let mut no_profile = harness.request(
        &conversation,
        NativeRuntimeTarget::Codex {
            model: "gpt-fixture".into(),
            model_provider: "openai".into(),
        },
        Uuid::new_v4(),
        "0.144.5",
        None,
    );
    no_profile.target_profile_root = &missing_profile;
    assert_eq!(
        prepare_native_materialization(no_profile)
            .expect_err("missing account profile authorization")
            .kind,
        NativeMaterializationFailureKind::FilesystemBoundary
    );
}

#[test]
fn ownership_guard_and_candidate_scoped_staging_reconciliation_are_enforced() {
    let harness = Harness::new();
    let ownership_error =
        crate::filesystem::reject_directory_for_foreign_euid_test(&harness.profile)
            .expect_err("foreign euid must fail");
    assert_eq!(
        ownership_error.kind,
        NativeMaterializationFailureKind::FilesystemBoundary
    );

    let target_name = "candidate.jsonl";
    let stale = harness
        .profile
        .join(format!(".{target_name}.org2-materializing-deadbeef.tmp"));
    let unrelated = harness
        .profile
        .join(".other.org2-materializing-deadbeef.tmp");
    for path in [&stale, &unrelated] {
        fs::write(path, b"staging").expect("staging file");
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).expect("staging mode");
    }
    crate::filesystem::cleanup_candidate_temporaries_for_test(&harness.profile, target_name)
        .expect("candidate cleanup");
    assert!(!stale.exists());
    assert!(unrelated.exists());
}

#[test]
fn unsupported_native_semantics_fail_closed_instead_of_flattening_prompt() {
    let harness = Harness::new();
    let mut claude = claude_conversation();
    claude.events = vec![event(
        0,
        PortableEventBody::Message {
            role: PortableRole::System,
            content: text("privileged"),
        },
    )];
    let claude_error = prepare_native_materialization(harness.request(
        &claude,
        NativeRuntimeTarget::ClaudeCode {
            model: "claude-fixture".into(),
        },
        Uuid::new_v4(),
        "2.1.226",
        None,
    ))
    .expect_err("Claude privileged message must fail");
    assert_eq!(
        claude_error.kind,
        NativeMaterializationFailureKind::UnsupportedPortableSemantics
    );

    let mut codex = codex_conversation();
    let result = codex
        .events
        .iter_mut()
        .find(|event| matches!(event.body, PortableEventBody::ToolResult { .. }))
        .expect("tool result");
    if let PortableEventBody::ToolResult { is_error, .. } = &mut result.body {
        *is_error = true;
    }
    let codex_error = prepare_native_materialization(harness.request(
        &codex,
        NativeRuntimeTarget::Codex {
            model: "gpt-fixture".into(),
            model_provider: "openai".into(),
        },
        Uuid::new_v4(),
        "0.144.5",
        None,
    ))
    .expect_err("Codex error result must fail");
    assert_eq!(
        codex_error.kind,
        NativeMaterializationFailureKind::UnsupportedPortableSemantics
    );
}

#[test]
fn compaction_boundaries_fail_closed_when_the_target_shape_is_not_verified() {
    let harness = Harness::new();

    let claude_summary_without_boundary = portable(vec![event(
        0,
        PortableEventBody::CompactionSummary {
            content: text("summary without boundary"),
        },
    )]);
    let error = prepare_native_materialization(harness.request(
        &claude_summary_without_boundary,
        NativeRuntimeTarget::ClaudeCode {
            model: "claude-fixture".into(),
        },
        Uuid::new_v4(),
        "2.1.226",
        None,
    ))
    .expect_err("Claude summary without boundary must fail");
    assert_eq!(
        error.kind,
        NativeMaterializationFailureKind::UnsupportedPortableSemantics
    );

    let codex_boundary = portable(vec![
        event(
            0,
            PortableEventBody::CompactionBoundary {
                content: Vec::new(),
            },
        ),
        event(
            1,
            PortableEventBody::CompactionSummary {
                content: text("summary"),
            },
        ),
    ]);
    let error = prepare_native_materialization(harness.request(
        &codex_boundary,
        NativeRuntimeTarget::Codex {
            model: "gpt-fixture".into(),
            model_provider: "openai".into(),
        },
        Uuid::new_v4(),
        "0.144.5",
        None,
    ))
    .expect_err("Codex boundary must fail");
    assert_eq!(
        error.kind,
        NativeMaterializationFailureKind::UnsupportedPortableSemantics
    );

    let claude_image_boundary = portable(vec![
        event(
            0,
            PortableEventBody::CompactionBoundary {
                content: vec![PortableContentBlock::Image { uri: IMAGE.into() }],
            },
        ),
        event(
            1,
            PortableEventBody::CompactionSummary {
                content: text("summary"),
            },
        ),
    ]);
    let error = prepare_native_materialization(harness.request(
        &claude_image_boundary,
        NativeRuntimeTarget::ClaudeCode {
            model: "claude-fixture".into(),
        },
        Uuid::new_v4(),
        "2.1.226",
        None,
    ))
    .expect_err("Claude image boundary must fail");
    assert_eq!(
        error.kind,
        NativeMaterializationFailureKind::UnsupportedPortableSemantics
    );
}

#[cfg(unix)]
#[test]
fn symlinked_target_component_and_writable_profile_are_rejected() {
    use std::os::unix::fs::symlink;

    let harness = Harness::new();
    let conversation = claude_conversation();
    let outside = harness._temporary.path().join("outside-native-transcripts");
    fs::create_dir(&outside).expect("outside");
    symlink(&outside, harness.profile.join("projects")).expect("projects symlink");
    let error = prepare_native_materialization(harness.request(
        &conversation,
        NativeRuntimeTarget::ClaudeCode {
            model: "claude-fixture".into(),
        },
        Uuid::new_v4(),
        "2.1.226",
        None,
    ))
    .expect_err("symlink component must fail");
    assert_eq!(
        error.kind,
        NativeMaterializationFailureKind::FilesystemBoundary
    );
    assert!(fs::read_dir(&outside)
        .expect("outside empty")
        .next()
        .is_none());

    fs::remove_file(harness.profile.join("projects")).expect("remove symlink");
    fs::set_permissions(&harness.profile, fs::Permissions::from_mode(0o777))
        .expect("writable profile");
    let writable_error = prepare_native_materialization(harness.request(
        &conversation,
        NativeRuntimeTarget::ClaudeCode {
            model: "claude-fixture".into(),
        },
        Uuid::new_v4(),
        "2.1.226",
        None,
    ))
    .expect_err("writable profile must fail");
    assert_eq!(
        writable_error.kind,
        NativeMaterializationFailureKind::FilesystemBoundary
    );
}

fn append(path: &Path, bytes: &[u8]) {
    let mut file = OpenOptions::new()
        .append(true)
        .open(path)
        .expect("open append");
    file.write_all(bytes).expect("append bytes");
    file.sync_all().expect("sync append");
}

fn codex_conversation() -> PortableConversation {
    portable(vec![
        event(
            0,
            PortableEventBody::Message {
                role: PortableRole::System,
                content: text("system context"),
            },
        ),
        event(
            1,
            PortableEventBody::Message {
                role: PortableRole::Developer,
                content: text("developer context"),
            },
        ),
        source_record_event(
            event(
                2,
                PortableEventBody::Message {
                    role: PortableRole::User,
                    content: text("hello"),
                },
            ),
            2,
            "message",
            "codex-user-record",
            0,
        ),
        source_record_event(
            event(
                3,
                PortableEventBody::Message {
                    role: PortableRole::User,
                    content: vec![PortableContentBlock::Image { uri: IMAGE.into() }],
                },
            ),
            2,
            "message",
            "codex-user-record",
            1,
        ),
        event(
            4,
            PortableEventBody::ToolCall {
                call_id: "call-1".into(),
                name: "shell".into(),
                canonical_name: "shell".into(),
                state: PortableToolCallState::Settled,
                input: json!({"command": "pwd"}),
            },
        ),
        event(
            5,
            PortableEventBody::ToolResult {
                call_id: "call-1".into(),
                content: text("/workspace"),
                is_error: false,
            },
        ),
        event(
            6,
            PortableEventBody::CompactionSummary {
                content: text("summary"),
            },
        ),
        event(
            7,
            PortableEventBody::Message {
                role: PortableRole::Assistant,
                content: text("ready"),
            },
        ),
    ])
}

fn claude_conversation() -> PortableConversation {
    portable(vec![
        source_record_event(
            event(
                0,
                PortableEventBody::Message {
                    role: PortableRole::User,
                    content: text("hello"),
                },
            ),
            0,
            "user",
            "claude-user-record",
            0,
        ),
        source_record_event(
            event(
                1,
                PortableEventBody::Message {
                    role: PortableRole::User,
                    content: vec![PortableContentBlock::Image { uri: IMAGE.into() }],
                },
            ),
            0,
            "user",
            "claude-user-record",
            1,
        ),
        event(
            2,
            PortableEventBody::Message {
                role: PortableRole::Assistant,
                content: text("checking"),
            },
        ),
        event(
            3,
            PortableEventBody::ToolCall {
                call_id: "toolu-1".into(),
                name: "Read".into(),
                canonical_name: "read".into(),
                state: PortableToolCallState::Settled,
                input: json!({"file_path": "/missing"}),
            },
        ),
        event(
            4,
            PortableEventBody::ToolResult {
                call_id: "toolu-1".into(),
                content: text("missing"),
                is_error: true,
            },
        ),
        event(
            5,
            PortableEventBody::CompactionBoundary {
                content: Vec::new(),
            },
        ),
        event(
            6,
            PortableEventBody::CompactionSummary {
                content: text("summary"),
            },
        ),
        event(
            7,
            PortableEventBody::Message {
                role: PortableRole::User,
                content: text("continue"),
            },
        ),
    ])
}

fn portable(events: Vec<PortableEvent>) -> PortableConversation {
    PortableConversation {
        schema: PORTABLE_CONVERSATION_SCHEMA.into(),
        schema_version: PORTABLE_CONVERSATION_VERSION,
        source: PortableConversationSource {
            source_kind: "fixture".into(),
            source_session_id: "source-session-never-reused".into(),
            source_snapshot: PortableSourceSnapshot {
                algorithm: PortableSourceSnapshotAlgorithm::Sha256,
                digest: "0".repeat(64),
                observed_bytes: 1,
            },
            parser_version: 1,
            source_runtime_version: Some("fixture-runtime".into()),
            title: None,
            model: None,
            source_workspace_hint: Some("/source/never/trusted".into()),
            started_at: None,
            updated_at: None,
        },
        events,
        loss_manifest: PortableLossManifest::default(),
    }
}

fn event(source_index: u64, body: PortableEventBody) -> PortableEvent {
    PortableEvent {
        event_id: format!("event-{source_index}"),
        source_index,
        source_record_index: source_index,
        source_record_type: Some("fixture-record".into()),
        source_record_id: Some(format!("record-{source_index}")),
        source_block_index: Some(0),
        source_thread_id: None,
        timestamp: Some(CREATED_AT.into()),
        body,
    }
}

fn source_record_event(
    mut event: PortableEvent,
    source_record_index: u64,
    source_record_type: &str,
    source_record_id: &str,
    source_block_index: u64,
) -> PortableEvent {
    event.source_record_index = source_record_index;
    event.source_record_type = Some(source_record_type.into());
    event.source_record_id = Some(source_record_id.into());
    event.source_block_index = Some(source_block_index);
    event
}

fn text(value: &str) -> Vec<PortableContentBlock> {
    vec![PortableContentBlock::Text { text: value.into() }]
}

fn codex_01444_fixture_semantics() -> Vec<NativeSemanticGroup> {
    vec![
        group(vec![
            NativeSemanticEvent::Message {
                role: PortableRole::User,
                content: text("Remember BETA-2048."),
            },
            NativeSemanticEvent::Message {
                role: PortableRole::User,
                content: vec![PortableContentBlock::Image { uri: IMAGE.into() }],
            },
        ]),
        group(vec![NativeSemanticEvent::ToolCall {
            call_id: "call_fixture_1".into(),
            name: "shell".into(),
            state: PortableToolCallState::Settled,
            input: json!({"command": "pwd"}),
        }]),
        group(vec![NativeSemanticEvent::ToolResult {
            call_id: "call_fixture_1".into(),
            content: text("/work"),
            is_error: false,
        }]),
        group(vec![NativeSemanticEvent::CompactionSummary {
            content: text("Remember BETA-2048 and the shell result."),
        }]),
        group(vec![NativeSemanticEvent::Message {
            role: PortableRole::Assistant,
            content: text("Ready."),
        }]),
    ]
}

fn codex_01445_fixture_semantics() -> Vec<NativeSemanticGroup> {
    vec![
        group(vec![NativeSemanticEvent::Message {
            role: PortableRole::System,
            content: text("System fixture."),
        }]),
        group(vec![NativeSemanticEvent::Message {
            role: PortableRole::Developer,
            content: text("Developer fixture."),
        }]),
        group(vec![NativeSemanticEvent::Message {
            role: PortableRole::User,
            content: text("Continue."),
        }]),
        group(vec![NativeSemanticEvent::Message {
            role: PortableRole::Assistant,
            content: text("Continuing."),
        }]),
    ]
}

fn claude_21209_fixture_semantics() -> Vec<NativeSemanticGroup> {
    vec![
        group(vec![
            NativeSemanticEvent::Message {
                role: PortableRole::User,
                content: text("Remember ALPHA-1042."),
            },
            NativeSemanticEvent::Message {
                role: PortableRole::User,
                content: vec![PortableContentBlock::Image { uri: IMAGE.into() }],
            },
        ]),
        group(vec![
            NativeSemanticEvent::Message {
                role: PortableRole::Assistant,
                content: text("I will remember it."),
            },
            NativeSemanticEvent::ToolCall {
                call_id: "toolu_fixture_1".into(),
                name: "Read".into(),
                state: PortableToolCallState::Settled,
                input: json!({"file_path": "/work/README.md"}),
            },
        ]),
        group(vec![NativeSemanticEvent::ToolResult {
            call_id: "toolu_fixture_1".into(),
            content: text("Synthetic output."),
            is_error: false,
        }]),
        group(vec![NativeSemanticEvent::CompactionBoundary {
            content: text("Synthetic boundary."),
        }]),
        group(vec![NativeSemanticEvent::CompactionSummary {
            content: text("Remember ALPHA-1042 and the Read result."),
        }]),
    ]
}

fn claude_21226_fixture_semantics() -> Vec<NativeSemanticGroup> {
    vec![
        group(vec![NativeSemanticEvent::Message {
            role: PortableRole::User,
            content: text("Run the failing fixture tool."),
        }]),
        group(vec![NativeSemanticEvent::ToolCall {
            call_id: "toolu_fixture_2".into(),
            name: "Read".into(),
            state: PortableToolCallState::Settled,
            input: json!({"file_path": "/missing"}),
        }]),
        group(vec![NativeSemanticEvent::ToolResult {
            call_id: "toolu_fixture_2".into(),
            content: text("missing"),
            is_error: true,
        }]),
    ]
}

fn group(events: Vec<NativeSemanticEvent>) -> NativeSemanticGroup {
    NativeSemanticGroup { events }
}
