/**
 * Shared types and helpers for Git operations modules.
 */
import type { GitErrorType } from "@src/api/http/git/streaming";
import { gitOutputIntegrationAtom } from "@src/store/workstation/codeEditor/outputIntegration";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

// ============================================
// Types
// ============================================

export interface GitOperationResult {
  success: boolean;
  errorType: GitErrorType;
  message?: string;
}

export interface RepoContext {
  repoId: string;
  repoPath: string;
}

// ============================================
// Repo Context (module-level singleton)
// ============================================

let repoContext: RepoContext | null = null;

export function setRepoContext(repoId: string, repoPath: string): void {
  repoContext = { repoId, repoPath };
}

export function getRepoContext(): RepoContext | null {
  return repoContext;
}

// ============================================
// Helper Functions
// ============================================

export function getStore() {
  return getInstrumentedStore();
}

export function getOutputIntegration() {
  return getStore().get(gitOutputIntegrationAtom);
}

const GIT_ERROR_TYPES = new Set<GitErrorType>([
  "none",
  "non_fast_forward",
  "protected_branch",
  "authentication_failed",
  "remote_branch_deleted",
  "uncommitted_changes",
  "network_error",
  "merge_conflicts",
  "permission_denied",
  "unknown",
]);

function getStructuredGitErrorType(error: Error): GitErrorType | undefined {
  const errorRecord = error as { errorType?: unknown; error_type?: unknown };
  const maybeErrorType = errorRecord.errorType ?? errorRecord.error_type;
  if (typeof maybeErrorType !== "string") return undefined;
  // The HTTP error boundary (GitApiError) emits "merge_conflict" (singular);
  // the streaming layer emits "merge_conflicts". Accept both.
  const normalized =
    maybeErrorType === "merge_conflict" ? "merge_conflicts" : maybeErrorType;
  if (!GIT_ERROR_TYPES.has(normalized as GitErrorType)) return undefined;
  return normalized as GitErrorType;
}

export function parseGitError(error: unknown): {
  type: GitErrorType;
  message: string;
} {
  if (error instanceof Error) {
    const structuredErrorType = getStructuredGitErrorType(error);
    if (structuredErrorType && structuredErrorType !== "none") {
      return { type: structuredErrorType, message: error.message };
    }

    const message = error.message.toLowerCase();

    // Order matters: git embeds branch names, file paths, and URLs in its
    // output, so the most content-specific pattern families are tested first
    // and the generic substrings ("connection", "timeout") come last. A bare
    // "auth" substring used to run first and turned a rejected push on a
    // branch named feature/auth-login into a credential prompt.
    if (
      message.includes("would be overwritten") ||
      message.includes("your local changes") ||
      message.includes("unstaged changes") ||
      message.includes("please commit or stash them") ||
      message.includes("please commit your changes or stash them") ||
      message.includes("untracked working tree files would be overwritten")
    ) {
      return { type: "uncommitted_changes", message: error.message };
    }

    if (
      message.includes("conflict") ||
      message.includes("automatic merge failed")
    ) {
      return { type: "merge_conflicts", message: error.message };
    }

    // Push rejections. Policy rejections also carry "failed to push some
    // refs", so the protected-branch family must win.
    if (
      message.includes("protected branch") ||
      message.includes("branch is protected") ||
      message.includes("pre-receive hook declined") ||
      message.includes("remote rejected")
    ) {
      return { type: "protected_branch", message: error.message };
    }
    if (
      message.includes("non-fast-forward") ||
      message.includes("fetch first") ||
      message.includes("updates were rejected") ||
      message.includes("failed to push some refs")
    ) {
      return { type: "non_fast_forward", message: error.message };
    }

    if (
      message.includes("authentication") ||
      message.includes("invalid username or password") ||
      message.includes("invalid username or token") ||
      message.includes("bad credentials") ||
      message.includes("http basic: access denied") ||
      message.includes("permission denied") ||
      message.includes("could not read username") ||
      message.includes("unable to get password from user") ||
      message.includes("repository not found") ||
      /\bsaml\b|\bsso\b/.test(message) ||
      message.includes("password authentication was removed") ||
      message.includes("requested url returned error: 403")
    ) {
      return { type: "authentication_failed", message: error.message };
    }

    if (
      message.includes("could not resolve host") ||
      message.includes("network") ||
      message.includes("connection") ||
      message.includes("timeout")
    ) {
      return { type: "network_error", message: error.message };
    }

    return { type: "unknown", message: error.message };
  }

  return { type: "unknown", message: String(error) };
}
