//! Pure UI-routing enums shared between the agent runtime and the CLI
//! alias table.
//!
//! These two enums (`AppSubtool` and `ChatBlock`) are referenced from
//! both `agent_core::core::tools::ui_metadata` (for built-in tool
//! metadata) and `core_types::cli_alias` (for the CLI agent alias map),
//! so they live here at the bottom of the dep graph.
//!
//! See `.cursor/rules/session-rendering.mdc` for the full dispatch model.

use serde::{Deserialize, Serialize};

/// Sub-tool category within a simulator app (e.g., shell vs file_read within CODE app).
/// Used by both chat panel and simulator to route events to blocks / panels.
/// See `.cursor/rules/event-rendering.mdc` for the full dispatch model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum AppSubtool {
    /// File read operations (read_file)
    FileRead,
    /// File write/edit/delete operations (edit_file, delete_file, historical apply_patch events).
    /// The `file_write` subtool also covers CLI-agent-emitted delete aliases
    /// routed via the CLI alias map exposed by `init_tool_registry`.
    FileWrite,
    /// Shell/terminal commands (run_shell, await_output)
    Shell,
    /// Directory listing, LSP queries, workspace management
    /// (list_dir, query_lsp, manage_workspace)
    Explore,
    /// Content search results (code_search grep/symbols)
    Search,
    /// File list results (code_search find_files/glob)
    Glob,
    /// External browser navigation and interaction (Playwright/CDP, Chrome)
    Browser,
    /// Internal browser automation (Tauri inline webview)
    InternalBrowser,
    /// Project management
    Project,
    /// Agent messages, user interaction, approval, mode-switch
    #[default]
    Message,
    /// Interactive agent ↔ user widgets that aren't plain chat messages
    /// (ask_user_questions, ask_user_permissions, suggest_mode_switch).
    /// Rendered in the chat panel with dedicated
    /// components; in the Messages replay they appear in their own section
    /// instead of polluting the chat bubble transcript.
    OtherInteractions,
    /// Todo / task list operations
    Todo,
    /// Subagent / session management / spawn
    Subagent,
    /// LLM thinking / reasoning (not a tool — internal model output)
    Thinking,
    /// Generic fallback for tools without a specialized view
    OtherTool,
}

/// Agent Station live display behavior for a tool invocation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ToolDisplayBehavior {
    /// Tool-call args are enough to build the primary UI immediately.
    Instant,
    /// Args plus live output are the primary UI while the tool runs.
    Stream,
    /// Meaningful body content should wait for the final tool result.
    #[default]
    WaitForResult,
}

impl AppSubtool {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::FileRead => "file_read",
            Self::FileWrite => "file_write",
            Self::Shell => "shell",
            Self::Explore => "explore",
            Self::Search => "search",
            Self::Glob => "glob",
            Self::Browser => "browser",
            Self::InternalBrowser => "internal_browser",
            Self::Project => "project",
            Self::Message => "message",
            Self::OtherInteractions => "other_interactions",
            Self::Todo => "todo",
            Self::Subagent => "subagent",
            Self::Thinking => "thinking",
            Self::OtherTool => "other_tool",
        }
    }
}

/// Chat-panel block dispatch key — one variant per actual React block.
///
/// Independent from [`AppSubtool`] (which groups tools into simulator tabs).
/// The chat panel does not need the simulator's tab taxonomy, so each
/// variant here corresponds 1:1 to a block component in
/// `src/engines/ChatPanel/blocks/` and has no dead branches.
///
/// See `.cursor/rules/session-rendering.mdc` for the dispatch model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ChatBlock {
    /// ReadFileBlock — read_file (text/image/pdf)
    ReadFile,
    /// DiffBlock — edit_file, delete_file, historical apply_patch, and CLI-agent delete aliases.
    Diff,
    /// ShellBlock — run_shell, await_output, git/shell passthroughs
    Shell,
    /// ExploreBlock — list_dir, manage_workspace
    Explore,
    /// SearchBlock — code_search grep/symbols
    Search,
    /// GlobBlock — code_search find_files/glob
    Glob,
    /// WebSearchBlock — web_search, web_fetch, browser
    WebSearch,
    /// TodoBlock — manage_todo
    Todo,
    /// OrgTaskBlock — Agent Org task board mutations and reads.
    OrgTask,
    /// SubagentBlock — agent (delegate/shadow/kill), manage_session
    Subagent,
    /// TitleOnlyBlock — header-only row whose title carries the full message.
    TitleOnly,
    /// SentMessageBlock — outbound message bubble plus destination footer.
    SentMessage,
    /// PlanDocBlock — streaming markdown plan card with inline "Build" button
    /// (used by `create_plan`).
    PlanDoc,
    /// Hidden — the tool-call event is filtered out of the chat stream
    /// entirely (used by signal-only tools whose payload is already surfaced
    /// elsewhere in the UI).
    Hidden,
    /// CanvasInlineBlock — render_inline_canvas and revise_inline_canvas
    /// (html / url / a2ui / react modes)
    CanvasInline,
    /// SetupRepoBlock — setup_repo (report_status, update_env, add_env_vars, launch_app)
    SetupRepo,
    /// ToolCallBlock — default fallback for tools without a specialized view
    #[default]
    Fallback,
}

impl ChatBlock {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ReadFile => "read_file",
            Self::Diff => "diff",
            Self::Shell => "shell",
            Self::Explore => "explore",
            Self::Search => "search",
            Self::Glob => "glob",
            Self::WebSearch => "web_search",
            Self::Todo => "todo",
            Self::OrgTask => "org_task",
            Self::Subagent => "subagent",
            Self::TitleOnly => "title_only",
            Self::SentMessage => "sent_message",
            Self::PlanDoc => "plan_doc",
            Self::Hidden => "hidden",
            Self::CanvasInline => "canvas_inline",
            Self::SetupRepo => "setup_repo",
            Self::Fallback => "fallback",
        }
    }
}
