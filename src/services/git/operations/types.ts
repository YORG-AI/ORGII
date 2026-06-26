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
  if (!GIT_ERROR_TYPES.has(maybeErrorType as GitErrorType)) return undefined;
  return maybeErrorType as GitErrorType;
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

    if (
      message.includes("authentication") ||
      message.includes("auth") ||
      message.includes("invalid username or password") ||
      message.includes("invalid username or token") ||
      message.includes("bad credentials") ||
      message.includes("http basic: access denied") ||
      message.includes("permission denied") ||
      message.includes("could not read username") ||
      message.includes("unable to get password from user") ||
      message.includes("repository not found") ||
      message.includes("saml") ||
      message.includes("sso") ||
      message.includes("password authentication was removed") ||
      message.includes("requested url returned error: 403")
    ) {
      return { type: "authentication_failed", message: error.message };
    }

    if (
      message.includes("network") ||
      message.includes("connection") ||
      message.includes("timeout")
    ) {
      return { type: "network_error", message: error.message };
    }

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

    if (message.includes("conflict") || message.includes("merge")) {
      return { type: "merge_conflicts", message: error.message };
    }

    return { type: "unknown", message: error.message };
  }

  return { type: "unknown", message: String(error) };
}
