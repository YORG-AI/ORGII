import React from "react";

import Button from "@src/components/Button";
import TabPill from "@src/components/TabPill";
import WorkItemContentStack from "@src/modules/ProjectManager/WorkItems/components/WorkItemContentStack";
import {
  DETAIL_PANEL_TOKENS,
  DetailPanelContainer,
} from "@src/modules/shared/layouts/blocks";
import type { ChatPanelSelectedCollabOrg } from "@src/store/ui/chatPanelAtom";

import { ChatSection } from "./CollabOrgPanelView/ChatSection";
import { MembersSection } from "./CollabOrgPanelView/MembersSection";
import {
  ProjectsSection,
  WorkItemsSection,
} from "./CollabOrgPanelView/MetadataSections";
import { SessionsSection } from "./CollabOrgPanelView/SessionsSection";
import { SettingsSection } from "./CollabOrgPanelView/SettingsSection";
import { COLLAB_ORG_TAB } from "./CollabOrgPanelView/constants";
import type { CollabOrgTab } from "./CollabOrgPanelView/constants";
import { useCollabOrgPanelModel } from "./CollabOrgPanelView/useCollabOrgPanelModel";

interface CollabOrgPanelViewProps {
  selectedCollabOrg: ChatPanelSelectedCollabOrg;
}

export const CollabOrgPanelView: React.FC<CollabOrgPanelViewProps> = ({
  selectedCollabOrg,
}) => {
  const model = useCollabOrgPanelModel(selectedCollabOrg);
  const { t, org } = model;

  if (!org) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-[13px] text-text-3">
        {t("collaboration.orgNotFound")}
      </div>
    );
  }

  const descriptionContent = (
    <section
      className={`${DETAIL_PANEL_TOKENS.contentWidth} flex min-h-0 flex-1 flex-col`}
      data-testid="chat-panel-collab-org-section"
    >
      <div className="mb-4 flex shrink-0 items-center justify-between gap-3">
        <TabPill
          tabs={model.tabs}
          activeTab={model.activeTab}
          onChange={(tab) => model.setActiveTab(tab as CollabOrgTab)}
          variant="simple"
          size="chatPanel"
          fillWidth={false}
        />
        {model.selectedMember ? (
          <Button
            htmlType="button"
            size="small"
            onClick={model.handleBackToOrg}
          >
            {t("collaboration.backToOrg")}
          </Button>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto scrollbar-hide">
        {model.activeTab === COLLAB_ORG_TAB.WORK_ITEMS ? (
          <WorkItemsSection
            t={t}
            workItems={model.orgWorkItems}
            localMetadataError={model.localMetadataError}
          />
        ) : null}

        {model.activeTab === COLLAB_ORG_TAB.PROJECTS ? (
          <ProjectsSection
            t={t}
            projects={model.orgProjects}
            localMetadataError={model.localMetadataError}
          />
        ) : null}

        {model.activeTab === COLLAB_ORG_TAB.SESSIONS ? (
          <SessionsSection
            t={t}
            sessionItems={model.sessionItems}
            latestSnapshotRequest={model.latestSnapshotRequest}
            onSelectSession={model.handleSelectSession}
          />
        ) : null}

        {model.activeTab === COLLAB_ORG_TAB.MEMBERS ? (
          <MembersSection
            t={t}
            org={org}
            orgMembers={model.orgMembers}
            selectedMember={model.selectedMember}
            currentMember={model.currentMember}
            activeMemberIds={model.activeMemberIds}
            latestInvite={model.latestInvite}
            canCreateInvite={model.canCreateInvite}
            creatingInvite={model.creatingInvite}
            copyingInvite={model.copyingInvite}
            inviteError={model.inviteError}
            memberError={model.memberError}
            removingMemberId={model.removingMemberId}
            onCreateInvite={model.handleCreateInvite}
            onCopyInvite={model.handleCopyInvite}
            onSelectMember={model.handleSelectMember}
            onRemoveMember={model.handleRemoveMember}
          />
        ) : null}

        {model.activeTab === COLLAB_ORG_TAB.SETTINGS ? (
          <SettingsSection
            t={t}
            currentAccessSettings={model.currentAccessSettings}
            workspaceOptions={model.workspaceOptions}
            onSelectAccessMode={model.handleSelectAccessMode}
            onToggleWorkspace={model.handleToggleWorkspace}
          />
        ) : null}

        {model.activeTab === COLLAB_ORG_TAB.CHAT ? (
          <ChatSection
            t={t}
            messages={model.orgChatMessages}
            currentMember={model.currentMember}
            draftMessage={model.draftMessage}
            sending={model.sending}
            chatError={model.chatError}
            onDraftMessageChange={model.setDraftMessage}
            onSendMessage={model.handleSendMessage}
          />
        ) : null}
      </div>
    </section>
  );

  return (
    <div
      className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden"
      data-testid="chat-panel-collab-org-detail"
    >
      <DetailPanelContainer testId="collab-org-panel">
        <WorkItemContentStack
          descriptionContent={descriptionContent}
          descriptionFlexible
        />
      </DetailPanelContainer>
    </div>
  );
};

export default CollabOrgPanelView;
