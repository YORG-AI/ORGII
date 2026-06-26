/**
 * CreateWorkspaceFolderForm
 *
 * Form for creating a new local workspace folder.
 */
import Button from "@/src/components/Button";
import { Code, Folder } from "lucide-react";
import React, { useEffect } from "react";
import { useTranslation } from "react-i18next";

import Input from "@src/components/Input";
import { PanelFooter } from "@src/modules/shared/layouts/blocks";
import { joinPathForDisplay } from "@src/util/file/pathUtils";

import { ICONS } from "../../config";
import {
  SpotlightFormBody,
  SpotlightFormShell,
  SpotlightModalHeader,
} from "../shared";

interface CreateWorkspaceFolderFormProps {
  workspaceName: string;
  onWorkspaceNameChange: (name: string) => void;
  workspacePath: string;
  onWorkspacePathChange: (path: string) => void;
  onChoosePath: () => Promise<string | null>;
  onCancel: () => void;
  onSubmit: () => void;
  loading: boolean;
  hideHeader?: boolean;
  initialPath?: string;
  initialName?: string;
}

const CreateWorkspaceFolderForm: React.FC<CreateWorkspaceFolderFormProps> = ({
  workspaceName,
  onWorkspaceNameChange,
  workspacePath,
  onWorkspacePathChange,
  onChoosePath,
  onCancel,
  onSubmit,
  loading,
  hideHeader = false,
  initialPath,
  initialName,
}) => {
  const { t } = useTranslation();

  useEffect(() => {
    if (initialPath && !workspacePath) {
      onWorkspacePathChange(initialPath);
    }
    if (initialName && !workspaceName) {
      onWorkspaceNameChange(initialName);
    }
  }, [
    initialPath,
    initialName,
    workspacePath,
    workspaceName,
    onWorkspacePathChange,
    onWorkspaceNameChange,
  ]);

  const handleWorkspaceNameChange = (value: string) => {
    const sanitized = value.replace(/\s+/g, "");
    onWorkspaceNameChange(sanitized);
  };

  return (
    <div className="flex h-full flex-col">
      <SpotlightModalHeader
        icon={ICONS.newRepo}
        title={t("selectors.repo.forms.createWorkspaceTitle")}
        badge="CREATE"
        badgeColor="green"
        statusText={
          loading
            ? t("selectors.repo.forms.creatingWorkspace")
            : t("selectors.repo.forms.readyToCreateWorkspace")
        }
        isLoading={loading}
        onClose={onCancel}
        hideHeader={hideHeader}
      />
      <SpotlightFormShell>
        <SpotlightFormBody>
          <div className="mb-3">
            <label className="mb-2 block text-[14px] font-[400] text-text-2">
              {t("selectors.repo.forms.workspaceName")}
            </label>
            <Input
              placeholder={t("selectors.repo.forms.workspaceNamePlaceholder")}
              value={workspaceName}
              onChange={handleWorkspaceNameChange}
              className="h-[32px] rounded-lg bg-fill-1 text-[14px]"
              prefix={<Code className="text-[16px] text-text-2" size={16} />}
              autoCorrect="off"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          </div>
          <div className="mb-3">
            <label className="mb-2 block text-[14px] font-[400] text-text-2">
              {t("selectors.repo.forms.localPath")}
            </label>
            <div className="flex gap-3">
              <div className="flex-1">
                <Input
                  value={workspacePath}
                  onChange={onWorkspacePathChange}
                  placeholder={t("selectors.repo.forms.chooseDestinationPath")}
                  className="h-[32px] rounded-lg bg-fill-1 text-[14px]"
                  prefix={
                    <Folder className="text-[16px] text-text-2" size={16} />
                  }
                />
              </div>
              <Button
                onClick={async () => {
                  const path = await onChoosePath();
                  if (path) onWorkspacePathChange(path);
                }}
                className="h-[32px] rounded-lg border border-border-2 bg-bg-2 px-4 text-[14px] text-text-1 hover:bg-bg-3"
              >
                {t("selectors.repo.forms.choose")}
              </Button>
            </div>
          </div>
        </SpotlightFormBody>

        <PanelFooter
          secondaryButtonSize="default"
          primaryButtonSize="default"
          left={
            workspacePath && workspaceName ? (
              <span className="truncate text-[14px] text-text-1">
                {t("selectors.repo.forms.createAt", {
                  path: joinPathForDisplay(workspacePath, workspaceName),
                })}
              </span>
            ) : undefined
          }
          secondaryActions={[
            {
              label: t("actions.cancel"),
              onClick: onCancel,
              variant: "secondary",
              disabled: loading,
            },
          ]}
          primaryAction={{
            label: loading ? `${t("actions.create")}...` : t("actions.create"),
            onClick: onSubmit,
            disabled: !workspaceName.trim() || !workspacePath.trim(),
            loading,
            variant: "primary",
          }}
        />
      </SpotlightFormShell>
    </div>
  );
};

export default CreateWorkspaceFolderForm;
