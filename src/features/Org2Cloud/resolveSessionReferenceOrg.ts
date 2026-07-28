/**
 * Which cloud org should a LOCAL session's reference name?
 *
 * A reference carries `(org, owner, session)` and is only resolvable by
 * members of that org, so producing one for an org the session was never
 * published to yields a link that fails for everyone — and the mistake is
 * invisible at the moment of pasting. This resolver therefore never
 * guesses: it answers with the org, asks the user to choose, or declines.
 *
 * Preference order: the org the user is currently scoped to (the common
 * case — you copy while looking at the team you are copying for), then a
 * sole publication target. Anything else is genuinely ambiguous and is
 * handed back for an explicit choice.
 *
 * Publication is read from the two local push markers, both keyed
 * `${orgId}:${sessionId}`. `orgId` is a uuid and carries no colon, so the
 * first colon splits the key exactly (same parse as the retract reconcile).
 */

export const SESSION_REFERENCE_ORG = {
  RESOLVED: "resolved",
  CHOOSE: "choose",
  UNPUBLISHED: "unpublished",
} as const;

export type SessionReferenceOrgResolution =
  | { kind: typeof SESSION_REFERENCE_ORG.RESOLVED; orgId: string }
  | { kind: typeof SESSION_REFERENCE_ORG.CHOOSE; orgIds: string[] }
  | { kind: typeof SESSION_REFERENCE_ORG.UNPUBLISHED };

/** Cloud orgs this local session has a live push marker for. */
export function publishedOrgIdsForSession(
  sessionId: string,
  cursors: Record<string, unknown>,
  pushedMetadata: Record<string, unknown>
): string[] {
  const suffix = `:${sessionId}`;
  const orgIds = new Set<string>();
  for (const key of [...Object.keys(cursors), ...Object.keys(pushedMetadata)]) {
    if (!key.endsWith(suffix)) continue;
    const separator = key.indexOf(":");
    if (separator > 0) orgIds.add(key.slice(0, separator));
  }
  return [...orgIds].sort();
}

export function resolveSessionReferenceOrg(input: {
  publishedOrgIds: readonly string[];
  activeCloudOrgId: string | null;
}): SessionReferenceOrgResolution {
  const { publishedOrgIds, activeCloudOrgId } = input;
  if (publishedOrgIds.length === 0) {
    return { kind: SESSION_REFERENCE_ORG.UNPUBLISHED };
  }
  if (activeCloudOrgId && publishedOrgIds.includes(activeCloudOrgId)) {
    return { kind: SESSION_REFERENCE_ORG.RESOLVED, orgId: activeCloudOrgId };
  }
  if (publishedOrgIds.length === 1) {
    return { kind: SESSION_REFERENCE_ORG.RESOLVED, orgId: publishedOrgIds[0] };
  }
  return { kind: SESSION_REFERENCE_ORG.CHOOSE, orgIds: [...publishedOrgIds] };
}
