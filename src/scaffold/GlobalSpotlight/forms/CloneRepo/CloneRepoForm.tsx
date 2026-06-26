/**
 * CloneRepoForm
 *
 * Form for cloning a repo from GitHub
 */
import {
  Code,
  ExternalLink,
  Filter,
  Folder,
  FolderOpen,
  Lock,
} from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { ACTION_ID, useActionSystemOptional } from "@src/ActionSystem";
import type { GitHubRepo } from "@src/api/http/github/types";
import Button from "@src/components/Button";
import Input from "@src/components/Input";
import Radio from "@src/components/Radio";
import { buildIntegrationsPath } from "@src/config/mainAppPaths";
import { PanelFooter, Placeholder } from "@src/modules/shared/layouts/blocks";
import { joinPathForDisplay } from "@src/util/file/pathUtils";

import { ICONS } from "../../config";
import {
  SpotlightFormBody,
  SpotlightFormShell,
  SpotlightModalHeader,
} from "../shared";

interface CloneRepoFormProps {
  subTab: "myGitHub" | "githubUrl";
  onSubTabChange: (tab: "myGitHub" | "githubUrl") => void;
  filterText: string;
  onFilterTextChange: (text: string) => void;
  repositories: GitHubRepo[];
  groupedRepos: Array<{ organization: string; repositories: GitHubRepo[] }>;
  selectedRepo: string | null;
  onSelectRepo: (id: string | null) => void;
  repoUrl: string;
  onRepoUrlChange: (url: string) => void;
  localPath: string;
  onLocalPathChange: (path: string) => void;
  isLoadingRepos: boolean;
  onChoosePath: () => Promise<string | null>;
  onFetchRepos: () => void;
  onCancel: () => void;
  onSubmit: () => void;
  loading: boolean;
  hideHeader?: boolean;
}

const CloneRepoForm: React.FC<CloneRepoFormProps> = ({
  subTab,
  onSubTabChange,
  filterText,
  onFilterTextChange,
  repositories,
  groupedRepos,
  selectedRepo,
  onSelectRepo,
  repoUrl,
  onRepoUrlChange,
  localPath,
  onLocalPathChange,
  isLoadingRepos,
  onChoosePath,
  onFetchRepos,
  onCancel,
  onSubmit,
  loading,
  hideHeader = false,
}) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const actionSystem = useActionSystemOptional();
  const isSubmitDisabled =
    loading ||
    (subTab === "myGitHub" && selectedRepo === null) ||
    (subTab === "githubUrl" && !repoUrl.trim()) ||
    !localPath.trim();

  const handleGoToSettings = () => {
    onCancel();
    if (actionSystem?.isValidAction(ACTION_ID.APP_GO_TO_CONNECTIONS)) {
      void actionSystem.dispatch(ACTION_ID.APP_GO_TO_CONNECTIONS, {}, "user");
      return;
    }
    navigate(buildIntegrationsPath({ category: "connections" }));
  };

  const getStatusKey = (): string => {
    if (loading) return "statusCloningRepo";
    if (isLoadingRepos) return "statusLoadingRepos";
    if (subTab === "myGitHub" && selectedRepo) return "statusRepoSelected";
    if (subTab === "githubUrl" && repoUrl) return "statusUrlProvided";
    return "statusSelectRepo";
  };

  return (
    <div className="flex h-full flex-col">
      <SpotlightModalHeader
        icon={ICONS.cloneRepo}
        title={t("cloneForm.titleCloneFromGitHub")}
        badge="CLONE"
        badgeColor="primary"
        statusText={t(`cloneForm.${getStatusKey()}`)}
        isLoading={loading || isLoadingRepos}
        onClose={onCancel}
        hideHeader={hideHeader}
      />
      <SpotlightFormShell>
        {/* Tabs */}
        <div className="mb-3 flex items-center justify-center border-b border-solid border-border-1">
          <button
            className={`px-4 py-2 text-[14px] font-medium ${
              subTab === "myGitHub"
                ? "border-b-2 border-primary-6 text-primary-6"
                : "text-text-2"
            }`}
            onClick={() => {
              onSubTabChange("myGitHub");
              if (repositories.length === 0) onFetchRepos();
            }}
          >
            {t("cloneForm.tabMyGitHub")}
          </button>
          <button
            className={`px-4 py-2 text-[14px] font-medium ${
              subTab === "githubUrl"
                ? "border-b-2 border-primary-6 text-primary-6"
                : "text-text-2"
            }`}
            onClick={() => onSubTabChange("githubUrl")}
          >
            {t("cloneForm.tabGitHubUrl")}
          </button>
        </div>

        <SpotlightFormBody>
          {/* My GitHub Tab */}
          {subTab === "myGitHub" && (
            <>
              <div className="mb-3">
                <Input
                  placeholder={t("cloneForm.filterReposPlaceholder")}
                  value={filterText}
                  onChange={onFilterTextChange}
                  className="h-[32px] rounded-lg bg-fill-1 text-[14px]"
                  prefix={<Filter className="text-[16px] text-text-2" />}
                />
              </div>
              <div className="spotlight-scrollable mb-3 max-h-[150px] overflow-y-auto">
                {isLoadingRepos ? (
                  <div className="flex items-center justify-center py-4">
                    <span className="text-[14px] text-text-2">
                      {t("cloneForm.loadingRepos")}
                    </span>
                  </div>
                ) : groupedRepos.length > 0 ? (
                  groupedRepos.map((group) => (
                    <div key={group.organization} className="mb-2">
                      <div className="mb-1 text-[12px] font-medium uppercase text-text-2">
                        {group.organization}
                      </div>
                      <div className="space-y-1">
                        {group.repositories.map((repo) => (
                          <label
                            key={repo.id}
                            className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-fill-1"
                          >
                            <Radio
                              checked={selectedRepo === repo.id}
                              onChange={() => onSelectRepo(repo.id)}
                            />
                            <div className="flex items-center gap-2">
                              {repo.is_private && (
                                <Lock className="text-[12px] text-text-2" />
                              )}
                              <span className="text-[14px] text-text-1">
                                {repo.full_name}
                              </span>
                            </div>
                          </label>
                        ))}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="flex min-h-[120px] flex-col items-center justify-center py-4">
                    <Placeholder
                      variant={filterText ? "no-results" : "empty"}
                      title={
                        filterText
                          ? t("cloneForm.noReposFound")
                          : t("cloneForm.githubNotConnected")
                      }
                      subtitle={
                        filterText
                          ? t("cloneForm.noReposFoundMatching")
                          : t("cloneForm.connectGithubHint")
                      }
                    />
                  </div>
                )}
              </div>
            </>
          )}

          {/* GitHub URL Tab */}
          {subTab === "githubUrl" && (
            <div className="mb-3">
              <label className="mb-2 block text-[14px] font-[400] text-text-2">
                {t("cloneForm.githubUrl")}
              </label>
              <Input
                placeholder={t("cloneForm.githubUrlPlaceholder")}
                value={repoUrl}
                onChange={onRepoUrlChange}
                className="h-[32px] rounded-lg bg-fill-1 text-[14px]"
                prefix={<Code className="text-[16px] text-text-2" />}
              />
            </div>
          )}

          {/* Clone to (parent folder) */}
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
                  readOnly
                  className="h-[32px] rounded-lg bg-fill-1 text-[14px]"
                  prefix={<Folder className="text-[16px] text-text-2" />}
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
            {localPath && (subTab === "myGitHub" ? selectedRepo : repoUrl) && (
              <div className="mt-2 text-[12px] text-text-2">
                {t("cloneForm.repoWillBeClonedTo")}{" "}
                <span className="font-medium text-text-1">
                  {joinPathForDisplay(
                    localPath,
                    subTab === "myGitHub"
                      ? (repositories.find((repo) => repo.id === selectedRepo)
                          ?.name ?? "")
                      : repoUrl.match(
                          /github\.com[:/]([^/]+)\/([^/.]+)/
                        )?.[2] || "repo"
                  )}
                </span>
              </div>
            )}
          </div>
        </SpotlightFormBody>

        <PanelFooter
          secondaryButtonSize="default"
          primaryButtonSize="default"
          left={
            subTab === "myGitHub" &&
            groupedRepos.length === 0 &&
            !filterText ? (
              <Button
                variant="secondary"
                size="default"
                icon={<ExternalLink size={14} />}
                iconPosition="right"
                onClick={handleGoToSettings}
              >
                {t("integrations:git.connectGithub")}
              </Button>
            ) : null
          }
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

export default CloneRepoForm;
