//! Factory Droid managed hooks. Droid emits Claude-Code-shaped payloads and
//! consumes the same nested JSON `hooks.PostToolUse` schema (installed via the
//! shared helper in the dispatcher), with its own file-tool verbs and the
//! Claude-Code lifecycle event vocabulary.

// Factory Droid emits Claude-Code-shaped payloads with its own file verbs
// (`Create`, `Edit`, `ApplyPatch`).
pub(super) const FACTORY_DROID_POST_TOOL_USE_MATCHER: &str =
    "Read|Write|Create|Edit|MultiEdit|ApplyPatch|Delete|Glob|Grep";
// Factory Droid emits Claude-Code-shaped lifecycle events.
pub(super) const FACTORY_DROID_LIFECYCLE_EVENTS: &[(&str, Option<&str>)] =
    super::claude::CLAUDE_CODE_LIFECYCLE_EVENTS;
