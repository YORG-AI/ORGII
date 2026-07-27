/**
 * Org2CloudSyncEngine — per-org entitlement backoff bookkeeping.
 *
 * ORG2_CONFLICT is handled inline by the session-push retry path; this
 * module owns the OTHER two entitlement failures (ORG2_QUOTA_EXCEEDED /
 * ORG2_SYNC_DISABLED, including their projects/work-items counterpart) —
 * bounded per-org backoff plus the "only the actively viewed org surfaces a
 * warning" notification rule from the engine's module doc.
 */
import Message from "@src/components/Message";
import { createLogger } from "@src/hooks/logger";
import i18n from "@src/i18n";

import { isOrg2ProjectsErrorCode } from "./org2CloudProjectsClient";
import { isOrg2SyncErrorCode } from "./org2CloudSyncClient";
import {
  INACTIVE_ORG_BACKOFF_COOLDOWN_MS,
  ORG_BACKOFF_COOLDOWN_MS,
} from "./org2CloudSyncEngine.constants";

const log = createLogger("Org2CloudSyncEngine");

/** ORG2_CONFLICT is re-anchored inline and is never a backoff trigger. */
export function isCloudSyncBackoffError(error: unknown): boolean {
  return (
    isOrg2SyncErrorCode(error, "ORG2_QUOTA_EXCEEDED") ||
    isOrg2SyncErrorCode(error, "ORG2_SYNC_DISABLED") ||
    // Projects/work-items RPCs (Phase B) gate on the same entitlement.
    isOrg2ProjectsErrorCode(error, "ORG2_SYNC_DISABLED")
  );
}

/**
 * Org id → entitlement backoff deadline + notification state. Session
 * replay quota must not block the projects/work-items control plane: users
 * still need to delete shared data while replay uploads are over quota, so
 * the "kind" of an active backoff is tracked alongside its deadline.
 */
export class Org2CloudOrgBackoffTracker {
  private readonly untilMs = new Map<string, number>();
  /** Org id → plane that caused the entitlement backoff. */
  private readonly kinds = new Map<string, "session_quota" | "sync_disabled">();
  /** Whether the current deadline was established while the org was
   * visible. Selecting an org whose deadline came from a background pass
   * resumes it. */
  private readonly audiences = new Map<string, "active" | "inactive">();
  /** Strongest report already emitted for the current entitlement episode.
   * An inactive log can be upgraded once to an active toast; automatic
   * expiry otherwise preserves the marker so persistent failures cannot
   * make noise. */
  private readonly reportedAudiences = new Map<string, "active" | "inactive">();

  constructor(private readonly isActiveOrg: (orgId: string) => boolean) {}

  /** Shared by the engine's full reset() and its explicit clearAll() — both
   * clear the exact same bookkeeping. */
  reset(): void {
    this.untilMs.clear();
    this.kinds.clear();
    this.audiences.clear();
    this.reportedAudiences.clear();
  }

  prune(currentOrgIds: ReadonlySet<string>): void {
    for (const orgId of this.untilMs.keys()) {
      if (!currentOrgIds.has(orgId)) this.untilMs.delete(orgId);
    }
    for (const orgId of this.kinds.keys()) {
      if (!currentOrgIds.has(orgId)) this.kinds.delete(orgId);
    }
    for (const orgId of this.audiences.keys()) {
      if (!currentOrgIds.has(orgId)) this.audiences.delete(orgId);
    }
    for (const orgId of this.reportedAudiences.keys()) {
      if (!currentOrgIds.has(orgId)) this.reportedAudiences.delete(orgId);
    }
  }

  backOffOrg(orgId: string, error: unknown): void {
    const isActiveOrg = this.isActiveOrg(orgId);
    const cooldownMs = isActiveOrg
      ? ORG_BACKOFF_COOLDOWN_MS
      : INACTIVE_ORG_BACKOFF_COOLDOWN_MS;
    this.untilMs.set(orgId, Date.now() + cooldownMs);
    this.audiences.set(orgId, isActiveOrg ? "active" : "inactive");
    this.kinds.set(
      orgId,
      isOrg2SyncErrorCode(error, "ORG2_QUOTA_EXCEEDED")
        ? "session_quota"
        : "sync_disabled"
    );
    const previousAudience = this.reportedAudiences.get(orgId);
    if (previousAudience === "active" || (!isActiveOrg && previousAudience)) {
      return;
    }
    this.reportedAudiences.set(orgId, isActiveOrg ? "active" : "inactive");
    const key = isOrg2SyncErrorCode(error, "ORG2_QUOTA_EXCEEDED")
      ? "navigation:cloud.sync.quotaExceededToast"
      : "navigation:cloud.sync.syncDisabledToast";
    if (isActiveOrg) Message.warning(i18n.t(key));
    log.warn(
      `cloud sync backed off for ${isActiveOrg ? "active" : "inactive"} org ${orgId} for ${cooldownMs} ms:`,
      error
    );
  }

  clearOrgBackoff(orgId: string): void {
    this.untilMs.delete(orgId);
    this.kinds.delete(orgId);
    this.audiences.delete(orgId);
    this.reportedAudiences.delete(orgId);
  }

  /** Automatic expiry permits one bounded retry without starting a new
   * notification episode. A persistent entitlement error therefore remains
   * silent until a meaningful external/user signal calls clearOrgBackoff(). */
  private expireOrgBackoff(orgId: string): void {
    this.untilMs.delete(orgId);
    this.kinds.delete(orgId);
    this.audiences.delete(orgId);
  }

  isOrgBackedOff(orgId: string): boolean {
    const untilMs = this.untilMs.get(orgId);
    if (untilMs === undefined) return false;
    if (this.isActiveOrg(orgId) && this.audiences.get(orgId) === "inactive") {
      this.expireOrgBackoff(orgId);
      return false;
    }
    if (Date.now() < untilMs) return true;
    this.expireOrgBackoff(orgId);
    return false;
  }

  /** Session replay quota pauses only the session plane. Sync-disabled is an
   * org-wide entitlement gate and therefore still pauses project RPCs. */
  isOrgProjectBackedOff(orgId: string): boolean {
    if (!this.isOrgBackedOff(orgId)) return false;
    return this.kinds.get(orgId) !== "session_quota";
  }
}
