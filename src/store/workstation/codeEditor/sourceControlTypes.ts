/** Source Control sidebar dataset selected for the current workstation. */
export type SourceControlFilterMode =
  | "uncommitted"
  | "unstaged"
  | "staged"
  | "stashed"
  | "history"
  | "pr"
  | "issues";

/** Repository root used by Source Control reads and mutations. */
export type SourceControlScope =
  | { kind: "local" }
  | { kind: "worktree"; path: string };

/** Per-repository Source Control scope for the current app session. */
export type SourceControlScopeMap = Record<string, SourceControlScope>;
