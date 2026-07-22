import React, { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  PROJECT_ORG_SYNC_PROVIDER,
  type ProjectOrg,
  type SyncProjectOrgGitFolderResult,
} from "@src/api/http/project";
import Button from "@src/components/Button";
import Input from "@src/components/Input";
import {
  DEFAULT_PERSONAL_PROJECT_ORG_ID,
  canDeleteLocalProjectOrg,
} from "@src/modules/ProjectManager/projectOrgVisibility";
import {
  SECTION_ACTION_GAP_CLASSES,
  SECTION_DESCRIPTION_CLASSES,
  SECTION_GAP_CLASSES,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import {
  CARD_ROW_TOKENS,
  CollapsibleSection,
  DETAIL_PANEL_TOKENS,
} from "@src/modules/shared/layouts/blocks";
import type { Label } from "@src/types/core/shared";

import { LabelsSection } from "../../WorkItems/components/WorkItemsSettings/subpages";

const SyncMethodsSection: React.FC<{
  org: ProjectOrg | null;
  folderPath: string;
  onFolderPathChange: (value: string) => void;
  onConfigure: () => Promise<void>;
  onSyncNow: () => Promise<SyncProjectOrgGitFolderResult | null>;
}> = ({ org, folderPath, onFolderPathChange, onConfigure, onSyncNow }) => {
  const { t } = useTranslation(["projects", "common"]);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] =
    useState<SyncProjectOrgGitFolderResult | null>(null);

  const isGitFolder =
    org?.sync_provider === PROJECT_ORG_SYNC_PROVIDER.GIT_FOLDER;

  const handleConfigure = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await onConfigure();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [onConfigure]);

  const handleSyncNow = useCallback(async () => {
    setSyncing(true);
    setError(null);
    try {
      setLastResult(await onSyncNow());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  }, [onSyncNow]);

  return (
    <div className={SECTION_GAP_CLASSES}>
      <SectionContainer>
        <SectionRow
          label={t("projects:orgs.management.gitFolderSync")}
          description={t("projects:orgs.management.gitFolderSyncDescription")}
        >
          <span className="rounded-full bg-fill-2 px-2 py-0.5 text-xs text-text-2">
            {isGitFolder
              ? t("projects:orgs.gitFolderBadge")
              : t("projects:orgs.management.notConfigured")}
          </span>
        </SectionRow>
        <SectionRow
          label={t("projects:orgs.gitFolderPath")}
          description={t("projects:orgs.gitFolderPathHint")}
          layout="vertical"
        >
          <div className="flex w-full min-w-0 items-center gap-2">
            <Input
              value={folderPath}
              onChange={onFolderPathChange}
              placeholder={t("projects:orgs.gitFolderPathPlaceholder")}
              className="min-w-0 flex-1"
            />
            <Button
              onClick={handleConfigure}
              disabled={saving || !folderPath.trim()}
            >
              {saving
                ? t("common:status.saving")
                : t("common:actions.configure")}
            </Button>
          </div>
        </SectionRow>
      </SectionContainer>
      <SectionContainer>
        <SectionRow
          label={t("projects:settings.sidebarSync")}
          description={t("projects:orgs.management.syncNowDescription")}
        >
          <div className={SECTION_ACTION_GAP_CLASSES}>
            {lastResult && (
              <span className="text-xs text-text-2">
                {t("projects:orgs.management.syncSummary", {
                  projects:
                    lastResult.projects_exported + lastResult.projects_imported,
                  workItems:
                    lastResult.work_items_exported +
                    lastResult.work_items_imported,
                  conflicts: lastResult.conflicts.length,
                })}
              </span>
            )}
            <Button onClick={handleSyncNow} disabled={syncing || !isGitFolder}>
              {syncing ? t("common:status.syncing") : t("common:actions.sync")}
            </Button>
          </div>
        </SectionRow>
        {error && (
          <SectionRow label="" indent showHeader={false}>
            <div className="rounded-md border border-danger-6/30 bg-danger-2/20 px-3 py-2 text-xs text-danger-6">
              {error}
            </div>
          </SectionRow>
        )}
      </SectionContainer>
      <p className={`px-1 ${SECTION_DESCRIPTION_CLASSES}`}>
        {t("projects:orgs.management.syncHowItWorks")}
      </p>
    </div>
  );
};

const EmptyOrgCatalogHint: React.FC = () => {
  const { t } = useTranslation("projects");
  return (
    <SectionContainer>
      <SectionRow label="" showHeader={false}>
        <div className={CARD_ROW_TOKENS.emptyState}>
          <div className="flex flex-col gap-1">
            <span>{t("orgs.management.noProjectsForCatalog")}</span>
            <span className={SECTION_DESCRIPTION_CLASSES}>
              {t("orgs.management.noProjectsForCatalogHint")}
            </span>
          </div>
        </div>
      </SectionRow>
    </SectionContainer>
  );
};

export const OrgDangerZone: React.FC<{
  org: ProjectOrg | null;
  onDeleteOrg: () => Promise<void>;
}> = ({ org, onDeleteOrg }) => {
  const { t } = useTranslation(["projects", "common"]);
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const canDelete = Boolean(org && canDeleteLocalProjectOrg(org));
  const isConfirmed = Boolean(org && confirmText.trim() === org.name);
  const isPersonalOrg = org?.id === DEFAULT_PERSONAL_PROJECT_ORG_ID;

  const handleDelete = useCallback(async () => {
    if (!canDelete || !isConfirmed) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await onDeleteOrg();
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeleting(false);
    }
  }, [canDelete, isConfirmed, onDeleteOrg]);

  return (
    <SectionContainer title={t("projects:orgs.management.dangerZone")}>
      <div data-testid="local-org-danger-zone">
        <SectionRow
          label={t("projects:orgs.management.deleteOrg")}
          description={
            isPersonalOrg
              ? t("projects:orgs.management.personalOrgDeleteDisabled")
              : t("projects:orgs.management.deleteOrgDescription", {
                  org: org?.name ?? "",
                })
          }
          layout="vertical"
          align="start"
        >
          <div className={`${SECTION_ACTION_GAP_CLASSES} w-full`}>
            <Input
              size="default"
              value={confirmText}
              onChange={setConfirmText}
              placeholder={t("projects:orgs.management.deleteTypeToConfirm", {
                org: org?.name ?? "",
              })}
              className="min-w-0 flex-1"
              disabled={!canDelete || deleting}
              data-testid="local-org-delete-confirm-input"
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleDelete();
              }}
            />
            <Button
              htmlType="button"
              size="default"
              variant="danger"
              disabled={!canDelete || !isConfirmed || deleting}
              loading={deleting}
              data-testid="local-org-delete-confirm"
              onClick={() => void handleDelete()}
            >
              {t("projects:orgs.management.deleteOrgAction")}
            </Button>
          </div>
        </SectionRow>
        {deleteError ? (
          <div className="pb-2 text-[12px] text-danger-6">{deleteError}</div>
        ) : null}
      </div>
    </SectionContainer>
  );
};

export interface ProjectOrgSettingsPaneProps {
  org: ProjectOrg | null;
  projectCount: number;
  labels: Label[];
  folderPath: string;
  onFolderPathChange: (value: string) => void;
  onConfigureGitFolder: () => Promise<void>;
  onSyncGitFolder: () => Promise<SyncProjectOrgGitFolderResult | null>;
  onUpdateLabels: (labels: Label[]) => Promise<void>;
  onDeleteOrg: () => Promise<void>;
}

export const ProjectOrgSettingsPane: React.FC<ProjectOrgSettingsPaneProps> = ({
  org,
  projectCount,
  labels,
  folderPath,
  onFolderPathChange,
  onConfigureGitFolder,
  onSyncGitFolder,
  onUpdateLabels,
  onDeleteOrg,
}) => {
  const { t } = useTranslation("projects");
  const labelsContent =
    projectCount > 0 ? (
      <LabelsSection
        labels={labels}
        onUpdateLabels={onUpdateLabels}
        showTitle={false}
      />
    ) : (
      <EmptyOrgCatalogHint />
    );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className={DETAIL_PANEL_TOKENS.scrollContent}>
        <div className={DETAIL_PANEL_TOKENS.contentWidthWithPadding}>
          <CollapsibleSection title={t("orgs.management.syncMethods")}>
            <SyncMethodsSection
              org={org}
              folderPath={folderPath}
              onFolderPathChange={onFolderPathChange}
              onConfigure={onConfigureGitFolder}
              onSyncNow={onSyncGitFolder}
            />
          </CollapsibleSection>
          <CollapsibleSection title={t("properties.labels")}>
            {labelsContent}
          </CollapsibleSection>
          <OrgDangerZone org={org} onDeleteOrg={onDeleteOrg} />
        </div>
      </div>
    </div>
  );
};

export default ProjectOrgSettingsPane;
