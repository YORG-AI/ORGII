//! Flow Awareness activity store.

use std::collections::{HashMap, VecDeque};
use std::sync::{LazyLock, RwLock};

use chrono::{Duration, Utc};

use super::types::*;

/// Maximum number of activities to keep per session.
const MAX_ACTIVITIES_PER_SESSION: usize = 100;

/// Maximum number of activities to keep globally (no session).
const MAX_GLOBAL_ACTIVITIES: usize = 200;

/// Maximum age of activities to consider (5 minutes).
const MAX_ACTIVITY_AGE_SECS: i64 = 300;

/// Limits for summary generation.
mod summary_limits {
    pub const MAX_FILE_ENTRIES: usize = 5;
    pub const MAX_COMMAND_ENTRIES: usize = 3;
    pub const MAX_SEARCH_ENTRIES: usize = 3;
    pub const MAX_ERROR_ENTRIES: usize = 3;
    pub const MAX_COMMAND_DISPLAY_CHARS: usize = 60;
    pub const MAX_ERROR_DISPLAY_CHARS: usize = 80;
    pub const MAX_PATH_COMPONENTS: usize = 3;
}

/// Global flow awareness store.
pub static GLOBAL_FLOW_STORE: LazyLock<FlowStore> = LazyLock::new(FlowStore::new);

/// Thread-safe activity store with FIFO eviction.
pub struct FlowStore {
    /// Per-session activities.
    sessions: RwLock<HashMap<String, VecDeque<Activity>>>,
    /// Global activities (no session association).
    global: RwLock<VecDeque<Activity>>,
}

impl FlowStore {
    /// Create a new empty store.
    pub fn new() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            global: RwLock::new(VecDeque::with_capacity(MAX_GLOBAL_ACTIVITIES)),
        }
    }

    /// Get the global store instance.
    pub fn global() -> &'static FlowStore {
        &GLOBAL_FLOW_STORE
    }

    /// Record an activity.
    pub fn record(&self, activity: Activity) {
        // Clone session_id before moving activity to avoid borrow conflict
        let session_id = activity.session_id.clone();
        if let Some(ref sid) = session_id {
            self.record_session(sid, activity);
        } else {
            self.record_global(activity);
        }
    }

    /// Record a session-scoped activity.
    fn record_session(&self, session_id: &str, activity: Activity) {
        match self.sessions.write() {
            Ok(mut sessions) => {
                let queue = sessions
                    .entry(session_id.to_string())
                    .or_insert_with(|| VecDeque::with_capacity(MAX_ACTIVITIES_PER_SESSION));

                // FIFO eviction
                if queue.len() >= MAX_ACTIVITIES_PER_SESSION {
                    queue.pop_front();
                }
                queue.push_back(activity);
            }
            Err(poisoned) => {
                // Log the error and attempt recovery
                eprintln!(
                    "[FlowStore] Session store poisoned, attempting recovery: {}",
                    poisoned
                );
                let mut sessions = poisoned.into_inner();
                sessions.clear(); // Reset store to avoid inconsistent state
                let queue = sessions
                    .entry(session_id.to_string())
                    .or_insert_with(|| VecDeque::with_capacity(MAX_ACTIVITIES_PER_SESSION));
                queue.push_back(activity);
            }
        }
    }

    /// Record a global (non-session) activity.
    fn record_global(&self, activity: Activity) {
        match self.global.write() {
            Ok(mut global) => {
                // FIFO eviction
                if global.len() >= MAX_GLOBAL_ACTIVITIES {
                    global.pop_front();
                }
                global.push_back(activity);
            }
            Err(poisoned) => {
                // Log the error and attempt recovery
                eprintln!(
                    "[FlowStore] Global store poisoned, attempting recovery: {}",
                    poisoned
                );
                let mut global = poisoned.into_inner();
                global.clear(); // Reset store to avoid inconsistent state
                global.push_back(activity);
            }
        }
    }

    /// Get recent activities for a session (or global if session_id is None).
    pub fn get_recent(
        &self,
        session_id: Option<&str>,
        max_count: usize,
        max_age_secs: Option<i64>,
    ) -> Vec<Activity> {
        let max_age = max_age_secs.unwrap_or(MAX_ACTIVITY_AGE_SECS);
        let cutoff = Utc::now() - Duration::seconds(max_age);

        let activities = if let Some(sid) = session_id {
            match self.sessions.read() {
                Ok(sessions) => sessions
                    .get(sid)
                    .map(|queue| queue.iter().cloned().collect::<Vec<_>>())
                    .unwrap_or_default(),
                Err(err) => {
                    // RwLock poisoning means a previous writer panicked while
                    // holding the lock. Silently returning an empty list
                    // would make the LLM see "no recent activity" with no
                    // way to distinguish that from a genuinely idle session
                    // — and the underlying panic would never surface.
                    tracing::warn!(
                        session_id = %sid,
                        error = %err,
                        "flow_awareness::get_recent: sessions RwLock poisoned; recent activity unavailable"
                    );
                    Vec::new()
                }
            }
        } else {
            match self.global.read() {
                Ok(global) => global.iter().cloned().collect(),
                Err(err) => {
                    tracing::warn!(
                        error = %err,
                        "flow_awareness::get_recent: global RwLock poisoned; recent activity unavailable"
                    );
                    Vec::new()
                }
            }
        };

        // Filter by age and take most recent
        activities
            .into_iter()
            .filter(|a| a.timestamp >= cutoff)
            .rev()
            .take(max_count)
            .collect()
    }

    /// Get activities from both session and global stores.
    pub fn get_combined(
        &self,
        session_id: Option<&str>,
        max_count: usize,
        max_age_secs: Option<i64>,
    ) -> Vec<Activity> {
        let max_age = max_age_secs.unwrap_or(MAX_ACTIVITY_AGE_SECS);
        let cutoff = Utc::now() - Duration::seconds(max_age);

        let mut all_activities: Vec<Activity> = Vec::new();

        // Add session activities if session_id provided
        if let Some(sid) = session_id {
            match self.sessions.read() {
                Ok(sessions) => {
                    if let Some(queue) = sessions.get(sid) {
                        all_activities.extend(queue.iter().cloned());
                    }
                }
                Err(err) => {
                    tracing::warn!(
                        session_id = %sid,
                        error = %err,
                        "flow_awareness::get_combined: sessions RwLock poisoned; session activity excluded"
                    );
                }
            }
        }

        // Add global activities
        match self.global.read() {
            Ok(global) => {
                all_activities.extend(global.iter().cloned());
            }
            Err(err) => {
                tracing::warn!(
                    error = %err,
                    "flow_awareness::get_combined: global RwLock poisoned; global activity excluded"
                );
            }
        }

        // Filter by age, sort by timestamp (newest first), take max_count
        all_activities.retain(|a| a.timestamp >= cutoff);
        all_activities.sort_by_key(|activity| std::cmp::Reverse(activity.timestamp));
        all_activities.truncate(max_count);

        all_activities
    }

    /// Clear all activities for a session.
    pub fn clear_session(&self, session_id: &str) {
        if let Ok(mut sessions) = self.sessions.write() {
            sessions.remove(session_id);
        }
    }

    /// Clear all global activities.
    pub fn clear_global(&self) {
        if let Ok(mut global) = self.global.write() {
            global.clear();
        }
    }

    /// Generate a flow summary from recent activities.
    pub fn summarize(&self, session_id: Option<&str>, max_activities: usize) -> FlowSummary {
        let activities = self.get_combined(session_id, max_activities, None);

        let mut summary = FlowSummary::default();

        let mut file_edits: Vec<String> = Vec::new();
        let mut file_opens: Vec<String> = Vec::new();
        let mut commands: Vec<String> = Vec::new();
        let mut searches: Vec<String> = Vec::new();
        let mut errors: Vec<String> = Vec::new();

        let mut edit_count = 0u32;
        let mut open_count = 0u32;
        let mut command_count = 0u32;
        let mut error_count = 0u32;
        let mut debug_count = 0u32;
        let mut git_count = 0u32;
        let mut search_count = 0u32;

        for activity in &activities {
            match &activity.activity_type {
                ActivityType::FileEdit { path, .. } => {
                    edit_count += 1;
                    if !file_edits.contains(path)
                        && file_edits.len() < summary_limits::MAX_FILE_ENTRIES
                    {
                        file_edits.push(path.clone());
                    }
                }
                ActivityType::FileOpen { path } => {
                    open_count += 1;
                    if !file_opens.contains(path)
                        && file_opens.len() < summary_limits::MAX_FILE_ENTRIES
                    {
                        file_opens.push(path.clone());
                    }
                }
                ActivityType::TerminalCommand { command, .. } => {
                    command_count += 1;
                    if commands.len() < summary_limits::MAX_COMMAND_ENTRIES {
                        commands.push(truncate_command(
                            command,
                            summary_limits::MAX_COMMAND_DISPLAY_CHARS,
                        ));
                    }
                }
                ActivityType::Search { query, .. } => {
                    search_count += 1;
                    if searches.len() < summary_limits::MAX_SEARCH_ENTRIES {
                        searches.push(query.clone());
                    }
                }
                ActivityType::Error { message, .. } => {
                    error_count += 1;
                    if errors.len() < summary_limits::MAX_ERROR_ENTRIES {
                        errors.push(truncate_command(
                            message,
                            summary_limits::MAX_ERROR_DISPLAY_CHARS,
                        ));
                    }
                }
                ActivityType::Debug { .. } => {
                    debug_count += 1;
                }
                ActivityType::GitOperation { .. } => {
                    git_count += 1;
                }
                ActivityType::Clipboard { .. } | ActivityType::Navigation { .. } => {}
            }
        }

        summary.recent_edits = file_edits;
        summary.recent_opens = file_opens;
        summary.recent_commands = commands;
        summary.recent_searches = searches;
        summary.current_errors = errors;

        // Infer intent based on activity patterns
        summary.intent = Some(infer_intent(
            edit_count,
            open_count,
            command_count,
            error_count,
            debug_count,
            git_count,
            search_count,
        ));

        // Calculate idle time
        if let Some(most_recent) = activities.first() {
            let idle = Utc::now() - most_recent.timestamp;
            summary.idle_seconds = Some(idle.num_seconds().max(0) as u64);
        }

        summary
    }

    /// Format flow context as a string for system prompt injection.
    pub fn format_context(&self, session_id: Option<&str>, max_activities: usize) -> String {
        let summary = self.summarize(session_id, max_activities);
        format_summary(&summary)
    }
}

impl Default for FlowStore {
    fn default() -> Self {
        Self::new()
    }
}

/// Truncate a command/message for display (UTF-8 safe).
fn truncate_command(s: &str, max_len: usize) -> String {
    let trimmed = s.trim();
    if trimmed.len() <= max_len {
        trimmed.to_string()
    } else {
        // Find a valid char boundary
        let mut end = max_len;
        while end > 0 && !trimmed.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}...", &trimmed[..end])
    }
}

/// Intent inference thresholds.
mod intent_thresholds {
    pub const MIN_DEBUG_ACTIONS_FOR_DEBUG: u32 = 2;
    pub const MIN_GIT_OPS_FOR_VERSION_CONTROL: u32 = 3;
    pub const MIN_COMMANDS_FOR_TESTING: u32 = 3;
    pub const MAX_EDITS_FOR_TESTING: u32 = 3;
    pub const MIN_SEARCHES_FOR_EXPLORING: u32 = 2;
    pub const MIN_OPENS_FOR_EXPLORING: u32 = 5;
    pub const MAX_EDITS_FOR_EXPLORING: u32 = 2;
    pub const MIN_OPENS_FOR_REVIEWING: u32 = 3;
    pub const MIN_EDITS_FOR_WRITING: u32 = 3;
    pub const MIN_EDITS_FOR_REFACTORING: u32 = 1;
    pub const MIN_OPENS_FOR_REFACTORING: u32 = 1;
}

/// Infer user intent from activity counts.
fn infer_intent(
    edits: u32,
    opens: u32,
    commands: u32,
    errors: u32,
    debug_actions: u32,
    git_ops: u32,
    searches: u32,
) -> InferredIntent {
    use intent_thresholds::*;

    // Debugging: errors + debug actions dominate
    if errors > 0 || debug_actions > MIN_DEBUG_ACTIONS_FOR_DEBUG {
        return InferredIntent::Debugging;
    }

    // Version control: git operations dominate
    if git_ops > MIN_GIT_OPS_FOR_VERSION_CONTROL {
        return InferredIntent::VersionControl;
    }

    // Testing: lots of commands with few edits
    if commands > MIN_COMMANDS_FOR_TESTING && edits < MAX_EDITS_FOR_TESTING {
        return InferredIntent::Testing;
    }

    // Exploring: searches + opens dominate edits
    if searches > MIN_SEARCHES_FOR_EXPLORING
        || (opens > MIN_OPENS_FOR_EXPLORING && edits < MAX_EDITS_FOR_EXPLORING)
    {
        return InferredIntent::Exploring;
    }

    // Reviewing: many opens, few edits
    if opens > MIN_OPENS_FOR_REVIEWING && edits == 0 {
        return InferredIntent::Reviewing;
    }

    // Writing: edits dominate
    if edits > MIN_EDITS_FOR_WRITING {
        return InferredIntent::Writing;
    }

    // Refactoring: edits across multiple files (checked by caller if needed)
    // For now, moderate edits with some opens
    if edits > MIN_EDITS_FOR_REFACTORING && opens > MIN_OPENS_FOR_REFACTORING {
        return InferredIntent::Refactoring;
    }

    InferredIntent::Unknown
}

/// Human-readable descriptions for intents.
impl InferredIntent {
    pub fn as_activity_description(&self) -> &'static str {
        match self {
            InferredIntent::Debugging => "debugging an issue",
            InferredIntent::Refactoring => "refactoring code",
            InferredIntent::Exploring => "exploring the codebase",
            InferredIntent::Writing => "writing new code",
            InferredIntent::Reviewing => "reviewing code",
            InferredIntent::Testing => "running tests or builds",
            InferredIntent::VersionControl => "working with git",
            InferredIntent::Unknown => "working",
        }
    }
}

/// Format a FlowSummary as a human-readable string for system prompts.
fn format_summary(summary: &FlowSummary) -> String {
    let mut parts: Vec<String> = Vec::new();

    // Intent
    if let Some(ref intent) = summary.intent {
        if *intent != InferredIntent::Unknown {
            parts.push(format!(
                "- User appears to be **{}**",
                intent.as_activity_description()
            ));
        }
    }

    // Recent edits
    if !summary.recent_edits.is_empty() {
        let files: Vec<String> = summary
            .recent_edits
            .iter()
            .map(|f| format!("`{}`", shorten_path(f)))
            .collect();
        parts.push(format!("- Recently edited: {}", files.join(", ")));
    }

    // Recent opens (only if different from edits)
    let opens_not_in_edits: Vec<&String> = summary
        .recent_opens
        .iter()
        .filter(|f| !summary.recent_edits.contains(f))
        .collect();
    if !opens_not_in_edits.is_empty() {
        let files: Vec<String> = opens_not_in_edits
            .iter()
            .take(3)
            .map(|f| format!("`{}`", shorten_path(f)))
            .collect();
        parts.push(format!("- Also viewing: {}", files.join(", ")));
    }

    // Recent commands
    if !summary.recent_commands.is_empty() {
        let cmds: Vec<String> = summary
            .recent_commands
            .iter()
            .map(|c| format!("`{}`", c))
            .collect();
        parts.push(format!("- Recent commands: {}", cmds.join(", ")));
    }

    // Recent searches
    if !summary.recent_searches.is_empty() {
        let queries: Vec<String> = summary
            .recent_searches
            .iter()
            .map(|q| format!("\"{}\"", q))
            .collect();
        parts.push(format!("- Searched for: {}", queries.join(", ")));
    }

    // Current errors
    if !summary.current_errors.is_empty() {
        parts.push(format!(
            "- Encountering errors:\n  - {}",
            summary.current_errors.join("\n  - ")
        ));
    }

    if parts.is_empty() {
        return String::new();
    }

    format!("## User Activity Context\n\n{}", parts.join("\n"))
}

/// Shorten a file path for display (keep last components).
fn shorten_path(path: &str) -> String {
    let components: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    if components.len() <= summary_limits::MAX_PATH_COMPONENTS {
        path.to_string()
    } else {
        components[components.len() - summary_limits::MAX_PATH_COMPONENTS..].join("/")
    }
}
