/**
 * CloneUrlForm
 *
 * Form for cloning a repo from a GitHub URL
 */
import { Code, Folder, FolderOpen } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Input from "@src/components/Input";
import { PanelFooter } from "@src/modules/shared/layouts/blocks";
import { joinPathForDisplay } from "@src/util/file/pathUtils";

import { ICONS } from "../../config";
import {
  SpotlightFormBody,
  SpotlightFormShell,
  SpotlightModalHeader,
} from "../shared";

interface CloneUrlFormProps {
  repoUrl: string;
  onRepoUrlChange: (url: string) => void;
  localPath: string;
  onLocalPathChange: (path: string) => void;
  onChoosePath: () => Promise<string | null>;
  onCancel: () => void;
  onSubmit: () => void;
  loading: boolean;
  hideHeader?: boolean;
}

const CloneUrlForm: React.FC<CloneUrlFormProps> = ({
  repoUrl,
  onRepoUrlChange,
  localPath,
  onLocalPathChange,
  onChoosePath,
  onCancel,
  onSubmit,
  loading,
  hideHeader = false,
}) => {
  const { t } = useTranslation();
  const isSubmitDisabled = loading || !repoUrl.trim() || !localPath.trim();

  const getStatusKey = (): string => {
    if (loading) return "statusCloningRepo";
    if (repoUrl && localPath) return "statusReadyToClone";
    if (repoUrl) return "statusSelectLocalPath";
    return "statusEnterGitHubUrl";
  };

  // Extract repo name from GitHub URL
  const getRepoNameFromUrl = (url: string): string | null => {
    try {
      // Handle various GitHub URL formats:
      // - https://github.com/owner/repo.git
      // - https://github.com/owner/repo
      // - github.com/owner/repo
      // - git@github.com:owner/repo.git
      const match = url.match(/github\.com[:/]([^/]+)\/([^/.]+)(\.git)?$/i);
      return match ? match[2] : null;
    } catch {
      return null;
    }
  };

  const repoName = getRepoNameFromUrl(repoUrl);

  return (
    <div className="flex h-full flex-col">
      <SpotlightModalHeader
        icon={ICONS.cloneRepo}
        title={t("cloneForm.titleCloneFromGitHubUrl")}
        badge="CLONE"
        badgeColor="primary"
        statusText={t(`cloneForm.${getStatusKey()}`)}
        isLoading={loading}
        onClose={onCancel}
        hideHeader={hideHeader}
      />
      <SpotlightFormShell>
        <SpotlightFormBody>
          <div className="mb-3">
            <label className="mb-2 block text-[14px] font-[400] text-text-2">
              {t("cloneForm.githubUrl")}
            </label>
            <Input
              placeholder={t("cloneForm.githubUrlPlaceholder")}
              value={repoUrl}
              onChange={onRepoUrlChange}
              className="h-[32px] rounded-lg bg-fill-1 text-[14px]"
              prefix={<Code className="text-[16px] text-text-2" size={16} />}
            />
          </div>
          <div className="mb-3">
            <label className="mb-2 block text-[14px] font-[400] text-text-2">
              {t("cloneForm.cloneTo")}
            </label>
            <div className="flex gap-3">
              <div className="flex-1">
                <Input
                  value={localPath}
                  onChange={onLocalPathChange}
                  placeholder={t("cloneForm.parentFolderPlaceholder")}
                  className="h-[32px] rounded-lg bg-fill-1 text-[14px]"
                  prefix={
                    <Folder className="text-[16px] text-text-2" size={16} />
                  }
                />
              </div>
              <Button
                variant="secondary"
                size="default"
                iconOnly
                icon={<FolderOpen size={16} />}
                title={t("cloneForm.chooseFolder")}
                onClick={async () => {
                  const path = await onChoosePath();
                  if (path) onLocalPathChange(path);
                }}
                className="h-[32px] w-[32px] shrink-0 rounded-lg border border-border-2 bg-bg-2 text-text-1 hover:bg-bg-3"
              />
            </div>
            {/* Destination preview */}
            {localPath && repoName && (
              <div className="mt-2 text-[12px] text-text-2">
                {t("cloneForm.repoWillBeClonedTo")}{" "}
                <span className="font-medium text-text-1">
                  {joinPathForDisplay(localPath, repoName)}
                </span>
              </div>
            )}
          </div>
        </SpotlightFormBody>

        <PanelFooter
          secondaryButtonSize="default"
          primaryButtonSize="default"
          secondaryActions={[
            {
              label: t("actions.back"),
              onClick: onCancel,
              variant: "secondary",
              disabled: loading,
            },
          ]}
          primaryAction={{
            label: loading ? `${t("actions.clone")}...` : t("actions.clone"),
            onClick: onSubmit,
            disabled: isSubmitDisabled,
            loading,
            variant: "primary",
          }}
        />
      </SpotlightFormShell>
    </div>
  );
};

export default CloneUrlForm;
