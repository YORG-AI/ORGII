/**
 * Loud failure for git operations invoked while no repository context is set.
 *
 * These operations used to fall back to typing the git command into the
 * user's visible terminal: the text ran in whatever cwd that terminal
 * happened to be in (possibly a different repository, possibly as input to a
 * running program), and the call resolved the moment Enter was delivered —
 * so the operation reported success regardless of what git did, and every
 * parameter that had no terminal spelling (remote, branch, --set-upstream,
 * prune) was silently dropped.
 *
 * Without a repository context there is nowhere trustworthy to run git.
 * Failing loudly surfaces the actual wiring bug (a caller that never set the
 * repo context) instead of fabricating a success.
 */
import { createLogger } from "@src/hooks/logger";

import type { GitOperationResult } from "./types";

const logger = createLogger("GitOps");

export function noRepoContextFailure(operation: string): GitOperationResult {
  logger.error(`${operation} not run: no repository context is set`);
  return {
    success: false,
    errorType: "unknown",
    message: `No repository is selected, so ${operation} was not run.`,
  };
}
