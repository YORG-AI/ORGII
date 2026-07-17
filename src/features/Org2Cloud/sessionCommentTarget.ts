/**
 * Comment-target resolution for the session-comments surfaces (design
 * session-comments-design-0707 §4).
 *
 * Comments key on the CLOUD coordinates `(orgId, sessionId)`:
 * - an IMPORTED teammate session carries them on `Session.importedFrom`
 *   (`{orgId, sourceSessionId}`) — that pair is the target, valid only
 *   while the org is still in the signed-in user's cloud org list (the
 *   `useForkImportedSession` discrimination — post Phase E cloud orgs live
 *   in `org2CloudOrgsAtom` alone);
 * - the owner's OWN local session is a target when it is tagged into a
 *   cloud org (`cloudOrgIdsForSession`); the cloud session id equals the
 *   bare local session id (the push path keys rows on it).
 *
 * Multi-org-tagged sessions (design §8 default): the target org is the
 * cloud org the chat panel's cloud scope is currently on, falling back to
 * the FIRST tagged org — comments do NOT mirror across orgs.
 *
 * Everything else (plain local sessions, external history, guest imports
 * whose org the viewer left) resolves to null — the comments UI renders
 * nothing (cloud-org sessions only in v1).
 */
import { useAtomValue } from "jotai";
import { useMemo } from "react";

import {
  type SessionOrgTags,
  cloudOrgIdsForSession,
  sessionOrgTagsAtom,
} from "@src/features/TeamCollaboration/sessionOrgTagsAtom";
import type { Session } from "@src/store/session/sessionAtom/types";
import { chatPanelSelectedCloudOrgAtom } from "@src/store/ui/chatPanelAtom";

import type { Org2CloudOrg } from "./org2CloudOrgsAtom";
import { org2CloudOrgsAtom } from "./org2CloudOrgsAtom";

export interface SessionCommentTarget {
  orgId: string;
  /** Cloud session id (the OWNER-side bare session id). */
  sessionId: string;
}

type CommentTargetSession = Pick<Session, "session_id" | "importedFrom">;

/** Pure resolution (unit-tested; no IO). */
export function resolveSessionCommentTarget(params: {
  session: CommentTargetSession | null | undefined;
  cloudOrgs: readonly Org2CloudOrg[];
  tags: SessionOrgTags;
  /** Cloud org id the surrounding UI scope prefers (nullable). */
  preferredOrgId: string | null;
}): SessionCommentTarget | null {
  const { session, cloudOrgs, tags, preferredOrgId } = params;
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

  const taggedOrgIds = cloudOrgIdsForSession(tags, session.session_id).filter(
    (orgId) => memberOrgIds.has(orgId)
  );
  if (taggedOrgIds.length === 0) return null;
  const orgId =
    preferredOrgId && taggedOrgIds.includes(preferredOrgId)
      ? preferredOrgId
      : taggedOrgIds[0];
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

  return useMemo(
    () =>
      resolveSessionCommentTarget({
        session,
        cloudOrgs,
        tags,
        preferredOrgId: selectedCloudOrg?.orgId ?? null,
      }),
    [session, cloudOrgs, tags, selectedCloudOrg]
  );
}
