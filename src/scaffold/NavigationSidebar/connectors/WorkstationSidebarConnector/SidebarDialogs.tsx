import RenameModal from "@/src/scaffold/ModalSystem/variants/Rename";
import React from "react";
import { useTranslation } from "react-i18next";

import CloudSessionShareDialog from "@src/features/Org2Cloud/CloudSessionShareDialog";
import type { useCloudSessionShareDialog } from "@src/features/Org2Cloud/CloudSessionShareDialog/useCloudSessionShareDialog";
import CloudShareImportDialog from "@src/features/Org2Cloud/CloudShareImportDialog";
import CloudSyncLevelDialog from "@src/features/Org2Cloud/CloudSyncLevelDialog";
import type { useCloudSyncLevelDialog } from "@src/features/Org2Cloud/CloudSyncLevelDialog/useCloudSyncLevelDialog";
import JoinCloudOrgDialog from "@src/features/Org2Cloud/JoinCloudOrgDialog";
import ForkCheckoutPickerDialog from "@src/features/TeamCollaboration/components/ForkCheckoutPickerDialog";
import ForkSessionSetupDialog from "@src/features/TeamCollaboration/components/ForkSessionSetupDialog";
import MoveToOrgDialog from "@src/features/TeamCollaboration/components/MoveToOrgDialog";
import type { useMoveToOrgDialog } from "@src/features/TeamCollaboration/components/MoveToOrgDialog/useMoveToOrgDialog";
import type { useRenameSessionModal } from "@src/scaffold/NavigationSidebar/connectors/useRenameSessionModal";
import type { Session } from "@src/store/session";

interface SidebarDialogsProps {
  /** Org-channel dialogs (create/settings/archive/delete/members) — mounted once. */
  cloudChannelsDialogs: React.ReactNode;
  /** Local-channel dialogs (create/settings/archive/delete) — mounted once. */
  localChannelsDialogs: React.ReactNode;
  cloudMemberFilterDropdown: React.ReactNode;
  cloudShare: ReturnType<typeof useCloudSessionShareDialog>;
  cloudSyncLevel: ReturnType<typeof useCloudSyncLevelDialog>;
  moveToOrg: ReturnType<typeof useMoveToOrgDialog>;
  rename: ReturnType<typeof useRenameSessionModal>;
  sessionMap: ReadonlyMap<string, Session>;
}

export const SidebarDialogs: React.FC<SidebarDialogsProps> = ({
  cloudChannelsDialogs,
  localChannelsDialogs,
  cloudMemberFilterDropdown,
  cloudShare,
  cloudSyncLevel,
  moveToOrg,
  rename,
  sessionMap,
}) => {
  const { t } = useTranslation("navigation");
  const { t: tCommon } = useTranslation();

  return (
    <>
      <RenameModal
        visible={rename.visible}
        currentName={rename.currentName}
        title={`${tCommon("actions.rename")} ${t("routes.session")}`}
        placeholder={t("sidebar.defaults.enterSessionName")}
        loading={rename.loading}
        onCancel={rename.onCancel}
        onConfirm={(newName) => rename.onConfirm(newName, sessionMap)}
      />
      <MoveToOrgDialog
        session={moveToOrg.moveDialogSession}
        onClose={moveToOrg.closeMoveToOrg}
      />
      <CloudSyncLevelDialog
        session={cloudSyncLevel.syncLevelSession}
        onClose={cloudSyncLevel.closeSyncLevel}
      />
      <CloudSessionShareDialog
        session={cloudShare.cloudShareSession}
        orgs={cloudShare.cloudShareOrgs}
        onClose={cloudShare.closeCloudShare}
      />
      <CloudShareImportDialog />
      <JoinCloudOrgDialog />
      <ForkCheckoutPickerDialog />
      <ForkSessionSetupDialog />
      {cloudChannelsDialogs}
      {localChannelsDialogs}
      {cloudMemberFilterDropdown}
    </>
  );
};
