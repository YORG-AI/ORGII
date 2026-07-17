import { atom } from "jotai";

import type { CloudInviteDeepLink } from "./org2CloudOrgManagement";

/**
 * An ORG2 Cloud invite captured from an `orgii://cloud/join` deep link,
 * waiting to be consumed by `JoinCloudOrgDialog` (confirm → `accept_invite`
 * → refresh `org2CloudOrgsAtom`).
 *
 * In-memory only — a one-shot hand-off from `useDeepLinkHandler` to the
 * dialog. The atom IS the dialog
 * visibility: it stays set while the confirmation is open (including a
 * sign-in detour through Settings) and is cleared exactly once on dismiss
 * or successful join.
 */
export type Org2CloudPendingInvite = CloudInviteDeepLink;

export const org2CloudPendingInviteAtom = atom<Org2CloudPendingInvite | null>(
  null
);
org2CloudPendingInviteAtom.debugLabel = "org2CloudPendingInviteAtom";
