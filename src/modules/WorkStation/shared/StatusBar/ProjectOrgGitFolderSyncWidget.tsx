import { useAtomValue, useSetAtom } from "jotai";
import React, { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  PROJECT_GIT_FOLDER_SYNC_STATUS,
  projectApi,
} from "@src/api/http/project";
import { useWorkStationTabs } from "@src/hooks/tabHost/useWorkStationTabs";
import {
  CloudAlertIcon,
  CloudIcon,
  CloudUploadIcon,
  GitMergeIcon,
  HugeiconsIcon,
} from "@src/icons";
import {
  projectGitFolderSyncResultByOrgAtom,
  projectListRefreshAtom,
  setProjectGitFolderSyncResultAtom,
} from "@src/store/project";
import { createProjectGitSyncReviewTab } from "@src/store/workstation/tabs";

import { StatusBarButton } from "./StatusBarBase";

export interface ProjectOrgGitFolderSyncWidgetProps {
  orgId: string | undefined;
  orgName: string | undefined;
  enabled: boolean | undefined;
}

const ProjectOrgGitFolderSyncWidget: React.FC<ProjectOrgGitFolderSyncWidgetProps> =
  memo(({ orgId, orgName, enabled }) => {
    const { t } = useTranslation("projects");
    const bumpProjectListRefresh = useSetAtom(projectListRefreshAtom);
    const setProjectGitFolderSyncResult = useSetAtom(
      setProjectGitFolderSyncResultAtom
    );
    const { openTab: openProjectTab } = useWorkStationTabs();
    const syncResultByOrg = useAtomValue(projectGitFolderSyncResultByOrgAtom);
    const [syncing, setSyncing] = useState(false);
    const [lastError, setLastError] = useState<string | null>(null);
    const [lastResultLabel, setLastResultLabel] = useState<string | null>(null);
    const syncResult = orgId ? syncResultByOrg[orgId] : undefined;
    const conflictCount =
      syncResult?.status === PROJECT_GIT_FOLDER_SYNC_STATUS.BLOCKED
        ? syncResult.conflicts.length
        : 0;

    const openConflictReview = useCallback(() => {
      if (!orgId) return;
      openProjectTab(createProjectGitSyncReviewTab(orgId, orgName));
    }, [openProjectTab, orgId, orgName]);

    const handleSync = useCallback(async () => {
      if (!orgId) return;
      if (conflictCount > 0) {
        openConflictReview();
        return;
      }
      setSyncing(true);
      setLastError(null);
      try {
        const result = await projectApi.syncOrgGitFolder({ org_id: orgId });
        setProjectGitFolderSyncResult(result);
        if (result.status === PROJECT_GIT_FOLDER_SYNC_STATUS.BLOCKED) {
          setLastResultLabel(null);
          openConflictReview();
          return;
        }
        setLastResultLabel(
          t("statusBar.gitFolderSync.result", {
            projectsImported: result.projects_imported,
            projectsExported: result.projects_exported,
            workItemsImported: result.work_items_imported,
            workItemsExported: result.work_items_exported,
          })
        );
        bumpProjectListRefresh((current) => current + 1);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setLastError(message);
      } finally {
        setSyncing(false);
      }
    }, [
      bumpProjectListRefresh,
      conflictCount,
      openConflictReview,
      orgId,
      setProjectGitFolderSyncResult,
      t,
    ]);

    const view = useMemo(() => {
      if (!enabled || !orgId) return null;
      if (syncing) {
        return {
          icon: (
            <HugeiconsIcon
              icon={CloudUploadIcon}
              data-icon="cloud-upload"
              size={13}
              className="text-text-1"
            />
          ),
          label: t("statusBar.gitFolderSync.syncing"),
          title: t("statusBar.gitFolderSync.syncingTitle", { org: orgName }),
        };
      }
      if (lastError) {
        return {
          icon: (
            <HugeiconsIcon
              icon={CloudAlertIcon}
              data-icon="cloud-alert"
              size={13}
              className="text-warning-6"
            />
          ),
          label: t("statusBar.gitFolderSync.retry"),
          title: t("statusBar.gitFolderSync.failed", { message: lastError }),
        };
      }
      if (conflictCount > 0) {
        return {
          icon: (
            <HugeiconsIcon
              icon={GitMergeIcon}
              data-icon="git-merge"
              size={13}
              className="text-warning-6"
            />
          ),
          label: t("statusBar.gitFolderSync.conflicts", {
            count: conflictCount,
          }),
          title: t("statusBar.gitFolderSync.conflictsTitle", {
            count: conflictCount,
          }),
        };
      }
      return {
        icon: (
          <HugeiconsIcon
            icon={CloudIcon}
            data-icon="cloud"
            size={13}
            className="text-text-1"
          />
        ),
        label: t("statusBar.gitFolderSync.syncNow"),
        title:
          lastResultLabel ??
          t("statusBar.gitFolderSync.title", { org: orgName }),
      };
    }, [
      conflictCount,
      enabled,
      lastError,
      lastResultLabel,
      orgId,
      orgName,
      syncing,
      t,
    ]);

    if (!view) return null;

    return (
      <StatusBarButton
        disabled={syncing}
        onClick={handleSync}
        title={view.title}
      >
        {view.icon}
        <span>{view.label}</span>
      </StatusBarButton>
    );
  });

ProjectOrgGitFolderSyncWidget.displayName = "ProjectOrgGitFolderSyncWidget";

export default ProjectOrgGitFolderSyncWidget;
