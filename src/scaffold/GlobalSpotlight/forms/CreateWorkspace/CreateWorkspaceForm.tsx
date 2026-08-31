/**
 * CreateWorkspaceForm
 *
 * Form for composing a Multi-repo Workspace from existing repos.
 * User selects 2+ repos from a checklist; on submit, the selected
 * repos become workspace folders via setWorkspaceFoldersAtom.
 */
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { WorkspaceRecord } from "@src/api/tauri/workspace";
import Checkbox from "@src/components/Checkbox";
import Input from "@src/components/Input";
import { Placeholder } from "@src/components/Placeholder";
import {
  FolderClosedIcon,
  HugeiconsIcon,
  Search01Icon,
  Tick01Icon,
} from "@src/icons";
import { PanelFooter } from "@src/modules/shared/layouts/blocks";
import { REPO_KIND } from "@src/store/repo";

import { ICONS } from "../../config";
import type { RepoItem } from "../../types";
import {
  SpotlightFormBody,
  SpotlightFormShell,
  SpotlightModalHeader,
} from "../shared";

const MAX_WORKSPACE_REPOS = 5;

interface CreateWorkspaceFormProps {
  repos: RepoItem[];
  currentRepoId?: string;
  /** When set, the form runs in edit mode: pre-populated with the
   *  workspace's name and folder selection, and the submit handler will
   *  update the existing record rather than creating a new one. */
  editingWorkspace?: WorkspaceRecord | null;
  onCancel: () => void;
  onSubmit: (selectedRepoIds: string[], workspaceName: string) => void;
  loading: boolean;
  hideHeader?: boolean;
}

const CreateWorkspaceForm: React.FC<CreateWorkspaceFormProps> = ({
  repos,
  currentRepoId,
  editingWorkspace,
  onCancel,
  onSubmit,
  loading,
  hideHeader = false,
}) => {
  const { t } = useTranslation();
  const isEditing = !!editingWorkspace;

  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    if (editingWorkspace) {
      for (const folder of editingWorkspace.folders) {
        if (folder.repoId) initial.add(folder.repoId);
      }
      return initial;
    }
    if (currentRepoId) initial.add(currentRepoId);
    return initial;
  });

  const [workspaceName, setWorkspaceName] = useState(
    editingWorkspace?.name ?? ""
  );
  const [hasCustomWorkspaceName, setHasCustomWorkspaceName] = useState(
    Boolean(editingWorkspace?.name)
  );
  const [repoSearchQuery, setRepoSearchQuery] = useState("");

  const orderedRepos = useMemo(() => repos, [repos]);

  const filteredRepos = useMemo(() => {
    const normalizedQuery = repoSearchQuery.trim().toLowerCase();
    if (!normalizedQuery) return orderedRepos;

    return orderedRepos.filter((repo) => {
      const searchableText = [
        repo.name,
        repo.description,
        repo.repo_url,
        repo.branch,
        repo.fs_uri,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return searchableText.includes(normalizedQuery);
    });
  }, [orderedRepos, repoSearchQuery]);

  const handleToggle = useCallback((repoId: string, checked: boolean) => {
    setSelectedIds((prev) => {
      if (checked && !prev.has(repoId) && prev.size >= MAX_WORKSPACE_REPOS) {
        return prev;
      }

      const next = new Set(prev);
      if (checked) {
        next.add(repoId);
      } else {
        next.delete(repoId);
      }
      return next;
    });
  }, []);

  const generatedWorkspaceName = useMemo(() => {
    const selectedRepoNames = orderedRepos
      .filter((repo) => selectedIds.has(repo.id))
      .map((repo) => repo.name)
      .filter(Boolean);
    return selectedRepoNames.join("-");
  }, [selectedIds, orderedRepos]);

  const effectiveName = workspaceName.trim() || generatedWorkspaceName;
  const displayedWorkspaceName = hasCustomWorkspaceName
    ? workspaceName
    : generatedWorkspaceName;

  const handleSubmit = useCallback(() => {
    const name = effectiveName || t("workspaceForm.defaultName", "Workspace");
    const selectedRepoIds = orderedRepos
      .filter((repo) => selectedIds.has(repo.id))
      .map((repo) => repo.id);
    onSubmit(selectedRepoIds, name);
  }, [onSubmit, selectedIds, effectiveName, orderedRepos, t]);

  const isSubmitDisabled = loading || selectedIds.size < 2;

  const statusKey =
    selectedIds.size < 2
      ? "statusSelectAtLeastTwo"
      : selectedIds.size >= MAX_WORKSPACE_REPOS
        ? "statusMaxRepos"
        : "statusReadyToCreate";

  return (
    <div className="flex h-full flex-col">
      <SpotlightModalHeader
        icon={ICONS.workspace}
        title={
          isEditing
            ? t("workspaceForm.editTitle", "Edit Workspace")
            : t("workspaceForm.title", "Create Multi-repo Workspace")
        }
        badge="WORKSPACE"
        badgeColor="green"
        statusText={t(`workspaceForm.${statusKey}`, {
          defaultValue:
            selectedIds.size < 2
              ? "Select at least 2 repos"
              : `${selectedIds.size} repos selected`,
        })}
        isLoading={loading}
        onClose={onCancel}
        hideHeader={hideHeader}
      />
      <SpotlightFormShell>
        <SpotlightFormBody>
          <div className="mb-3">
            <label className="mb-2 block text-[14px] font-[400] text-text-2">
              {t("workspaceForm.workspaceName", "Workspace Name")}
            </label>
            <Input
              placeholder={
                effectiveName ||
                t("workspaceForm.workspaceNamePlaceholder", "My Workspace")
              }
              value={displayedWorkspaceName}
              onChange={(name) => {
                setWorkspaceName(name);
                setHasCustomWorkspaceName(
                  name.trim() !== generatedWorkspaceName
                );
              }}
              className="h-[32px] rounded-lg bg-fill-1 text-[14px]"
              prefix={
                <HugeiconsIcon
                  icon={ICONS.workspace}
                  className="text-[16px] text-text-2"
                  size={16}
                />
              }
            />
          </div>

          <div className="mb-3">
            <Input
              type="search"
              placeholder={t(
                "workspaceForm.filterPlaceholder",
                "Filter repos..."
              )}
              value={repoSearchQuery}
              onChange={setRepoSearchQuery}
              allowClear
              className="h-[32px] rounded-lg bg-fill-1 text-[14px]"
              prefix={
                <HugeiconsIcon
                  icon={Search01Icon}
                  data-icon="search"
                  size={16}
                  className="text-text-2"
                />
              }
            />
          </div>

          <div className="mb-1 text-[12px] font-medium text-text-3">
            {t("workspaceForm.selectRepos", "Select repos for workspace")}
            {selectedIds.size > 0 && (
              <span className="ml-1 text-primary-6">({selectedIds.size})</span>
            )}
          </div>

          <div className="spotlight-scrollable mb-3 max-h-[200px] overflow-y-auto">
            {filteredRepos.length > 0 ? (
              <div className="space-y-0.5">
                {filteredRepos.map((repo) => {
                  const isChecked = selectedIds.has(repo.id);
                  const isCurrent = repo.id === currentRepoId;
                  const isSelectionDisabled =
                    !isChecked && selectedIds.size >= MAX_WORKSPACE_REPOS;
                  return (
                    <label
                      key={repo.id}
                      className={`flex items-center gap-2.5 rounded px-2 py-1.5 ${
                        isSelectionDisabled
                          ? "cursor-not-allowed opacity-50"
                          : "cursor-pointer hover:bg-fill-3"
                      } ${isChecked ? "bg-fill-1/50" : ""}`}
                    >
                      <Checkbox
                        checked={isChecked}
                        disabled={isSelectionDisabled}
                        onCheckedChange={(checked) =>
                          handleToggle(repo.id, checked)
                        }
                      />
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        {repo.kind === REPO_KIND.FOLDER ? (
                          <HugeiconsIcon
                            icon={FolderClosedIcon}
                            data-icon="folder"
                            size={13}
                            className="shrink-0 text-text-3"
                          />
                        ) : (
                          <HugeiconsIcon
                            icon={ICONS.repo}
                            size={13}
                            className="shrink-0 text-text-3"
                          />
                        )}
                        <span className="truncate text-[14px] text-text-1">
                          {repo.name}
                        </span>
                        {isCurrent && (
                          <span className="flex items-center gap-0.5 text-[11px] text-primary-6">
                            <HugeiconsIcon
                              icon={Tick01Icon}
                              data-icon="check"
                              size={10}
                            />
                            {t("workspaceForm.current", "current")}
                          </span>
                        )}
                      </div>
                      {repo.description && (
                        <span className="max-w-[120px] shrink-0 truncate text-[12px] text-text-3">
                          {repo.description}
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>
            ) : (
              <div className="flex min-h-[80px] flex-col items-center justify-center py-4">
                <Placeholder
                  variant={repoSearchQuery.trim() ? "no-results" : "empty"}
                  title={
                    repoSearchQuery.trim()
                      ? t("workspaceForm.noReposFound", "No repos match filter")
                      : t("workspaceForm.noRepos", "No repos available")
                  }
                />
              </div>
            )}
          </div>
        </SpotlightFormBody>

        <PanelFooter
          secondaryButtonSize="default"
          primaryButtonSize="default"
          left={
            selectedIds.size >= 2 ? (
              <span className="truncate text-[14px] text-text-1">
                {t("workspaceForm.willInclude", {
                  count: selectedIds.size,
                })}
              </span>
            ) : undefined
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
            label: loading
              ? `${
                  isEditing
                    ? t("actions.save", "Save")
                    : t("actions.create", "Create")
                }...`
              : isEditing
                ? t("actions.save", "Save")
                : t("actions.create", "Create"),
            onClick: handleSubmit,
            disabled: isSubmitDisabled,
            loading,
            variant: "primary",
          }}
        />
      </SpotlightFormShell>
    </div>
  );
};

export default CreateWorkspaceForm;
