/**
 * GeneralSection — General project settings.
 *
 * Uses the shared SectionLayout components (same as Settings).
 * Includes a danger zone with GitHub-style project deletion:
 * user must type the project name to confirm.
 */
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Input from "@src/components/Input";
import Switch from "@src/components/Switch";
import { Alert01Icon, HugeiconsIcon } from "@src/icons";
import {
  SECTION_ACTION_GAP_CLASSES,
  SECTION_CONTROL_STYLE,
  SECTION_DESCRIPTION_CLASSES,
  SectionContainer,
  SectionHeading,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";

import { deriveWorkItemPrefix } from "../../../config";

export interface GeneralSectionProps {
  projectName: string;
  workItemPrefix: string;
  workItemPrefixCustom: boolean;
  onUpdateWorkItemPrefix: (prefix: string, custom: boolean) => void;
  onDeleteProject?: () => Promise<void>;
}

const WORK_ITEM_PREFIX_MAX_LENGTH = 3;

function sanitizePrefixInput(rawValue: string): string {
  return rawValue
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, WORK_ITEM_PREFIX_MAX_LENGTH);
}

const GeneralSection: React.FC<GeneralSectionProps> = ({
  projectName,
  workItemPrefix,
  workItemPrefixCustom,
  onUpdateWorkItemPrefix,
  onDeleteProject,
}) => {
  const { t } = useTranslation("projects");
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const isConfirmed = useMemo(
    () => confirmText.trim() === projectName,
    [confirmText, projectName]
  );
  const autoPrefix = useMemo(
    () => deriveWorkItemPrefix(projectName),
    [projectName]
  );
  const displayPrefix = workItemPrefixCustom ? workItemPrefix : autoPrefix;

  const handleDelete = useCallback(async () => {
    if (!isConfirmed || !onDeleteProject) return;
    setDeleting(true);
    try {
      await onDeleteProject();
    } finally {
      setDeleting(false);
      setShowConfirm(false);
      setConfirmText("");
    }
  }, [isConfirmed, onDeleteProject]);

  const handleCancel = useCallback(() => {
    setShowConfirm(false);
    setConfirmText("");
  }, []);

  const handlePrefixChange = useCallback(
    (value: string) => {
      const nextPrefix = sanitizePrefixInput(value);
      if (nextPrefix.length > 0) {
        onUpdateWorkItemPrefix(nextPrefix, true);
      }
    },
    [onUpdateWorkItemPrefix]
  );

  const handleCustomToggle = useCallback(
    (enabled: boolean) => {
      if (enabled) {
        onUpdateWorkItemPrefix(autoPrefix, true);
        return;
      }
      onUpdateWorkItemPrefix(autoPrefix, false);
    },
    [autoPrefix, onUpdateWorkItemPrefix]
  );

  return (
    <SectionHeading title={t("settings.sidebarGeneral")}>
      <SectionContainer title={t("settings.workItemIdTitle")}>
        <SectionRow
          label={t("settings.customPrefix")}
          description={t("settings.customPrefixCurrentValue", {
            value: displayPrefix,
          })}
        >
          <Switch
            checked={workItemPrefixCustom}
            onCheckedChange={handleCustomToggle}
          />
        </SectionRow>
        {workItemPrefixCustom && (
          <SectionRow
            label={t("settings.workItemIdPrefix")}
            description={t("settings.workItemIdPrefixDescription")}
            indent
          >
            <Input
              value={displayPrefix}
              onChange={handlePrefixChange}
              style={SECTION_CONTROL_STYLE}
              placeholder={t("settings.workItemIdPrefix")}
            />
          </SectionRow>
        )}
      </SectionContainer>

      {/* Danger Zone */}
      <SectionContainer title={t("settings.dangerZone")}>
        <SectionRow
          label={t("settings.deleteProject")}
          description={t("settings.deleteProjectWarning")}
          layout="vertical"
        >
          {!showConfirm ? (
            <Button
              variant="danger"
              size="small"
              onClick={() => setShowConfirm(true)}
              disabled={!onDeleteProject}
              data-testid="project-delete-start"
            >
              {t("settings.deleteThisProject")}
            </Button>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex items-start gap-2">
                <HugeiconsIcon
                  icon={Alert01Icon}
                  data-icon="alert-triangle"
                  size={14}
                  className="mt-0.5 shrink-0 text-danger-6"
                />
                <div className={SECTION_DESCRIPTION_CLASSES}>
                  {t("settings.deleteConfirmPrompt", { projectName })}
                </div>
              </div>
              <Input
                value={confirmText}
                onChange={setConfirmText}
                placeholder={projectName}
                className="max-w-[320px]"
                data-testid="project-delete-confirm-input"
                autoFocus
                onKeyDown={(event) => {
                  if (event.key === "Enter" && isConfirmed) handleDelete();
                  if (event.key === "Escape") handleCancel();
                }}
              />
              <div className={SECTION_ACTION_GAP_CLASSES}>
                <Button
                  variant="danger"
                  size="small"
                  disabled={!isConfirmed}
                  loading={deleting}
                  onClick={handleDelete}
                  data-testid="project-delete-confirm"
                >
                  {t("settings.confirmDelete")}
                </Button>
                <Button size="small" onClick={handleCancel} disabled={deleting}>
                  {t("common:actions.cancel")}
                </Button>
              </div>
            </div>
          )}
        </SectionRow>
      </SectionContainer>
    </SectionHeading>
  );
};

export default GeneralSection;
