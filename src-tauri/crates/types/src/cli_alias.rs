//! CLI agent tool alias map for frontend UI component routing.
//!
//! Maps CLI agent tool names to canonical forms:
//! - `storage`: Fine-grained canonical name for database storage
//! - `ui`: Coarse canonical name for UI component lookup (UiCanonical enum)
//! - `simulator_app`: Simulator dock routing (CODE_EDITOR, BROWSER, CHANNELS, STORY_MANAGER)
//! - `app_subtool`: Fine-grained panel routing within apps (file_read, shell, search, etc.)
//!
//! This map is only for CLI agents (Cursor, Claude Code, Codex, Gemini, Kiro, Copilot).
//! Rust agents (OS, SDE) use canonical tool names directly and don't need aliasing.

use std::collections::HashMap;
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};

use crate::tool_names;
use crate::ui_metadata::{AppSubtool, ChatBlock};

/// UI canonical component mapping for frontend rendering.
///
/// Each variant maps 1:1 with a frontend component. Frontend uses this to determine
/// which React component renders a given tool event. Serialized as snake_case.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UiCanonical {
    // File operations
    ReadFile,
    EditFile,
    DeleteFile,
    ListDir,
    // Terminal
    RunShell,
    AwaitOutput,
    // Search
    CodeSearch,
    WebSearch,
    GlobFileSearch,
    QueryLsp,
    // Conversation
    AgentMessage,
    Thinking,
    User,
    ConsultAgent,
    AskUserQuestions,
    // Approval
    AskUserPermissions,
    // Subagent / Task
    Subagent,
    SuggestModeSwitch,
    ManageTodo,
    TaskCreate,
    TaskUpdate,
    TaskList,
    TaskGet,
    // Browser
    Browser,
    InternalBrowser,
    // Generic fallback
    ToolCall,
}

impl UiCanonical {
    pub fn as_str(&self) -> &'static str {
        match self {
            UiCanonical::ReadFile => "read_file",
            UiCanonical::EditFile => "edit_file",
            UiCanonical::DeleteFile => "delete_file",
            UiCanonical::ListDir => "list_dir",
            UiCanonical::RunShell => "run_shell",
            UiCanonical::AwaitOutput => tool_names::AWAIT_OUTPUT,
            UiCanonical::CodeSearch => "code_search",
            UiCanonical::WebSearch => "web_search",
            UiCanonical::GlobFileSearch => "glob_file_search",
            UiCanonical::QueryLsp => "query_lsp",
            UiCanonical::AgentMessage => "agent_message",
            UiCanonical::Thinking => "thinking",
            UiCanonical::User => "user",
            UiCanonical::ConsultAgent => "consult_agent",
            UiCanonical::AskUserQuestions => "ask_user_questions",
            UiCanonical::AskUserPermissions => "ask_user_permissions",
            UiCanonical::Subagent => "subagent",
            UiCanonical::SuggestModeSwitch => "suggest_mode_switch",
            UiCanonical::ManageTodo => "manage_todo",
            UiCanonical::TaskCreate => tool_names::TASK_CREATE,
            UiCanonical::TaskUpdate => tool_names::TASK_UPDATE,
            UiCanonical::TaskList => tool_names::TASK_LIST,
            UiCanonical::TaskGet => tool_names::TASK_GET,
            UiCanonical::Browser => "browser",
            UiCanonical::InternalBrowser => "internal_browser",
            UiCanonical::ToolCall => "tool_call",
        }
    }
}

/// Simulator app types (matches `builtin_tools_list::SimulatorApp`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SimApp {
    CodeEditor,
    Browser,
    Channels,
    ProjectManager,
    BackgroundTasks,
}

impl SimApp {
    pub fn as_str(&self) -> &'static str {
        match self {
            SimApp::CodeEditor => "CODE_EDITOR",
            SimApp::Browser => "BROWSER",
            SimApp::Channels => "CHANNELS",
            SimApp::ProjectManager => "STORY_MANAGER",
            SimApp::BackgroundTasks => "BACKGROUND_TASKS",
        }
    }
}

/// Alias entry with canonical names, simulator routing, subtool category, and chat block.
#[derive(Clone, Copy)]
pub struct AliasEntry {
    pub storage: &'static str,
    pub ui: UiCanonical,
    pub simulator_app: SimApp,
    pub app_subtool: AppSubtool,
    pub chat_block: ChatBlock,
}

impl AliasEntry {
    const fn new(
        storage: &'static str,
        ui: UiCanonical,
        app: SimApp,
        subtool: AppSubtool,
        chat_block: ChatBlock,
    ) -> Self {
        Self {
            storage,
            ui,
            simulator_app: app,
            app_subtool: subtool,
            chat_block,
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // File operations (CODE_EDITOR app)
    // ═══════════════════════════════════════════════════════════════════════════

    /// CODE_EDITOR + FileRead → ReadFile UI
    const fn read_file(storage: &'static str) -> Self {
        Self::new(
            storage,
            UiCanonical::ReadFile,
            SimApp::CodeEditor,
            AppSubtool::FileRead,
            ChatBlock::ReadFile,
        )
    }

    /// CODE_EDITOR + FileWrite → EditFile UI
    const fn edit_file(storage: &'static str) -> Self {
        Self::new(
            storage,
            UiCanonical::EditFile,
            SimApp::CodeEditor,
            AppSubtool::FileWrite,
            ChatBlock::Diff,
        )
    }

    /// CODE_EDITOR + FileWrite → DeleteFile UI
    const fn delete_file(storage: &'static str) -> Self {
        Self::new(
            storage,
            UiCanonical::DeleteFile,
            SimApp::CodeEditor,
            AppSubtool::FileWrite,
            ChatBlock::Diff,
        )
    }

    /// CODE_EDITOR + Search → ListDir UI
    const fn list_dir(storage: &'static str) -> Self {
        Self::new(
            storage,
            UiCanonical::ListDir,
            SimApp::CodeEditor,
            AppSubtool::Explore,
            ChatBlock::Explore,
        )
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Terminal (CODE_EDITOR app)
    // ═══════════════════════════════════════════════════════════════════════════

    /// CODE_EDITOR + Shell → RunShell UI
    const fn shell(storage: &'static str) -> Self {
        Self::new(
            storage,
            UiCanonical::RunShell,
            SimApp::CodeEditor,
            AppSubtool::Shell,
            ChatBlock::Shell,
        )
    }

    /// CODE_EDITOR + Shell → Await output wait UI
    const fn await_output() -> Self {
        Self::new(
            tool_names::AWAIT_OUTPUT,
            UiCanonical::AwaitOutput,
            SimApp::CodeEditor,
            AppSubtool::Shell,
            ChatBlock::TitleOnly,
        )
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Search (CODE_EDITOR app)
    // ═══════════════════════════════════════════════════════════════════════════

    /// CODE_EDITOR + Search → CodeSearch UI
    const fn codebase_search(storage: &'static str) -> Self {
        Self::new(
            storage,
            UiCanonical::CodeSearch,
            SimApp::CodeEditor,
            AppSubtool::Explore,
            ChatBlock::Search,
        )
    }

    /// CODE_EDITOR + Search → GlobFileSearch UI
    const fn glob_search(storage: &'static str) -> Self {
        Self::new(
            storage,
            UiCanonical::GlobFileSearch,
            SimApp::CodeEditor,
            AppSubtool::Explore,
            ChatBlock::Glob,
        )
    }

    const fn query_lsp(storage: &'static str) -> Self {
        Self::new(
            storage,
            UiCanonical::QueryLsp,
            SimApp::CodeEditor,
            AppSubtool::Explore,
            ChatBlock::Search,
        )
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Browser (BROWSER app)
    // ═══════════════════════════════════════════════════════════════════════════

    /// BROWSER + Browser → WebSearch UI
    const fn web_search(storage: &'static str) -> Self {
        Self::new(
            storage,
            UiCanonical::WebSearch,
            SimApp::Browser,
            AppSubtool::Browser,
            ChatBlock::WebSearch,
        )
    }

    /// BROWSER + Browser → Browser UI
    const fn browser(storage: &'static str) -> Self {
        Self::new(
            storage,
            UiCanonical::Browser,
            SimApp::Browser,
            AppSubtool::Browser,
            ChatBlock::WebSearch,
        )
    }

    /// BROWSER + InternalBrowser → InternalBrowser UI
    const fn internal_browser(storage: &'static str) -> Self {
        Self::new(
            storage,
            UiCanonical::InternalBrowser,
            SimApp::Browser,
            AppSubtool::InternalBrowser,
            ChatBlock::WebSearch,
        )
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Conversation (CHANNELS app)
    // ═══════════════════════════════════════════════════════════════════════════

    /// CHANNELS + Message → AgentMessage UI
    const fn agent_message(storage: &'static str) -> Self {
        Self::new(
            storage,
            UiCanonical::AgentMessage,
            SimApp::Channels,
            AppSubtool::Message,
            ChatBlock::Fallback,
        )
    }

    /// CHANNELS + Thinking → Thinking UI
    const fn thinking(storage: &'static str) -> Self {
        Self::new(
            storage,
            UiCanonical::Thinking,
            SimApp::Channels,
            AppSubtool::Thinking,
            ChatBlock::Fallback,
        )
    }

    /// CHANNELS + Message → User UI
    const fn user(storage: &'static str) -> Self {
        Self::new(
            storage,
            UiCanonical::User,
            SimApp::Channels,
            AppSubtool::Message,
            ChatBlock::Fallback,
        )
    }

    /// CHANNELS + Message → ConsultAgent UI
    const fn consult_agent(storage: &'static str) -> Self {
        Self::new(
            storage,
            UiCanonical::ConsultAgent,
            SimApp::Channels,
            AppSubtool::Message,
            ChatBlock::Fallback,
        )
    }

    /// CHANNELS + Message → AskUserQuestions UI
    const fn ask_user_questions(storage: &'static str) -> Self {
        Self::new(
            storage,
            UiCanonical::AskUserQuestions,
            SimApp::Channels,
            AppSubtool::Message,
            ChatBlock::Fallback,
        )
    }

    /// CHANNELS + Message → AskUserPermissions UI
    const fn ask_user_permissions(storage: &'static str) -> Self {
        Self::new(
            storage,
            UiCanonical::AskUserPermissions,
            SimApp::Channels,
            AppSubtool::Message,
            ChatBlock::Fallback,
        )
    }

    /// BACKGROUND_TASKS + Subagent → Subagent UI
    const fn subagent(storage: &'static str) -> Self {
        Self::new(
            storage,
            UiCanonical::Subagent,
            SimApp::BackgroundTasks,
            AppSubtool::Subagent,
            ChatBlock::Subagent,
        )
    }

    /// CHANNELS + Message → SuggestModeSwitch UI
    const fn mode_switch(storage: &'static str) -> Self {
        Self::new(
            storage,
            UiCanonical::SuggestModeSwitch,
            SimApp::Channels,
            AppSubtool::Message,
            ChatBlock::Fallback,
        )
    }

    /// CHANNELS + Todo → ManageTodo UI
    const fn manage_todo(storage: &'static str) -> Self {
        Self::new(
            storage,
            UiCanonical::ManageTodo,
            SimApp::Channels,
            AppSubtool::Todo,
            ChatBlock::Todo,
        )
    }

    /// CHANNELS + Todo → Agent Org task UI
    const fn org_task(storage: &'static str, ui: UiCanonical) -> Self {
        Self::new(
            storage,
            ui,
            SimApp::Channels,
            AppSubtool::Todo,
            ChatBlock::OrgTask,
        )
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Generic / Fallback
    // ═══════════════════════════════════════════════════════════════════════════

    /// CODE_EDITOR + Shell → ToolCall UI (git ops etc)
    const fn tool_call_shell(storage: &'static str) -> Self {
        Self::new(
            storage,
            UiCanonical::ToolCall,
            SimApp::CodeEditor,
            AppSubtool::Shell,
            ChatBlock::Shell,
        )
    }

    /// CODE_EDITOR + OtherTool → ToolCall UI (misc IDE-adjacent tools)
    const fn tool_call_other(storage: &'static str) -> Self {
        Self::new(
            storage,
            UiCanonical::ToolCall,
            SimApp::CodeEditor,
            AppSubtool::OtherTool,
            ChatBlock::Fallback,
        )
    }

    /// CODE_EDITOR + Explore → ToolSearch UI
    const fn tool_search(storage: &'static str) -> Self {
        Self::new(
            storage,
            UiCanonical::ToolCall,
            SimApp::CodeEditor,
            AppSubtool::Explore,
            ChatBlock::Explore,
        )
    }

    /// CHANNELS + Message → ToolCall UI
    const fn tool_call_msg(storage: &'static str) -> Self {
        Self::new(
            storage,
            UiCanonical::ToolCall,
            SimApp::Channels,
            AppSubtool::Message,
            ChatBlock::Fallback,
        )
    }

    // ═══════════════════════════════════════════════════════════════════════════
}

/// CLI agent alias → (storage_canonical, ui_canonical)
///
/// - storage: fine-grained for DB (e.g. "edit_file_by_replace", "create_file")
/// - ui: UiCanonical enum for UI component lookup (e.g. EditFile for all edit operations)
static CLI_ALIAS_MAP: LazyLock<HashMap<&'static str, AliasEntry>> = LazyLock::new(|| {
    let mut m = HashMap::with_capacity(150);

    // ═══════════════════════════════════════════════════════════════════════════
    // File Operations (all CODE app)
    // ═══════════════════════════════════════════════════════════════════════════

    // Read file → ReadFile UI
    m.insert("Read", AliasEntry::read_file("read_file"));
    m.insert("READ", AliasEntry::read_file("read_file"));
    m.insert("read", AliasEntry::read_file("read_file"));
    m.insert("ReadFile", AliasEntry::read_file("read_file"));
    m.insert("readToolCall", AliasEntry::read_file("read_file"));
    m.insert("file_read", AliasEntry::read_file("read_file"));
    m.insert("cat", AliasEntry::read_file("read_file"));

    // Jupyter notebook cell editing → EditFile UI
    m.insert("NotebookEdit", AliasEntry::edit_file("notebook_edit"));
    m.insert("notebook_edit", AliasEntry::edit_file("notebook_edit"));

    // Edit/Write file → EditFile UI (storage distinguishes create vs edit)
    m.insert("Edit", AliasEntry::edit_file("edit_file_by_replace"));
    m.insert("EDIT", AliasEntry::edit_file("edit_file_by_replace"));
    m.insert("edit", AliasEntry::edit_file("edit_file_by_replace"));
    m.insert("MultiEdit", AliasEntry::edit_file("edit_file_by_replace"));
    m.insert(
        "edit_file_by_replace",
        AliasEntry::edit_file("edit_file_by_replace"),
    );
    m.insert(
        "editToolCall",
        AliasEntry::edit_file("edit_file_by_replace"),
    );
    m.insert(
        "file_range_edit",
        AliasEntry::edit_file("edit_file_by_replace"),
    );
    m.insert("text_editor", AliasEntry::edit_file("edit_file_by_replace"));
    m.insert("PatchApply", AliasEntry::edit_file("edit_file_by_replace"));
    m.insert("apply_patch", AliasEntry::edit_file("edit_file_by_replace"));
    m.insert("ApplyPatch", AliasEntry::edit_file("edit_file_by_replace"));
    m.insert("file_diff", AliasEntry::edit_file("edit_file_by_replace"));
    m.insert("append_file", AliasEntry::edit_file("edit_file_by_replace"));
    m.insert(
        "insert_content_at_line",
        AliasEntry::edit_file("edit_file_by_replace"),
    );
    m.insert(
        "search_replace",
        AliasEntry::edit_file("edit_file_by_replace"),
    );
    m.insert(
        "str_replace_editor",
        AliasEntry::edit_file("edit_file_by_replace"),
    );

    // Write/Create file → EditFile UI (storage is create_file)
    m.insert("Write", AliasEntry::edit_file("create_file"));
    m.insert("WRITE", AliasEntry::edit_file("create_file"));
    m.insert("write", AliasEntry::edit_file("create_file"));
    m.insert("write_file", AliasEntry::edit_file("create_file"));
    m.insert("create_file", AliasEntry::edit_file("create_file"));
    m.insert("createToolCall", AliasEntry::edit_file("create_file"));
    m.insert("file_write", AliasEntry::edit_file("create_file"));
    m.insert("Create", AliasEntry::edit_file("create_file"));

    // Delete file → DeleteFile UI
    m.insert("Delete", AliasEntry::delete_file("delete_file"));
    m.insert("delete", AliasEntry::delete_file("delete_file"));
    m.insert("deleteToolCall", AliasEntry::delete_file("delete_file"));
    m.insert("remove_file", AliasEntry::delete_file("delete_file"));

    // List directory → ListDir UI
    m.insert("LS", AliasEntry::list_dir("list_directory"));
    m.insert("Ls", AliasEntry::list_dir("list_directory"));
    m.insert("ls", AliasEntry::list_dir("list_directory"));
    m.insert("ListDir", AliasEntry::list_dir("list_directory"));
    m.insert("list_directory", AliasEntry::list_dir("list_directory"));
    m.insert("search_directory", AliasEntry::list_dir("list_directory"));

    // ═══════════════════════════════════════════════════════════════════════════
    // Terminal / Shell (all CODE app) → RunShell UI
    // ═══════════════════════════════════════════════════════════════════════════

    m.insert("PowerShell", AliasEntry::shell("run_command_line"));
    m.insert("powershell", AliasEntry::shell("run_command_line"));
    m.insert("power_shell", AliasEntry::shell("run_command_line"));
    m.insert("Monitor", AliasEntry::shell("run_command_line"));
    m.insert("monitor", AliasEntry::shell("run_command_line"));
    m.insert("Shell", AliasEntry::shell("run_command_line"));
    m.insert("SHELL", AliasEntry::shell("run_command_line"));
    m.insert("shell", AliasEntry::shell("run_command_line"));
    m.insert("Bash", AliasEntry::shell("run_command_line"));
    m.insert("BASH", AliasEntry::shell("run_command_line"));
    m.insert("bash", AliasEntry::shell("run_command_line"));
    m.insert("shellToolCall", AliasEntry::shell("run_command_line"));
    m.insert("run_command_line", AliasEntry::shell("run_command_line"));
    m.insert("command_execution", AliasEntry::shell("run_command_line"));
    m.insert("Execute", AliasEntry::shell("run_command_line"));
    m.insert("ExecCommand", AliasEntry::shell("run_command_line"));
    m.insert("exec", AliasEntry::shell("run_command_line"));
    m.insert("execute", AliasEntry::shell("run_command_line"));
    m.insert("run_shell", AliasEntry::shell("run_command_line"));
    m.insert("run_terminal_cmd", AliasEntry::shell("run_command_line"));
    m.insert("run_command", AliasEntry::shell("run_command_line"));
    m.insert("Await", AliasEntry::await_output());
    m.insert("await", AliasEntry::await_output());
    // Codex names its yielded-command continuation tool `wait`. It has the
    // same chat semantics as await_output, even though its payload uses
    // cell_id/yield_time_ms instead of handles/block_until_ms.
    m.insert("wait", AliasEntry::await_output());
    // Newer Codex runtimes use empty write_stdin calls to await more output
    // from a yielded exec session. Importers special-case non-empty input so
    // interrupts and terminal interaction stay on the originating shell.
    m.insert("write_stdin", AliasEntry::await_output());
    m.insert("awaitToolCall", AliasEntry::await_output());
    m.insert("AwaitToolCall", AliasEntry::await_output());

    // ═══════════════════════════════════════════════════════════════════════════
    // Search (CODE app for code search, BROWSER app for web search)
    // ═══════════════════════════════════════════════════════════════════════════

    // LSP diagnostics → query_lsp UI in the Code Editor Explore panel
    m.insert("LSP", AliasEntry::query_lsp("query_lsp"));
    m.insert("lsp", AliasEntry::query_lsp("query_lsp"));
    m.insert("Read Lints", AliasEntry::query_lsp("query_lsp"));
    m.insert("ReadLints", AliasEntry::query_lsp("query_lsp"));
    m.insert("read_lints", AliasEntry::query_lsp("query_lsp"));
    m.insert("read_lint", AliasEntry::query_lsp("query_lsp"));

    // Code search → CodeSearch UI
    m.insert("grep", AliasEntry::codebase_search("grep"));
    m.insert("Grep", AliasEntry::codebase_search("grep"));
    m.insert("GREP", AliasEntry::codebase_search("grep"));
    m.insert("search", AliasEntry::codebase_search("codebase_search"));
    m.insert(
        "code_search",
        AliasEntry::codebase_search("codebase_search"),
    );
    m.insert(
        "search_code",
        AliasEntry::codebase_search("codebase_search"),
    );
    m.insert("ripgrep", AliasEntry::codebase_search("grep"));
    m.insert("Search", AliasEntry::codebase_search("codebase_search"));
    m.insert(
        "searchToolCall",
        AliasEntry::codebase_search("codebase_search"),
    );
    m.insert(
        "search_codebase",
        AliasEntry::codebase_search("codebase_search"),
    );
    m.insert(
        "codebase_search",
        AliasEntry::codebase_search("codebase_search"),
    );

    // Web search → WebSearch UI (BROWSER app)
    m.insert("WebSearch", AliasEntry::web_search("web_search"));
    m.insert("web_fetch", AliasEntry::web_search("web_fetch"));
    m.insert("WebFetch", AliasEntry::web_search("web_fetch"));
    m.insert("load_web_page", AliasEntry::web_search("web_fetch"));
    m.insert("FetchUrl", AliasEntry::web_search("web_fetch"));

    // Glob/file search → GlobFileSearch UI
    m.insert("file_search", AliasEntry::glob_search("glob_file_search"));
    m.insert("find_files", AliasEntry::glob_search("glob_file_search"));
    m.insert("glob", AliasEntry::glob_search("glob_file_search"));
    m.insert("Glob", AliasEntry::glob_search("glob_file_search"));
    m.insert("GLOB", AliasEntry::glob_search("glob_file_search"));
    m.insert("Glob File", AliasEntry::glob_search("glob_file_search"));
    m.insert("GlobFile", AliasEntry::glob_search("glob_file_search"));
    m.insert("glob_file", AliasEntry::glob_search("glob_file_search"));
    m.insert("search_files", AliasEntry::glob_search("glob_file_search"));
    m.insert("SearchFiles", AliasEntry::glob_search("glob_file_search"));

    // ═══════════════════════════════════════════════════════════════════════════
    // Conversation / Messages (all CHANNELS app)
    // ═══════════════════════════════════════════════════════════════════════════

    // Assistant → AgentMessage UI
    m.insert("assistant", AliasEntry::agent_message("assistant"));
    m.insert("message", AliasEntry::agent_message("assistant"));
    m.insert("send_message", AliasEntry::agent_message("assistant"));
    m.insert("message_delta", AliasEntry::agent_message("assistant"));
    m.insert("assistant_delta", AliasEntry::agent_message("assistant"));
    m.insert("assistant_message", AliasEntry::agent_message("assistant"));
    m.insert("agent_message", AliasEntry::agent_message("assistant"));
    m.insert(
        "agent_message_delta",
        AliasEntry::agent_message("assistant"),
    );
    m.insert("agent_response", AliasEntry::agent_message("assistant"));
    m.insert("AGENT", AliasEntry::agent_message("assistant"));
    // NOTE: bare "Agent" intentionally routes to Subagent tool-call semantics;
    // see the subagent block below.

    // Thinking → Thinking UI
    m.insert("thinking", AliasEntry::thinking("thinking"));
    m.insert("think", AliasEntry::thinking("thinking"));
    m.insert("llm_thinking", AliasEntry::thinking("thinking"));
    m.insert("llm_thinking_delta", AliasEntry::thinking("thinking"));
    m.insert("thinking_delta", AliasEntry::thinking("thinking"));
    m.insert("reasoning", AliasEntry::thinking("thinking"));
    m.insert("internal_monologue", AliasEntry::thinking("thinking"));
    m.insert("reflection", AliasEntry::thinking("thinking"));
    m.insert("Thinking", AliasEntry::thinking("thinking"));
    m.insert("THINKING", AliasEntry::thinking("thinking"));

    // Consult → ConsultAgent UI
    m.insert("consult_agent", AliasEntry::consult_agent("consult_agent"));
    m.insert("ConsultAgent", AliasEntry::consult_agent("consult_agent"));
    m.insert("CONSULT_AGENT", AliasEntry::consult_agent("consult_agent"));

    // Ask user → AskUser UI
    m.insert(
        "ask_question",
        AliasEntry::ask_user_questions("ask_user_questions"),
    );
    m.insert(
        "ask_followup_question",
        AliasEntry::ask_user_questions("ask_user_questions"),
    );
    m.insert(
        "clarification",
        AliasEntry::ask_user_questions("ask_user_questions"),
    );
    m.insert(
        "question",
        AliasEntry::ask_user_questions("ask_user_questions"),
    );
    m.insert(
        "ask_user",
        AliasEntry::ask_user_questions("ask_user_questions"),
    );
    m.insert(
        "ask_user_questions",
        AliasEntry::ask_user_questions("ask_user_questions"),
    );
    m.insert(
        "askuserquestion",
        AliasEntry::ask_user_questions("ask_user_questions"),
    );
    m.insert(
        "AskUserQuestion",
        AliasEntry::ask_user_questions("ask_user_questions"),
    );
    m.insert(
        "AskQuestion",
        AliasEntry::ask_user_questions("ask_user_questions"),
    );
    m.insert(
        "CollectFeedback",
        AliasEntry::ask_user_questions("ask_user_questions"),
    );

    // User / raw → User UI
    m.insert("user", AliasEntry::user("user"));
    m.insert("raw", AliasEntry::user("user"));
    m.insert("raw_event", AliasEntry::user("user"));

    // ═══════════════════════════════════════════════════════════════════════════
    // Todo (CHANNELS app) → ManageTodo UI
    // ═══════════════════════════════════════════════════════════════════════════

    m.insert("manage_todo", AliasEntry::manage_todo("manage_todo"));
    m.insert("todo_write", AliasEntry::manage_todo("manage_todo"));
    m.insert("TodoWrite", AliasEntry::manage_todo("manage_todo"));
    m.insert("todowrite", AliasEntry::manage_todo("manage_todo"));
    m.insert("todoread", AliasEntry::manage_todo("manage_todo"));
    m.insert("TodoRead", AliasEntry::manage_todo("manage_todo"));
    m.insert("todo_read", AliasEntry::manage_todo("manage_todo"));
    m.insert("todo", AliasEntry::manage_todo("manage_todo"));
    m.insert("UpdateTodos", AliasEntry::manage_todo("manage_todo"));
    m.insert("update_todos", AliasEntry::manage_todo("manage_todo"));

    // ═══════════════════════════════════════════════════════════════════════════
    // Subagent / Task (CHANNELS app) → Subagent UI
    // ═══════════════════════════════════════════════════════════════════════════

    // Claude Code CLI `Skill` (capital-S) forks a prompt-workflow subagent →
    // Subagent UI. The lowercase `skill` is ORG2's rust-native first-class
    // skill tool (atomic SKILL.md expansion, NO subagent involved) — it must
    // render as a plain tool call, not an empty subagent card.
    m.insert("Skill", AliasEntry::subagent("skill"));
    m.insert("skill", AliasEntry::tool_call_other("skill"));
    // Agent team multi-agent coordination → Subagent UI
    m.insert("TeamCreate", AliasEntry::subagent("team_create"));
    m.insert("team_create", AliasEntry::subagent("team_create"));
    m.insert("TeamDelete", AliasEntry::subagent("team_delete"));
    m.insert("team_delete", AliasEntry::subagent("team_delete"));
    m.insert("SendMessage", AliasEntry::subagent("send_message"));
    m.insert("send_message", AliasEntry::subagent("send_message"));

    m.insert("subagent", AliasEntry::subagent("subagent"));
    m.insert("agent", AliasEntry::subagent("subagent"));
    m.insert("Agent", AliasEntry::subagent("subagent"));
    m.insert("Subagent", AliasEntry::subagent("subagent"));
    m.insert("sub_agent", AliasEntry::subagent("subagent"));
    m.insert("Task", AliasEntry::subagent("subagent"));
    m.insert("task", AliasEntry::subagent("subagent"));
    m.insert("session", AliasEntry::subagent("subagent"));
    m.insert("manage_session", AliasEntry::subagent("subagent"));
    m.insert("spawn", AliasEntry::subagent("subagent"));
    m.insert("spawn_agent", AliasEntry::subagent("subagent"));
    m.insert("spawn_sub_agent", AliasEntry::subagent("subagent"));
    m.insert("delegate", AliasEntry::subagent("subagent"));
    m.insert("manage_agent_def", AliasEntry::subagent("subagent"));

    // ═══════════════════════════════════════════════════════════════════════════
    // Mode switch (CHANNELS app) → SuggestModeSwitch UI
    // ═══════════════════════════════════════════════════════════════════════════

    m.insert(
        "suggest_mode_switch",
        AliasEntry::mode_switch("suggest_mode_switch"),
    );
    m.insert(
        "SuggestModeSwitch",
        AliasEntry::mode_switch("suggest_mode_switch"),
    );
    m.insert(
        "suggestModeSwitch",
        AliasEntry::mode_switch("suggest_mode_switch"),
    );
    m.insert(
        "mode_switch",
        AliasEntry::mode_switch("suggest_mode_switch"),
    );
    // Claude Code plan mode tools → SuggestModeSwitch UI (same interaction pattern)
    m.insert("EnterPlanMode", AliasEntry::mode_switch("enter_plan_mode"));
    m.insert(
        "enter_plan_mode",
        AliasEntry::mode_switch("enter_plan_mode"),
    );
    m.insert("ExitPlanMode", AliasEntry::mode_switch("exit_plan_mode"));
    m.insert("exit_plan_mode", AliasEntry::mode_switch("exit_plan_mode"));

    // ═══════════════════════════════════════════════════════════════════════════
    // Browser (all BROWSER app)
    // ═══════════════════════════════════════════════════════════════════════════

    m.insert("browser", AliasEntry::browser("browser"));
    m.insert("control_browser", AliasEntry::browser("browser")); // Legacy alias
    m.insert("control_external_browser", AliasEntry::browser("browser"));
    m.insert(
        "control_internal_browser",
        AliasEntry::internal_browser("internal_browser"),
    );
    m.insert(
        "control_desktop_with_peekaboo",
        AliasEntry::browser("control_desktop_with_peekaboo"),
    );
    m.insert("browser_navigate", AliasEntry::browser("browser"));
    m.insert("browser_act", AliasEntry::browser("browser"));
    m.insert("browser_screenshot", AliasEntry::browser("browser"));
    m.insert("browser_snapshot", AliasEntry::browser("browser"));
    m.insert("browser_open", AliasEntry::browser("browser"));
    m.insert("browser_visit", AliasEntry::browser("browser"));
    m.insert("web_navigate", AliasEntry::browser("browser"));
    m.insert("web_open", AliasEntry::browser("browser"));
    m.insert("navigate_url", AliasEntry::browser("browser"));
    m.insert("open_url", AliasEntry::browser("browser"));
    m.insert("visit_page", AliasEntry::browser("browser"));

    // ═══════════════════════════════════════════════════════════════════════════
    // Generic tool_call and misc tools → ToolCall UI (fallback)
    // ═══════════════════════════════════════════════════════════════════════════

    // Generic/MCP tools
    m.insert("call_tool", AliasEntry::tool_call_other("tool_call"));
    m.insert("Mcp", AliasEntry::tool_call_other("tool_call"));
    m.insert("mcp", AliasEntry::tool_call_other("tool_call"));
    m.insert("McpToolCall", AliasEntry::tool_call_other("tool_call"));
    // Git operations → Shell subtool
    m.insert("git_commit", AliasEntry::tool_call_shell("tool_call"));
    m.insert("GitCommit", AliasEntry::tool_call_shell("tool_call"));
    m.insert("git_push", AliasEntry::tool_call_shell("tool_call"));
    m.insert("GitPush", AliasEntry::tool_call_shell("tool_call"));
    m.insert(
        "create_pull_request",
        AliasEntry::tool_call_shell("tool_call"),
    );
    m.insert(
        "CreatePullRequest",
        AliasEntry::tool_call_shell("tool_call"),
    );
    m.insert("create_pr", AliasEntry::tool_call_shell("tool_call"));
    m.insert("plan_update", AliasEntry::tool_call_other("tool_call"));
    m.insert("schedule_task", AliasEntry::tool_call_msg("tool_call"));
    // Claude Code scheduled/cron tasks → Shell UI (schedule shell commands)
    m.insert("CronCreate", AliasEntry::tool_call_shell("cron_create"));
    m.insert("cron_create", AliasEntry::tool_call_shell("cron_create"));
    m.insert("CronDelete", AliasEntry::tool_call_shell("cron_delete"));
    m.insert("cron_delete", AliasEntry::tool_call_shell("cron_delete"));
    m.insert("CronList", AliasEntry::tool_call_shell("cron_list"));
    m.insert("cron_list", AliasEntry::tool_call_shell("cron_list"));
    // Claude Code git worktree tools → Shell UI (git operations)
    m.insert(
        "EnterWorktree",
        AliasEntry::tool_call_shell("enter_worktree"),
    );
    m.insert(
        "enter_worktree",
        AliasEntry::tool_call_shell("enter_worktree"),
    );
    m.insert("ExitWorktree", AliasEntry::tool_call_shell("exit_worktree"));
    m.insert(
        "exit_worktree",
        AliasEntry::tool_call_shell("exit_worktree"),
    );
    // MCP meta-tools → Fallback UI (tool discovery/resource operations)
    m.insert(
        "ListMcpResourcesTool",
        AliasEntry::tool_call_other("list_mcp_resources"),
    );
    m.insert(
        "list_mcp_resources",
        AliasEntry::tool_call_other("list_mcp_resources"),
    );
    m.insert(
        "ReadMcpResourceTool",
        AliasEntry::tool_call_other("read_mcp_resource"),
    );
    m.insert(
        "read_mcp_resource",
        AliasEntry::tool_call_other("read_mcp_resource"),
    );
    m.insert("ToolSearch", AliasEntry::tool_search("tool_search"));
    m.insert("tool_search", AliasEntry::tool_search("tool_search"));
    // Notification / remote tools → Fallback UI
    m.insert(
        "PushNotification",
        AliasEntry::tool_call_msg("push_notification"),
    );
    m.insert(
        "push_notification",
        AliasEntry::tool_call_msg("push_notification"),
    );
    m.insert("RemoteTrigger", AliasEntry::tool_call_msg("remote_trigger"));
    m.insert(
        "remote_trigger",
        AliasEntry::tool_call_msg("remote_trigger"),
    );
    m.insert(
        "ShareOnboardingGuide",
        AliasEntry::tool_call_msg("share_onboarding_guide"),
    );
    m.insert(
        "share_onboarding_guide",
        AliasEntry::tool_call_msg("share_onboarding_guide"),
    );

    // Agent Org task-board tools are first-class built-ins. Preserve their
    // identity so Rust `chat_block: OrgTask` and extracted payloads reach the
    // frontend instead of collapsing to generic `tool_call` / shell UI.
    m.insert(
        "TaskCreate",
        AliasEntry::org_task(tool_names::TASK_CREATE, UiCanonical::TaskCreate),
    );
    m.insert(
        tool_names::TASK_CREATE,
        AliasEntry::org_task(tool_names::TASK_CREATE, UiCanonical::TaskCreate),
    );
    m.insert(
        "TaskGet",
        AliasEntry::org_task(tool_names::TASK_GET, UiCanonical::TaskGet),
    );
    m.insert(
        tool_names::TASK_GET,
        AliasEntry::org_task(tool_names::TASK_GET, UiCanonical::TaskGet),
    );
    m.insert(
        "TaskList",
        AliasEntry::org_task(tool_names::TASK_LIST, UiCanonical::TaskList),
    );
    m.insert(
        tool_names::TASK_LIST,
        AliasEntry::org_task(tool_names::TASK_LIST, UiCanonical::TaskList),
    );
    m.insert(
        "TaskUpdate",
        AliasEntry::org_task(tool_names::TASK_UPDATE, UiCanonical::TaskUpdate),
    );
    m.insert(
        tool_names::TASK_UPDATE,
        AliasEntry::org_task(tool_names::TASK_UPDATE, UiCanonical::TaskUpdate),
    );

    // Claude Code background task control tools → Shell UI
    m.insert("TaskStop", AliasEntry::tool_call_shell("task_stop"));
    m.insert("task_stop", AliasEntry::tool_call_shell("task_stop"));
    m.insert("TaskOutput", AliasEntry::tool_call_shell("task_output"));
    m.insert("task_output", AliasEntry::tool_call_shell("task_output"));

    // NOTE: Built-in tool names (manage_workspace, query_lsp, manage_lsp,
    // setup_repo, manage_nodes, control_orgii,
    // query_knowledge, manage_project, manage_work_item) are intentionally
    // NOT aliased here. The old entries collapsed their identity to
    // `UiCanonical::ToolCall` ("tool_call"), which masked the per-tool
    // `label_running/done/failed` and `chat_block` declared in
    // `builtin_tools.rs`. Unaliased names fall through to the builtin
    // registry, which already carries the correct simulator app, subtool,
    // chat block, and lifecycle labels.

    // ═══════════════════════════════════════════════════════════════════════════
    // Session / lifecycle events
    // ═══════════════════════════════════════════════════════════════════════════

    m.insert(
        "approval_request",
        AliasEntry::ask_user_permissions("ask_user_permissions"),
    );
    m.insert(
        "approval_response",
        AliasEntry::ask_user_permissions("ask_user_permissions"),
    );
    m.insert(
        "ask_user_permissions",
        AliasEntry::ask_user_permissions("ask_user_permissions"),
    );

    m
});

/// Resolve a CLI agent tool name to its dual canonical forms.
///
/// Returns `Some((storage, ui_str))` if found, `None` otherwise.
pub fn resolve_cli_alias(raw: &str) -> Option<(&'static str, &'static str)> {
    CLI_ALIAS_MAP.get(raw).map(|e| (e.storage, e.ui.as_str()))
}

/// Resolve a CLI alias to all five canonical forms:
/// (storage, ui, simulator_app, app_subtool, chat_block).
pub fn resolve_cli_alias_full(
    raw: &str,
) -> Option<(
    &'static str,
    &'static str,
    &'static str,
    &'static str,
    &'static str,
)> {
    CLI_ALIAS_MAP.get(raw).map(|e| {
        (
            e.storage,
            e.ui.as_str(),
            e.simulator_app.as_str(),
            e.app_subtool.as_str(),
            e.chat_block.as_str(),
        )
    })
}

/// Get the UI canonical enum for a CLI alias.
///
/// Returns `None` if not found.
pub fn get_ui_canonical_enum(raw: &str) -> Option<UiCanonical> {
    CLI_ALIAS_MAP.get(raw).map(|e| e.ui)
}

/// Get the UI canonical name (string) for a CLI alias.
///
/// Returns the alias itself if not found (passthrough).
pub fn get_ui_canonical(raw: &str) -> &str {
    CLI_ALIAS_MAP.get(raw).map(|e| e.ui.as_str()).unwrap_or(raw)
}

/// Get the simulator app for a CLI alias.
///
/// Returns `None` if not found.
pub fn get_simulator_app(raw: &str) -> Option<&'static str> {
    CLI_ALIAS_MAP.get(raw).map(|e| e.simulator_app.as_str())
}

/// Get the app subtool for a CLI alias.
///
/// Returns `None` if not found.
pub fn get_app_subtool(raw: &str) -> Option<&'static str> {
    CLI_ALIAS_MAP.get(raw).map(|e| e.app_subtool.as_str())
}

/// Get all CLI aliases as a map:
/// alias → (storage, ui, simulator_app, app_subtool, chat_block).
///
/// Used by the Tauri command to send the full map to the frontend.
pub fn get_all_cli_aliases() -> HashMap<String, (String, String, String, String, String)> {
    CLI_ALIAS_MAP
        .iter()
        .map(|(&k, v)| {
            (
                k.to_string(),
                (
                    v.storage.to_string(),
                    v.ui.as_str().to_string(),
                    v.simulator_app.as_str().to_string(),
                    v.app_subtool.as_str().to_string(),
                    v.chat_block.as_str().to_string(),
                ),
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_read_file_aliases() {
        assert_eq!(resolve_cli_alias("Read"), Some(("read_file", "read_file")));
        assert_eq!(
            resolve_cli_alias("readToolCall"),
            Some(("read_file", "read_file"))
        );
        // Check enum variant
        assert_eq!(get_ui_canonical_enum("Read"), Some(UiCanonical::ReadFile));
    }

    #[test]
    fn test_edit_file_aliases() {
        // Edit → edit_file_by_replace storage, edit_file ui
        assert_eq!(
            resolve_cli_alias("Edit"),
            Some(("edit_file_by_replace", "edit_file"))
        );
        assert_eq!(
            resolve_cli_alias("Write"),
            Some(("create_file", "edit_file"))
        );
        // Both should have same UI canonical
        let edit_ui = get_ui_canonical("Edit");
        let write_ui = get_ui_canonical("Write");
        assert_eq!(edit_ui, write_ui);
        assert_eq!(edit_ui, "edit_file");
        // Check enum variant
        assert_eq!(get_ui_canonical_enum("Edit"), Some(UiCanonical::EditFile));
        assert_eq!(get_ui_canonical_enum("Write"), Some(UiCanonical::EditFile));
        assert_eq!(
            get_ui_canonical_enum("apply_patch"),
            Some(UiCanonical::EditFile)
        );
    }

    #[test]
    fn test_shell_aliases() {
        assert_eq!(
            resolve_cli_alias("Bash"),
            Some(("run_command_line", "run_shell"))
        );
        assert_eq!(
            resolve_cli_alias("Shell"),
            Some(("run_command_line", "run_shell"))
        );
        assert_eq!(
            resolve_cli_alias("shellToolCall"),
            Some(("run_command_line", "run_shell"))
        );
        assert_eq!(get_ui_canonical_enum("Bash"), Some(UiCanonical::RunShell));
    }

    #[test]
    fn test_cursor_await_aliases_use_wait_ui() {
        assert_eq!(
            resolve_cli_alias("Await"),
            Some((tool_names::AWAIT_OUTPUT, tool_names::AWAIT_OUTPUT))
        );
        assert_eq!(
            resolve_cli_alias("awaitToolCall"),
            Some((tool_names::AWAIT_OUTPUT, tool_names::AWAIT_OUTPUT))
        );
        assert_eq!(
            resolve_cli_alias("wait"),
            Some((tool_names::AWAIT_OUTPUT, tool_names::AWAIT_OUTPUT))
        );
        assert_eq!(
            resolve_cli_alias("write_stdin"),
            Some((tool_names::AWAIT_OUTPUT, tool_names::AWAIT_OUTPUT))
        );
        assert_eq!(
            get_ui_canonical_enum("Await"),
            Some(UiCanonical::AwaitOutput)
        );
        assert_eq!(
            resolve_cli_alias_full("awaitToolCall"),
            Some((
                tool_names::AWAIT_OUTPUT,
                tool_names::AWAIT_OUTPUT,
                "CODE_EDITOR",
                "shell",
                "title_only"
            ))
        );
    }

    #[test]
    fn test_search_aliases() {
        assert_eq!(resolve_cli_alias("Grep"), Some(("grep", "code_search")));
        assert_eq!(
            resolve_cli_alias("Search"),
            Some(("codebase_search", "code_search"))
        );
        assert_eq!(
            resolve_cli_alias("Glob File"),
            Some(("glob_file_search", "glob_file_search"))
        );
        assert_eq!(
            resolve_cli_alias("Read Lints"),
            Some(("query_lsp", "query_lsp"))
        );
        assert_eq!(get_ui_canonical_enum("Grep"), Some(UiCanonical::CodeSearch));
        assert_eq!(
            get_ui_canonical_enum("Glob File"),
            Some(UiCanonical::GlobFileSearch)
        );
        assert_eq!(
            get_ui_canonical_enum("Read Lints"),
            Some(UiCanonical::QueryLsp)
        );
    }

    #[test]
    fn test_unknown_passthrough() {
        assert_eq!(resolve_cli_alias("some_unknown_tool"), None);
        // get_ui_canonical should passthrough unknown
        assert_eq!(get_ui_canonical("some_unknown_tool"), "some_unknown_tool");
        // get_ui_canonical_enum returns None for unknown
        assert_eq!(get_ui_canonical_enum("some_unknown_tool"), None);
    }

    #[test]
    fn test_get_all_has_entries() {
        let all = get_all_cli_aliases();
        assert!(all.len() > 100);
        assert!(all.contains_key("Read"));
        assert!(all.contains_key("Bash"));
    }

    #[test]
    fn test_ui_canonical_as_str() {
        assert_eq!(UiCanonical::ReadFile.as_str(), "read_file");
        assert_eq!(UiCanonical::EditFile.as_str(), "edit_file");
        assert_eq!(UiCanonical::RunShell.as_str(), "run_shell");
        assert_eq!(UiCanonical::QueryLsp.as_str(), "query_lsp");
        assert_eq!(UiCanonical::ToolCall.as_str(), "tool_call");
        assert_eq!(UiCanonical::AgentMessage.as_str(), "agent_message");
    }

    #[test]
    fn test_agent_message_aliases() {
        // assistant → agent_message UI
        assert_eq!(
            resolve_cli_alias("assistant"),
            Some(("assistant", "agent_message"))
        );
        assert_eq!(
            resolve_cli_alias("message"),
            Some(("assistant", "agent_message"))
        );
        assert_eq!(
            get_ui_canonical_enum("assistant"),
            Some(UiCanonical::AgentMessage)
        );
    }

    #[test]
    fn test_codex_spawn_agent_alias() {
        assert_eq!(
            resolve_cli_alias("spawn_agent"),
            Some(("subagent", "subagent"))
        );
        assert_eq!(
            get_ui_canonical_enum("spawn_agent"),
            Some(UiCanonical::Subagent)
        );
    }
}
