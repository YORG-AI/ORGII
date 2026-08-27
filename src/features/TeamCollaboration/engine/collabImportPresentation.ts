/**
 * Display-side resolution for an imported replay copy: the source-derived
 * timestamps, the inherited agent/model presentation, and the no-content
 * refresh that reconciles an existing local row with the current roster row.
 */
import { buildCloudOrgSelectorValue } from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import { sessionsAtom } from "@src/store/session/sessionAtom/atoms";
import { recordGuestImportedSession } from "@src/store/session/sessionAtom/guestImportRegistry";
import {
  applyImportedSessionTimestamps,
  upsertSession,
} from "@src/store/session/sessionAtom/mutations";
import { persistSessions } from "@src/store/session/sessionAtom/persistence";
import type {
  Session,
  SessionImportedFrom,
} from "@src/store/session/sessionAtom/types";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";
import { resolveSessionDisplayMetadata } from "@src/util/session/sessionDisplayMetadata";

import type { ImportRemoteSessionOptions } from "./collabImportStreaming";

/**
 * Activity time of the OWNER's session, for the imported copy's timestamps.
 *
 * The replay copy describes someone else's work; stamping it with the moment
 * the viewer clicked made every card jump its Started / Last updated to "Now"
 * on first open, reordered List/Diary around the click, and pulled an old
 * session back out of the auto-archived column. Cloud metadata carries no
 * creation timestamp, so `lastActivityAt` is the only source-side time we
 * have — the same proxy the pre-click cloud card itself renders.
 *
 * Returns undefined for a row carrying no usable `lastActivityAt`, and the
 * two callers deliberately treat that differently: the refresh path leaves
 * the existing stamps alone (nothing to adopt, and the row already has some),
 * while the write path falls back to `now` because `created_at`/`updated_at`
 * are required on the insert it may be about to make.
 */
export function readSourceActivityAt(
  remoteSession: ImportRemoteSessionOptions["remoteSession"]
): string | undefined {
  const lastActivityAt = remoteSession.lastActivityAt;
  if (!lastActivityAt) return undefined;
  return Number.isFinite(Date.parse(lastActivityAt))
    ? lastActivityAt
    : undefined;
}

/**
 * A session cannot have been created after its own last activity. Keeping the
 * earlier of the two also heals rows imported before the fix above, whose
 * `created_at` is the old import-click stamp.
 */
export function resolveImportedCreatedAt(
  existingCreatedAt: string | undefined,
  activityAt: string
): string {
  if (!existingCreatedAt) return activityAt;
  const existingMs = Date.parse(existingCreatedAt);
  if (!Number.isFinite(existingMs)) return activityAt;
  return existingMs <= Date.parse(activityAt) ? existingCreatedAt : activityAt;
}

export function resolveImportedSourceDisplay(
  remoteSession: ImportRemoteSessionOptions["remoteSession"],
  existing: Session | undefined
): NonNullable<SessionImportedFrom["sourceDisplay"]> {
  return {
    cliAgentType:
      remoteSession.cliAgentType ??
      existing?.importedFrom?.sourceDisplay?.cliAgentType,
    agentDisplayName:
      remoteSession.agentDisplayName ??
      existing?.importedFrom?.sourceDisplay?.agentDisplayName,
    agentDefinitionId:
      remoteSession.agentDefinitionId ??
      existing?.importedFrom?.sourceDisplay?.agentDefinitionId,
    model: remoteSession.model ?? existing?.importedFrom?.sourceDisplay?.model,
  };
}

export function resolveImportedSourcePresentation(
  localSessionId: string,
  importedFrom: SessionImportedFrom
) {
  return resolveSessionDisplayMetadata({
    kind: "local",
    session: {
      session_id: localSessionId,
      importedFrom,
    },
  });
}

/**
 * Re-resolve an existing replay copy's presentation from the current roster
 * row, without fetching content.
 *
 * Three of the four call sites reach here having downloaded NOTHING — the
 * roster published no segments, a restream returned empty, or the assembler
 * refused the payload — and they still adopt the source's activity time. That
 * is deliberate, not an oversight: `updated_at` on a replay copy describes the
 * OWNER's session activity, not how fresh our local content is. The cloud card
 * for a session with no local copy at all already renders
 * `created_at`/`updated_at` from the same `lastActivityAt`
 * (`cloudRemoteToKanbanTask.ts`), so a copy that adopts it stays consistent
 * with the card it replaced. Content progress is tracked separately and
 * explicitly by the `importedFrom` cursor (`epoch`/`seq`/`count`); the two are
 * not meant to move together, and gating the clock on a successful fetch would
 * reintroduce exactly the card-jumping this module's timestamps exist to avoid.
 */
export function refreshImportedSessionPresentation(
  existing: Session,
  remoteSession: ImportRemoteSessionOptions["remoteSession"]
): void {
  const importedFrom = existing.importedFrom;
  if (!importedFrom) return;

  const externalHistorySource =
    remoteSession.origin?.kind === "external_history"
      ? remoteSession.origin.source
      : importedFrom.externalHistorySource;
  const sourceDisplay = resolveImportedSourceDisplay(remoteSession, existing);
  const ownerAvatarUrl =
    remoteSession.ownerAvatarUrl ?? importedFrom.ownerAvatarUrl;
  const repoPath = remoteSession.repoPath ?? existing.repoPath;
  const branch = remoteSession.branch ?? existing.branch;
  const baseBranch = remoteSession.baseBranch ?? existing.baseBranch;
  const worktreeBranch =
    remoteSession.worktreeBranch ?? existing.worktreeBranch;
  const refreshedImportedFrom: SessionImportedFrom = {
    ...importedFrom,
    ownerMemberId: remoteSession.ownerMemberId,
    ownerDisplayName: remoteSession.ownerDisplayName,
    ownerAvatarUrl,
    externalHistorySource,
    sourceDisplay,
  };
  const sourcePresentation = resolveImportedSourcePresentation(
    existing.session_id,
    refreshedImportedFrom
  );
  // Rows imported before the ownership stamp used the selector form carry a
  // bare org uuid, which resolves to no owning org. Heal them here: this
  // refresh is the only path a long-lived import takes, so without it a
  // legacy row never regains its ownership-derived affordances. Guest rows
  // (no ownership stamp) and non-cloud scopes are left untouched.
  const normalizedOrgId =
    existing.orgId === importedFrom.orgId
      ? buildCloudOrgSelectorValue(importedFrom.orgId)
      : existing.orgId;
  // Same healing rationale for the source-activity timestamps: a copy imported
  // before they were tracked carries the old import-click stamp, and a
  // cursor-current reopen never reaches the write path that would correct it.
  const activityAt = readSourceActivityAt(remoteSession);
  const createdAt = activityAt
    ? resolveImportedCreatedAt(existing.created_at, activityAt)
    : existing.created_at;
  const timestampsUnchanged =
    !activityAt ||
    (existing.created_at === createdAt &&
      existing.updated_at === activityAt &&
      existing.completed_at === activityAt);
  const unchanged =
    existing.orgId === normalizedOrgId &&
    timestampsUnchanged &&
    existing.name === remoteSession.title &&
    existing.repoPath === repoPath &&
    existing.branch === branch &&
    existing.baseBranch === baseBranch &&
    existing.worktreeBranch === worktreeBranch &&
    existing.agentDisplayName === sourcePresentation.agentLabel &&
    existing.agentIconId === sourcePresentation.agentIconId &&
    importedFrom.ownerMemberId === remoteSession.ownerMemberId &&
    importedFrom.ownerDisplayName === remoteSession.ownerDisplayName &&
    importedFrom.ownerAvatarUrl === ownerAvatarUrl &&
    importedFrom.externalHistorySource === externalHistorySource &&
    importedFrom.sourceDisplay?.cliAgentType === sourceDisplay.cliAgentType &&
    importedFrom.sourceDisplay?.agentDisplayName ===
      sourceDisplay.agentDisplayName &&
    importedFrom.sourceDisplay?.agentDefinitionId ===
      sourceDisplay.agentDefinitionId &&
    importedFrom.sourceDisplay?.model === sourceDisplay.model;
  if (unchanged) return;

  const refreshed: Session = {
    ...existing,
    ...(normalizedOrgId !== undefined ? { orgId: normalizedOrgId } : {}),
    ...(activityAt
      ? {
          created_at: createdAt,
          updated_at: activityAt,
          completed_at: activityAt,
        }
      : {}),
    name: remoteSession.title,
    repoPath,
    branch,
    baseBranch,
    worktreeBranch,
    agentDisplayName: sourcePresentation.agentLabel,
    agentIconId: sourcePresentation.agentIconId,
    importedFrom: refreshedImportedFrom,
  };
  upsertSession(refreshed);
  if (activityAt) {
    // upsertSession pins timestamps; this row's clock is the source's.
    applyImportedSessionTimestamps(existing.session_id, {
      created_at: createdAt ?? activityAt,
      updated_at: activityAt,
      completed_at: activityAt,
    });
  }
  recordGuestImportedSession(refreshed);
  persistSessions(getInstrumentedStore().get(sessionsAtom) as Session[]);
}
