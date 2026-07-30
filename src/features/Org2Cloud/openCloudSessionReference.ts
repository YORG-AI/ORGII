/**
 * Shared decision + navigation for opening an ORG2 Cloud session reference,
 * used by both the in-app chip and the OS deep-link handler.
 *
 * The reference carries no capability (see `cloudSessionReference`), so a
 * viewer outside the owning org must be turned away. That refusal is a
 * courtesy, not the boundary: every read RPC re-asserts membership server
 * side, and a non-member who bypassed this gate would still see nothing.
 * The gate exists so the app says "not your org" instead of silently
 * revealing an empty section.
 *
 * Membership is judged against the roster the engine already loaded. An
 * EMPTY roster is treated as "unknown, let the server decide" — orgs are
 * absent for a beat at boot, and refusing then would reject a legitimate
 * reference clicked during that window.
 */
import type { Org2CloudOrg } from "./org2CloudOrgsAtom";

export const CLOUD_REFERENCE_REFUSAL = {
  SIGNED_OUT: "signed-out",
  NOT_MEMBER: "not-member",
} as const;

export type CloudReferenceRefusal =
  (typeof CLOUD_REFERENCE_REFUSAL)[keyof typeof CLOUD_REFERENCE_REFUSAL];

export type CloudReferenceAdmission =
  | { admitted: true }
  | { admitted: false; refusal: CloudReferenceRefusal };

export function decideCloudReferenceAdmission(input: {
  orgId: string;
  signedIn: boolean;
  orgs: readonly Pick<Org2CloudOrg, "orgId">[];
}): CloudReferenceAdmission {
  if (!input.signedIn) {
    return { admitted: false, refusal: CLOUD_REFERENCE_REFUSAL.SIGNED_OUT };
  }
  if (input.orgs.length === 0) return { admitted: true };
  const member = input.orgs.some((org) => org.orgId === input.orgId);
  return member
    ? { admitted: true }
    : { admitted: false, refusal: CLOUD_REFERENCE_REFUSAL.NOT_MEMBER };
}

/** Sidebar row identity for a reference's `(org, owner, session)` tuple. */
export function cloudReferenceRowId(reference: {
  orgId: string;
  ownerUserId: string;
  sourceSessionId: string;
}): string {
  return `${reference.orgId}:${reference.ownerUserId}:${reference.sourceSessionId}`;
}
