/**
 * Invite lifecycle defaults (design §8.1) — the SINGLE definition; the old
 * `DEFAULT_INVITE_USAGE_LIMIT` was duplicated in CreateCollabOrgView and
 * CollabOrgPanelView/constants (fix S8-style dedupe).
 *
 * Two explicit tiers:
 * - BOOTSTRAP (auto-created on org creation): multi-use — the canonical flow
 *   is pasting it into a team channel, and a single-use ticket would lock
 *   out member #2.
 * - PANEL (manually created in the members tab): single-use by default; the
 *   creator can explicitly raise the limit in the create form.
 *
 * Both tiers default to a 7-day expiry.
 */
import { COLLAB_ROLE } from "./types";
import type { CollabRole } from "./types";

export const BOOTSTRAP_INVITE_USAGE_LIMIT = 10;
export const PANEL_INVITE_USAGE_LIMIT = 1;
export const DEFAULT_INVITE_EXPIRY_DAYS = 7;

export const INVITE_KIND = {
  BOOTSTRAP: "bootstrap",
  PANEL: "panel",
} as const;

export type InviteKind = (typeof INVITE_KIND)[keyof typeof INVITE_KIND];

export interface InviteDefaults {
  usageLimit: number;
  expiresAt: string;
  role: CollabRole;
}

export function getInviteExpiresAt(
  days: number,
  now: Date = new Date()
): string {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

export function createInviteDefaults(
  kind: InviteKind,
  now: Date = new Date()
): InviteDefaults {
  return {
    usageLimit:
      kind === INVITE_KIND.BOOTSTRAP
        ? BOOTSTRAP_INVITE_USAGE_LIMIT
        : PANEL_INVITE_USAGE_LIMIT,
    expiresAt: getInviteExpiresAt(DEFAULT_INVITE_EXPIRY_DAYS, now),
    role: COLLAB_ROLE.MEMBER,
  };
}
