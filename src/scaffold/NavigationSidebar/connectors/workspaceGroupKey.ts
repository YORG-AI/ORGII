import type { Session } from "@src/store/session";

import { NO_WORKSPACE_KEY } from "./types";

/**
 * The workspace group a session belongs to in the Organize-by-workspace view.
 *
 * One derivation shared by the menu builder (which renders the groups) and
 * `loadedSessionVisibility` (which grows the visible count of the group a
 * newly loaded page landed in). They must agree: a session bucketed under a
 * key the pager never expands stays invisible behind its group's "Load more".
 *
 * A blank or whitespace-only `repoPath` is no workspace, not a workspace named
 * `"   "`. The upstream invariant lives at the imported-history write boundary
 * (`scratch_workspace.rs`); this is the view-side normalization for sessions
 * whose path never went through it.
 */
export function workspaceGroupKey(session: Session): string {
  const path = session.repoPath?.trim().replace(/\/+$/, "") ?? "";
  return path || NO_WORKSPACE_KEY;
}
