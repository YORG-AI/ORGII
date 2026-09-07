import { emit } from "@tauri-apps/api/event";

/**
 * Narrow cross-window invalidation for the local project/member roster.
 * Work Item and Discussion mutations deliberately do not use this channel.
 */
export const PROJECT_ROSTER_CHANGED_EVENT = "orgii-project-roster-changed";
export const PROJECT_STATUS_DEFINITIONS_CHANGED_EVENT =
  "orgii-project-status-definitions-changed";

export interface ProjectRosterChangedPayload {
  project_slug?: string;
  source: "project" | "members" | "collab";
}

export function emitProjectRosterChanged(
  payload: ProjectRosterChangedPayload
): Promise<void> {
  return emit(PROJECT_ROSTER_CHANGED_EVENT, payload);
}

/**
 * Post-commit notifications must never turn a successful project mutation
 * into a rejected UI action. The read owner will converge on the next mount
 * even when this best-effort cross-window nudge cannot be published.
 */
export function notifyProjectRosterChanged(
  payload: ProjectRosterChangedPayload
): void {
  try {
    void emitProjectRosterChanged(payload).catch(() => undefined);
  } catch {
    // A notification is only an acceleration path after commit.
  }
}

export interface ProjectStatusDefinitionsChangedPayload {
  org_id: string;
}

export function emitProjectStatusDefinitionsChanged(
  payload: ProjectStatusDefinitionsChangedPayload
): Promise<void> {
  return emit(PROJECT_STATUS_DEFINITIONS_CHANGED_EVENT, payload);
}

export function notifyProjectStatusDefinitionsChanged(orgId: string): void {
  try {
    void emitProjectStatusDefinitionsChanged({ org_id: orgId }).catch(
      () => undefined
    );
  } catch {
    // A notification is only an acceleration path after commit.
  }
}
