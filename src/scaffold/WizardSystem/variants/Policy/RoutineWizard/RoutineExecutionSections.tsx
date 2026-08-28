import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import Input from "@src/components/Input";
import ModelIcon from "@src/components/ModelIcon";
import Select from "@src/components/Select";
import { FolderGitTwoIcon, GripIcon, HugeiconsIcon } from "@src/icons";
import {
  SECTION_CONTROL_STYLE,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";

import SpotlightSelectTrigger from "./SpotlightSelectTrigger";
import type { RoutineDraft, UpdateRoutineDraft } from "./routineDraft";

interface RoutineExecutionSectionsProps {
  draft: RoutineDraft;
  updateDraft: UpdateRoutineDraft;
  isWorkspacePaletteOpen: boolean;
  isModelPaletteOpen: boolean;
  onOpenWorkspacePalette: () => void;
  onOpenModelPalette: () => void;
}

const RoutineExecutionSections: React.FC<RoutineExecutionSectionsProps> = ({
  draft,
  updateDraft,
  isWorkspacePaletteOpen,
  isModelPaletteOpen,
  onOpenWorkspacePalette,
  onOpenModelPalette,
}) => {
  const { t } = useTranslation("integrations");
  const workspaceKindOptions = useMemo(
    () => [
      { value: "NONE", label: t("routineFields.noWorkspace") },
      { value: "LOCAL_WORKSPACE", label: t("routineFields.localWorkspace") },
      { value: "WORKTREE", label: t("routineFields.worktree") },
    ],
    [t]
  );

  return (
    <>
      <SectionContainer>
        <SectionRow label={t("routineFields.workspace")}>
          <Select
            value={draft.workspaceKind}
            onChange={(value) =>
              updateDraft(
                "workspaceKind",
                String(value) as RoutineDraft["workspaceKind"]
              )
            }
            options={workspaceKindOptions}
            size="default"
            style={SECTION_CONTROL_STYLE}
            dataTestId="routine-wizard-workspace-kind-select"
          />
        </SectionRow>

        {draft.workspaceKind !== "NONE" && (
          <SectionRow label={t("routineFields.workspacePath")} required indent>
            <SpotlightSelectTrigger
              value={draft.workspaceLabel || draft.workspacePath || undefined}
              placeholder={t("routineFields.workspacePathPlaceholder")}
              onClick={onOpenWorkspacePalette}
              active={isWorkspacePaletteOpen}
              size="default"
              style={SECTION_CONTROL_STYLE}
              prefix={
                <HugeiconsIcon
                  icon={FolderGitTwoIcon}
                  data-icon="folder-git-2"
                  size={16}
                  className="text-text-2"
                />
              }
              dataTestId="routine-wizard-workspace-trigger"
              ariaLabel={t("routineFields.workspacePath")}
            />
          </SectionRow>
        )}

        {draft.workspaceKind === "WORKTREE" && (
          <SectionRow label={t("routineFields.branch")} indent>
            <Input
              value={draft.branch}
              onChange={(value) => updateDraft("branch", value)}
              placeholder="routine/my-automation"
              size="default"
              style={SECTION_CONTROL_STYLE}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              data-testid="routine-wizard-branch-input"
            />
          </SectionRow>
        )}
      </SectionContainer>

      <SectionContainer>
        <SectionRow label={t("routineFields.model")}>
          <SpotlightSelectTrigger
            value={draft.modelLabel || draft.model || undefined}
            placeholder={t("routineFields.modelPlaceholder")}
            onClick={onOpenModelPalette}
            active={isModelPaletteOpen}
            size="default"
            style={SECTION_CONTROL_STYLE}
            prefix={
              draft.modelType ? (
                <ModelIcon agentType={draft.modelType} size={16} />
              ) : (
                <HugeiconsIcon
                  icon={GripIcon}
                  data-icon="grip"
                  size={16}
                  className="text-text-2"
                />
              )
            }
            dataTestId="routine-wizard-model-trigger"
            ariaLabel={t("routineFields.model")}
          />
        </SectionRow>
      </SectionContainer>
    </>
  );
};

export default RoutineExecutionSections;
