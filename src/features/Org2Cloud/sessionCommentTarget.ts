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
import type { Session } from "@src/store/session/sessionAtom/types";
import { chatPanelSelectedCloudOrgAtom } from "@src/store/ui/chatPanelAtom";

import type { Org2CloudOrg } from "./org2CloudOrgsAtom";
import {
  org2CloudOrgsAtom,
  parseCloudOrgSelectorValue,
} from "./org2CloudOrgsAtom";
import { org2CloudRepoScopesAtom } from "./org2CloudSyncAtoms";

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
}): SessionCommentTarget | null {
  const {
    session,
    cloudOrgs,
    tags,
    preferredOrgId,
    orgRepoScopes = {},
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
  const candidateOrgIds = [
    ...(ownedCloudOrgId ? [ownedCloudOrgId] : []),
    ...cloudOrgIdsForSession(tags, session.session_id),
    ...scopeMatchedOrgIds,
  ].filter(
    (orgId, index, all) =>
      memberOrgIds.has(orgId) && all.indexOf(orgId) === index
  );
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

  return useMemo(
    () =>
      resolveSessionCommentTarget({
        session: session
          ? { ...session, forkedFrom: getSessionForkedFrom(session) }
          : null,
        cloudOrgs,
        tags,
        preferredOrgId: selectedCloudOrg?.orgId ?? null,
        orgRepoScopes,
      }),
    [session, cloudOrgs, tags, selectedCloudOrg, orgRepoScopes]
  );
}
