import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import {
  ROUTINE_CATCH_UP_POLICY,
  ROUTINE_CONCURRENCY_POLICY,
  ROUTINE_OUTPUT_MODE,
  type RoutineCatchUpPolicy,
  type RoutineConcurrencyPolicy,
  type RoutineOutputMode,
} from "@src/api/http/project";
import Input from "@src/components/Input";
import Select from "@src/components/Select";
import Switch from "@src/components/Switch";
import {
  SECTION_CONTROL_STYLE,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";

import type {
  RoutineDraft,
  RoutineProjectOption,
  UpdateRoutineDraft,
} from "./routineDraft";

interface RoutineOutputSectionProps {
  draft: RoutineDraft;
  projects: RoutineProjectOption[];
  updateDraft: UpdateRoutineDraft;
}

const RoutineOutputSection: React.FC<RoutineOutputSectionProps> = ({
  draft,
  projects,
  updateDraft,
}) => {
  const { t } = useTranslation("integrations");

  const outputModeOptions = useMemo(
    () => [
      {
        value: ROUTINE_OUTPUT_MODE.DIRECT_SESSION,
        label: t("routineFields.outputDirectSession"),
        dataTestId: "routine-wizard-output-mode-option-direct_session",
      },
      {
        value: ROUTINE_OUTPUT_MODE.CREATE_WORK_ITEM,
        label: t("routineFields.outputCreateWorkItem"),
        dataTestId: "routine-wizard-output-mode-option-create_work_item",
      },
      {
        value: ROUTINE_OUTPUT_MODE.UPDATE_EXISTING_WORK_ITEM,
        label: t("routineFields.outputUpdateWorkItem"),
        dataTestId:
          "routine-wizard-output-mode-option-update_existing_work_item",
      },
    ],
    [t]
  );

  const concurrencyOptions = useMemo(
    () => [
      {
        value: ROUTINE_CONCURRENCY_POLICY.COALESCE_IF_ACTIVE,
        label: t("routineFields.concurrencyCoalesce"),
        dataTestId: "routine-wizard-concurrency-option-coalesce_if_active",
      },
      {
        value: ROUTINE_CONCURRENCY_POLICY.SKIP_IF_ACTIVE,
        label: t("routineFields.concurrencySkip"),
        dataTestId: "routine-wizard-concurrency-option-skip_if_active",
      },
      {
        value: ROUTINE_CONCURRENCY_POLICY.QUEUE_IF_ACTIVE,
        label: t("routineFields.concurrencyQueue"),
        dataTestId: "routine-wizard-concurrency-option-queue_if_active",
      },
      {
        value: ROUTINE_CONCURRENCY_POLICY.ALWAYS_CREATE,
        label: t("routineFields.concurrencyAlways"),
        dataTestId: "routine-wizard-concurrency-option-always_create",
      },
    ],
    [t]
  );

  const catchUpOptions = useMemo(
    () => [
      {
        value: ROUTINE_CATCH_UP_POLICY.SKIP_MISSED,
        label: t("routineFields.catchUpSkipMissed"),
        dataTestId: "routine-wizard-catch-up-option-skip_missed",
      },
      {
        value: ROUTINE_CATCH_UP_POLICY.RUN_ONCE,
        label: t("routineFields.catchUpRunOnce"),
        dataTestId: "routine-wizard-catch-up-option-run_once",
      },
      {
        value: ROUTINE_CATCH_UP_POLICY.RUN_ALL_LIMITED,
        label: t("routineFields.catchUpRunAll"),
        dataTestId: "routine-wizard-catch-up-option-run_all_limited",
      },
    ],
    [t]
  );

  const projectOptions = useMemo(
    () => [
      {
        value: "",
        label: t("routineFields.standaloneItem"),
        dataTestId: "routine-wizard-output-project-option-standalone",
      },
      ...projects.map((project) => ({
        value: project.slug,
        label: project.name,
        dataTestId: `routine-wizard-output-project-option-${project.slug}`,
      })),
    ],
    [projects, t]
  );

  const updateProjectOptions = useMemo(
    () =>
      projects.map((project) => ({
        value: project.slug,
        label: project.name,
        dataTestId: `routine-wizard-update-project-option-${project.slug}`,
      })),
    [projects]
  );

  return (
    <SectionContainer>
      <SectionRow label={t("routineFields.output")} required>
        <Select
          value={draft.outputMode}
          onChange={(value) =>
            updateDraft("outputMode", String(value) as RoutineOutputMode)
          }
          options={outputModeOptions}
          size="default"
          style={SECTION_CONTROL_STYLE}
          dataTestId="routine-wizard-output-mode-select"
        />
      </SectionRow>

      {draft.outputMode === ROUTINE_OUTPUT_MODE.CREATE_WORK_ITEM && (
        <>
          <SectionRow label={t("routineFields.project")} indent>
            <Select
              value={draft.createWorkItemProjectSlug}
              onChange={(value) =>
                updateDraft("createWorkItemProjectSlug", String(value))
              }
              options={projectOptions}
              size="default"
              style={SECTION_CONTROL_STYLE}
              dataTestId="routine-wizard-output-project-select"
            />
          </SectionRow>
          <SectionRow label={t("routineFields.autoStart")} indent>
            <Switch
              size="small"
              checked={draft.autoStart}
              onCheckedChange={(checked) => updateDraft("autoStart", checked)}
              dataTestId="routine-wizard-auto-start-switch"
            />
          </SectionRow>
        </>
      )}

      {draft.outputMode === ROUTINE_OUTPUT_MODE.UPDATE_EXISTING_WORK_ITEM && (
        <>
          <SectionRow label={t("routineFields.project")} required indent>
            <Select
              value={draft.updateWorkItemProjectSlug}
              onChange={(value) =>
                updateDraft("updateWorkItemProjectSlug", String(value))
              }
              options={updateProjectOptions}
              size="default"
              style={SECTION_CONTROL_STYLE}
              dataTestId="routine-wizard-update-project-select"
            />
          </SectionRow>
          <SectionRow label={t("routineFields.targetWorkItem")} required indent>
            <Input
              value={draft.updateWorkItemShortId}
              onChange={(value) => updateDraft("updateWorkItemShortId", value)}
              placeholder="ABC-0042"
              size="default"
              style={SECTION_CONTROL_STYLE}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              data-testid="routine-wizard-update-short-id-input"
            />
          </SectionRow>
        </>
      )}

      <SectionRow label={t("routineFields.concurrencyPolicy")}>
        <Select
          value={draft.concurrencyPolicy}
          onChange={(value) =>
            updateDraft(
              "concurrencyPolicy",
              String(value) as RoutineConcurrencyPolicy
            )
          }
          options={concurrencyOptions}
          size="default"
          style={SECTION_CONTROL_STYLE}
          dataTestId="routine-wizard-concurrency-select"
        />
      </SectionRow>

      <SectionRow label={t("routineFields.catchUpPolicy")}>
        <Select
          value={draft.catchUpPolicy}
          onChange={(value) =>
            updateDraft("catchUpPolicy", String(value) as RoutineCatchUpPolicy)
          }
          options={catchUpOptions}
          size="default"
          style={SECTION_CONTROL_STYLE}
          dataTestId="routine-wizard-catch-up-select"
        />
      </SectionRow>
    </SectionContainer>
  );
};

export default RoutineOutputSection;
