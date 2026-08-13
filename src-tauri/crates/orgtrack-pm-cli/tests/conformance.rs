//! Minimal conformance gate (design §5.7): real CLI process output must
//! validate against the frozen JSON Schemas, and the stable error-code
//! fixtures must match the implementation's wire strings.

use std::path::PathBuf;
use std::process::Command;

use test_helpers::test_env;

fn docs_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../docs/orgtrack-pm-protocol")
}

fn load_json(path: &PathBuf) -> serde_json::Value {
    let raw = std::fs::read_to_string(path).unwrap_or_else(|err| panic!("{path:?}: {err}"));
    serde_json::from_str(&raw).unwrap_or_else(|err| panic!("{path:?}: {err}"))
}

fn schema_validator(name: &str) -> jsonschema::Validator {
    let dir = docs_dir().join("schemas");
    let schema = load_json(&dir.join(name));
    let common = load_json(&dir.join("common.schema.json"));
    let retriever = InDirRetriever { common };
    jsonschema::options()
        .with_retriever(retriever)
        .build(&schema)
        .unwrap_or_else(|err| panic!("compile {name}: {err}"))
}

struct InDirRetriever {
    common: serde_json::Value,
}

impl jsonschema::Retrieve for InDirRetriever {
    fn retrieve(
        &self,
        uri: &jsonschema::Uri<&str>,
    ) -> Result<serde_json::Value, Box<dyn std::error::Error + Send + Sync>> {
        if uri.as_str().contains("common.schema.json") {
            return Ok(self.common.clone());
        }
        Err(format!("unexpected schema ref: {uri}").into())
    }
}

fn run_cli(args: &[&str]) -> (i32, serde_json::Value) {
    let home = std::env::var_os("ORGII_HOME").expect("sandbox sets ORGII_HOME");
    let output = Command::new(env!("CARGO_BIN_EXE_org2-pm"))
        .args(args)
        .env("ORGII_HOME", &home)
        .current_dir(home)
        .output()
        .expect("spawn org2-pm");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let envelope: serde_json::Value =
        serde_json::from_str(stdout.trim()).unwrap_or_else(|err| panic!("{stdout}: {err}"));
    (output.status.code().unwrap_or(-1), envelope)
}

fn assert_valid(validator: &jsonschema::Validator, value: &serde_json::Value, label: &str) {
    let errors: Vec<String> = validator
        .iter_errors(value)
        .map(|err| format!("{}: {}", err.instance_path, err))
        .collect();
    assert!(
        errors.is_empty(),
        "{label} failed schema validation:\n{}",
        errors.join("\n")
    );
}

#[test]
fn real_envelopes_validate_against_frozen_schemas() {
    let _sandbox = test_env::sandbox();
    let envelope_schema = schema_validator("envelope.schema.json");
    let context_schema = schema_validator("execution-context.schema.json");

    let (exit, bare_context) = run_cli(&["context"]);
    assert_eq!(exit, 0, "{bare_context}");
    assert_valid(&envelope_schema, &bare_context, "bare context envelope");
    assert_valid(
        &context_schema,
        &bare_context["data"],
        "bare context data (null scope/actor)",
    );

    let (exit, project_context) = run_cli(&[
        "context",
        "--mode",
        "project",
        "--scope",
        "demo",
        "--actor",
        "human:conformance",
    ]);
    assert_eq!(exit, 0, "{project_context}");
    assert_valid(
        &envelope_schema,
        &project_context,
        "project context envelope",
    );
    assert_valid(
        &context_schema,
        &project_context["data"],
        "project context data",
    );

    let (exit, gated) = run_cli(&["work", "create", "--title", "x", "--scope", "demo"]);
    assert_eq!(exit, 5, "{gated}");
    assert_valid(&envelope_schema, &gated, "error envelope");
}

#[test]
fn error_fixtures_match_the_implementation_strings() {
    let fixtures = docs_dir().join("fixtures/errors");
    let mut checked = 0;
    for entry in std::fs::read_dir(&fixtures).expect("fixtures dir") {
        let path = entry.expect("entry").path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let fixture = load_json(&path);
        let code = fixture["error"]["code"].as_str().expect("code");
        let retryable = fixture["error"]["retryable"].as_bool().expect("retryable");
        let expected = expected_retryable(code);
        assert_eq!(
            retryable, expected,
            "{path:?}: fixture retryable disagrees with ErrorCode::retryable"
        );
        checked += 1;
    }
    assert!(
        checked >= 18,
        "expected the 18 frozen error fixtures, found {checked}"
    );
}

fn expected_retryable(code: &str) -> bool {
    matches!(
        code,
        "REVISION_CONFLICT" | "NOT_READY" | "PROVIDER_UNAVAILABLE" | "STORE_UNAVAILABLE"
    )
}
