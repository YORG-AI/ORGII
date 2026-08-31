/**
 * Resolve the cloud coordinates that own comments for the active session.
 * Imported replays and writable forks both point at the source session;
 * ordinary owned sessions point at their selected cloud-org tag. The local
 * session remains the execution target for Address Comments, so a fork can
 * act on parent threads without copying those threads into the fork row.
 */
import { useAtomValue } from "jotai";
import { useMemo } from "react";

import { getSessionForkedFrom } from "@src/features/TeamCollaboration/forkSession";
import { collectScopeMatchedImportedSessionIds } from "@src/features/TeamCollaboration/importedSessionScopeMatch";
import {
  type SessionOrgTags,
  cloudOrgIdsForSession,
  sessionOrgTagsAtom,
} from "@src/features/TeamCollaboration/sessionOrgTagsAtom";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";
import type { Session } from "@src/store/session/sessionAtom/types";
import { chatPanelSelectedCloudOrgAtom } from "@src/store/ui/chatPanelAtom";

import type { Org2CloudOrg } from "./org2CloudOrgsAtom";
import {
  org2CloudOrgsAtom,
  parseCloudOrgSelectorValue,
} from "./org2CloudOrgsAtom";
import { org2CloudRemoteSessionsAtom } from "./org2CloudRemoteSessionsAtom";
import {
  org2CloudPushCursorsAtom,
  org2CloudPushedMetadataAtom,
  org2CloudRepoScopesAtom,
} from "./org2CloudSyncAtoms";

export interface SessionCommentTarget {
  orgId: string;
  /** Cloud session id (the OWNER-side bare session id). */
  sessionId: string;
}

type CommentTargetSession = {
  session_id: string;
  /** Canonical launch ownership (`cloud:<orgId>` for managed-cloud runs). */
  orgId?: string;
  importedFrom?: Session["importedFrom"];
  forkedFrom?: Session["forkedFrom"];
  /** Checkout identity for the repo-scope auto-match admission route. */
  repoPath?: Session["repoPath"];
  repoRemoteUrls?: Session["repoRemoteUrls"];
};

/** Orgs whose configured repo scopes cover this session's checkout. */
function scopeMatchedOrgIdsForSession(
  session: CommentTargetSession,
  orgRepoScopes: Record<string, string[]>
): string[] {
  const matched: string[] = [];
  for (const [orgId, scopes] of Object.entries(orgRepoScopes)) {
    if (
      collectScopeMatchedImportedSessionIds([session], scopes).has(
        session.session_id
      )
    ) {
      matched.push(orgId);
    }
  }
  return matched;
}

/** Pure resolution (unit-tested; no IO). */
export function resolveSessionCommentTarget(params: {
  session: CommentTargetSession | null | undefined;
  cloudOrgs: readonly Org2CloudOrg[];
  tags: SessionOrgTags;
  /** Cloud org id the surrounding UI scope prefers (nullable). */
  preferredOrgId: string | null;
  /** orgId → configured repo scopes, for the auto-match admission route. */
  orgRepoScopes?: Record<string, string[]>;
  /**
   * Orgs where THIS session has a live server row (push cursor or pushed
   * metadata marker). Repo-scope matching alone over-generates: after a
   * GitHub rename, the network-identity fallback makes every org that
   * scoped either name a candidate, but the cloud row only exists where
   * the push pass actually pushed — listing comments elsewhere is
   * ORG2_SESSION_NOT_FOUND.
   */
  pushedOrgIds?: readonly string[];
}): SessionCommentTarget | null {
  const {
    session,
    cloudOrgs,
    tags,
    preferredOrgId,
    orgRepoScopes = {},
    pushedOrgIds = [],
  } = params;
  if (!session) return null;

  const memberOrgIds = new Set(cloudOrgs.map((org) => org.orgId));

  const importedFrom = session.importedFrom;
  if (importedFrom) {
    // Imported replay copy: comment on the SOURCE coordinates. Not being a
    // member anymore (left the org / signed out / guest link import) ⇒ no
    // comments surface.
    return memberOrgIds.has(importedFrom.orgId)
      ? {
          orgId: importedFrom.orgId,
          sessionId: importedFrom.sourceSessionId,
        }
      : null;
  }

  const forkedFrom = session.forkedFrom;
  if (forkedFrom && memberOrgIds.has(forkedFrom.orgId)) {
    // Writable fork: unresolved comments belong to the SOURCE session on the
    // parent org, while the local fork is the execution target.
    return {
      orgId: forkedFrom.orgId,
      sessionId: forkedFrom.sourceSessionId,
    };
  }

  const ownedCloudOrgId = session.orgId
    ? parseCloudOrgSelectorValue(session.orgId)
    : null;
  // Repo-scope auto-match is a THIRD admission route (the push pass accepts
  // `isScopeMatchableImportedSession` alongside ownership and tags). Without
  // it here, an imported history shared purely by repo scope has no comment
  // surface for its owner: teammates can comment and the cloud row carries
  // the threads, but the owner sees no affordance — so no reply, and no
  // owner-only @agent round either.
  const scopeMatchedOrgIds = scopeMatchedOrgIdsForSession(
    session,
    orgRepoScopes
  );
  // Push markers are a FOURTH admission route, not just a priority filter:
  // a live server row this device pushed is the strongest evidence a comment
  // surface exists. External-history sessions shared purely by repo scope
  // reach the provider as a session_id-only stub (no repoPath/remotes), so
  // without this route they produce zero candidates and lose their surface.
  const allCandidateOrgIds = [
    ...(ownedCloudOrgId ? [ownedCloudOrgId] : []),
    ...cloudOrgIdsForSession(tags, session.session_id),
    ...scopeMatchedOrgIds,
    ...pushedOrgIds,
  ].filter(
    (orgId, index, all) =>
      memberOrgIds.has(orgId) && all.indexOf(orgId) === index
  );
  // A candidate with a live server row beats one that merely COULD admit
  // the session; without any pushed candidate (fresh share, push pending)
  // keep the full set so the composer stays available.
  const pushedCandidateOrgIds = allCandidateOrgIds.filter((orgId) =>
    pushedOrgIds.includes(orgId)
  );
  const candidateOrgIds =
    pushedCandidateOrgIds.length > 0
      ? pushedCandidateOrgIds
      : allCandidateOrgIds;
  if (candidateOrgIds.length === 0) return null;
  const orgId =
    preferredOrgId && candidateOrgIds.includes(preferredOrgId)
      ? preferredOrgId
      : candidateOrgIds[0];
  return { orgId, sessionId: session.session_id };
}

/**
 * Reactive resolution for the mounted surfaces. Returns null for every
 * non-cloud session — consumers render nothing in that case.
 */
export function useSessionCommentTarget(
  session: Session | null | undefined
): SessionCommentTarget | null {
  const cloudOrgs = useAtomValue(org2CloudOrgsAtom);
  const tags = useAtomValue(sessionOrgTagsAtom);
  const selectedCloudOrg = useAtomValue(chatPanelSelectedCloudOrgAtom);
  const orgRepoScopes = useAtomValue(org2CloudRepoScopesAtom);
  const pushCursors = useAtomValue(org2CloudPushCursorsAtom);
  const pushedMetadata = useAtomValue(org2CloudPushedMetadataAtom);

  const pushedOrgIds = useMemo(() => {
    if (!session) return [];
    const suffix = `:${session.session_id}`;
    return [
      ...Object.keys(pushCursors),
      ...Object.keys(pushedMetadata),
    ].flatMap((key) =>
      key.endsWith(suffix) ? [key.slice(0, -suffix.length)] : []
    );
  }, [session, pushCursors, pushedMetadata]);

  const remoteEntries = useAtomValue(org2CloudRemoteSessionsAtom);

  return useMemo(() => {
    const lineage = session ? getSessionForkedFrom(session) : undefined;
    const target = resolveSessionCommentTarget({
      session: session ? { ...session, forkedFrom: lineage } : null,
      cloudOrgs,
      tags,
      preferredOrgId: selectedCloudOrg?.orgId ?? null,
      orgRepoScopes,
      pushedOrgIds,
    });
    const rows = target ? remoteEntries[target.orgId]?.rows : undefined;
    const rerooted = rerootSessionCommentTarget(target, rows);
    return rerooted;
  }, [
    session,
    cloudOrgs,
    tags,
    selectedCloudOrg,
    orgRepoScopes,
    pushedOrgIds,
    remoteEntries,
  ]);
}

/**
 * One conversation, one discussion plane: comments on any fork-family member
 * belong to the family ROOT session, so every viewpoint — root owner, fork
 * owner, teammate replay of either — reads and writes the same thread.
 * Without this, a writable fork posts to its parent while a replay of that
 * fork reads the fork's own plane, and the discussion silently splits.
 *
 * When the root ROW is gone from the listing (replay retention expires the
 * oldest segment first — live-observed 2026-08-21), targeting it anyway
 * means every comment call fails ORG2_RETENTION_EXPIRED and the whole
 * conversation goes mute while its forks are still alive. Fall back to the
 * oldest live family member: forkedAt order (id tiebreak) is identical on
 * every client reading the same listing, so all viewpoints converge on the
 * same surviving plane.
 */
export function rerootSessionCommentTarget(
  target: SessionCommentTarget | null,
  rows: readonly RemoteTeammateSessionMetadata[] | undefined
): SessionCommentTarget | null {
  if (!target || !rows?.length) return target;
  const selfRow = rows.find(
    (candidate) => candidate.sourceSessionId === target.sessionId
  );
  const rootSessionId = selfRow?.forkedFrom?.rootSessionId ?? target.sessionId;
  const rootRow = rows.find(
    (candidate) => candidate.sourceSessionId === rootSessionId
  );
  if (rootRow) {
    return rootSessionId === target.sessionId
      ? target
      : { orgId: target.orgId, sessionId: rootSessionId };
  }
  const liveMembers = rows
    .filter(
      (candidate) => candidate.forkedFrom?.rootSessionId === rootSessionId
    )
    .sort(
      (left, right) =>
        (left.forkedFrom?.forkedAt ?? "").localeCompare(
          right.forkedFrom?.forkedAt ?? ""
        ) || left.sourceSessionId.localeCompare(right.sourceSessionId)
    );
  const anchor = liveMembers[0];
  return anchor
    ? { orgId: target.orgId, sessionId: anchor.sourceSessionId }
    : target;
}
