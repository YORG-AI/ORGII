//! Session-scoped system prompt section cache.
//!
//! Stable prompt sections are cached for the lifetime of a conversation and
//! volatile sections opt out explicitly. Each section declares a
//! [`PromptCachePolicy`], and live sessions keep a [`SessionPromptCache`] so
//! expensive stable sections are rendered once per session instead of on every
//! turn.

use std::collections::{HashMap, HashSet, VecDeque};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::skills::loader::SkillListingEntry;

const MAX_SECTION_CACHE_ENTRIES: usize = 64;
const MAX_SKILL_LISTING_CACHE_ENTRIES: usize = 32;
const MAX_SKILL_SENT_AGENT_ENTRIES: usize = 64;
const MAX_LEARNINGS_CACHE_ENTRIES: usize = 128;
pub const ORGII_SYSTEM_CACHE_SCOPE_KEY: &str = "_orgii_cache_scope";

const MAX_CACHE_BREAK_SAMPLES: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PromptCacheInvalidationReason {
    SessionReset,
    AgentDefinitionChanged,
    WorkspaceSnapshotChanged,
    SkillCatalogChanged,
    LearningsChanged,
    Compaction,
    Resume,
}

impl PromptCacheInvalidationReason {
    pub fn as_str(self) -> &'static str {
        match self {
            PromptCacheInvalidationReason::SessionReset => "session_reset",
            PromptCacheInvalidationReason::AgentDefinitionChanged => "agent_definition_changed",
            PromptCacheInvalidationReason::WorkspaceSnapshotChanged => "workspace_snapshot_changed",
            PromptCacheInvalidationReason::SkillCatalogChanged => "skill_catalog_changed",
            PromptCacheInvalidationReason::LearningsChanged => "learnings_changed",
            PromptCacheInvalidationReason::Compaction => "compaction",
            PromptCacheInvalidationReason::Resume => "resume",
        }
    }
}

/// Cache behavior for a prompt section.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PromptCachePolicy {
    /// Render once per live session and reuse until the session is cleared or
    /// recreated. This is for text whose inputs are session-stable snapshots.
    StableUntilClear,
    /// Rendered content is reusable only while a caller-supplied revision key
    /// remains unchanged.
    RevisionKeyed,
    /// Render every prompt build. Use this for sections whose inputs can change
    /// between turns or whose current implementation still performs live reads.
    Volatile,
}

impl PromptCachePolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            PromptCachePolicy::StableUntilClear => "stable_until_clear",
            PromptCachePolicy::RevisionKeyed => "revision_keyed",
            PromptCachePolicy::Volatile => "volatile",
        }
    }

    pub fn is_cacheable(self) -> bool {
        matches!(self, PromptCachePolicy::StableUntilClear)
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStats {
    pub hits: u64,
    pub misses: u64,
    pub entries: usize,
}

impl CacheStats {
    pub fn reset_counts(&mut self) {
        self.hits = 0;
        self.misses = 0;
    }
}

#[derive(Debug)]
struct BoundedMap<K, V> {
    map: HashMap<K, V>,
    order: VecDeque<K>,
    max_entries: usize,
}

impl<K, V> BoundedMap<K, V>
where
    K: Clone + Eq + Hash,
{
    fn new(max_entries: usize) -> Self {
        Self {
            map: HashMap::new(),
            order: VecDeque::new(),
            max_entries,
        }
    }

    fn get(&self, key: &K) -> Option<&V> {
        self.map.get(key)
    }

    fn insert(&mut self, key: K, value: V) {
        if self.max_entries == 0 {
            return;
        }
        if !self.map.contains_key(&key) {
            self.order.push_back(key.clone());
        }
        self.map.insert(key, value);
        self.evict_overflow();
    }

    fn clear(&mut self) {
        self.map.clear();
        self.order.clear();
    }

    fn len(&self) -> usize {
        self.map.len()
    }

    fn evict_overflow(&mut self) {
        while self.map.len() > self.max_entries {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            self.map.remove(&oldest);
        }
    }
}

impl<K, V> Default for BoundedMap<K, V>
where
    K: Clone + Eq + Hash,
{
    fn default() -> Self {
        Self::new(64)
    }
}

/// Per-session storage for rendered prompt sections.
#[derive(Debug)]
pub struct SessionPromptCache {
    sections: BoundedMap<&'static str, Option<String>>,
    stats: CacheStats,
}

impl Default for SessionPromptCache {
    fn default() -> Self {
        Self {
            sections: BoundedMap::new(MAX_SECTION_CACHE_ENTRIES),
            stats: CacheStats::default(),
        }
    }
}

impl SessionPromptCache {
    pub fn get(&mut self, section_id: &'static str) -> Option<Option<String>> {
        let value = self.sections.get(&section_id).cloned();
        if value.is_some() {
            self.stats.hits += 1;
        } else {
            self.stats.misses += 1;
        }
        value
    }

    pub fn insert(&mut self, section_id: &'static str, content: Option<String>) {
        self.sections.insert(section_id, content);
        self.stats.entries = self.sections.len();
    }

    pub fn clear(&mut self) {
        self.sections.clear();
        self.stats.entries = 0;
        self.stats.reset_counts();
    }

    pub fn stats(&self) -> CacheStats {
        CacheStats {
            entries: self.sections.len(),
            ..self.stats
        }
    }

    pub fn reset_stats(&mut self) {
        self.stats.reset_counts();
        self.stats.entries = self.sections.len();
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.sections.len()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SkillListingCacheKey {
    workspace_root: PathBuf,
    disabled_skills: Vec<String>,
    include_filter: Option<Vec<String>>,
    agent_id: String,
    org_id: Option<String>,
    load_workspace_resources: bool,
}

impl SkillListingCacheKey {
    pub fn new(
        workspace_root: &Path,
        disabled_skills: &[String],
        include_filter: Option<&[String]>,
        agent_id: &str,
        org_id: Option<&str>,
        load_workspace_resources: bool,
    ) -> Self {
        let mut disabled = disabled_skills.to_vec();
        disabled.sort();
        disabled.dedup();

        let include = include_filter.map(|filter| {
            let mut values = filter.to_vec();
            values.sort();
            values.dedup();
            values
        });

        Self {
            workspace_root: workspace_root.to_path_buf(),
            disabled_skills: disabled,
            include_filter: include,
            agent_id: agent_id.to_string(),
            org_id: org_id.map(str::to_string),
            load_workspace_resources,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillListingDeltaStats {
    pub scanned_count: usize,
    pub new_count: usize,
    pub sent_count: usize,
    pub suppressed: bool,
}

#[derive(Debug)]
pub struct SkillListingCache {
    entries: BoundedMap<SkillListingCacheKey, Vec<SkillListingEntry>>,
    sent_names: BoundedMap<String, HashSet<String>>,
    stats: CacheStats,
    last_delta: SkillListingDeltaStats,
}

impl Default for SkillListingCache {
    fn default() -> Self {
        Self {
            entries: BoundedMap::new(MAX_SKILL_LISTING_CACHE_ENTRIES),
            sent_names: BoundedMap::new(MAX_SKILL_SENT_AGENT_ENTRIES),
            stats: CacheStats::default(),
            last_delta: SkillListingDeltaStats::default(),
        }
    }
}

impl SkillListingCache {
    pub fn get(&mut self, key: &SkillListingCacheKey) -> Option<Vec<SkillListingEntry>> {
        let value = self.entries.get(key).cloned();
        if value.is_some() {
            self.stats.hits += 1;
        } else {
            self.stats.misses += 1;
        }
        value
    }

    pub fn insert(&mut self, key: SkillListingCacheKey, listing: Vec<SkillListingEntry>) {
        self.entries.insert(key, listing);
        self.stats.entries = self.entries.len();
    }

    /// Return the listing entries to render for this request.
    ///
    /// The skill listing rides the volatile per-request dynamic sections,
    /// which are rebuilt fresh every request and never persisted into
    /// conversation history. An unseen-only delta on that surface makes the
    /// catalog vanish after the first request (turn 2+ would carry no skill
    /// names anywhere), so the FULL catalog is returned every time; the
    /// rendered section is stable text, so the provider prompt cache absorbs
    /// the repeat. `sent_names` is kept purely for delta stats (how many
    /// names are new to this agent vs. already seen).
    pub fn new_entries_for_agent(
        &mut self,
        agent_key: &str,
        entries: &[SkillListingEntry],
    ) -> Vec<SkillListingEntry> {
        let mut sent = self
            .sent_names
            .get(&agent_key.to_string())
            .cloned()
            .unwrap_or_default();
        let new_count = entries
            .iter()
            .filter(|entry| sent.insert(entry.name.clone()))
            .count();
        let sent_count = sent.len();
        self.sent_names.insert(agent_key.to_string(), sent);
        self.last_delta = SkillListingDeltaStats {
            scanned_count: entries.len(),
            new_count,
            sent_count,
            suppressed: entries.is_empty(),
        };
        entries.to_vec()
    }

    /// Historical resume hook, now a no-op: the listing surface is volatile
    /// (never persisted into the transcript), so a resumed session has no
    /// listing in history — suppressing the next render would blind the
    /// model to the catalog for that request.
    pub fn suppress_next_listing(&mut self) {}

    pub fn clear_catalog(&mut self) {
        self.entries.clear();
        self.stats.entries = 0;
        self.stats.reset_counts();
    }

    pub fn clear_all(&mut self) {
        self.entries.clear();
        self.sent_names.clear();
        self.last_delta = SkillListingDeltaStats::default();
        self.stats.entries = 0;
        self.stats.reset_counts();
    }

    pub fn clear(&mut self) {
        self.clear_all();
    }

    pub fn stats(&self) -> CacheStats {
        CacheStats {
            entries: self.entries.len(),
            ..self.stats
        }
    }

    pub fn last_delta_stats(&self) -> SkillListingDeltaStats {
        self.last_delta.clone()
    }

    pub fn reset_stats(&mut self) {
        self.stats.reset_counts();
        self.stats.entries = self.entries.len();
        self.last_delta = SkillListingDeltaStats::default();
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.entries.len()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct LearningsPromptCacheKey {
    agent_scope: String,
    row_count: u64,
    revision: Option<String>,
}

impl LearningsPromptCacheKey {
    pub fn new(agent_scope: impl Into<String>, row_count: u64, revision: Option<String>) -> Self {
        Self {
            agent_scope: agent_scope.into(),
            row_count,
            revision,
        }
    }
}

#[derive(Debug)]
pub struct LearningsPromptCache {
    entries: BoundedMap<LearningsPromptCacheKey, Option<String>>,
    stats: CacheStats,
}

impl Default for LearningsPromptCache {
    fn default() -> Self {
        Self {
            entries: BoundedMap::new(MAX_LEARNINGS_CACHE_ENTRIES),
            stats: CacheStats::default(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RenderedSystemBlockScope {
    Global,
    Org,
    Session,
    Volatile,
}

impl RenderedSystemBlockScope {
    pub fn is_cacheable(self) -> bool {
        !matches!(self, RenderedSystemBlockScope::Volatile)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            RenderedSystemBlockScope::Global => "global",
            RenderedSystemBlockScope::Org => "org",
            RenderedSystemBlockScope::Session => "session",
            RenderedSystemBlockScope::Volatile => "volatile",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderedSystemBlock {
    pub text: String,
    pub cache_scope: RenderedSystemBlockScope,
}

impl RenderedSystemBlock {
    pub fn new(text: impl Into<String>, cache_scope: RenderedSystemBlockScope) -> Self {
        Self {
            text: text.into(),
            cache_scope,
        }
    }
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheBreakSample {
    pub system_hash: u64,
    pub tools_hash: u64,
    pub model_hash: u64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub prompt_tokens: i64,
    pub broke_cache: bool,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheBreakStats {
    pub samples: usize,
    pub breaks: u64,
    pub last: Option<CacheBreakSample>,
}

#[derive(Debug, Default)]
pub struct PromptCacheBreakTracker {
    samples: VecDeque<CacheBreakSample>,
    breaks: u64,
}

/// Build the per-turn volatile context reminder message.
///
/// A `user`-role message wrapping the volatile system-prompt body + dynamic
/// sections in `<system-reminder>` tags. Appended AFTER the conversation
/// history so the ever-changing content sits past the sliding prompt-cache
/// breakpoint instead of invalidating the prefix. The content block carries
/// a `volatile` cache-scope marker so providers can (a) skip it when
/// placing the trailing cache breakpoint and (b) strip the marker before
/// the wire.
pub fn volatile_context_reminder_message(text: &str) -> Value {
    serde_json::json!({
        "role": "user",
        "content": [{
            "type": "text",
            "text": format!(
                "<system-reminder>\nThe following is per-turn session context (environment, IDE state, mode, reminders). It is not a message from the user — do not respond to it directly; apply it to the user's actual request.\n\n{}\n</system-reminder>",
                text
            ),
            (ORGII_SYSTEM_CACHE_SCOPE_KEY): RenderedSystemBlockScope::Volatile.as_str(),
        }],
    })
}

/// Attach the per-turn volatile context reminder to the message list.
///
/// Normal case: appended as a trailing `<system-reminder>` user message
/// (see [`volatile_context_reminder_message`]).
///
/// Shape guard: when the history ends with a `role:"tool"` result (turn
/// resumed after a cancel, force-send behind tool results, …), a synthetic
/// user message directly after a tool result creates a "tool_result followed
/// by a lone Human turn" shape that teaches the model to stop prematurely
/// (reference harness folds reminder siblings into the tool_result for the
/// same reason — their #21049 A/B). In that case the reminder text is folded
/// into the trailing tool result's content instead. In-memory only — the
/// persisted transcript never contains the reminder either way.
pub fn attach_volatile_context_reminder(messages: &mut Vec<Value>, text: &str) {
    let last_is_tool_result = messages
        .last()
        .and_then(|m| m.get("role"))
        .and_then(Value::as_str)
        == Some("tool");

    if last_is_tool_result {
        if let Some(last) = messages.last_mut() {
            if let Some(existing) = last.get("content").and_then(Value::as_str) {
                let folded = format!(
                    "{}\n\n<system-reminder>\nThe following is per-turn session context (environment, IDE state, mode, reminders). It is not part of the tool result above and not a message from the user — apply it to the user's actual request.\n\n{}\n</system-reminder>",
                    existing, text
                );
                last["content"] = Value::String(folded);
                // The fold rewrites this message's bytes every turn — mark it
                // volatile so the provider's sliding cache breakpoint (BP3)
                // never lands on it (providers strip the marker before wire).
                last[ORGII_SYSTEM_CACHE_SCOPE_KEY] =
                    Value::String(RenderedSystemBlockScope::Volatile.as_str().to_string());
                return;
            }
        }
    }

    messages.push(volatile_context_reminder_message(text));
}

pub fn rendered_system_blocks_from_messages(messages: &[Value]) -> Vec<RenderedSystemBlock> {
    let mut blocks = Vec::new();
    for message in messages {
        if message.get("role").and_then(Value::as_str) != Some("system") {
            continue;
        }
        if let Some(content_blocks) = message.get("content").and_then(Value::as_array) {
            for block in content_blocks {
                let Some(text) = block.get("text").and_then(Value::as_str) else {
                    continue;
                };
                let scope = block
                    .get(ORGII_SYSTEM_CACHE_SCOPE_KEY)
                    .and_then(Value::as_str)
                    .and_then(parse_rendered_system_block_scope)
                    .unwrap_or(RenderedSystemBlockScope::Volatile);
                blocks.push(RenderedSystemBlock::new(text, scope));
            }
        } else if let Some(text) = message.get("content").and_then(Value::as_str) {
            blocks.push(RenderedSystemBlock::new(
                text,
                RenderedSystemBlockScope::Session,
            ));
        }
    }
    blocks
}

fn parse_rendered_system_block_scope(raw: &str) -> Option<RenderedSystemBlockScope> {
    match raw {
        "global" => Some(RenderedSystemBlockScope::Global),
        "org" => Some(RenderedSystemBlockScope::Org),
        "session" => Some(RenderedSystemBlockScope::Session),
        "volatile" => Some(RenderedSystemBlockScope::Volatile),
        _ => None,
    }
}

impl PromptCacheBreakTracker {
    pub fn record(
        &mut self,
        system_blocks: &[RenderedSystemBlock],
        tools: Option<&[Value]>,
        model: &str,
        prompt_tokens: i64,
        cache_read_tokens: i64,
        cache_write_tokens: i64,
    ) -> CacheBreakSample {
        let system_hash =
            stable_hash_json(&serde_json::to_value(system_blocks).unwrap_or(Value::Null));
        let tools_hash = stable_hash_json(&serde_json::to_value(tools).unwrap_or(Value::Null));
        let model_hash = stable_hash_text(model);
        let has_cacheable_blocks = system_blocks
            .iter()
            .any(|block| block.cache_scope.is_cacheable());
        let broke_cache = has_cacheable_blocks
            && cache_read_tokens == 0
            && cache_write_tokens > 0
            && self.samples.back().is_some_and(|previous| {
                previous.system_hash == system_hash
                    && previous.tools_hash == tools_hash
                    && previous.model_hash == model_hash
            });

        if broke_cache {
            self.breaks += 1;
        }

        let sample = CacheBreakSample {
            system_hash,
            tools_hash,
            model_hash,
            cache_read_tokens,
            cache_write_tokens,
            prompt_tokens,
            broke_cache,
        };
        self.samples.push_back(sample.clone());
        while self.samples.len() > MAX_CACHE_BREAK_SAMPLES {
            self.samples.pop_front();
        }
        sample
    }

    pub fn stats(&self) -> CacheBreakStats {
        CacheBreakStats {
            samples: self.samples.len(),
            breaks: self.breaks,
            last: self.samples.back().cloned(),
        }
    }

    pub fn clear(&mut self) {
        self.samples.clear();
        self.breaks = 0;
    }
}

// ── Git branch volatile cache ────────────────────────────────────────────────

/// Short-lived cache for `git rev-parse --abbrev-ref HEAD` results.
///
/// Each process call takes ~5–30ms; with many prompt builds per turn this
/// adds up. We cache per repo-path with a 150ms TTL, which is short enough
/// that branch switches mid-session are reflected within one user turn.
const GIT_BRANCH_CACHE_TTL: Duration = Duration::from_millis(150);

struct GitBranchEntry {
    branch: Option<String>,
    fetched_at: Instant,
}

/// Process-wide cache for git branch reads. Wrapped in `Arc<Mutex<_>>` so
/// it can be accessed from multiple async contexts without session state.
#[derive(Clone, Default)]
pub struct GitBranchCache {
    inner: Arc<Mutex<HashMap<PathBuf, GitBranchEntry>>>,
}

impl GitBranchCache {
    pub fn get_or_fetch(&self, repo_path: &Path) -> Option<String> {
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(entry) = guard.get(repo_path) {
            if entry.fetched_at.elapsed() < GIT_BRANCH_CACHE_TTL {
                return entry.branch.clone();
            }
        }
        let branch = git::git_command()
            .ok()
            .and_then(|mut command| {
                command
                    .args(["rev-parse", "--abbrev-ref", "HEAD"])
                    .current_dir(repo_path)
                    .output()
                    .ok()
            })
            .filter(|out| out.status.success())
            .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string());
        guard.insert(
            repo_path.to_path_buf(),
            GitBranchEntry {
                branch: branch.clone(),
                fetched_at: Instant::now(),
            },
        );
        branch
    }
}

fn stable_hash_text(text: &str) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut hasher);
    hasher.finish()
}

fn stable_hash_json(value: &Value) -> u64 {
    stable_hash_text(&serde_json::to_string(value).unwrap_or_default())
}

impl LearningsPromptCache {
    pub fn get(&mut self, key: &LearningsPromptCacheKey) -> Option<Option<String>> {
        let value = self.entries.get(key).cloned();
        if value.is_some() {
            self.stats.hits += 1;
        } else {
            self.stats.misses += 1;
        }
        value
    }

    pub fn insert(&mut self, key: LearningsPromptCacheKey, content: Option<String>) {
        self.entries.insert(key, content);
        self.stats.entries = self.entries.len();
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.stats.entries = 0;
        self.stats.reset_counts();
    }

    pub fn stats(&self) -> CacheStats {
        CacheStats {
            entries: self.entries.len(),
            ..self.stats
        }
    }

    pub fn reset_stats(&mut self) {
        self.stats.reset_counts();
        self.stats.entries = self.entries.len();
    }
}

#[cfg(test)]
mod tests {
    use super::{
        attach_volatile_context_reminder, rendered_system_blocks_from_messages,
        PromptCacheBreakTracker, RenderedSystemBlockScope, SkillListingCache, SkillListingCacheKey,
        ORGII_SYSTEM_CACHE_SCOPE_KEY,
    };
    use crate::skills::loader::SkillListingEntry;
    use std::path::Path;

    #[test]
    fn skill_listing_cache_key_normalizes_filter_order() {
        let disabled_a = vec!["beta".to_string(), "alpha".to_string(), "alpha".to_string()];
        let include_a = vec![
            "gamma".to_string(),
            "alpha".to_string(),
            "gamma".to_string(),
        ];
        let disabled_b = vec!["alpha".to_string(), "beta".to_string()];
        let include_b = vec!["alpha".to_string(), "gamma".to_string()];

        let first = SkillListingCacheKey::new(
            Path::new("/tmp/project"),
            &disabled_a,
            Some(&include_a),
            "agent-a",
            None,
            true,
        );
        let second = SkillListingCacheKey::new(
            Path::new("/tmp/project"),
            &disabled_b,
            Some(&include_b),
            "agent-a",
            None,
            true,
        );

        assert_eq!(first, second);
    }

    #[test]
    fn skill_listing_cache_distinguishes_empty_filter_from_no_filter() {
        let disabled: Vec<String> = Vec::new();
        let empty_include: Vec<String> = Vec::new();
        let no_filter = SkillListingCacheKey::new(
            Path::new("/tmp/project"),
            &disabled,
            None,
            "agent-a",
            None,
            true,
        );
        let empty_filter = SkillListingCacheKey::new(
            Path::new("/tmp/project"),
            &disabled,
            Some(&empty_include),
            "agent-a",
            None,
            true,
        );

        assert_ne!(no_filter, empty_filter);
    }

    #[test]
    fn skill_listing_cache_is_scoped_by_org() {
        let org_a = SkillListingCacheKey::new(
            Path::new("/tmp/project"),
            &[],
            None,
            "agent-a",
            Some("org-a"),
            true,
        );
        let org_b = SkillListingCacheKey::new(
            Path::new("/tmp/project"),
            &[],
            None,
            "agent-a",
            Some("org-b"),
            true,
        );

        assert_ne!(org_a, org_b);
    }

    fn listing_entry(name: &str) -> SkillListingEntry {
        SkillListingEntry {
            name: name.to_string(),
            source: "workspace".to_string(),
            description: format!("{name} description"),
            available: true,
        }
    }

    #[test]
    fn skill_listing_returns_full_catalog_every_request() {
        // The listing rides a volatile per-request surface (never persisted
        // into history), so every request must carry the full catalog; only
        // the delta STATS track seen vs. unseen names.
        let key =
            SkillListingCacheKey::new(Path::new("/tmp/project"), &[], None, "agent-a", None, true);
        let mut cache = SkillListingCache::default();
        let entries = vec![listing_entry("alpha"), listing_entry("beta")];

        assert_eq!(cache.get(&key), None);
        cache.insert(key.clone(), entries.clone());
        assert_eq!(cache.get(&key), Some(entries.clone()));
        assert_eq!(cache.len(), 1);

        assert_eq!(cache.new_entries_for_agent("agent:one", &entries), entries);
        let first = cache.last_delta_stats();
        assert_eq!(first.new_count, 2);
        assert_eq!(first.sent_count, 2);
        assert!(!first.suppressed);

        let cached_entries = cache.get(&key).unwrap();
        assert_eq!(
            cache.new_entries_for_agent("agent:one", &cached_entries),
            entries,
            "turn 2+ must still see the full listing",
        );
        let second = cache.last_delta_stats();
        assert_eq!(second.new_count, 0);
        assert_eq!(second.sent_count, 2);
        assert!(!second.suppressed);
    }

    #[test]
    fn skill_listing_resume_does_not_blind_the_model() {
        // Resume used to suppress the next render on the (wrong) assumption
        // that the listing was already in the transcript; the surface is
        // volatile, so suppression must be a no-op.
        let mut cache = SkillListingCache::default();
        let entries = vec![listing_entry("alpha")];
        cache.suppress_next_listing();
        assert_eq!(cache.new_entries_for_agent("agent:one", &entries), entries);
        assert!(!cache.last_delta_stats().suppressed);
    }

    #[test]
    fn rendered_system_blocks_from_messages_preserves_cache_scope() {
        let messages = vec![serde_json::json!({
            "role": "system",
            "content": [{
                "type": "text",
                "text": "stable",
                (ORGII_SYSTEM_CACHE_SCOPE_KEY): "session"
            }]
        })];
        let blocks = rendered_system_blocks_from_messages(&messages);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].text, "stable");
        assert_eq!(blocks[0].cache_scope, RenderedSystemBlockScope::Session);
    }

    #[test]
    fn cache_break_tracker_flags_recreation_without_read_for_same_prefix() {
        let messages = vec![serde_json::json!({
            "role": "system",
            "content": [{
                "type": "text",
                "text": "stable",
                (ORGII_SYSTEM_CACHE_SCOPE_KEY): "session"
            }]
        })];
        let blocks = rendered_system_blocks_from_messages(&messages);
        let tools = vec![serde_json::json!({"name": "read_file"})];
        let mut tracker = PromptCacheBreakTracker::default();
        let first = tracker.record(&blocks, Some(&tools), "model", 100, 0, 100);
        assert!(!first.broke_cache);
        let second = tracker.record(&blocks, Some(&tools), "model", 100, 0, 90);
        assert!(second.broke_cache);
        assert_eq!(tracker.stats().breaks, 1);
    }

    /// Shape guard: trailing tool result absorbs the reminder (no synthetic
    /// Human turn after a tool_result), gets the volatile marker, and the
    /// message count stays unchanged.
    #[test]
    fn volatile_reminder_folds_into_trailing_tool_result() {
        let mut messages = vec![
            serde_json::json!({"role": "assistant", "content": "calling tool"}),
            serde_json::json!({
                "role": "tool",
                "tool_call_id": "call_1",
                "name": "run_shell",
                "content": "tool output here"
            }),
        ];
        attach_volatile_context_reminder(&mut messages, "## Environment\nfoo");

        assert_eq!(messages.len(), 2, "must not append a new message");
        let last = &messages[1];
        assert_eq!(last["role"], "tool");
        let content = last["content"].as_str().unwrap();
        assert!(content.starts_with("tool output here"));
        assert!(content.contains("<system-reminder>"));
        assert!(content.contains("## Environment\nfoo"));
        assert_eq!(
            last[ORGII_SYSTEM_CACHE_SCOPE_KEY], "volatile",
            "folded tool message must be excluded from the sliding cache breakpoint"
        );
    }

    #[test]
    fn volatile_reminder_appends_user_message_when_history_ends_with_user_or_assistant() {
        for tail in [
            serde_json::json!({"role": "user", "content": "hi"}),
            serde_json::json!({"role": "assistant", "content": "done"}),
        ] {
            let mut messages = vec![tail];
            attach_volatile_context_reminder(&mut messages, "ctx");
            assert_eq!(messages.len(), 2, "must append a reminder message");
            assert_eq!(messages[1]["role"], "user");
            let text = messages[1]["content"][0]["text"].as_str().unwrap();
            assert!(text.contains("<system-reminder>"));
            assert!(text.contains("ctx"));
        }
    }
}
