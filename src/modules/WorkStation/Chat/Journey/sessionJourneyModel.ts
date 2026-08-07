import type {
  JourneyReview,
  JourneySnapshot,
} from "@src/api/tauri/sessionJourney";

export type ReviewPanelMode = "dock" | "float" | "hidden";
export const REVIEW_PANEL_STORAGE_KEY = "orgii-session-journey-review-panel";

export function activeTask(snapshot: JourneySnapshot | null) {
  return snapshot?.active_task_id
    ? (snapshot.tasks[snapshot.active_task_id] ?? null)
    : null;
}

export function visibleReviews(
  snapshot: JourneySnapshot | null
): JourneyReview[] {
  return Object.values(snapshot?.reviews ?? {}).filter(
    (review) =>
      review.state === "queued" ||
      review.state === "ready" ||
      review.state === "failed"
  );
}

export function isRevisionConflict(error: unknown): boolean {
  return String(error).includes("修订冲突");
}

export function hasRecoverableJourney(
  snapshot: JourneySnapshot | null
): boolean {
  if (!snapshot) return false;
  return (
    Boolean(snapshot.active_task_id) ||
    Object.values(snapshot.branches).some(
      (fork) =>
        fork.id !== fork.parent_branch_id &&
        (fork.state === "active" || fork.state === "closing")
    )
  );
}

export function compareSameAnchorForks(snapshot: JourneySnapshot | null) {
  const groups = new Map<number, JourneySnapshot["branches"][string][]>();
  for (const fork of Object.values(snapshot?.branches ?? {})) {
    if (fork.id === fork.parent_branch_id) continue;
    groups.set(fork.anchor_sequence, [
      ...(groups.get(fork.anchor_sequence) ?? []),
      fork,
    ]);
  }
  return [...groups.entries()].filter(([, forks]) => forks.length > 1);
}
