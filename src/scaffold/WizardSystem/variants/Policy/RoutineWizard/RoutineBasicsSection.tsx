import { Network } from "lucide-react";
import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import Input from "@src/components/Input";
import Select from "@src/components/Select";
import Textarea from "@src/components/Textarea";
import TimePicker from "@src/components/TimePicker";
import { resolveAgentIcon } from "@src/config/agentIcons";
import { useTimezoneSelect } from "@src/hooks/geo/useTimezoneSelect";
import {
  type CronParts,
  type ScheduleFrequency,
  buildCron,
  parseCron,
} from "@src/modules/ProjectManager/WorkItems/components/ScheduleEditor/cronUtils";
import {
  SECTION_CONTROL_STYLE,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";

import SpotlightSelectTrigger from "./SpotlightSelectTrigger";
import type { RoutineDraft, UpdateRoutineDraft } from "./routineDraft";

interface RoutineBasicsSectionProps {
  draft: RoutineDraft;
  setDraft: React.Dispatch<React.SetStateAction<RoutineDraft>>;
  updateDraft: UpdateRoutineDraft;
  isAgentPaletteOpen: boolean;
  onOpenAgentPalette: () => void;
}

const RoutineBasicsSection: React.FC<RoutineBasicsSectionProps> = ({
  draft,
  setDraft,
  updateDraft,
  isAgentPaletteOpen,
  onOpenAgentPalette,
}) => {
  const { t } = useTranslation("integrations");
  const timezoneSelectProps = useTimezoneSelect({
    value: draft.timezone,
    onChange: (value) => updateDraft("timezone", value),
    excludeAuto: true,
    offsetPrefix: "UTC",
    style: SECTION_CONTROL_STYLE,
  });

  const triggerOptions = useMemo(
    () => [
      {
        value: "ONE_TIME",
        label: t("routineFields.oneTime"),
        dataTestId: "routine-wizard-trigger-option-one_time",
      },
      {
        value: "CRON",
        label: t("routineFields.cron"),
        dataTestId: "routine-wizard-trigger-option-cron",
      },
    ],
    [t]
  );

  // Cron builder state: derive the structured parts from the raw cron, the
  // same round-trip ScheduleEditor uses. Unparseable expressions fall back
  // to the raw text input (customCron).
  const cronParts = useMemo<CronParts>(() => {
    const parsed = draft.cron ? parseCron(draft.cron) : null;
    return parsed ?? { frequency: "daily", hour: 9, minute: 0 };
  }, [draft.cron]);

  const updateCronParts = useCallback(
    (next: CronParts) => {
      setDraft((current) => ({ ...current, cron: buildCron(next) }));
    },
    [setDraft]
  );

  const frequencyOptions = useMemo(
    () => [
      {
        value: "daily",
        label: t("common:schedule.freq.daily"),
        dataTestId: "routine-wizard-cron-frequency-option-daily",
      },
      {
        value: "weekday",
        label: t("common:schedule.freq.weekday"),
        dataTestId: "routine-wizard-cron-frequency-option-weekday",
      },
      {
        value: "weekly",
        label: t("common:schedule.freq.weekly"),
        dataTestId: "routine-wizard-cron-frequency-option-weekly",
      },
      {
        value: "monthly",
        label: t("common:schedule.freq.monthly"),
        dataTestId: "routine-wizard-cron-frequency-option-monthly",
      },
    ],
    [t]
  );

  const weekdayOptions = useMemo(
    () =>
      (["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const).map(
        (key, day) => ({
          value: day,
          label: t(`common:schedule.days.${key}`),
        })
      ),
    [t]
  );

  const monthDayOptions = useMemo(
    () =>
      Array.from({ length: 28 }, (_, index) => ({
        value: index + 1,
        label: String(index + 1),
      })),
    []
  );

  return (
    <>
      <SectionContainer>
        <SectionRow label={t("routineFields.name")} required>
          <Input
            value={draft.name}
            onChange={(value) => updateDraft("name", value)}
            placeholder={t("routineFields.namePlaceholder")}
            size="default"
            style={SECTION_CONTROL_STYLE}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            data-testid="routine-wizard-name-input"
          />
        </SectionRow>
      </SectionContainer>

      <SectionContainer>
        <SectionRow label={t("routineFields.trigger")} required>
          <Select
            value={draft.triggerKind}
            onChange={(value) => {
              const kind = String(value) as RoutineDraft["triggerKind"];
              setDraft((current) => ({
                ...current,
                triggerKind: kind,
                // Builder mode needs a concrete expression immediately,
                // otherwise canSave blocks on the empty string.
                cron:
                  kind === "CRON" && !current.cron
                    ? buildCron({ frequency: "daily", hour: 9, minute: 0 })
                    : current.cron,
              }));
            }}
            options={triggerOptions}
            size="default"
            style={SECTION_CONTROL_STYLE}
            dataTestId="routine-wizard-trigger-select"
          />
        </SectionRow>

        {draft.triggerKind === "ONE_TIME" ? (
          <SectionRow label={t("routineFields.runAt")} required>
            <Input
              value={draft.at}
              onChange={(value) => updateDraft("at", value)}
              placeholder="2026-05-07T09:00"
              size="default"
              style={SECTION_CONTROL_STYLE}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              data-testid="routine-wizard-run-at-input"
            />
          </SectionRow>
        ) : (
          <>
            {!draft.customCron && (
              <>
                <SectionRow
                  label={t("common:schedule.frequency")}
                  required
                  indent
                >
                  <Select
                    value={cronParts.frequency}
                    onChange={(value) =>
                      updateCronParts({
                        ...cronParts,
                        frequency: String(value) as ScheduleFrequency,
                      })
                    }
                    options={frequencyOptions}
                    size="default"
                    style={SECTION_CONTROL_STYLE}
                    dataTestId="routine-wizard-cron-frequency-select"
                  />
                </SectionRow>
                {cronParts.frequency === "weekly" && (
                  <SectionRow label={t("common:schedule.dayOfWeek")} indent>
                    <Select
                      value={cronParts.dayOfWeek ?? 1}
                      onChange={(value) =>
                        updateCronParts({
                          ...cronParts,
                          dayOfWeek: Number(value),
                        })
                      }
                      options={weekdayOptions}
                      size="default"
                      style={SECTION_CONTROL_STYLE}
                      dataTestId="routine-wizard-cron-weekday-select"
                    />
                  </SectionRow>
                )}
                {cronParts.frequency === "monthly" && (
                  <SectionRow label={t("common:schedule.dayOfMonth")} indent>
                    <Select
                      value={cronParts.dayOfMonth ?? 1}
                      onChange={(value) =>
                        updateCronParts({
                          ...cronParts,
                          dayOfMonth: Number(value),
                        })
                      }
                      options={monthDayOptions}
                      size="default"
                      style={SECTION_CONTROL_STYLE}
                      dataTestId="routine-wizard-cron-monthday-select"
                    />
                  </SectionRow>
                )}
                <SectionRow label={t("common:schedule.time")} indent>
                  <TimePicker
                    hour={cronParts.hour}
                    minute={cronParts.minute}
                    onChange={(hour, minute) =>
                      updateCronParts({ ...cronParts, hour, minute })
                    }
                    appearance="ghost"
                  />
                </SectionRow>
                <SectionRow label={t("common:common.timezone")} indent>
                  <Select
                    {...timezoneSelectProps}
                    dataTestId="routine-wizard-timezone-select"
                  />
                </SectionRow>
              </>
            )}
            {draft.customCron && (
              <>
                <SectionRow
                  label={t("routineFields.cronExpression")}
                  required
                  indent
                >
                  <Input
                    value={draft.cron}
                    onChange={(value) => updateDraft("cron", value)}
                    placeholder="0 9 * * 1"
                    size="default"
                    style={SECTION_CONTROL_STYLE}
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    data-testid="routine-wizard-cron-input"
                  />
                </SectionRow>
                <SectionRow label={t("common:common.timezone")} indent>
                  <Select
                    {...timezoneSelectProps}
                    dataTestId="routine-wizard-timezone-select"
                  />
                </SectionRow>
              </>
            )}
            <SectionRow label="" indent>
              <button
                type="button"
                className="text-[11px] text-primary-6 hover:underline"
                onClick={() => {
                  // Entering builder mode discards an unparseable custom cron
                  // because the builder always emits valid expressions.
                  setDraft((current) => ({
                    ...current,
                    customCron: !current.customCron,
                    cron: current.customCron
                      ? buildCron(cronParts)
                      : current.cron,
                  }));
                }}
                data-testid="routine-wizard-cron-toggle"
              >
                {draft.customCron
                  ? t("common:schedule.hideCustomCron")
                  : t("common:schedule.customCron")}
              </button>
            </SectionRow>
          </>
        )}
      </SectionContainer>

      <SectionContainer>
        <SectionRow label={t("routineFields.agentResponsible")} required>
          <SpotlightSelectTrigger
            value={draft.targetLabel || undefined}
            placeholder={t("routineFields.agentResponsiblePlaceholder")}
            onClick={onOpenAgentPalette}
            active={isAgentPaletteOpen}
            size="default"
            style={SECTION_CONTROL_STYLE}
            prefix={(() => {
              if (!draft.target) return null;
              if (draft.targetIsOrg) {
                return <Network size={16} className="text-text-2" />;
              }
              return React.createElement(resolveAgentIcon(draft.targetIconId), {
                size: 16,
                className: "text-text-2",
              });
            })()}
            dataTestId="routine-wizard-agent-trigger"
            ariaLabel={t("routineFields.agentResponsible")}
          />
        </SectionRow>
      </SectionContainer>

      <SectionContainer>
        <SectionRow
          label={t("routineFields.prompt")}
          required
          layout="vertical"
        >
          <Textarea
            value={draft.prompt}
            onChange={(value) => updateDraft("prompt", value)}
            autoSize={{ minRows: 4, maxRows: 8 }}
            placeholder={t("routineFields.promptPlaceholder")}
            data-testid="routine-wizard-prompt-input"
          />
        </SectionRow>
      </SectionContainer>
    </>
  );
};

export default RoutineBasicsSection;
