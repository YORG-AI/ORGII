/**
 * All ORG2 Cloud org-management state + handlers for `CloudOrgPanelView`
 * (managed-backend mirror of the self-hosted `useMemberActions`): invite
 * create/list/revoke with the one-time plaintext window, member role
 * changes, removal, leave, rename, ownership transfer, org deletion.
 *
 * Server truth lives behind the throwing wrappers in
 * `org2CloudManagementClient`; recognized §22 codes surface as specific
 * translated messages via `cloudManagementErrorMessage`. Obvious
 * ORG2_LAST_ADMIN cases are pre-checked client-side (`wouldRemoveLastAdmin`)
 * so they fail fast without a round-trip — the server guard stays the
 * authority for races.
 */
import { useAtom, useSetAtom } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import Message from "@src/components/Message";
import {
  commitRefreshedAuth,
  org2CloudAuthAtom,
} from "@src/features/Org2Cloud/org2CloudAuthAtom";
import {
  type CloudOrgMember,
  ensureFreshSession,
} from "@src/features/Org2Cloud/org2CloudClient";
import {
  type CreatedCloudInvite,
  createCloudInvite,
  deleteCloudOrg,
  leaveCloudOrg,
  listCloudInvites,
  removeCloudMember,
  renameCloudOrg,
  revokeCloudInvite,
  transferCloudOwnership,
  updateCloudMemberRole,
} from "@src/features/Org2Cloud/org2CloudManagementClient";
import {
  type CloudAssignableRole,
  type CloudInviteRecord,
  cloudManagementErrorMessage,
  wouldRemoveLastAdmin,
} from "@src/features/Org2Cloud/org2CloudOrgManagement";
import { useRefetchOrg2CloudOrgs } from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import { setMemberSharingFloor } from "@src/features/Org2Cloud/org2CloudSyncClient";
import { createLogger } from "@src/hooks/logger";
import { closeCloudOrgManagementChatPanelTabAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import { getInviteExpiresAt } from "@src/store/collaboration/inviteDefaults";
import {
  COLLAB_SESSION_ACCESS_MODE,
  type CollabSessionAccessMode,
} from "@src/store/collaboration/types";
import { copyText } from "@src/util/data/clipboard";

const log = createLogger("CloudOrgManagement");

export interface CreateCloudInviteOptions {
  usageLimit: number;
  /** null = the invite never expires. */
  expiresInDays: number | null;
  role: CloudAssignableRole;
}

interface UseCloudOrgManagementParams {
  orgId: string;
  orgName: string;
  isAdmin: boolean;
  isOwner: boolean;
  members: CloudOrgMember[];
  setMembers: React.Dispatch<React.SetStateAction<CloudOrgMember[]>>;
}

export function useCloudOrgManagement({
  orgId,
  orgName,
  isAdmin,
  isOwner,
  members,
  setMembers,
}: UseCloudOrgManagementParams) {
  const { t } = useTranslation("navigation");
  const [auth, setAuth] = useAtom(org2CloudAuthAtom);
  const closeCloudOrgManagementTab = useSetAtom(
    closeCloudOrgManagementChatPanelTabAtom
  );
  const refetchOrgs = useRefetchOrg2CloudOrgs();

  // Invites (admin-only surface)
  const [invites, setInvites] = useState<CloudInviteRecord[]>([]);
  const [inviteListError, setInviteListError] = useState<string | null>(null);
  const [creatingInvite, setCreatingInvite] = useState(false);
  const [copyingInvite, setCopyingInvite] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [revokingInviteId, setRevokingInviteId] = useState<string | null>(null);
  // Plaintext of the invite minted in THIS panel session — the one
  // guaranteed copy window; the server never echoes plaintext back.
  const [latestCreatedInvite, setLatestCreatedInvite] =
    useState<CreatedCloudInvite | null>(null);

  // Members
  const [memberError, setMemberError] = useState<string | null>(null);
  const [removingUserId, setRemovingUserId] = useState<string | null>(null);
  const [updatingRoleUserId, setUpdatingRoleUserId] = useState<string | null>(
    null
  );
  const [updatingFloorUserId, setUpdatingFloorUserId] = useState<string | null>(
    null
  );
  const [leavingOrg, setLeavingOrg] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);

  // Org settings
  const [renaming, setRenaming] = useState(false);
  const [renameSaved, setRenameSaved] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [transferring, setTransferring] = useState(false);
  const [transferError, setTransferError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Latest auth via ref (panel idiom): token-refresh writes must not
  // retrigger effects or invalidate callbacks.
  const authRef = useRef(auth);
  useEffect(() => {
    authRef.current = auth;
  }, [auth]);

  const getFreshToken = useCallback(async (): Promise<string> => {
    const current = authRef.current;
    if (!current) throw new Error(t("cloud.orgPanel.loadError"));
    const fresh = await ensureFreshSession(current);
    if (!fresh) throw new Error(t("cloud.orgPanel.loadError"));
    commitRefreshedAuth(setAuth, current, fresh);
    return fresh.accessToken;
  }, [setAuth, t]);

  // Invite inventory: admin-only; reset + refetch when the panel switches
  // orgs (cloud_list_invites raises ORG2_ADMIN_REQUIRED for non-admins, so
  // members never even call it).
  useEffect(() => {
    setInvites([]);
    setInviteListError(null);
    setInviteError(null);
    setLatestCreatedInvite(null);
    setMemberError(null);
    setLeaveError(null);
    setRenameError(null);
    setRenameSaved(false);
    setTransferError(null);
    setDeleteError(null);
    if (!isAdmin) return;
    let cancelled = false;
    void (async () => {
      try {
        const token = await getFreshToken();
        const list = await listCloudInvites(token, orgId);
        if (!cancelled) setInvites(list);
      } catch (error) {
        log.warn("cloud_list_invites failed:", error);
        if (!cancelled) {
          setInviteListError(t("cloud.orgManagement.invites.loadError"));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, isAdmin, getFreshToken, t]);

  const flashCopied = useCallback(() => {
    setCopyingInvite(true);
    window.setTimeout(() => setCopyingInvite(false), 1500);
  }, []);

  const handleCreateInvite = useCallback(
    async (options: CreateCloudInviteOptions) => {
      if (creatingInvite) return;
      setCreatingInvite(true);
      setInviteError(null);
      try {
        const token = await getFreshToken();
        const created = await createCloudInvite(token, {
          orgId,
          role: options.role,
          maxUses: options.usageLimit,
          expiresAt:
            options.expiresInDays === null
              ? undefined
              : getInviteExpiresAt(options.expiresInDays),
        });
        setLatestCreatedInvite(created);
        // Local prepend mirrors the server row (created_at desc ordering)
        // without an extra list round-trip.
        setInvites((current) => [
          {
            inviteId: created.inviteId,
            role: options.role,
            maxUses: options.usageLimit,
            usedCount: 0,
            expiresAt:
              options.expiresInDays === null
                ? undefined
                : getInviteExpiresAt(options.expiresInDays),
            createdAt: new Date().toISOString(),
            revokedAt: undefined,
          },
          ...current,
        ]);
        await copyText(created.inviteLink);
        flashCopied();
      } catch (error) {
        setInviteError(cloudManagementErrorMessage(error, t));
      } finally {
        setCreatingInvite(false);
      }
    },
    [creatingInvite, flashCopied, getFreshToken, orgId, t]
  );

  const handleCopyInvite = useCallback(async () => {
    if (!latestCreatedInvite || copyingInvite) return;
    setInviteError(null);
    try {
      await copyText(latestCreatedInvite.inviteLink);
      flashCopied();
    } catch (error) {
      setInviteError(error instanceof Error ? error.message : String(error));
    }
  }, [copyingInvite, flashCopied, latestCreatedInvite]);

  const handleRevokeInvite = useCallback(
    async (invite: CloudInviteRecord) => {
      if (revokingInviteId) return;
      setRevokingInviteId(invite.inviteId);
      setInviteError(null);
      try {
        const token = await getFreshToken();
        await revokeCloudInvite(token, orgId, invite.inviteId);
        const revokedAt = new Date().toISOString();
        setInvites((current) =>
          current.map((item) =>
            item.inviteId === invite.inviteId ? { ...item, revokedAt } : item
          )
        );
        // A revoked link is dead — drop the one-time copy window for it.
        setLatestCreatedInvite((current) =>
          current?.inviteId === invite.inviteId ? null : current
        );
      } catch (error) {
        setInviteError(cloudManagementErrorMessage(error, t));
      } finally {
        setRevokingInviteId(null);
      }
    },
    [getFreshToken, orgId, revokingInviteId, t]
  );

  const handleUpdateMemberRole = useCallback(
    async (member: CloudOrgMember, role: CloudAssignableRole) => {
      if (updatingRoleUserId || member.role === role) return;
      setMemberError(null);
      // Client-side last-admin pre-check (server ORG2_LAST_ADMIN mirror).
      if (role !== "admin" && wouldRemoveLastAdmin(members, member.userId)) {
        setMemberError(t("cloud.orgManagement.errors.lastAdmin"));
        return;
      }
      setUpdatingRoleUserId(member.userId);
      try {
        const token = await getFreshToken();
        await updateCloudMemberRole(token, orgId, member.userId, role);
        setMembers((current) =>
          current.map((item) =>
            item.userId === member.userId ? { ...item, role } : item
          )
        );
      } catch (error) {
        setMemberError(cloudManagementErrorMessage(error, t));
      } finally {
        setUpdatingRoleUserId(null);
      }
    },
    [getFreshToken, members, orgId, setMembers, t, updatingRoleUserId]
  );

  // Per-member sharing floor (admin-set minimum). Same optimistic-mirror
  // idiom as the role change; the target member's own device picks the new
  // effective floor up via get_entitlement_state on its next panel read /
  // sync pass (and the membership UPDATE fires the org-wide realtime roster
  // subscription for open panels).
  const handleUpdateMemberFloor = useCallback(
    async (member: CloudOrgMember, floor: CollabSessionAccessMode) => {
      if (updatingFloorUserId) return;
      if ((member.sharingFloor ?? COLLAB_SESSION_ACCESS_MODE.OFF) === floor) {
        return;
      }
      setMemberError(null);
      setUpdatingFloorUserId(member.userId);
      try {
        const token = await getFreshToken();
        await setMemberSharingFloor(token, orgId, member.userId, floor);
        setMembers((current) =>
          current.map((item) =>
            item.userId === member.userId
              ? {
                  ...item,
                  sharingFloor:
                    floor === COLLAB_SESSION_ACCESS_MODE.OFF
                      ? undefined
                      : floor,
                }
              : item
          )
        );
      } catch (error) {
        setMemberError(cloudManagementErrorMessage(error, t));
      } finally {
        setUpdatingFloorUserId(null);
      }
    },
    [getFreshToken, orgId, setMembers, t, updatingFloorUserId]
  );

  const handleRemoveMember = useCallback(
    async (member: CloudOrgMember) => {
      if (removingUserId) return;
      setMemberError(null);
      if (wouldRemoveLastAdmin(members, member.userId)) {
        setMemberError(t("cloud.orgManagement.errors.lastAdmin"));
        return;
      }
      setRemovingUserId(member.userId);
      try {
        const token = await getFreshToken();
        await removeCloudMember(token, orgId, member.userId);
        setMembers((current) =>
          current.map((item) =>
            item.userId === member.userId
              ? { ...item, status: "removed" }
              : item
          )
        );
      } catch (error) {
        setMemberError(cloudManagementErrorMessage(error, t));
      } finally {
        setRemovingUserId(null);
      }
    },
    [getFreshToken, members, orgId, removingUserId, setMembers, t]
  );

  const handleLeaveOrg = useCallback(async () => {
    if (leavingOrg) return;
    setLeavingOrg(true);
    setLeaveError(null);
    try {
      const token = await getFreshToken();
      await leaveCloudOrg(token, orgId);
      Message.success(
        t("cloud.orgManagement.leave.leftToast", { org: orgName })
      );
      await refetchOrgs({
        until: (orgs) => !orgs.some((org) => org.orgId === orgId),
      });
      // The org is gone from list_my_orgs — close its dedicated tab.
      closeCloudOrgManagementTab();
    } catch (error) {
      setLeaveError(cloudManagementErrorMessage(error, t));
    } finally {
      setLeavingOrg(false);
    }
  }, [
    getFreshToken,
    leavingOrg,
    orgId,
    orgName,
    refetchOrgs,
    closeCloudOrgManagementTab,
    t,
  ]);

  const handleRenameOrg = useCallback(
    async (name: string) => {
      if (renaming) return;
      setRenaming(true);
      setRenameError(null);
      setRenameSaved(false);
      try {
        const token = await getFreshToken();
        await renameCloudOrg(token, orgId, name);
        // Selector + panel header read from org2CloudOrgsAtom.
        await refetchOrgs({
          until: (orgs) =>
            orgs.some((org) => org.orgId === orgId && org.name === name),
        });
        setRenameSaved(true);
      } catch (error) {
        setRenameError(cloudManagementErrorMessage(error, t));
      } finally {
        setRenaming(false);
      }
    },
    [getFreshToken, orgId, refetchOrgs, renaming, t]
  );

  const handleTransferOwnership = useCallback(
    async (newOwnerUserId: string) => {
      if (transferring) return;
      setTransferring(true);
      setTransferError(null);
      try {
        const token = await getFreshToken();
        await transferCloudOwnership(token, orgId, newOwnerUserId);
        // Server swap: new user → owner, old owner → admin.
        setMembers((current) =>
          current.map((item) =>
            item.userId === newOwnerUserId
              ? { ...item, role: "owner" }
              : item.role === "owner"
                ? { ...item, role: "admin" }
                : item
          )
        );
        // Own role changed owner → admin; the owner-only controls key off
        // the refetched org record.
        await refetchOrgs({
          until: (orgs) =>
            orgs.some((org) => org.orgId === orgId && org.role === "admin"),
        });
        Message.success(t("cloud.orgManagement.settings.transferredToast"));
      } catch (error) {
        setTransferError(cloudManagementErrorMessage(error, t));
      } finally {
        setTransferring(false);
      }
    },
    [getFreshToken, orgId, refetchOrgs, setMembers, t, transferring]
  );

  const handleDeleteOrg = useCallback(async () => {
    if (deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const token = await getFreshToken();
      await deleteCloudOrg(token, orgId);
      Message.success(t("cloud.orgManagement.settings.deletedToast"));
      await refetchOrgs({
        until: (orgs) => !orgs.some((org) => org.orgId === orgId),
      });
      closeCloudOrgManagementTab();
    } catch (error) {
      setDeleteError(cloudManagementErrorMessage(error, t));
    } finally {
      setDeleting(false);
    }
  }, [
    closeCloudOrgManagementTab,
    deleting,
    getFreshToken,
    orgId,
    refetchOrgs,
    t,
  ]);

  return {
    // invites
    invites,
    inviteListError,
    creatingInvite,
    copyingInvite,
    inviteError,
    revokingInviteId,
    latestCreatedInvite,
    handleCreateInvite,
    handleCopyInvite,
    handleRevokeInvite,
    // members
    memberError,
    removingUserId,
    updatingRoleUserId,
    updatingFloorUserId,
    leavingOrg,
    leaveError,
    handleUpdateMemberRole,
    handleUpdateMemberFloor,
    handleRemoveMember,
    handleLeaveOrg,
    // org settings
    renaming,
    renameSaved,
    renameError,
    handleRenameOrg,
    transferring,
    transferError,
    handleTransferOwnership,
    deleting,
    deleteError,
    handleDeleteOrg,
    // gates (echoed for the section components)
    isAdmin,
    isOwner,
  };
}

export type CloudOrgManagement = ReturnType<typeof useCloudOrgManagement>;
