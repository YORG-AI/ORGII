/**
 * Agent Session Workspace API
 *
 * Frontend wrapper for the `SessionWorkspace` runtime model.
 * Each agent session owns one `SessionWorkspace` in
 * memory describing its `workspace_root`, `working_dir`, and the set of
 * additional directories (`AdditionalDirectory[]`) granted during the
 * session.
 *
 * Use these commands to:
 *  - mirror multi-root IDE workspace folders into an already-running
 *    session (add/remove) — see `useSessionWorkspaceSync`.
 *  - switch a running session into a git worktree.
 *  - inspect the workspace for debugging or slash-command-style UIs.
 *
 * Launch-time seeding (mapping `workspaceFoldersAtom` → first
 * `SessionWorkspace`) happens inside `sessionLaunch` via the
 * `additionalDirectories` field on `SessionLaunchParams`, NOT through
 * these commands.
 */
import { invokeTauri } from "@src/util/platform/tauri/init";

/**
 * Origin of an additional directory entry. Mirrors the Rust enum
 * `agent_core::session::workspace::DirectorySource` (serde
 * `rename_all = "camelCase"`).
 *
 * Frontend wiring produces two variants:
 *  - `"session"` — transient grants made *by the agent* (e.g. the
 *    `/add-dir` slash command) or by ad-hoc UI actions. Dies with the
 *    runtime. The IDE sync layer must never add or remove these.
 *  - `"ideWorkspace"` — entries mirrored from the IDE's multi-root
 *    workspace folders by `useSessionWorkspaceSync`. This is the only
 *    source the IDE sync layer is allowed to manage.
 *
 * The settings/CLI variants are produced by the backend only.
 */
export type DirectorySource =
  | "session"
  | "ideWorkspace"
  | "localSettings"
  | "userSettings"
  | "cliArg";

export const DIRECTORY_SOURCE = {
  SESSION: "session",
  IDE_WORKSPACE: "ideWorkspace",
  LOCAL_SETTINGS: "localSettings",
  USER_SETTINGS: "userSettings",
  CLI_ARG: "cliArg",
} as const satisfies Record<string, DirectorySource>;

/** One entry in `SessionWorkspaceView.additionalDirectories`. */
export interface AdditionalDirectoryView {
  path: string;
  source: DirectorySource;
}

/**
 * Full snapshot of a session's workspace. Paths are absolute and
 * canonicalised by the backend at insertion time (the add/remove/launch
 * entry points all run `canonicalize` before storing), so frontend
 * consumers can compare paths with plain string equality.
 */
export interface SessionWorkspaceView {
  sessionId: string;
  workspaceRoot: string;
  workingDir: string;
  isWorktree: boolean;
  additionalDirectories: AdditionalDirectoryView[];
}

/**
 * Tauri event channel emitted by the backend whenever a session's
 * workspace changes (directory added/removed, runtime rebuilt).
 */
export const WORKSPACE_CHANGED_EVENT = "workspace:changed";

/**
 * Payload of the `workspace:changed` Tauri event. All paths are
 * canonical (camelCase serde rename on the Rust side).
 */
export interface WorkspaceChangedPayload {
  sessionId: string;
  workspaceRoot: string;
  workingDir: string;
  additionalDirectories: AdditionalDirectoryView[];
}

/**
 * Grant the session access to `path` in addition to its `workspace_root`.
 * The backend canonicalises `path` before storing it.
 *
 * Returns `true` if the directory was inserted, `false` if it was
 * already present (first-writer-wins — the original `source` is kept).
 *
 * `source` defaults to `"session"` on the Rust side when omitted.
 * IDE workspace sync MUST pass `"ideWorkspace"` so its entries stay
 * distinguishable from agent-initiated grants.
 */
export async function addSessionDirectory(
  sessionId: string,
  path: string,
  source?: DirectorySource
): Promise<boolean> {
  return invokeTauri<boolean>("agent_session_add_directory", {
    sessionId,
    path,
    source,
  });
}

/**
 * Revoke access to `path`. Returns `true` if an entry was removed,
 * `false` if it was not in the workspace. Does NOT touch
 * `workspace_root`.
 */
export async function removeSessionDirectory(
  sessionId: string,
  path: string
): Promise<boolean> {
  return invokeTauri<boolean>("agent_session_remove_directory", {
    sessionId,
    path,
  });
}

/** Inspect the current workspace of a running session. */
export async function listSessionWorkspace(
  sessionId: string
): Promise<SessionWorkspaceView> {
  return invokeTauri<SessionWorkspaceView>("agent_session_list_workspaces", {
    sessionId,
  });
}
