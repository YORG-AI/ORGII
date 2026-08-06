//! `read_file` tool — read a file's contents with optional line-range
//! selection.

use async_trait::async_trait;
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::specialization::skills::builtin;

use super::{allowed_roots, authorize_path, live_allowed_dir, map_err, WorkspaceStateHandle};
use crate::security::SecurityPolicy;
use crate::tools::impls::coding::action_router::ActionRouter;
use crate::tools::names as tool_names;
use crate::tools::traits::{optional_int, required_string, Tool, ToolError};

const READ_CACHE_MAX_ENTRIES: usize = 128;
const READ_CACHE_MAX_BYTES: usize = 512 * 1024;
const READ_ACTION_FILE_UNCHANGED: &str = "file_unchanged";

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct ReadCacheKey {
    resolved_path: PathBuf,
    offset: Option<i64>,
    limit: Option<usize>,
}

#[derive(Clone, Debug)]
struct ReadCacheEntry {
    modified_millis: u128,
    total_bytes: u64,
    output_bytes: usize,
    start_line: usize,
    end_line: usize,
    total_lines: usize,
}

#[derive(Debug, Default)]
struct ReadFileCache {
    entries: HashMap<ReadCacheKey, ReadCacheEntry>,
    order: VecDeque<ReadCacheKey>,
    bytes: usize,
}

impl ReadFileCache {
    fn get(&mut self, key: &ReadCacheKey) -> Option<ReadCacheEntry> {
        let entry = self.entries.get(key).cloned()?;
        self.touch(key);
        Some(entry)
    }

    fn insert(&mut self, key: ReadCacheKey, entry: ReadCacheEntry) {
        if let Some(previous) = self.entries.remove(&key) {
            self.bytes = self.bytes.saturating_sub(previous.output_bytes);
            self.order.retain(|candidate| candidate != &key);
        }

        self.bytes = self.bytes.saturating_add(entry.output_bytes);
        self.order.push_back(key.clone());
        self.entries.insert(key, entry);
        self.evict_over_budget();
    }

    fn touch(&mut self, key: &ReadCacheKey) {
        self.order.retain(|candidate| candidate != key);
        self.order.push_back(key.clone());
    }

    fn evict_over_budget(&mut self) {
        while self.entries.len() > READ_CACHE_MAX_ENTRIES || self.bytes > READ_CACHE_MAX_BYTES {
            let Some(oldest_key) = self.order.pop_front() else {
                break;
            };
            if let Some(oldest) = self.entries.remove(&oldest_key) {
                self.bytes = self.bytes.saturating_sub(oldest.output_bytes);
            }
        }
    }
}

pub struct ReadFileTool {
    /// Construction-time sandbox root; `None` = unrestricted. When
    /// `workspace_state` is attached the live `working_dir()` is read on
    /// every call instead — this field then only signals "restricted" and
    /// serves as a fallback for workspace-less construction (tests).
    allowed_dir: Option<PathBuf>,
    /// Static extra dirs granted at construction time (scratchpad,
    /// readonly skill dirs). Live workspace roots (workspace_root,
    /// worktree working_dir, `/add-dir` grants) come from
    /// `workspace_state` via `allowed_roots()` at call time so mutations
    /// are visible without a registry rebuild.
    additional_allowed_dirs: Vec<PathBuf>,
    workspace_state: Option<WorkspaceStateHandle>,
    router: Option<ActionRouter>,
    security_policy: Option<Arc<SecurityPolicy>>,
    read_cache: Mutex<ReadFileCache>,
}

impl ReadFileTool {
    pub fn new(allowed_dir: Option<PathBuf>) -> Self {
        Self {
            allowed_dir,
            additional_allowed_dirs: Vec::new(),
            workspace_state: None,
            router: None,
            security_policy: None,
            read_cache: Mutex::new(ReadFileCache::default()),
        }
    }

    pub fn with_router(mut self, router: ActionRouter) -> Self {
        self.router = Some(router);
        self
    }

    pub fn with_security_policy(mut self, policy: Arc<SecurityPolicy>) -> Self {
        self.security_policy = Some(policy);
        self
    }

    pub fn with_scratchpad(mut self, scratchpad_dir: PathBuf) -> Self {
        self.additional_allowed_dirs.push(scratchpad_dir);
        self
    }

    pub fn with_readonly_extra_dir(mut self, directory: PathBuf) -> Self {
        self.additional_allowed_dirs.push(directory);
        self
    }

    /// Attach the session's live `SessionWorkspace` so that directories added
    /// via `/add-dir` mutator commands become authorised for this tool without
    /// rebuilding the tool registry.
    pub fn with_workspace_state(mut self, state: WorkspaceStateHandle) -> Self {
        self.workspace_state = Some(state);
        self
    }

    /// Live primary sandbox root — see [`live_allowed_dir`].
    fn current_allowed_dir(&self) -> Option<PathBuf> {
        live_allowed_dir(
            self.allowed_dir.is_some(),
            self.workspace_state.as_ref(),
            self.allowed_dir.as_ref(),
        )
    }
}

#[async_trait]
impl Tool for ReadFileTool {
    fn name(&self) -> &str {
        tool_names::READ_FILE
    }

    fn category(&self) -> &str {
        crate::tools::categories::CODING
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn output_budget(&self) -> usize {
        100_000
    }

    /// Never stub a file read to disk — telling the model "the content is in
    /// a file on disk" in response to it reading a file is circular. Oversized
    /// reads fall back to plain tail truncation.
    fn allow_persisted_output(&self) -> bool {
        false
    }

    fn description(&self) -> &str {
        "Read a file's contents with optional line-range selection. \
         Supports text files, PDFs (extracts text), images (JPEG/PNG/GIF/WebP — returns inline for vision), \
         and Jupyter notebooks (.ipynb — renders cells as text). \
         By default reads up to 2000 lines from the start. \
         For large files, use `offset` and `limit` to read specific sections. \
         Files over 256 KB require offset/limit."
    }

    fn llm_description(&self) -> Option<String> {
        let mut roots = Vec::new();
        if let Some(root) = self.current_allowed_dir() {
            roots.push(root);
        }
        roots.extend(allowed_roots(
            &self.additional_allowed_dirs,
            self.workspace_state.as_ref(),
        ));
        roots.sort();
        roots.dedup();
        let workspace = if roots.is_empty() {
            "(unrestricted)".to_string()
        } else {
            roots
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        };
        Some(format!(
            "Read a file in {workspace}. ALWAYS use this tool to read files — NEVER invoke `cat`, `head`, \
             `tail`, or `sed -n` through the shell tool. Supports text, PDF (text extraction), \
             images (JPEG/PNG/GIF/WebP — inline for vision models), \
             and Jupyter notebooks (.ipynb). \
             Optional line-range with offset/limit. Default: up to 2000 lines. \
             Files over 256 KB require offset/limit. Use absolute paths for files outside the primary working directory. \
             You MUST read a file before editing it. When you intend to read multiple files, issue the reads in parallel.\n\
             Output format: each line is prefixed with a right-aligned line number and │ separator, \
             e.g. \"     1│first line\". This prefix is metadata — never include it in old_string \
             when editing."
        ))
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Path to the file to read"
                },
                "offset": {
                    "type": "integer",
                    "description": "Line number to start reading from (1-indexed). Negative values count from end (e.g. -20 = last 20 lines). Only provide if the file is too large to read at once."
                },
                "limit": {
                    "type": "integer",
                    "description": "Number of lines to read. Only provide if the file is too large to read at once."
                }
            },
            "required": ["path"]
        })
    }

    async fn execute_text(
        &self,
        params: Value,
        _ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        let raw_path = required_string(&params, "path")?;
        let offset = optional_int(&params, "offset");
        let limit = optional_int(&params, "limit").map(|v| v.max(1) as usize);

        if let Some(output) = read_embedded_builtin_skill(&raw_path, offset, limit)? {
            return Ok(output);
        }

        let allowed = self.current_allowed_dir();
        let extras = allowed_roots(&self.additional_allowed_dirs, self.workspace_state.as_ref());
        let (authorized_path, authorized_roots) = authorize_path(
            &raw_path,
            allowed.as_deref(),
            &extras,
            self.security_policy.as_deref(),
        )
        .map_err(map_err)?;
        let authorized_path = authorized_path.to_string_lossy().into_owned();

        if let Some(ref router) = self.router {
            if router.should_route() {
                if let Some(result) = router
                    .try_execute("file.read", serde_json::json!({ "path": &authorized_path }))
                    .await?
                {
                    let action = classify_read_action(&raw_path, &result);
                    return Ok(format!("[action: {}]\n{}", action, result));
                }
            }
        }

        let stat = crate::tool_infra::file::stat_file_with_extras(
            &authorized_path,
            allowed.as_deref(),
            &authorized_roots,
        )
        .await
        .map_err(map_err)?;
        let cache_key = ReadCacheKey {
            resolved_path: stat.resolved_path.clone(),
            offset,
            limit,
        };

        if let Some(entry) = self.read_cache.lock().await.get(&cache_key) {
            if entry.modified_millis == stat.modified_millis
                && entry.total_bytes == stat.total_bytes
            {
                return Ok(format_file_unchanged_stub(&raw_path, &entry));
            }
        }

        let result = crate::tool_infra::file::read_file_in_range_with_extras(
            &authorized_path,
            allowed.as_deref(),
            &authorized_roots,
            offset,
            limit,
        )
        .await
        .map_err(map_err)?;

        let start_line = result.start_line;
        let end_line = result.start_line + result.lines_read.saturating_sub(1);
        let total_lines = result.total_lines;
        let total_bytes = result.total_bytes;
        let modified_millis = result.modified_millis;
        let resolved_path = result.resolved_path.clone();
        let mut output = result.content;

        if result.lines_read == 0 {
            // Silent empty output makes the model loop or hallucinate —
            // say explicitly why there is nothing to show.
            output = if total_lines == 0 {
                "Warning: the file exists but the contents are empty.".to_string()
            } else {
                format!(
                    "Warning: the file has only {} lines, which is fewer than \
                     the requested offset ({}).",
                    total_lines,
                    offset.unwrap_or_default(),
                )
            };
        } else if result.truncated || result.lines_read < result.total_lines {
            output.push_str(&format!(
                "\n\n[Showing lines {}-{} of {} total ({:.1} KB). \
                 Use offset and limit to read other sections.]",
                start_line,
                end_line,
                total_lines,
                total_bytes as f64 / 1024.0,
            ));
        }

        let action = classify_read_action(&raw_path, &output);
        let mut output = format!("[action: {}]\n{}", action, output);
        // The model asked for the file, so the beginning (imports, structure)
        // is the useful part of an oversized read — the executor's generic
        // fallback would keep the tail. Head-truncate here with re-read
        // guidance instead. Image markers are exempt (cut base64 corrupts;
        // the executor replaces oversized image results wholesale).
        if output.len() > self.output_budget() && !output.contains("[image:") {
            output = head_truncate_with_guidance(&output, self.output_budget());
        }
        self.read_cache.lock().await.insert(
            ReadCacheKey {
                resolved_path,
                offset,
                limit,
            },
            ReadCacheEntry {
                modified_millis,
                total_bytes,
                output_bytes: output.len(),
                start_line,
                end_line,
                total_lines,
            },
        );
        Ok(output)
    }
}

/// Head-keep truncation for oversized reads, sized to fit under `budget`
/// (including the guidance trailer) so the executor's tail-keep fallback
/// never fires on top of it.
fn head_truncate_with_guidance(output: &str, budget: usize) -> String {
    const GUIDANCE_HEADROOM: usize = 400;
    let keep = budget.saturating_sub(GUIDANCE_HEADROOM);
    let mut end = keep.min(output.len());
    while end > 0 && !output.is_char_boundary(end) {
        end -= 1;
    }
    let head = &output[..end];
    // Cut on a line boundary so the output never ends mid-line.
    let head = match head.rfind('\n') {
        Some(idx) => &head[..idx],
        None => head,
    };
    format!(
        "{}\n\n[output truncated: showing the FIRST ~{}K of {}K chars. \
         Re-read with offset/limit to view later sections, or use code_search \
         (action: grep) to locate specific content.]",
        head,
        keep / 1000,
        output.len() / 1000,
    )
}

fn format_file_unchanged_stub(path: &str, entry: &ReadCacheEntry) -> String {
    format!(
        "[action: {}]\n[{}: {}]\nPrevious read is still current; file bytes and modification time are unchanged.\nLines {}-{} of {} remain available from the previous read result.",
        READ_ACTION_FILE_UNCHANGED,
        READ_ACTION_FILE_UNCHANGED,
        path,
        entry.start_line,
        entry.end_line,
        entry.total_lines,
    )
}

fn read_embedded_builtin_skill(
    path: &str,
    offset: Option<i64>,
    limit: Option<usize>,
) -> Result<Option<String>, ToolError> {
    let Some(skill_name) = embedded_builtin_skill_name(path) else {
        return Ok(None);
    };
    let content = builtin::load_builtin_skill(&skill_name).ok_or_else(|| {
        ToolError::ExecutionFailed(format!("Built-in skill not found: {}", skill_name))
    })?;
    let resolved_path = PathBuf::from(format!("builtin://{}/SKILL.md", skill_name));
    let result = crate::tool_infra::file::format_text_result(
        content,
        content.len() as u64,
        0,
        resolved_path,
        offset,
        limit,
    )
    .map_err(ToolError::ExecutionFailed)?;
    let mut output = result.content;
    if result.truncated || result.lines_read < result.total_lines {
        output.push_str(&format!(
            "\n\n[Showing lines {}-{} of {} total ({:.1} KB). \
             Use offset and limit to read other sections.]",
            result.start_line,
            result.start_line + result.lines_read.saturating_sub(1),
            result.total_lines,
            result.total_bytes as f64 / 1024.0,
        ));
    }
    Ok(Some(format!("[action: read_text]\n{}", output)))
}

fn embedded_builtin_skill_name(path: &str) -> Option<String> {
    let trimmed = path.trim();
    if let Some(without_scheme) = trimmed.strip_prefix("builtin://") {
        return Some(
            without_scheme
                .strip_suffix("/SKILL.md")
                .unwrap_or(without_scheme)
                .to_string(),
        );
    }

    let global_skills_dir = app_paths::global_skills_dir();
    let skill_file = PathBuf::from(trimmed);
    let skill_dir = skill_file.parent()?;
    if skill_file.file_name().and_then(|name| name.to_str()) != Some("SKILL.md") {
        return None;
    }
    if skill_dir.parent()? != global_skills_dir {
        return None;
    }
    let skill_name = skill_dir.file_name()?.to_str()?;
    builtin::load_builtin_skill(skill_name).map(|_| skill_name.to_string())
}

/// Classify a `read_file` result into a concrete action so the frontend can
/// pick the right renderer without filename pattern matching.
///
/// The classification is emitted as a leading `[action: X]` marker line
/// prepended to the tool output.
fn classify_read_action(path: &str, output: &str) -> &'static str {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".png")
        || lower.ends_with(".jpg")
        || lower.ends_with(".jpeg")
        || lower.ends_with(".gif")
        || lower.ends_with(".webp")
        || lower.ends_with(".bmp")
        || lower.ends_with(".svg")
        || output.trim_start().starts_with("Image:")
    {
        return "read_image";
    }
    if lower.ends_with(".pdf") {
        return "read_pdf";
    }
    "read_text"
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::traits::Tool;
    use tempfile::TempDir;

    #[test]
    fn classify_read_action_detects_image() {
        assert_eq!(classify_read_action("/tmp/foo.png", ""), "read_image");
        assert_eq!(classify_read_action("bar.JPEG", ""), "read_image");
        assert_eq!(
            classify_read_action("notes.txt", "Image: foo.png (image/png, 12kb)\n..."),
            "read_image"
        );
    }

    #[test]
    fn classify_read_action_detects_pdf() {
        assert_eq!(classify_read_action("/doc.PDF", "abc"), "read_pdf");
    }

    #[test]
    fn classify_read_action_defaults_to_text() {
        assert_eq!(classify_read_action("README.md", "hello"), "read_text");
        assert_eq!(classify_read_action("noext", ""), "read_text");
    }

    #[tokio::test]
    async fn reads_embedded_builtin_skill_uri() {
        let tool = ReadFileTool::new(None);
        let output = tool
            .execute(
                serde_json::json!({ "path": "builtin://create-orgii-agent/SKILL.md" }),
                &crate::tools::call_context::CallContext::default(),
            )
            .await
            .unwrap();

        assert!(
            output.contains("[action: read_text]"),
            "output was: {output}"
        );
        assert!(
            output.contains("create-orgii-agent"),
            "output was: {output}"
        );
        assert!(
            output.contains("agent-definitions.json"),
            "output was: {output}"
        );
    }

    #[tokio::test]
    async fn embedded_builtin_skill_uri_supports_ranges() {
        let tool = ReadFileTool::new(None);
        let output = tool
            .execute(
                serde_json::json!({
                    "path": "builtin://create-orgii-agent/SKILL.md",
                    "offset": 1,
                    "limit": 3
                }),
                &crate::tools::call_context::CallContext::default(),
            )
            .await
            .unwrap();

        assert!(output.contains("     1│---"), "output was: {output}");
        assert!(output.contains("Showing lines 1-3"), "output was: {output}");
    }

    #[tokio::test]
    async fn reads_embedded_builtin_skill_from_global_skill_path() {
        let tool = ReadFileTool::new(None);
        let path = app_paths::global_skills_dir()
            .join("create-orgii-agent")
            .join("SKILL.md");
        let output = tool
            .execute(
                serde_json::json!({ "path": path.to_string_lossy() }),
                &crate::tools::call_context::CallContext::default(),
            )
            .await
            .unwrap();

        assert!(
            output.contains("create-orgii-agent"),
            "output was: {output}"
        );
        assert!(
            output.contains("agent-definitions.json"),
            "output was: {output}"
        );
    }

    #[tokio::test]
    async fn unknown_embedded_builtin_skill_errors_explicitly() {
        let tool = ReadFileTool::new(None);
        let err = tool
            .execute(
                serde_json::json!({ "path": "builtin://missing-skill/SKILL.md" }),
                &crate::tools::call_context::CallContext::default(),
            )
            .await
            .unwrap_err();

        assert!(
            matches!(err, ToolError::ExecutionFailed(ref message) if message.contains("Built-in skill not found: missing-skill")),
            "unexpected error: {err:?}"
        );
    }

    #[tokio::test]
    async fn repeated_unchanged_read_returns_stub() {
        let repo = TempDir::new().unwrap();
        std::fs::write(repo.path().join("marker.txt"), "hello\nworld").unwrap();

        let tool = ReadFileTool::new(Some(repo.path().to_path_buf()));
        let first = tool
            .execute(
                serde_json::json!({ "path": "marker.txt" }),
                &crate::tools::call_context::CallContext::default(),
            )
            .await
            .unwrap();
        assert!(first.contains("hello"), "output was: {}", first);

        let second = tool
            .execute(
                serde_json::json!({ "path": "marker.txt" }),
                &crate::tools::call_context::CallContext::default(),
            )
            .await
            .unwrap();
        assert!(
            second.contains("[action: file_unchanged]"),
            "output was: {}",
            second
        );
        assert!(
            !second.contains("hello"),
            "unchanged stub should not repeat content: {}",
            second
        );
    }

    #[tokio::test]
    async fn changed_file_refreshes_cache() {
        let repo = TempDir::new().unwrap();
        let path = repo.path().join("marker.txt");
        std::fs::write(&path, "hello").unwrap();

        let tool = ReadFileTool::new(Some(repo.path().to_path_buf()));
        let first = tool
            .execute(
                serde_json::json!({ "path": "marker.txt" }),
                &crate::tools::call_context::CallContext::default(),
            )
            .await
            .unwrap();
        assert!(first.contains("hello"), "output was: {}", first);

        std::thread::sleep(std::time::Duration::from_millis(2));
        std::fs::write(&path, "updated").unwrap();

        let second = tool
            .execute(
                serde_json::json!({ "path": "marker.txt" }),
                &crate::tools::call_context::CallContext::default(),
            )
            .await
            .unwrap();
        assert!(second.contains("updated"), "output was: {}", second);
        assert!(
            !second.contains("[action: file_unchanged]"),
            "output was: {}",
            second
        );
    }

    #[tokio::test]
    async fn empty_file_returns_explicit_warning() {
        let repo = TempDir::new().unwrap();
        std::fs::write(repo.path().join("empty.txt"), "").unwrap();

        let tool = ReadFileTool::new(Some(repo.path().to_path_buf()));
        let output = tool
            .execute(
                serde_json::json!({ "path": "empty.txt" }),
                &crate::tools::call_context::CallContext::default(),
            )
            .await
            .unwrap();

        assert!(
            output.contains("Warning: the file exists but the contents are empty."),
            "output was: {output}"
        );
    }

    #[tokio::test]
    async fn offset_past_eof_returns_explicit_warning() {
        let repo = TempDir::new().unwrap();
        std::fs::write(repo.path().join("short.txt"), "one\ntwo\nthree").unwrap();

        let tool = ReadFileTool::new(Some(repo.path().to_path_buf()));
        let output = tool
            .execute(
                serde_json::json!({ "path": "short.txt", "offset": 100 }),
                &crate::tools::call_context::CallContext::default(),
            )
            .await
            .unwrap();

        assert!(
            output.contains("Warning: the file has only 3 lines"),
            "output was: {output}"
        );
        assert!(
            output.contains("requested offset (100)"),
            "output was: {output}"
        );
    }

    #[tokio::test]
    async fn oversized_read_keeps_head_with_reread_guidance() {
        let repo = TempDir::new().unwrap();
        // 100 lines x ~1.5KB = ~150KB: under the 256KB no-range gate but
        // over the 100K output budget, so head truncation must fire.
        let line = "z".repeat(1_500);
        let content = (1..=100)
            .map(|idx| format!("L{idx} {line}"))
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(repo.path().join("wide.txt"), &content).unwrap();

        let tool = ReadFileTool::new(Some(repo.path().to_path_buf()));
        let output = tool
            .execute(
                serde_json::json!({ "path": "wide.txt" }),
                &crate::tools::call_context::CallContext::default(),
            )
            .await
            .unwrap();

        assert!(output.len() <= tool.output_budget(), "len={}", output.len());
        assert!(output.contains("L1 "), "head (first line) must survive");
        assert!(
            !output.contains("L100 "),
            "tail must be truncated, not kept"
        );
        assert!(
            output.contains("showing the FIRST"),
            "output was missing guidance trailer: {}",
            &output[output.len().saturating_sub(400)..]
        );
        assert!(output.contains("Re-read with offset/limit"));
    }

    #[test]
    fn head_truncate_with_guidance_cuts_on_line_boundary() {
        let content = (1..=50)
            .map(|idx| format!("line {idx} {}", "y".repeat(100)))
            .collect::<Vec<_>>()
            .join("\n");
        let out = head_truncate_with_guidance(&content, 2_000);
        assert!(out.len() <= 2_000);
        assert!(out.starts_with("line 1 "));
        let body = out.split("\n\n[output truncated").next().unwrap();
        assert!(
            body.ends_with('y'),
            "body should end with a complete line, got: ...{}",
            &body[body.len().saturating_sub(20)..]
        );
        assert!(out.contains("code_search"));
    }

    #[test]
    fn llm_description_lists_additional_roots() {
        let repo = TempDir::new().unwrap();
        let extra = TempDir::new().unwrap();
        let tool = ReadFileTool::new(Some(repo.path().to_path_buf()))
            .with_readonly_extra_dir(extra.path().to_path_buf());

        let description = tool.llm_description().unwrap();
        assert!(
            description.contains(&repo.path().display().to_string()),
            "description was: {description}"
        );
        assert!(
            description.contains(&extra.path().display().to_string()),
            "description was: {description}"
        );
        assert!(
            description
                .contains("Use absolute paths for files outside the primary working directory"),
            "description was: {description}"
        );
    }
}
