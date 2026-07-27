/**
 * diffSessionReplay.repoContext
 *
 * Repo-context resolution helpers for the Diff replay app: figuring out
 * which session/event/repo a diff or commit belongs to when no explicit
 * context was passed down. Pure (React-free) so each rule is unit-testable
 * in isolation from the host component.
 */
import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import type { SubmissionRepoContext } from "./useSubmissionsData";

export function hasRepoContext(context: SubmissionRepoContext | null): boolean {
  return Boolean(context?.repoId || context?.repoPath);
}

export function getSessionIdFromUnknown(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return typeof record.sessionId === "string" ? record.sessionId : null;
}

export function getRepoContextFromUnknown(
  value: unknown
): SubmissionRepoContext {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  const repoId =
    typeof record.repoId === "string"
      ? record.repoId
      : typeof record.repo_id === "string"
        ? record.repo_id
        : undefined;
  const repoPath =
    typeof record.repoPath === "string"
      ? record.repoPath
      : typeof record.repo_path === "string"
        ? record.repo_path
        : undefined;
  return { repoId: repoId ?? repoPath, repoPath };
}

export function resolveLatestRepoContext(
  events: readonly SessionEvent[],
  fallbackRepoContext: SubmissionRepoContext
): SubmissionRepoContext {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.repoId || event.repoPath) {
      return {
        repoId: event.repoId ?? event.repoPath,
        repoPath: event.repoPath,
      };
    }
  }
  return fallbackRepoContext;
}

export function getRepoContextKey(
  context: SubmissionRepoContext
): string | null {
  // Key by filesystem path when available so the same repo reached via
  // different repoId formats (UUID vs path) shares one history cache entry.
  return context.repoPath ?? context.repoId ?? null;
}
