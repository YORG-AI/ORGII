import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  collabMembersAtom,
  collabOrgsAtom,
  collabProjectsAtom,
  collabSessionSnapshotRequestsAtom,
  collabWorkItemsAtom,
  remoteTeammateSessionsAtom,
} from "@src/store/collaboration/collabOrgsAtom";
import { COLLAB_ROLE } from "@src/store/collaboration/types";
import type { CollabMemberRecord } from "@src/store/collaboration/types";
import { sessionsAtom } from "@src/store/session";
import type { ChatPanelSelectedCollabOrg } from "@src/store/ui/chatPanelAtom";
import { chatPanelSelectedCollabOrgAtom } from "@src/store/ui/chatPanelAtom";

import { COLLAB_ORG_TAB } from "./constants";
import type { CollabOrgTab } from "./constants";
import { useAccessSettingsModel } from "./useAccessSettingsModel";
import { useCollabOrgChat } from "./useCollabOrgChat";
import { useLocalOrgMetadata } from "./useLocalOrgMetadata";
import { useMemberActions } from "./useMemberActions";
import { useSessionActions } from "./useSessionActions";
import { isToday, toSessionTableItem } from "./utils";

export function useCollabOrgPanelModel(
  selectedCollabOrg: ChatPanelSelectedCollabOrg
) {
  const { t } = useTranslation("navigation");
  const orgs = useAtomValue(collabOrgsAtom);
  const sessions = useAtomValue(sessionsAtom);
  const remoteSessions = useAtomValue(remoteTeammateSessionsAtom);
  const members = useAtomValue(collabMembersAtom);
  const projects = useAtomValue(collabProjectsAtom);
  const workItems = useAtomValue(collabWorkItemsAtom);
  const snapshotRequests = useAtomValue(collabSessionSnapshotRequestsAtom);
  const setSelectedCollabOrg = useSetAtom(chatPanelSelectedCollabOrgAtom);
  const [activeTab, setActiveTab] = useState<CollabOrgTab>(
    selectedCollabOrg.memberId
      ? COLLAB_ORG_TAB.MEMBERS
      : COLLAB_ORG_TAB.WORK_ITEMS
  );

  const org = useMemo(
    () => orgs.find((candidate) => candidate.id === selectedCollabOrg.orgId),
    [orgs, selectedCollabOrg.orgId]
  );

  const orgMembers = useMemo(
    () =>
      members.filter(
        (member) =>
          member.orgId === selectedCollabOrg.orgId && !member.removedAt
      ),
    [members, selectedCollabOrg.orgId]
  );

  const selectedMember = useMemo(
    () =>
      selectedCollabOrg.memberId
        ? (orgMembers.find(
            (member) => member.id === selectedCollabOrg.memberId
          ) ?? null)
        : null,
    [orgMembers, selectedCollabOrg.memberId]
  );

  const currentMember = useMemo(
    () =>
      orgMembers.find((member) => member.id === org?.localMemberId) ??
      orgMembers.find((member) => member.role === COLLAB_ROLE.ADMIN) ??
      orgMembers[0],
    [org?.localMemberId, orgMembers]
  );

  const accessSettingsModel = useAccessSettingsModel({
    orgId: selectedCollabOrg.orgId,
    currentMember,
    sessions,
  });
  const chatModel = useCollabOrgChat({ org, orgMembers, currentMember, t });
  const memberActions = useMemberActions({
    org,
    currentMember,
    selectedCollabOrg,
  });
  const { localMetadataError } = useLocalOrgMetadata(org);

  const orgSessions = useMemo(
    () =>
      remoteSessions.filter(
        (session) => session.orgId === selectedCollabOrg.orgId
      ),
    [remoteSessions, selectedCollabOrg.orgId]
  );

  const visibleSessions = useMemo(
    () =>
      selectedMember
        ? orgSessions.filter(
            (session) => session.ownerMemberId === selectedMember.id
          )
        : orgSessions,
    [orgSessions, selectedMember]
  );

  const sessionItems = useMemo(
    () =>
      visibleSessions.map((session) =>
        toSessionTableItem(
          session,
          t("collaboration.sessionStatusActive"),
          t("collaboration.access.metadataOnlyBadge")
        )
      ),
    [visibleSessions, t]
  );

  const { handleSelectSession } = useSessionActions({
    orgSessions,
    sessions,
    currentMember,
    t,
  });

  const activeMemberIds = useMemo(
    () =>
      new Set(
        orgSessions
          .filter((session) => isToday(session.lastActivityAt))
          .map((session) => session.ownerMemberId)
      ),
    [orgSessions]
  );

  const orgChatMessages = useMemo(
    () =>
      chatModel.chatMessages
        .filter((message) => message.orgId === selectedCollabOrg.orgId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    [chatModel.chatMessages, selectedCollabOrg.orgId]
  );

  const orgProjects = useMemo(
    () =>
      projects.filter((project) => project.orgId === selectedCollabOrg.orgId),
    [projects, selectedCollabOrg.orgId]
  );

  const orgWorkItems = useMemo(
    () =>
      workItems.filter(
        (workItem) => workItem.orgId === selectedCollabOrg.orgId
      ),
    [selectedCollabOrg.orgId, workItems]
  );

  const latestSnapshotRequest = useMemo(
    () =>
      snapshotRequests
        .filter((request) => request.orgId === selectedCollabOrg.orgId)
        .sort((left, right) =>
          right.createdAt.localeCompare(left.createdAt)
        )[0],
    [selectedCollabOrg.orgId, snapshotRequests]
  );

  const handleSelectMember = useCallback(
    (member: CollabMemberRecord) => {
      setSelectedCollabOrg({ orgId: member.orgId, memberId: member.id });
      setActiveTab(COLLAB_ORG_TAB.MEMBERS);
    },
    [setSelectedCollabOrg]
  );

  const handleBackToOrg = useCallback(() => {
    setSelectedCollabOrg({ orgId: selectedCollabOrg.orgId });
    setActiveTab(COLLAB_ORG_TAB.SESSIONS);
  }, [selectedCollabOrg.orgId, setSelectedCollabOrg]);

  const tabs = useMemo(() => {
    const baseTabs = [
      {
        key: COLLAB_ORG_TAB.WORK_ITEMS,
        label: t("collaboration.tabs.workItems"),
      },
      { key: COLLAB_ORG_TAB.PROJECTS, label: t("collaboration.tabs.projects") },
      { key: COLLAB_ORG_TAB.SESSIONS, label: t("collaboration.tabs.sessions") },
      { key: COLLAB_ORG_TAB.MEMBERS, label: t("collaboration.tabs.members") },
      { key: COLLAB_ORG_TAB.CHAT, label: t("collaboration.tabs.chat") },
    ];
    if (!currentMember) return baseTabs;
    return [
      ...baseTabs,
      { key: COLLAB_ORG_TAB.SETTINGS, label: t("collaboration.tabs.settings") },
    ];
  }, [currentMember, t]);

  return {
    t,
    org,
    activeTab,
    setActiveTab,
    draftMessage: chatModel.draftMessage,
    setDraftMessage: chatModel.setDraftMessage,
    sending: chatModel.sending,
    chatError: chatModel.chatError,
    creatingInvite: memberActions.creatingInvite,
    copyingInvite: memberActions.copyingInvite,
    inviteError: memberActions.inviteError,
    removingMemberId: memberActions.removingMemberId,
    memberError: memberActions.memberError,
    localMetadataError,
    orgMembers,
    selectedMember,
    currentMember,
    currentAccessSettings: accessSettingsModel.currentAccessSettings,
    workspaceOptions: accessSettingsModel.workspaceOptions,
    latestInvite: memberActions.latestInvite,
    canCreateInvite: memberActions.canCreateInvite,
    sessionItems,
    activeMemberIds,
    orgChatMessages,
    orgProjects,
    orgWorkItems,
    latestSnapshotRequest,
    tabs,
    handleSendMessage: chatModel.handleSendMessage,
    handleSelectAccessMode: accessSettingsModel.handleSelectAccessMode,
    handleToggleWorkspace: accessSettingsModel.handleToggleWorkspace,
    handleSelectMember,
    handleSelectSession,
    handleBackToOrg,
    handleCreateInvite: memberActions.handleCreateInvite,
    handleCopyInvite: memberActions.handleCopyInvite,
    handleRemoveMember: memberActions.handleRemoveMember,
  };
}
