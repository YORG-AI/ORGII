/**
 * Code Editor App Store
 *
 * State management for the Code Editor app in Workstation.
 * Includes editor state, terminal, file explorer, and search.
 */

// Editor UI state (chat, themes, code citation)
export * from "./editor";

// Terminal sessions
export * from "./terminal";

// File explorer
export * from "./file";

// Code search
export * from "./search";

// Workspace listening ports (status bar)
export * from "./workspacePortsAtom";

// Git diff review bar (change list position)
export * from "./gitReviewNavigationAtom";

// Shared unified/split presentation preference for git diff surfaces
export * from "./diffViewModeAtom";

// Source Control focus target (sidebar click → scroll/expand in All Changes view)
export * from "./sourceControlFocusTargetAtom";

// Source Control sidebar filter mode (file buckets vs git history graph)
export * from "./sourceControlFilterModeAtom";

// Source Control worktree scope (host vs linked worktree)
export * from "./sourceControlScopeAtom";

// Source Control state contracts
export * from "./sourceControlTypes";

// Pinned Terminal tab target selection
export * from "./terminalTargetAtom";

// Git operation hook ref (set by EditorIntegrations)
export * from "./outputIntegration";

// GitHub Issues list, detail, and callback atoms
export * from "./workstationIssueAtom";
