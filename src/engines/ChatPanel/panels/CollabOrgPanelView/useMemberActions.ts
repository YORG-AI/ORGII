import { useAtom, useSetAtom } from "jotai";
import { useCallback, useMemo, useState } from "react";

import { supabaseSyncClient } from "@src/features/TeamCollaboration/sync/supabaseSyncClient";
import {
  collabInvitesAtom,
  collabMembersAtom,
} from "@src/store/collaboration/collabOrgsAtom";
import { COLLAB_ROLE } from "@src/store/collaboration/types";
import type {
  CollabMemberRecord,
  CollabOrgRecord,
} from "@src/store/collaboration/types";
import type { ChatPanelSelectedCollabOrg } from "@src/store/ui/chatPanelAtom";
import { chatPanelSelectedCollabOrgAtom } from "@src/store/ui/chatPanelAtom";
import { copyText } from "@src/util/data/clipboard";

import { DEFAULT_INVITE_USAGE_LIMIT } from "./constants";
import { upsertInvite, upsertMember } from "./utils";

interface UseMemberActionsParams {
  org: CollabOrgRecord | undefined;
  currentMember: CollabMemberRecord | undefined;
  selectedCollabOrg: ChatPanelSelectedCollabOrg;
}

export function useMemberActions({
  org,
  currentMember,
  selectedCollabOrg,
}: UseMemberActionsParams) {
  const [invites, setInvites] = useAtom(collabInvitesAtom);
  const setMembers = useSetAtom(collabMembersAtom);
  const setSelectedCollabOrg = useSetAtom(chatPanelSelectedCollabOrgAtom);
  const [creatingInvite, setCreatingInvite] = useState(false);
  const [copyingInvite, setCopyingInvite] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [removingMemberId, setRemovingMemberId] = useState<string | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);

  const latestInvite = useMemo(
    () =>
      invites
        .filter(
          (invite) =>
            invite.orgId === selectedCollabOrg.orgId && !invite.revokedAt
        )
        .sort((left, right) =>
          right.createdAt.localeCompare(left.createdAt)
        )[0],
    [invites, selectedCollabOrg.orgId]
  );

  const canCreateInvite =
    Boolean(org?.supabaseUrl && org.supabaseAnonKey && org.orgSecret) &&
    currentMember?.role === COLLAB_ROLE.ADMIN;

  const handleCreateInvite = useCallback(async () => {
    if (
      !org?.supabaseUrl ||
      !org.supabaseAnonKey ||
      !org.orgSecret ||
      creatingInvite
    ) {
      return;
    }
    setCreatingInvite(true);
    setInviteError(null);
    try {
      const invite = await supabaseSyncClient.createInvite({
        supabaseUrl: org.supabaseUrl,
        anonKey: org.supabaseAnonKey,
        orgSecret: org.orgSecret,
        orgId: org.id,
        usageLimit: DEFAULT_INVITE_USAGE_LIMIT,
      });
      setInvites((current) => upsertInvite(current, invite));
      await copyText(invite.inviteLink);
      setCopyingInvite(true);
      window.setTimeout(() => setCopyingInvite(false), 1500);
    } catch (error) {
      setInviteError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreatingInvite(false);
    }
  }, [creatingInvite, org, setInvites]);

  const handleCopyInvite = useCallback(async () => {
    if (!latestInvite?.inviteLink || copyingInvite) return;
    setInviteError(null);
    try {
      await copyText(latestInvite.inviteLink);
      setCopyingInvite(true);
      window.setTimeout(() => setCopyingInvite(false), 1500);
    } catch (error) {
      setInviteError(error instanceof Error ? error.message : String(error));
    }
  }, [copyingInvite, latestInvite?.inviteLink]);

  const handleRemoveMember = useCallback(
    async (member: CollabMemberRecord) => {
      if (
        !org?.supabaseUrl ||
        !org.supabaseAnonKey ||
        !org.orgSecret ||
        removingMemberId
      ) {
        return;
      }
      setRemovingMemberId(member.id);
      setMemberError(null);
      try {
        const removedMember = await supabaseSyncClient.removeMember({
          supabaseUrl: org.supabaseUrl,
          anonKey: org.supabaseAnonKey,
          orgSecret: org.orgSecret,
          orgId: org.id,
          memberId: member.id,
        });
        setMembers((current) => upsertMember(current, removedMember));
        if (selectedCollabOrg.memberId === member.id) {
          setSelectedCollabOrg({ orgId: selectedCollabOrg.orgId });
        }
      } catch (error) {
        setMemberError(error instanceof Error ? error.message : String(error));
      } finally {
        setRemovingMemberId(null);
      }
    },
    [
      org,
      removingMemberId,
      selectedCollabOrg.memberId,
      selectedCollabOrg.orgId,
      setMembers,
      setSelectedCollabOrg,
    ]
  );

  return {
    latestInvite,
    canCreateInvite,
    creatingInvite,
    copyingInvite,
    inviteError,
    removingMemberId,
    memberError,
    handleCreateInvite,
    handleCopyInvite,
    handleRemoveMember,
  };
}
