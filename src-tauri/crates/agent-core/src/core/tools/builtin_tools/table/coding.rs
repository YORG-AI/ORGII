//! Coding-category tool entries.

use super::aliases::*;
use super::macros::action_sub;

pub(super) static TOOLS: &[ToolEntry] = &[
    // ── Coding (shared) ──
    ToolEntry {
        name: tool_names::READ_FILE,
        description: "Read the contents of a file.",
        description_detail: "Reads text from a workspace-relative or absolute file path. Honors repository boundaries and configured size limits where applicable. Use before editing, for code review, or to pull excerpts into the conversation.",
        category: tool_categories::CODING,
        icon_id: "file-text",
        simulator_app: AppCode,
        app_subtool: FileRead,
        chat_block: CbReadFile,
        display_behavior: DisplayInstant,
        human_tool_key: Some(HtCode),
        action_icons: &[("read_image", "image"), ("read_pdf", "file-box")],
        label_running: "tools.readFileRunning",
        label_done: "tools.readFileDone",
        label_failed: "tools.readFileFailed",
        status_labels: &[
            ("skill_running", "tools.readFileSkillRunning"),
            ("skill_done", "tools.readFileSkillDone"),
            ("skill_failed", "tools.readFileSkillFailed"),
        ],
        actions: &[
            action_sub!("read_text", "Read text file contents with optional line range", FileRead, labels: "tools.readTextRunning", "tools.readTextDone", "tools.readTextFailed"),
            action_sub!("read_image", "Read image file into context for vision analysis", FileRead, labels: "tools.readImageRunning", "tools.readImageDone", "tools.readImageFailed"),
            action_sub!("read_pdf", "Extract text from a PDF document", FileRead, labels: "tools.readPdfRunning", "tools.readPdfDone", "tools.readPdfFailed"),
        ],
        ..DEFAULT_TOOL_ENTRY
    },
    ToolEntry {
        name: tool_names::LIST_DIR,
        description: "List files and directories in a given path.",
        description_detail: "Enumerates entries under a directory with optional filtering. Helps map project layout, find configuration files, or choose targets for search and edits without opening every file.",
        category: tool_categories::CODING,
        icon_id: "folder-open",
        simulator_app: AppCode,
        app_subtool: Explore,
        chat_block: CbExplore,
        human_tool_key: Some(HtCode),
        label_running: "tools.listDirRunning",
        label_done: "tools.listDirDone",
        label_failed: "tools.listDirFailed",
        actions: &[
            action_sub!("list", "List files and subdirectories at a given path", Explore, labels: "tools.listDirListRunning", "tools.listDirListDone", "tools.listDirListFailed"),
        ],
        ..DEFAULT_TOOL_ENTRY
    },
    ToolEntry {
        name: tool_names::RUN_SHELL,
        description: "Execute a shell command (subprocess or PTY).",
        description_detail: "Runs shell commands with captured stdout, stderr, and exit status, or attaches to a pseudo-terminal for interactive-style programs. Use for builds, tests, package managers, and scripts according to agent policy.",
        category: tool_categories::CODING,
        icon_id: "terminal",
        simulator_app: AppCode,
        app_subtool: Shell,
        chat_block: CbShell,
        display_behavior: DisplayStream,
        human_tool_key: Some(Terminal),
        label_running: "tools.runShellRunning",
        label_done: "tools.runShellDone",
        label_failed: "tools.runShellFailed",
        status_labels: &[
            ("background", "tools.shellStatus.background"),
            ("exited", "tools.shellStatus.exited"),
            ("killed", "tools.shellStatus.killed"),
        ],
        actions: &[
            action_sub!(
                "run",
                "Execute a shell command and capture output",
                Shell,
                labels: "tools.runShellRunRunning", "tools.runShellRunDone", "tools.runShellRunFailed"
            ),
            action_sub!(
                "kill",
                "Kill a backgrounded process by handle (SIGTERM + SIGKILL)",
                Shell,
                labels: "tools.killProcessRunning", "tools.killProcessDone", "tools.killProcessFailed"
            ),
        ],
        ..DEFAULT_TOOL_ENTRY
    },
    ToolEntry {
        name: tool_names::INSPECT_TERMINALS,
        description: "Inspect and control live terminal sessions.",
        description_detail: "Every request must include an `action` field. Use `{\"action\":\"list\"}` to list ORGII-managed PTY sessions, then `{\"action\":\"read_output\",\"session_id\":\"...\"}` to read bounded redacted output, `{\"action\":\"write_input\",\"session_id\":\"...\",\"input\":\"...\"}` to write input, or `{\"action\":\"close\",\"session_id\":\"...\"}` to close a selected PTY. Output returned to agents is read from the redacted snapshot buffer, not the raw terminal byte stream.",
        category: tool_categories::CODING,
        icon_id: "terminal-square",
        simulator_app: AppCode,
        app_subtool: Shell,
        chat_block: CbFallback,
        display_behavior: DisplayStream,
        human_tool_key: Some(Terminal),
        label_running: "tools.inspectTerminalsRunning",
        label_done: "tools.inspectTerminalsDone",
        label_failed: "tools.inspectTerminalsFailed",
        action_icons: &[
            ("read_output", "scroll-text"),
            ("write_input", "keyboard"),
            ("close", "x"),
        ],
        actions: &[
            action_sub!("list", "List live ORGII-managed terminal sessions", Shell, chat: CbFallback, labels: "tools.inspectTerminalsListRunning", "tools.inspectTerminalsListDone", "tools.inspectTerminalsListFailed"),
            action_sub!("read_output", "Read a bounded redacted output snapshot from a terminal session", Shell, chat: CbFallback, labels: "tools.inspectTerminalsReadOutputRunning", "tools.inspectTerminalsReadOutputDone", "tools.inspectTerminalsReadOutputFailed"),
            action_sub!("write_input", "Write input text or control characters into a terminal session", Shell, chat: CbFallback, labels: "tools.inspectTerminalsWriteInputRunning", "tools.inspectTerminalsWriteInputDone", "tools.inspectTerminalsWriteInputFailed"),
            action_sub!("close", "Close a terminal session", Shell, chat: CbFallback, labels: "tools.inspectTerminalsCloseRunning", "tools.inspectTerminalsCloseDone", "tools.inspectTerminalsCloseFailed"),
        ],
        ..DEFAULT_TOOL_ENTRY
    },
    ToolEntry {
        name: tool_names::AWAIT_OUTPUT,
        description: "Monitor background jobs (shell processes and subagents).",
        description_detail: "Multi-command tool for monitoring backgrounded processes and subagents. Supports blocking wait_for with regex matching, non-blocking monitor snapshots, and session-scoped job listing.",
        category: tool_categories::CODING,
        // `wait_for` keeps the default `timer` icon (it counts down). The other
        // two subcommands map to dedicated icons via `action_icons` below so
        // the chat-history row visually distinguishes "snapshot one task"
        // (focus) from "list all tasks" (list-tree).
        icon_id: "timer",
        simulator_app: AppCode,
        app_subtool: Shell,
        display_behavior: DisplayStream,
        action_icons: &[("monitor", "focus"), ("list", "list-tree")],
        // Tool-level default: each subcommand action overrides chat_block below.
        // `wait_for` / `monitor` render as TitleOnly rows (icon + title + subtitle,
        // no body); `list` renders via the Explore/ToolCallBlock stack list to
        // reuse the `manage_workspace > list` geometry.
        chat_block: CbTitleOnly,
        human_tool_key: Some(Terminal),
        // Fallback labels (used when action is not supplied — rare, since
        // every call specifies `command`). Action-specific labels below
        // carry the real wording.
        label_running: "tools.awaitOutputRunning",
        label_done: "tools.awaitOutputDone",
        label_failed: "tools.awaitOutputFailed",
        status_labels: &[
            ("pattern_matched", "tools.awaitOutputPatternMatched"),
            ("keep_waiting", "tools.awaitOutputKeepWaiting"),
            ("still_running", "tools.awaitOutputStillRunning"),
            ("killed", "tools.awaitOutputKilled"),
            ("not_found", "tools.awaitOutputNotFound"),
        ],
        actions: &[
            action_sub!(
                "wait_for",
                "Block until a regex pattern matches, the job completes, or the timeout elapses",
                Shell,
                chat: CbTitleOnly,
                display: DisplayStream,
                labels: "tools.awaitOutputWaitForRunning", "tools.awaitOutputWaitForDone", "tools.awaitOutputWaitForFailed"
            ),
            action_sub!(
                "monitor",
                "Non-blocking snapshot of a background job (current status + last N lines)",
                Shell,
                chat: CbTitleOnly,
                display: DisplayStream,
                labels: "tools.awaitOutputMonitorRunning", "tools.awaitOutputMonitorDone", "tools.awaitOutputMonitorFailed"
            ),
            action_sub!(
                "list",
                "List all background jobs for this session",
                Explore,
                chat: CbFallback,
                display: DisplayWaitForResult,
                labels: "tools.awaitOutputListRunning", "tools.awaitOutputListDone", "tools.awaitOutputListFailed"
            ),
        ],
        ..DEFAULT_TOOL_ENTRY
    },
    ToolEntry {
        name: tool_names::CODE_SEARCH,
        description: "Code and file search via ripgrep + glob.",
        description_detail: "Fast content search backed by ripgrep with optional path scopes and glob patterns. Locates symbols, literals, and regex patterns across the codebase for navigation and impact analysis.",
        category: tool_categories::CODING,
        icon_id: "search",
        simulator_app: AppCode,
        app_subtool: SubSearch,
        chat_block: CbSearch,
        human_tool_key: Some(HtCode),
        action_icons: &[
            ("find_files", "folder-search"),
            ("check_status", "activity"),
        ],
        label_running: "tools.searchGrepRunning",
        label_done: "tools.searchGrepDone",
        label_failed: "tools.searchGrepFailed",
        actions: &[
            action_sub!("grep", "Regex content search via ripgrep", SubSearch, labels: "tools.searchGrepRunning", "tools.searchGrepDone", "tools.searchGrepFailed"),
            action_sub!("find_files", "Fuzzy file name search", SubGlob, chat: CbGlob, labels: "tools.searchFindFilesRunning", "tools.searchFindFilesDone", "tools.searchFindFilesFailed"),
            action_sub!("glob", "True glob pattern matching (e.g. src/**/*.ts)", SubGlob, chat: CbGlob, labels: "tools.searchGlobRunning", "tools.searchGlobDone", "tools.searchGlobFailed"),
            action_sub!("symbols", "Search for code symbols (functions, classes, types)", SubSearch, labels: "tools.searchSymbolsRunning", "tools.searchSymbolsDone", "tools.searchSymbolsFailed"),
            action_sub!("check_status", "Check search status for a repository", OtherTool, chat: CbFallback, labels: "tools.searchCheckStatusRunning", "tools.searchCheckStatusDone", "tools.searchCheckStatusFailed"),
        ],
        ..DEFAULT_TOOL_ENTRY
    },
    ToolEntry {
        name: tool_names::USE_CODE_MAP,
        description: "Use the persistent Code Map symbol graph.",
        description_detail: "Read-only code intelligence backed by the Rust-native Code Map SQLite index. Use it for symbol search, source-aware node inspection, callers/callees, impact analysis, and relationship-oriented exploration after a workspace has been indexed. Use `manage_code_map` first when the index is missing, stale, failed, or needs a rebuild.",
        category: tool_categories::CODING,
        icon_id: "map",
        simulator_app: AppCode,
        app_subtool: SubSearch,
        chat_block: CbSearch,
        human_tool_key: Some(HtCode),
        action_icons: &[
            ("status", "activity"),
            ("node", "braces"),
            ("callers", "arrow-left-to-line"),
            ("callees", "arrow-right-from-line"),
            ("impact", "radar"),
            ("explore", "network"),
        ],
        label_running: "tools.codeMapSearchRunning",
        label_done: "tools.codeMapSearchDone",
        label_failed: "tools.codeMapSearchFailed",
        actions: &[
            action_sub!("status", "Show Code Map index status and counts", OtherTool, chat: CbFallback, labels: "tools.codeMapStatusRunning", "tools.codeMapStatusDone", "tools.codeMapStatusFailed"),
            action_sub!("search", "Search indexed symbols by name or qualified name", SubSearch, labels: "tools.codeMapSearchRunning", "tools.codeMapSearchDone", "tools.codeMapSearchFailed"),
            action_sub!("node", "Inspect a symbol or file node with source and relationships", Explore, labels: "tools.codeMapNodeRunning", "tools.codeMapNodeDone", "tools.codeMapNodeFailed"),
            action_sub!("callers", "List incoming callers and references for a node", Explore, labels: "tools.codeMapCallersRunning", "tools.codeMapCallersDone", "tools.codeMapCallersFailed"),
            action_sub!("callees", "List outgoing callees and references for a node", Explore, labels: "tools.codeMapCalleesRunning", "tools.codeMapCalleesDone", "tools.codeMapCalleesFailed"),
            action_sub!("impact", "Run bounded reverse traversal for impact analysis", Explore, labels: "tools.codeMapImpactRunning", "tools.codeMapImpactDone", "tools.codeMapImpactFailed"),
            action_sub!("explore", "Explore related indexed symbols and relationship trails", Explore, labels: "tools.codeMapExploreRunning", "tools.codeMapExploreDone", "tools.codeMapExploreFailed"),
        ],
        ..DEFAULT_TOOL_ENTRY
    },
    ToolEntry {
        name: tool_names::MANAGE_CODE_MAP,
        description: "Manage the Code Map index lifecycle.",
        description_detail: "Companion management tool for the Rust-native Code Map index. Use it to inspect status and freshness, run incremental indexing, force a full rebuild, cancel an active index task, or clear the local index. It prepares the persistent symbol graph consumed by the read-only `use_code_map` tool.",
        category: tool_categories::CODING,
        icon_id: "map",
        simulator_app: AppCode,
        app_subtool: OtherTool,
        chat_block: CbFallback,
        human_tool_key: Some(HtCode),
        action_icons: &[
            ("status", "activity"),
            ("index", "play"),
            ("reindex", "refresh-cw"),
            ("cancel", "circle-stop"),
            ("clear", "trash-2"),
        ],
        label_running: "tools.manageCodeMapRunning",
        label_done: "tools.manageCodeMapDone",
        label_failed: "tools.manageCodeMapFailed",
        actions: &[
            action_sub!("status", "Inspect Code Map index state, progress, freshness, counts, and size", OtherTool, chat: CbFallback, labels: "tools.manageCodeMapStatusRunning", "tools.manageCodeMapStatusDone", "tools.manageCodeMapStatusFailed"),
            action_sub!("index", "Run an incremental Code Map index for new or stale files", OtherTool, chat: CbFallback, labels: "tools.manageCodeMapIndexRunning", "tools.manageCodeMapIndexDone", "tools.manageCodeMapIndexFailed"),
            action_sub!("reindex", "Force a full Code Map rebuild", OtherTool, chat: CbFallback, labels: "tools.manageCodeMapReindexRunning", "tools.manageCodeMapReindexDone", "tools.manageCodeMapReindexFailed"),
            action_sub!("cancel", "Request cancellation for an active Code Map index task", OtherTool, chat: CbFallback, labels: "tools.manageCodeMapCancelRunning", "tools.manageCodeMapCancelDone", "tools.manageCodeMapCancelFailed"),
            action_sub!("clear", "Delete the local Code Map index for a workspace", OtherTool, chat: CbFallback, labels: "tools.manageCodeMapClearRunning", "tools.manageCodeMapClearDone", "tools.manageCodeMapClearFailed"),
        ],
        required_capability: CapCoding,
        ..DEFAULT_TOOL_ENTRY
    },
    ToolEntry {
        name: tool_names::MANAGE_WORKSPACE,
        description: "Manage orgii workspaces (git repos and work folders) tracked by the IDE.",
        description_detail: "Unified tool for listing, adding, creating, and removing workspaces. Actions: `list` enumerates tracked workspaces (names, paths, kinds); `add` registers an existing directory (auto-detects git vs folder); `create` creates a brand-new workspace (git=true|false); `remove` unregisters a workspace without touching files on disk. To clone a remote repo, use `run_shell` with `git clone`, wait for completion with `await_output` if it backgrounds, then register the cloned path with `add`.",
        category: tool_categories::CODING,
        icon_id: "folder-git-2",
        simulator_app: AppCode,
        app_subtool: Explore,
        // CbFallback routes to ToolCallBlock which has a dedicated
        // `ListWorkspacesOutput` styled renderer (Code2 icon for git repos,
        // Folder icon for plain folders). All actions share the same
        // `[kind] name → path` line format, so the single renderer works
        // uniformly across every sub-action — add/clone/create/remove emit a
        // single-entry list representing the changed workspace.
        chat_block: CbFallback,
        human_tool_key: Some(HtCode),
        label_running: "tools.manageWorkspaceListRunning",
        label_done: "tools.manageWorkspaceListDone",
        label_failed: "tools.manageWorkspaceListFailed",
        action_icons: &[
            ("list", "folder-git-2"),
            ("add", "folder-plus"),
            ("create", "folder-pen"),
            ("remove", "folder-minus"),
        ],
        actions: &[
            action_sub!("list", "List all tracked workspaces with paths and kinds", Explore, chat: CbFallback, labels: "tools.manageWorkspaceListRunning", "tools.manageWorkspaceListDone", "tools.manageWorkspaceListFailed"),
            action_sub!(
                "add",
                "Register an existing local directory as a workspace (auto-detects git vs folder, runs git init if needed)",
                Explore,
                chat: CbFallback,
                labels: "tools.manageWorkspaceAddRunning",
                "tools.manageWorkspaceAddDone",
                "tools.manageWorkspaceAddFailed"
            ),
            action_sub!(
                "create",
                "Create a new empty workspace (git=true by default; set git=false for a plain folder)",
                Explore,
                chat: CbFallback,
                labels: "tools.manageWorkspaceCreateRunning",
                "tools.manageWorkspaceCreateDone",
                "tools.manageWorkspaceCreateFailed"
            ),
            action_sub!(
                "remove",
                "Unregister a workspace by path or repo_id (files on disk are preserved)",
                Explore,
                chat: CbFallback,
                labels: "tools.manageWorkspaceRemoveRunning",
                "tools.manageWorkspaceRemoveDone",
                "tools.manageWorkspaceRemoveFailed"
            ),
        ],
        ..DEFAULT_TOOL_ENTRY
    },
    // ── Coding (SDE-primary; also registered on OS) ──
    ToolEntry {
        name: tool_names::EDIT_FILE,
        description: "Create, overwrite, or edit files with fuzzy search-and-replace.",
        description_detail: "Unified file editing tool with two modes:\n\n\
             **Create/Overwrite mode**: Provide `file_path` + `content` to create a new file or overwrite an existing one. Creates parent directories automatically.\n\n\
             **Edit mode**: Provide `file_path` + `old_string` + `new_string` for surgical search-and-replace. Uses 9 fuzzy matching strategies (whitespace, indentation, escapes) so minor formatting differences resolve automatically.",
        category: tool_categories::CODING,
        icon_id: "file-pen-line",
        simulator_app: AppCode,
        app_subtool: FileWrite,
        chat_block: CbDiff,
        human_tool_key: Some(HtCode),
        label_running: "tools.editFileRunning",
        label_done: "tools.editFileDone",
        label_failed: "tools.editFileFailed",
        status_labels: &[
            ("compact_running", "tools.editFileCompactRunning"),
            ("compact_done", "tools.editFileCompactDone"),
        ],
        actions: &[
            action_sub!("create", "Create a new file with full content", FileWrite, labels: "tools.editFileCreateRunning", "tools.editFileCreateDone", "tools.editFileCreateFailed"),
            action_sub!("overwrite", "Replace entire file contents", FileWrite, labels: "tools.editFileOverwriteRunning", "tools.editFileOverwriteDone", "tools.editFileOverwriteFailed"),
            action_sub!("edit", "Apply a search-and-replace edit with fuzzy matching", FileWrite, labels: "tools.editFileEditRunning", "tools.editFileEditDone", "tools.editFileEditFailed"),
        ],
        required_capability: CapCoding,
        ..DEFAULT_TOOL_ENTRY
    },
    ToolEntry {
        name: tool_names::DELETE_FILE,
        description: "Delete a single file from the workspace.",
        description_detail: "Deletes exactly one file after workspace sandbox validation. Refuses to delete directories.",
        category: tool_categories::CODING,
        icon_id: "trash-2",
        simulator_app: AppCode,
        app_subtool: FileWrite,
        chat_block: CbDiff,
        human_tool_key: Some(HtCode),
        label_running: "tools.deleteFileRunning",
        label_done: "tools.deleteFileDone",
        label_failed: "tools.deleteFileFailed",
        actions: &[
            action_sub!("delete", "Delete a single file", FileWrite, labels: "tools.deleteFileDeleteRunning", "tools.deleteFileDeleteDone", "tools.deleteFileDeleteFailed"),
        ],
        required_capability: CapCoding,
        ..DEFAULT_TOOL_ENTRY
    },
    ToolEntry {
        name: tool_names::QUERY_LSP,
        description: "Query language servers for diagnostics and code navigation.",
        description_detail: "Talks to installed Language Servers for diagnostics, definitions, references, hover details, document symbols, and workspace symbol search. Grounds edits in real type and project structure.",
        category: tool_categories::CODING,
        icon_id: "braces",
        simulator_app: AppCode,
        app_subtool: Explore,
        chat_block: CbExplore,
        human_tool_key: Some(HtCode),
        label_running: "tools.queryLspRunning",
        label_done: "tools.queryLspDone",
        label_failed: "tools.queryLspFailed",
        actions: &[
            action_sub!("diagnostics", "Get lint/type errors for one or more files/directories", Explore, labels: "tools.queryLspDiagnosticsRunning", "tools.queryLspDiagnosticsDone", "tools.queryLspDiagnosticsFailed"),
            action_sub!("definition", "Go to definition at a position", Explore, labels: "tools.queryLspDefinitionRunning", "tools.queryLspDefinitionDone", "tools.queryLspDefinitionFailed"),
            action_sub!("references", "Find all references of a symbol", Explore, labels: "tools.queryLspReferencesRunning", "tools.queryLspReferencesDone", "tools.queryLspReferencesFailed"),
            action_sub!("hover", "Get type info and documentation at a position", Explore, labels: "tools.queryLspHoverRunning", "tools.queryLspHoverDone", "tools.queryLspHoverFailed"),
            action_sub!("document_symbol", "List symbols in a file", Explore, labels: "tools.queryLspRunning", "tools.queryLspDone", "tools.queryLspFailed"),
            action_sub!("workspace_symbol", "Search symbols across the workspace", Explore, labels: "tools.queryLspRunning", "tools.queryLspDone", "tools.queryLspFailed"),
        ],
        required_capability: CapCoding,
        ..DEFAULT_TOOL_ENTRY
    },
    ToolEntry {
        name: tool_names::MANAGE_LSP,
        description: "Inspect, configure, and control installed language servers.",
        description_detail: "Lists supported language servers, reports installed and running status, returns install or uninstall commands, toggles workspace enablement, and starts or stops LSP processes. It does not execute package manager commands directly.",
        category: tool_categories::CODING,
        icon_id: "braces",
        simulator_app: AppCode,
        app_subtool: OtherTool,
        chat_block: CbFallback,
        human_tool_key: Some(HtCode),
        label_running: "tools.manageLspRunning",
        label_done: "tools.manageLspDone",
        label_failed: "tools.manageLspFailed",
        actions: &[
            action_sub!("list", "List supported servers with installed, running, and workspace-enabled status", OtherTool, labels: "tools.manageLspListRunning", "tools.manageLspListDone", "tools.manageLspListFailed"),
            action_sub!("running", "List currently running language servers", OtherTool, labels: "tools.manageLspRunningRunning", "tools.manageLspRunningDone", "tools.manageLspRunningFailed"),
            action_sub!("status", "Inspect one language server in detail", OtherTool, labels: "tools.manageLspStatusRunning", "tools.manageLspStatusDone", "tools.manageLspStatusFailed"),
            action_sub!("install_command", "Return the command needed to install a language server", OtherTool, labels: "tools.manageLspInstallCommandRunning", "tools.manageLspInstallCommandDone", "tools.manageLspInstallCommandFailed"),
            action_sub!("uninstall_command", "Return the command needed to uninstall a language server", OtherTool, labels: "tools.manageLspUninstallCommandRunning", "tools.manageLspUninstallCommandDone", "tools.manageLspUninstallCommandFailed"),
            action_sub!("enable", "Enable a language server for the workspace", OtherTool, labels: "tools.manageLspEnableRunning", "tools.manageLspEnableDone", "tools.manageLspEnableFailed"),
            action_sub!("disable", "Disable a language server for the workspace", OtherTool, labels: "tools.manageLspDisableRunning", "tools.manageLspDisableDone", "tools.manageLspDisableFailed"),
            action_sub!("start", "Start a language server process", OtherTool, labels: "tools.manageLspStartRunning", "tools.manageLspStartDone", "tools.manageLspStartFailed"),
            action_sub!("stop", "Stop a language server process", OtherTool, labels: "tools.manageLspStopRunning", "tools.manageLspStopDone", "tools.manageLspStopFailed"),
        ],
        required_capability: CapCoding,
        ..DEFAULT_TOOL_ENTRY
    },
    ToolEntry {
        name: tool_names::MANAGE_TODO,
        description: "Session-scoped task tracking (write and read todo lists).",
        description_detail: "Creates, updates, and reads in-session todo items for plans, checklists, and progress tracking visible across turns.",
        category: tool_categories::CODING,
        icon_id: "list-todo",
        simulator_app: AppChannels,
        app_subtool: SubTodo,
        chat_block: CbTodo,
        label_running: "tools.manageTodoRunning",
        label_done: "tools.manageTodoDone",
        label_failed: "tools.manageTodoFailed",
        actions: &[
            action_sub!("write", "Replace the entire todo list for this session", SubTodo, labels: "tools.manageTodoWriteRunning", "tools.manageTodoWriteDone", "tools.manageTodoWriteFailed"),
            action_sub!("read", "Fetch the current todo list", SubTodo, labels: "tools.manageTodoReadRunning", "tools.manageTodoReadDone", "tools.manageTodoReadFailed"),
        ],
        required_capability: CapCoding,
        ..DEFAULT_TOOL_ENTRY
    },
    // ── Plan mode — non-blocking plan approval ──
    ToolEntry {
        name: tool_names::CREATE_PLAN,
        description: "Write the session plan document and submit it for review.",
        description_detail: "Only available in Plan mode. In a top-level session or coordinator turn, this submits the plan to the user-facing Build approval surface. In a non-coordinator Agent Org member turn, this submits a typed plan approval request to the coordinator inbox. Calling again with the same title overwrites the same file; pass `new_plan: true` to rotate the slug.",
        category: tool_categories::CODING,
        icon_id: "clipboard-list",
        simulator_app: AppChannels,
        app_subtool: OtherInteractions,
        chat_block: CbPlanDoc,
        label_running: "tools.createPlanRunning",
        label_done: "tools.createPlanDone",
        label_failed: "tools.createPlanFailed",
        ..DEFAULT_TOOL_ENTRY
    },
    ToolEntry {
        name: tool_names::WRITE_ENV_FILE,
        description: "Write `.env`-style files, resolving secret tokens at write time.",
        description_detail: "Privileged consumer of `manage_secrets` tokens. Resolves any `{{secret:<token>}}` placeholders in the body to plaintext at the moment of write, sets `0o600` on Unix, enforces dotenv-style filenames, and refuses to overwrite git-tracked files without an explicit acknowledgement. The plaintext never enters the LLM transcript or the chat history.",
        category: tool_categories::CODING,
        icon_id: "lock",
        simulator_app: AppCode,
        app_subtool: FileWrite,
        chat_block: CbFallback,
        human_tool_key: Some(HtCode),
        label_running: "tools.writeEnvFileRunning",
        label_done: "tools.writeEnvFileDone",
        label_failed: "tools.writeEnvFileFailed",
        actions: &[
            action_sub!("write", "Write a `.env` file, resolving any secret tokens at write time", FileWrite, labels: "tools.writeEnvFileWriteRunning", "tools.writeEnvFileWriteDone", "tools.writeEnvFileWriteFailed"),
        ],
        required_capability: CapCoding,
        ..DEFAULT_TOOL_ENTRY
    },
    ToolEntry {
        name: tool_names::SETUP_REPO,
        description: "Report setup status and environment variables to the App Launcher.",
        description_detail: "Surfaces detected runtimes, dependency state, and relevant environment variables to the App Launcher for onboarding and reproducible dev setup.",
        category: tool_categories::CODING,
        icon_id: "folder-cog",
        simulator_app: AppCode,
        app_subtool: OtherTool,
        chat_block: CbSetupRepo,
        label_running: "tools.setupRepoRunning",
        label_done: "tools.setupRepoDone",
        label_failed: "tools.setupRepoFailed",
        actions: &[
            action_sub!("report_status", "Report detected runtimes and dependency state", OtherTool, chat: CbSetupRepo, labels: "tools.setupRepoReportStatusRunning", "tools.setupRepoReportStatusDone", "tools.setupRepoReportStatusFailed"),
            action_sub!("update_env", "Update environment variable configuration", OtherTool, chat: CbSetupRepo, labels: "tools.setupRepoUpdateEnvRunning", "tools.setupRepoUpdateEnvDone", "tools.setupRepoUpdateEnvFailed"),
            action_sub!("add_env_vars", "Add new environment variables to the setup", OtherTool, chat: CbSetupRepo, labels: "tools.setupRepoAddEnvVarsRunning", "tools.setupRepoAddEnvVarsDone", "tools.setupRepoAddEnvVarsFailed"),
            action_sub!("launch_app", "Launch the configured application", OtherTool, chat: CbSetupRepo, labels: "tools.setupRepoLaunchAppRunning", "tools.setupRepoLaunchAppDone", "tools.setupRepoLaunchAppFailed"),
        ],
        required_capability: CapCoding,
        ..DEFAULT_TOOL_ENTRY
    },
    ToolEntry {
        name: tool_names::WORKTREE,
        description: "Manage git worktrees for isolated parallel work.",
        description_detail: "Creates and manages git worktrees so the agent can work on a branch in an isolated checkout without disturbing the main workspace. Useful for parallel session sandboxing and safe refactors.",
        category: tool_categories::CODING,
        icon_id: "git-branch",
        simulator_app: AppCode,
        app_subtool: OtherTool,
        chat_block: CbFallback,
        human_tool_key: Some(HtCode),
        action_icons: &[],
        label_running: "tools.worktreeRunning",
        label_done: "tools.worktreeDone",
        label_failed: "tools.worktreeFailed",
        actions: &[
            action_sub!("add", "Create a worktree for a branch and switch into it", OtherTool,
                labels: "tools.worktreeAddRunning", "tools.worktreeAddDone", "tools.worktreeAddFailed"),
            action_sub!("leave", "Leave the current worktree and return to the main workspace", OtherTool,
                labels: "tools.worktreeLeaveRunning", "tools.worktreeLeaveDone", "tools.worktreeLeaveFailed"),
            action_sub!("list", "Show all active worktrees for the repository", OtherTool, labels: "tools.worktreeListRunning", "tools.worktreeListDone", "tools.worktreeListFailed"),
        ],
        required_capability: CapCoding,
        ..DEFAULT_TOOL_ENTRY
    },
    ToolEntry {
        name: tool_names::RENDER_INLINE_CANVAS,
        description: "Render interactive UI inline in the chat panel.",
        description_detail: "Displays an interactive preview card directly in the chat stream. \
            Supports four modes: \"html\" (self-contained HTML/SVG/CSS rendered in a sandboxed iframe), \
            \"url\" (HTTPS URL embedded in an iframe), \"react\" (React App component sandbox with runtime errors), and \"a2ui\" (structured JSONL element stream \
            for headings, text, code blocks, images, buttons, and lists). \
            Available to both SDE Agent and OS Agent.",
        category: tool_categories::CODING,
        icon_id: "layout",
        simulator_app: AppCanvas,
        app_subtool: OtherTool,
        chat_block: CbCanvasInline,
        label_running: "tools.renderInlineCanvasRunning",
        label_done: "tools.renderInlineCanvasDone",
        label_failed: "tools.renderInlineCanvasFailed",
        actions: &[
            action_sub!("html", "Render a self-contained HTML/SVG/CSS snippet", OtherTool, chat: CbCanvasInline, labels: "tools.renderInlineCanvasHtmlRunning", "tools.renderInlineCanvasHtmlDone", "tools.renderInlineCanvasHtmlFailed"),
            action_sub!("url", "Embed an HTTPS URL in a sandboxed iframe", OtherTool, chat: CbCanvasInline, labels: "tools.renderInlineCanvasUrlRunning", "tools.renderInlineCanvasUrlDone", "tools.renderInlineCanvasUrlFailed"),
            action_sub!("react", "Render a React App component in an iframe sandbox", OtherTool, chat: CbCanvasInline, labels: "tools.renderInlineCanvasHtmlRunning", "tools.renderInlineCanvasHtmlDone", "tools.renderInlineCanvasHtmlFailed"),
            action_sub!("a2ui", "Stream typed UI elements (heading, text, code, image, button, list)", OtherTool, chat: CbCanvasInline, labels: "tools.renderInlineCanvasA2uiRunning", "tools.renderInlineCanvasA2uiDone", "tools.renderInlineCanvasA2uiFailed"),
        ],
        ..DEFAULT_TOOL_ENTRY
    },
    ToolEntry {
        name: tool_names::MANAGE_FILE_HISTORY,
        description: "Inspect and rewind file-history snapshots for this session.",
        description_detail: "Lists captured snapshots and their files. \
            Use `rewind` to restore all files to their state before a given \
            message — this undoes every agent file edit since that point. \
            Use `redo` to re-apply the most recent rewind if a redo snapshot exists.",
        category: tool_categories::CODING,
        icon_id: "history",
        simulator_app: AppCode,
        app_subtool: OtherTool,
        chat_block: CbFallback,
        human_tool_key: Some(HtCode),
        label_running: "tools.manageFileHistoryRunning",
        label_done: "tools.manageFileHistoryDone",
        label_failed: "tools.manageFileHistoryFailed",
        actions: &[
            action_sub!("list", "List all snapshots for this session", OtherTool, labels: "tools.manageFileHistoryListRunning", "tools.manageFileHistoryListDone", "tools.manageFileHistoryListFailed"),
            action_sub!("rewind", "Revert all files to their state before a message", OtherTool, labels: "tools.manageFileHistoryRewindRunning", "tools.manageFileHistoryRewindDone", "tools.manageFileHistoryRewindFailed"),
            action_sub!("redo", "Re-apply the most recent rewind", OtherTool, labels: "tools.manageFileHistoryRedoRunning", "tools.manageFileHistoryRedoDone", "tools.manageFileHistoryRedoFailed"),
        ],
        required_capability: CapCoding,
        ..DEFAULT_TOOL_ENTRY
    },
];
