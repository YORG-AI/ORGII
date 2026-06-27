//! Schema generation, parameter parsing, and tool-name sanitization.
//!
//! Two paths exist:
//! - **Type-safe (recommended)**: `params_schema::<T>()` + `parse_params::<T>(value)`
//!   for tools that derive `JsonSchema` + `Deserialize` on a typed params struct.
//! - **Untyped helpers**: `required_string`, `optional_string`, `optional_int`,
//!   `optional_bool` for legacy tools that still hand-pull individual JSON keys.
//!   New tools should NOT use these — migrate via the typed path.

use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde_json::Value;

use super::error::ToolError;

// ============================================
// Tool-name sanitization
// ============================================

/// Sanitize a tool name to match the Anthropic/OpenAI function name regex `^[a-zA-Z0-9_-]+$`.
/// Replaces spaces and other invalid characters with underscores.
pub fn sanitize_tool_name(name: &str) -> String {
    name.chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

/// Guarantee the value is a JSON Schema with `"type": "object"`.
/// If it already has that field, return as-is. Otherwise wrap it.
pub(crate) fn ensure_object_schema(schema: Value) -> Value {
    if let Some(obj) = schema.as_object() {
        if obj.get("type").and_then(|v| v.as_str()) == Some("object") {
            return schema;
        }
        if obj.contains_key("properties") {
            let mut patched = obj.clone();
            patched.insert("type".into(), Value::String("object".into()));
            return Value::Object(patched);
        }
    }
    serde_json::json!({
        "type": "object",
        "properties": {}
    })
}

// ============================================
// Type-Safe Parameter Helpers (Recommended)
// ============================================

/// Generate a JSON Schema from a Rust type.
///
/// Use this in `Tool::parameters()` to get automatic schema generation:
/// ```ignore
/// fn parameters(&self) -> Value {
///     params_schema::<MyParams>()
/// }
/// ```
pub fn params_schema<T: JsonSchema>() -> Value {
    // Use Draft 7 (which OpenAI function-calling expects) with no meta_schema
    // URL.  OpenAPI 3.0 mode adds `$schema`, `nullable`, and `title` fields
    // that some proxies try to resolve, inflating token counts dramatically.
    //
    // `inline_subschemas = true` expands every nested struct/enum in place
    // instead of hoisting it into a top-level `definitions` map referenced by
    // `$ref`. This is the provider-agnostic contract: a schema with NO `$ref`
    // is accepted by every function-calling endpoint, whereas the `$ref`
    // dialect is balkanised — schemars' draft-07 default emits
    // `#/definitions/X`, moonshot/kimi demand `#/$defs/X` (HTTP 400 otherwise),
    // and Gemini rejects refs entirely. Inlining sidesteps all of it and
    // satisfies `assert_llm_compatible_schema`, which forbids `$ref` outright.
    // Tool params are shallow DTOs (no recursive/self-referential types), so
    // inlining cannot blow up.
    let schema = schemars::generate::SchemaSettings::draft07()
        .with(|settings| {
            settings.meta_schema = None;
            settings.inline_subschemas = true;
        })
        .into_generator()
        .into_root_schema_for::<T>();
    // schemars produces a `Schema` whose serde representation is a plain
    // JSON Object — `to_value` is structurally infallible. The previous
    // `unwrap_or_else({"type": "object", "properties": {}})` would have
    // silently registered the tool with an empty schema if a custom
    // serializer ever panicked, which means the LLM would believe the
    // tool accepts any arguments — every tool call would then likely fail
    // at the typed `parse_params` step with a confusing
    // `parameter validation failed` error and no schema-level signal of
    // why. Same anti-pattern as the MCP tool input-schema sweep already
    // landed; pin the infallible contract via `expect`.
    let mut value = serde_json::to_value(schema)
        .expect("schemars Schema serializes to JSON Object; infallible for any JsonSchema type");
    collapse_nullable_type_arrays(&mut value);
    value
}

/// Collapse nullable type arrays (`"type": ["string", "null"]`) emitted by
/// schemars for `Option<T>` fields down to the single non-null scalar
/// (`"type": "string"`), and strip the matching `null` entry from a sibling
/// `enum` array.
///
/// This is the second provider-dialect footgun after `$ref` (see
/// `params_schema`): draft-07 *permits* a `"type"` array, but several
/// function-calling validators reject it outright — baidu/ernie returns
/// HTTP 400 `not a valid jsonSchema` for any tool whose params contain a
/// nullable field (e.g. `edit_file`'s `Option<String>` content/old_string/
/// new_string). The plain scalar form is the least-common-denominator that
/// every provider accepts.
///
/// `Option<Enum>` fields (e.g. `use_code_map`'s `kind: Option<CodeMapNodeKind>`)
/// are a sharper version of the same trap: schemars emits both
/// `"type": ["string", "null"]` AND `"enum": [..variants, null]`. Collapsing
/// only the `type` leaves a `null` in the `enum` array, which moonshot/MiniMax
/// reject with HTTP 400 `enum value (<nil>) does not match any type in
/// [string]` (GitHub #23). So whenever we collapse the type to a non-null
/// scalar we also drop the `null` member from any sibling `enum`.
///
/// Optionality is already enforced at parse time by `Option<T>` + serde
/// `default`, so dropping `"null"` from the wire schema changes nothing about
/// how arguments deserialize — the model simply omits the field when it has no
/// value.
fn collapse_nullable_type_arrays(value: &mut Value) {
    match value {
        Value::Object(map) => {
            let mut collapsed_to_non_null = false;
            if let Some(Value::Array(parts)) = map.get("type") {
                let non_null: Vec<Value> = parts
                    .iter()
                    .filter(|p| p.as_str() != Some("null"))
                    .cloned()
                    .collect();
                // Only collapse the common `[scalar, "null"]` shape: exactly
                // one non-null type remains. Genuine multi-type unions (rare
                // in tool params) are left intact rather than guessed at.
                if non_null.len() == 1 && parts.len() > non_null.len() {
                    map.insert("type".into(), non_null.into_iter().next().unwrap());
                    collapsed_to_non_null = true;
                }
            }
            // After collapsing a nullable type to a scalar, a sibling `enum`
            // for an `Option<Enum>` field still carries a trailing `null` that
            // no longer matches the scalar `type` — strip it.
            if collapsed_to_non_null {
                if let Some(Value::Array(values)) = map.get_mut("enum") {
                    values.retain(|v| !v.is_null());
                }
            }
            for child in map.values_mut() {
                collapse_nullable_type_arrays(child);
            }
        }
        Value::Array(items) => {
            for child in items.iter_mut() {
                collapse_nullable_type_arrays(child);
            }
        }
        _ => {}
    }
}

/// Parse and validate tool parameters from JSON into a typed struct.
///
/// Use this in `Tool::execute()` to get automatic deserialization + validation:
/// ```ignore
/// async fn execute(&self, params: Value) -> Result<String, ToolError> {
///     let params: MyParams = parse_params(params)?;
///     // params is now fully typed!
/// }
/// ```
pub fn parse_params<T: DeserializeOwned>(params: Value) -> Result<T, ToolError> {
    // No `__`-prefix stripping needed: per-call framework metadata is
    // threaded via `CallContext` since the call_context refactor — the
    // params `Value` carries only LLM-supplied arguments. If a `__`-key
    // ever shows up here it's a real wiring bug, not metadata leakage,
    // and `deny_unknown_fields` will surface it.
    serde_json::from_value(params)
        .map_err(|err| ToolError::InvalidParams(format!("parameter validation failed: {}", err)))
}

/// Like [`parse_params`], but on failure appends a summary of the expected
/// schema (property names/types and the required list) so the model can
/// self-correct in one round trip instead of guessing. Use for tools whose
/// schema may not have reached the model intact (provider-side flattening).
pub fn parse_params_described<T: DeserializeOwned + JsonSchema>(
    params: Value,
) -> Result<T, ToolError> {
    serde_json::from_value(params).map_err(|err| {
        ToolError::InvalidParams(format!(
            "parameter validation failed: {}. Expected parameters — {}",
            err,
            schema_summary(&params_schema::<T>())
        ))
    })
}

/// One-line human/model-readable summary of a parameters schema:
/// `field: type (required), other: type`.
fn schema_summary(schema: &Value) -> String {
    let Some(obj) = schema.as_object() else {
        return "(no schema)".to_string();
    };
    let required: Vec<&str> = obj
        .get("required")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str()).collect())
        .unwrap_or_default();
    let Some(props) = obj.get("properties").and_then(|v| v.as_object()) else {
        return "(no parameters)".to_string();
    };
    if props.is_empty() {
        return "(no parameters)".to_string();
    }
    props
        .iter()
        .map(|(name, prop)| {
            let ty = prop
                .get("type")
                .map(|t| match t {
                    Value::String(s) => s.clone(),
                    Value::Array(parts) => parts
                        .iter()
                        .filter_map(|p| p.as_str())
                        .collect::<Vec<_>>()
                        .join("|"),
                    _ => "any".to_string(),
                })
                .unwrap_or_else(|| "any".to_string());
            if required.contains(&name.as_str()) {
                format!("{}: {} (required)", name, ty)
            } else {
                format!("{}: {}", name, ty)
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

// ============================================
// LLM schema compatibility contract
// ============================================

/// Validate that a tool parameters schema is expressible in the
/// least-common-denominator function-calling dialect that every LLM
/// provider (and every proxy in between) understands.
///
/// Schemas that violate this contract get silently flattened to
/// `"properties": {}` somewhere between the registry and the model —
/// the model then cannot see any fields and every call fails at
/// `parse_params` with a confusing "missing field" error. The classic
/// trigger is a `#[serde(tag = "action")]` enum, which schemars renders
/// as a top-level `oneOf` with no top-level `properties`.
///
/// Rules:
/// - top level must be `type: "object"` with a `properties` key
/// - no `oneOf` / `anyOf` / `allOf` / `$ref` anywhere in the schema
/// - every name in `required` must exist in `properties`
/// - no `enum` array may contain a `null` member
pub fn assert_llm_compatible_schema(schema: &Value) -> Result<(), String> {
    let obj = schema
        .as_object()
        .ok_or_else(|| "schema must be a JSON object".to_string())?;

    if obj.get("type").and_then(|v| v.as_str()) != Some("object") {
        return Err("top-level `type` must be \"object\"".to_string());
    }
    let props = obj
        .get("properties")
        .ok_or_else(|| "top-level `properties` is missing".to_string())?
        .as_object()
        .ok_or_else(|| "top-level `properties` must be an object".to_string())?;

    if let Some(required) = obj.get("required").and_then(|v| v.as_array()) {
        for name in required.iter().filter_map(|v| v.as_str()) {
            if !props.contains_key(name) {
                return Err(format!(
                    "`required` lists \"{}\" which is not in `properties`",
                    name
                ));
            }
        }
    }

    scan_for_forbidden_keywords(schema, "$")?;
    scan_for_null_enum_members(schema, "$")
}

fn scan_for_forbidden_keywords(value: &Value, path: &str) -> Result<(), String> {
    const FORBIDDEN: [&str; 4] = ["oneOf", "anyOf", "allOf", "$ref"];
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                if FORBIDDEN.contains(&key.as_str()) {
                    return Err(format!(
                        "`{}` at {} is not portable across LLM providers; flatten the schema \
                         (plain object with scalar properties) instead",
                        key, path
                    ));
                }
                scan_for_forbidden_keywords(child, &format!("{}.{}", path, key))?;
            }
            Ok(())
        }
        Value::Array(items) => {
            for (idx, child) in items.iter().enumerate() {
                scan_for_forbidden_keywords(child, &format!("{}[{}]", path, idx))?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// Reject any `enum` array that carries a `null` member.
///
/// schemars renders an `Option<Enum>` field as both `"type": ["string",
/// "null"]` AND `"enum": [..variants, null]`. After `collapse_nullable_type_arrays`
/// reduces the `type` to a plain scalar, a stray `null` left in the sibling
/// `enum` no longer matches the declared scalar type — moonshot/MiniMax/kimi
/// reject it with HTTP 400 `enum value (<nil>) does not match any type in
/// [string]` (GitHub #23). `params_schema` strips it at generation time; this
/// is the contract-level backstop that catches any future schema (hand-rolled,
/// or produced after a schemars upgrade that changes behavior) which slips a
/// `null` back into an enum.
fn scan_for_null_enum_members(value: &Value, path: &str) -> Result<(), String> {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                if key == "enum" {
                    if let Value::Array(members) = child {
                        if members.iter().any(|m| m.is_null()) {
                            return Err(format!(
                                "`enum` at {}.enum contains a `null` member, which moonshot/\
                                 MiniMax/kimi reject (HTTP 400 `enum value (<nil>) does not match \
                                 any type`); drop the null (an optional field omits the value \
                                 rather than sending null)",
                                path
                            ));
                        }
                    }
                }
                scan_for_null_enum_members(child, &format!("{}.{}", path, key))?;
            }
            Ok(())
        }
        Value::Array(items) => {
            for (idx, child) in items.iter().enumerate() {
                scan_for_null_enum_members(child, &format!("{}[{}]", path, idx))?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

// ============================================
// Untyped helpers (legacy migration path)
// ============================================
//
// Tools that haven't migrated to `parse_params<T>()` yet pull individual
// keys via these helpers. Two of the original five (`required_int`,
// `validate_required_keys`) had no production callers and were deleted.
// Remaining helpers stay until the last call site is migrated.

/// Extract a required string parameter from a JSON object.
pub fn required_string(params: &Value, key: &str) -> Result<String, ToolError> {
    params
        .get(key)
        .and_then(|val| val.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| ToolError::InvalidParams(format!("missing required parameter: {}", key)))
}

/// Extract an optional string parameter from a JSON object.
pub fn optional_string(params: &Value, key: &str) -> Option<String> {
    params
        .get(key)
        .and_then(|val| val.as_str())
        .map(|s| s.to_string())
}

/// Extract an optional integer parameter from a JSON object.
pub fn optional_int(params: &Value, key: &str) -> Option<i64> {
    params.get(key).and_then(|val| val.as_i64())
}

/// Extract an optional boolean parameter from a JSON object.
pub fn optional_bool(params: &Value, key: &str) -> Option<bool> {
    params.get(key).and_then(|val| val.as_bool())
}

#[cfg(test)]
mod tests {
    use super::*;
    use schemars::JsonSchema;
    use serde::Deserialize;

    /// Nested DTO that, under schemars' draft-07 default, would be hoisted
    /// into a top-level `definitions` map and referenced via
    /// `$ref: "#/definitions/Nested"`. Mirrors `StepProposal` in
    /// `suggest_next_steps`. With `inline_subschemas = true` it must be
    /// expanded in place with no `$ref` anywhere.
    #[allow(dead_code)]
    #[derive(Debug, Deserialize, JsonSchema)]
    struct Nested {
        title: String,
        command: String,
    }

    #[allow(dead_code)]
    #[derive(Debug, Deserialize, JsonSchema)]
    struct NestingParams {
        items: Vec<Nested>,
    }

    fn contains_ref(value: &Value) -> bool {
        match value {
            Value::Object(map) => {
                map.contains_key("$ref")
                    || map.contains_key("$defs")
                    || map.contains_key("definitions")
                    || map.values().any(contains_ref)
            }
            Value::Array(items) => items.iter().any(contains_ref),
            _ => false,
        }
    }

    #[test]
    fn params_schema_inlines_nested_structs_without_refs() {
        // The classic moonshot/kimi HTTP-400 trigger: a `Vec<Struct>` field.
        // The generated schema must inline the nested struct and contain NO
        // `$ref` / `$defs` / `definitions` — the provider-agnostic contract
        // enforced by `assert_llm_compatible_schema`.
        let schema = params_schema::<NestingParams>();
        assert!(
            !contains_ref(&schema),
            "params_schema must inline subschemas (no $ref/$defs/definitions): {schema}"
        );
        // The nested struct's fields must be reachable inline.
        let item = &schema["properties"]["items"]["items"];
        assert!(item["properties"]["title"].is_object());
        assert!(item["properties"]["command"].is_object());
    }

    #[test]
    fn params_schema_output_satisfies_llm_compat_contract() {
        let schema = params_schema::<NestingParams>();
        assert_llm_compatible_schema(&schema)
            .expect("inlined schema must satisfy the LLM-compat contract (no $ref)");
    }

    /// Mirrors `edit_file`'s params: `Option<String>` fields that schemars
    /// renders as `"type": ["string", "null"]`. baidu/ernie rejects that
    /// nullable type-array with HTTP 400 `not a valid jsonSchema`, so
    /// `params_schema` must collapse it to the plain scalar `"string"`.
    #[derive(Debug, Deserialize, JsonSchema)]
    struct NullableParams {
        required_path: String,
        #[serde(default)]
        maybe_text: Option<String>,
        #[serde(default)]
        flag: bool,
    }

    /// Walk the schema collecting every `"type"` value that is a JSON array
    /// (i.e. a non-collapsed nullable/union type).
    fn type_arrays(value: &Value) -> Vec<Value> {
        let mut found = Vec::new();
        fn walk(value: &Value, out: &mut Vec<Value>) {
            match value {
                Value::Object(map) => {
                    if let Some(t @ Value::Array(_)) = map.get("type") {
                        out.push(t.clone());
                    }
                    for child in map.values() {
                        walk(child, out);
                    }
                }
                Value::Array(items) => {
                    for child in items {
                        walk(child, out);
                    }
                }
                _ => {}
            }
        }
        walk(value, &mut found);
        found
    }

    #[test]
    fn params_schema_collapses_nullable_type_arrays() {
        // The baidu/ernie HTTP-400 trigger: an `Option<String>` field whose
        // schemars output is `"type": ["string", "null"]`. After collapse the
        // schema must contain NO `"type"` arrays at all — every nullable type
        // is reduced to its single non-null scalar.
        let schema = params_schema::<NullableParams>();
        assert!(
            type_arrays(&schema).is_empty(),
            "nullable type arrays must collapse to plain scalars: {schema}"
        );
        // The optional field must still be present, just with a scalar type,
        // and must NOT be listed as required.
        assert_eq!(
            schema["properties"]["maybe_text"]["type"],
            Value::String("string".into())
        );
        let required: Vec<&str> = schema["required"]
            .as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str()).collect())
            .unwrap_or_default();
        assert!(required.contains(&"required_path"));
        assert!(!required.contains(&"maybe_text"));
    }

    #[test]
    fn collapsed_nullable_params_still_deserialize_when_field_omitted() {
        // Dropping `"null"` from the wire schema must not change parsing:
        // `Option<String>` + serde default still accepts an omitted field.
        let parsed: NullableParams = parse_params(serde_json::json!({
            "required_path": "/tmp/x",
        }))
        .expect("optional field may be omitted");
        assert_eq!(parsed.required_path, "/tmp/x");
        assert!(parsed.maybe_text.is_none());
        assert!(!parsed.flag);
    }

    /// Mirrors `use_code_map`'s `kind: Option<CodeMapNodeKind>`: an optional
    /// enum field. schemars renders this as BOTH `"type": ["string", "null"]`
    /// AND `"enum": [..variants, null]`. moonshot/MiniMax reject the trailing
    /// `null` in the enum with HTTP 400 `enum value (<nil>) does not match any
    /// type in [string]` (GitHub #23), so `params_schema` must strip it.
    #[derive(Debug, Deserialize, JsonSchema)]
    #[serde(rename_all = "snake_case")]
    enum SampleKind {
        Alpha,
        Beta,
        Gamma,
    }

    #[derive(Debug, Deserialize, JsonSchema)]
    struct OptionalEnumParams {
        required_name: String,
        #[serde(default)]
        kind: Option<SampleKind>,
    }

    #[test]
    fn params_schema_strips_null_from_optional_enum() {
        let schema = params_schema::<OptionalEnumParams>();
        let kind = &schema["properties"]["kind"];
        // The nullable type array must have collapsed to a plain scalar.
        assert_eq!(kind["type"], Value::String("string".into()));
        // And the sibling enum must no longer carry a `null` member —
        // every entry must be a non-null string variant.
        let variants = kind["enum"]
            .as_array()
            .expect("optional enum field must keep its enum constraint");
        assert!(
            variants.iter().all(|v| v.is_string()),
            "enum must contain no null after collapse: {schema}"
        );
        assert_eq!(
            variants.len(),
            3,
            "all three variants must survive: {schema}"
        );
        // No `"type"` arrays must remain anywhere in the schema.
        assert!(
            type_arrays(&schema).is_empty(),
            "nullable type arrays must collapse to plain scalars: {schema}"
        );
    }

    #[test]
    fn collapsed_optional_enum_still_deserializes() {
        let parsed: OptionalEnumParams = parse_params(serde_json::json!({
            "required_name": "x",
            "kind": "beta",
        }))
        .expect("present optional enum must deserialize");
        assert_eq!(parsed.required_name, "x");
        assert!(matches!(parsed.kind, Some(SampleKind::Beta)));

        let omitted: OptionalEnumParams = parse_params(serde_json::json!({
            "required_name": "y",
        }))
        .expect("omitted optional enum must deserialize");
        assert!(omitted.kind.is_none());
    }

    #[test]
    fn optional_enum_schema_satisfies_llm_contract() {
        // The generation-time fix (`collapse_nullable_type_arrays` stripping
        // the null) and the contract backstop must agree: a real
        // `Option<Enum>` params type must pass `assert_llm_compatible_schema`.
        let schema = params_schema::<OptionalEnumParams>();
        assert_llm_compatible_schema(&schema)
            .expect("Option<Enum> schema must satisfy the LLM-compat contract after null strip");
    }

    #[test]
    fn llm_contract_rejects_null_enum_member() {
        // Backstop: a hand-rolled (or future schemars-produced) schema that
        // leaves a `null` in an enum array — the GitHub #23 trigger — must be
        // rejected by the contract, not silently shipped to the provider.
        let bad = serde_json::json!({
            "type": "object",
            "properties": {
                "kind": {
                    "type": "string",
                    "enum": ["file", "function", null]
                }
            }
        });
        let err = assert_llm_compatible_schema(&bad)
            .expect_err("enum carrying a null member must be rejected");
        assert!(
            err.contains("null"),
            "rejection must name the null enum member: {err}"
        );
    }

    /// Mirrors the agent-org task tools: strict params that reject any
    /// unknown LLM-supplied field.
    #[derive(Debug, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct StrictParams {
        subject: String,
    }

    #[test]
    fn parse_params_accepts_clean_strict_params() {
        let params = serde_json::json!({
            "subject": "audit yoyo-evolve",
        });
        let parsed: StrictParams = parse_params(params).expect("clean params must deserialize");
        assert_eq!(parsed.subject, "audit yoyo-evolve");
    }

    #[test]
    fn parse_params_rejects_unknown_fields_including_framework_meta() {
        // Post-CallContext refactor: framework metadata flows via
        // CallContext, NOT via `__`-prefixed keys in params. If anyone
        // ever puts `__`-keys back into params they must show up as a
        // real validation failure here — that surfaces the wiring bug
        // rather than silently swallowing it.
        let meta_leaked = serde_json::json!({
            "subject": "x",
            "__call_id": "call-1",
        });
        let result: Result<StrictParams, _> = parse_params(meta_leaked);
        assert!(
            result.is_err(),
            "framework meta in params is a wiring bug, must fail closed"
        );

        let real_unknown = serde_json::json!({
            "subject": "x",
            "bogus_field": true,
        });
        let result: Result<StrictParams, _> = parse_params(real_unknown);
        assert!(
            result.is_err(),
            "non-framework unknown fields must still fail closed"
        );
    }
}
