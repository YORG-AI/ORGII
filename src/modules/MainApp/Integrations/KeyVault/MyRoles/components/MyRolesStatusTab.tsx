import { useAtom, useAtomValue, useSetAtom } from "jotai";
import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import AnyIcon from "@src/components/AnyIcon";
import NumberInput from "@src/components/NumberInput";
import Select, { type SelectOption } from "@src/components/Select";
import Switch from "@src/components/Switch";
import Textarea from "@src/components/Textarea";
import {
  SECTION_CONTROL_STYLE,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import { resolveCustomRoleIcon } from "@src/scaffold/NavigationSidebar/blocks/customRoleIcons";
import { updateSettingAtom, useAllSettings } from "@src/store/settings";
import { userPresenceAtom } from "@src/store/user/userPresenceAtom";
import { userCustomRolesAtom } from "@src/store/user/userRolesAtom";
import {
  AWAY_DURATIONS,
  type BuiltInPresenceMode,
  USER_PRESENCE_MODE,
  type UserPresenceMode,
  buildCustomRoleMode,
  computeBackAtMs,
} from "@src/types/userPresence";

import {
  BUILT_IN_STATUS_OPTIONS,
  CUSTOM_ROLE_COLOR_CLASS,
  PRESENCE_GUIDANCE_DEFAULT_I18N_KEYS,
  PRESENCE_GUIDANCE_DEFAULT_VALUES,
  type PresenceGuidanceKey,
} from "../myRolesConstants";

export const MyRolesStatusTab: React.FC = () => {
  const { t } = useTranslation(["settings", "navigation"]);
  const settings = useAllSettings();
  const updateSetting = useSetAtom(updateSettingAtom);
  const [presence, setPresence] = useAtom(userPresenceAtom);
  const customRoles = useAtomValue(userCustomRolesAtom);

  const questionAutoSkipTimeoutByPresence = settings[
    "agent.sde.questionAutoSkipTimeoutByPresence"
  ] as Record<BuiltInPresenceMode, number>;
  const planAutoApproveTimeoutByPresence = settings[
    "agent.sde.planAutoApproveTimeoutByPresence"
  ] as Record<BuiltInPresenceMode, number>;
  const goalMaxTurnsByPresence = settings[
    "agent.sde.goalMaxTurnsByPresence"
  ] as Record<BuiltInPresenceMode, number>;
  const modeSwitchAutoPlanByPresence = settings[
    "agent.sde.modeSwitchAutoPlanByPresence"
  ] as Record<BuiltInPresenceMode, boolean>;
  const presenceGuidanceOnline =
    (settings["general.presenceGuidanceOnline"] as string | undefined) ?? "";
  const presenceGuidanceInvisible =
    (settings["general.presenceGuidanceInvisible"] as string | undefined) ?? "";
  const presenceGuidanceAway =
    (settings["general.presenceGuidanceAway"] as string | undefined) ?? "";

  const getPresenceGuidanceDisplayValue = useCallback(
    (key: PresenceGuidanceKey, value: string) => {
      if (PRESENCE_GUIDANCE_DEFAULT_VALUES[key].includes(value)) {
        return t(PRESENCE_GUIDANCE_DEFAULT_I18N_KEYS[key]);
      }
      return value;
    },
    [t]
  );

  const statusOptions = useMemo<SelectOption[]>(() => {
    const builtInOptions = BUILT_IN_STATUS_OPTIONS.map((option) => {
      const icon = option.icon;
      return {
        value: option.mode,
        label: (
          <span className="inline-flex items-center gap-2">
            <AnyIcon icon={icon} size={14} className={option.colorClass} />
            <span>{t(option.labelKey, { ns: "navigation" })}</span>
          </span>
        ),
        triggerLabel: t(option.labelKey, { ns: "navigation" }),
      };
    });

    const customOptions = customRoles.map((role) => {
      const icon = resolveCustomRoleIcon(role.iconId);
      const mode = buildCustomRoleMode(role.id);
      return {
        value: mode,
        label: (
          <span className="inline-flex items-center gap-2">
            <AnyIcon
              icon={icon}
              size={14}
              className={CUSTOM_ROLE_COLOR_CLASS}
            />
            <span>{role.label}</span>
          </span>
        ),
        triggerLabel: role.label,
      };
    });

    return [...builtInOptions, ...customOptions];
  }, [customRoles, t]);

  const handleStatusChange = useCallback(
    (value: string | number | (string | number)[]) => {
      if (Array.isArray(value)) return;
      const nextMode = String(value) as UserPresenceMode;
      if (nextMode === USER_PRESENCE_MODE.AWAY) {
        const fallbackDuration = AWAY_DURATIONS[1];
        setPresence({
          mode: nextMode,
          backAtMs: computeBackAtMs(fallbackDuration.id),
          awayDurationLabel: fallbackDuration.id,
        });
        return;
      }
      setPresence({
        mode: nextMode,
        backAtMs: undefined,
        awayDurationLabel: undefined,
      });
    },
    [setPresence]
  );

  const handlePresenceGuidanceChange = useCallback(
    (key: PresenceGuidanceKey) => (value: string) => {
      updateSetting({ key, value });
    },
    [updateSetting]
  );

  const handleQuestionAutoSkipTimeoutChange = useCallback(
    (mode: BuiltInPresenceMode) => (value: number | undefined) => {
      if (value === undefined) return;
      updateSetting({
        key: "agent.sde.questionAutoSkipTimeoutByPresence",
        value: {
          ...questionAutoSkipTimeoutByPresence,
          [mode]: value,
        },
      });
    },
    [questionAutoSkipTimeoutByPresence, updateSetting]
  );

  const handlePlanAutoApproveTimeoutChange = useCallback(
    (mode: BuiltInPresenceMode) => (value: number | undefined) => {
      if (value === undefined) return;
      updateSetting({
        key: "agent.sde.planAutoApproveTimeoutByPresence",
        value: {
          ...planAutoApproveTimeoutByPresence,
          [mode]: value,
        },
      });
    },
    [planAutoApproveTimeoutByPresence, updateSetting]
  );

  const handleGoalMaxTurnsChange = useCallback(
    (mode: BuiltInPresenceMode) => (value: number | undefined) => {
      if (value === undefined) return;
      updateSetting({
        key: "agent.sde.goalMaxTurnsByPresence",
        value: {
          ...goalMaxTurnsByPresence,
          [mode]: value,
        },
      });
    },
    [goalMaxTurnsByPresence, updateSetting]
  );

  const handleModeSwitchAutoPlanChange = useCallback(
    (mode: BuiltInPresenceMode) => (checked: boolean) => {
      updateSetting({
        key: "agent.sde.modeSwitchAutoPlanByPresence",
        value: {
          ...modeSwitchAutoPlanByPresence,
          [mode]: checked,
        },
      });
    },
    [modeSwitchAutoPlanByPresence, updateSetting]
  );

  const renderPolicyRows = useCallback(
    (mode: BuiltInPresenceMode, statusLabel: string) => (
      <>
        <SectionRow
          label={t("sdeAgent.questionAutoSkipTimeoutByStatus", {
            status: statusLabel,
          })}
          description={t("sdeAgent.questionAutoSkipTimeoutByStatusDesc")}
        >
          <NumberInput
            value={questionAutoSkipTimeoutByPresence[mode]}
            onValueChange={handleQuestionAutoSkipTimeoutChange(mode)}
            min={0}
            max={300}
            step={5}
            suffix={t("common:common.s")}
            controlsPosition="sides"
            style={SECTION_CONTROL_STYLE}
          />
        </SectionRow>
        <SectionRow
          label={t("sdeAgent.planAutoApproveTimeoutByStatus", {
            status: statusLabel,
            defaultValue: `${statusLabel} plan auto-approve`,
          })}
          description={t("sdeAgent.planAutoApproveTimeoutByStatusDesc", {
            defaultValue:
              "Auto-approve a pending plan after this many seconds in this status (0 = disabled)",
          })}
        >
          <NumberInput
            value={planAutoApproveTimeoutByPresence[mode]}
            onValueChange={handlePlanAutoApproveTimeoutChange(mode)}
            min={0}
            max={3600}
            step={10}
            suffix={t("common:common.s")}
            controlsPosition="sides"
            style={SECTION_CONTROL_STYLE}
          />
        </SectionRow>
        <SectionRow
          label={t("sdeAgent.goalMaxTurnsByStatus", {
            status: statusLabel,
            defaultValue: `${statusLabel} goal continuation budget`,
          })}
          description={t("sdeAgent.goalMaxTurnsByStatusDesc", {
            defaultValue:
              "Keep working toward your last request for up to this many extra turns after the agent would normally stop (0 = disabled)",
          })}
        >
          <NumberInput
            value={goalMaxTurnsByPresence[mode]}
            onValueChange={handleGoalMaxTurnsChange(mode)}
            min={0}
            max={100}
            step={1}
            controlsPosition="sides"
            style={SECTION_CONTROL_STYLE}
          />
        </SectionRow>
        <SectionRow
          label={t("sdeAgent.modeSwitchAutoPlanByStatus", {
            status: statusLabel,
            defaultValue: `${statusLabel} mode switch auto-plan`,
          })}
          description={t("sdeAgent.modeSwitchAutoPlanByStatusDesc", {
            defaultValue:
              "Auto-switch pending Plan mode suggestions when their confirmation timer expires",
          })}
        >
          <Switch
            checked={modeSwitchAutoPlanByPresence[mode]}
            onCheckedChange={handleModeSwitchAutoPlanChange(mode)}
            ariaLabel={t("sdeAgent.modeSwitchAutoPlanByStatus", {
              status: statusLabel,
              defaultValue: `${statusLabel} mode switch auto-plan`,
            })}
          />
        </SectionRow>
      </>
    ),
    [
      t,
      questionAutoSkipTimeoutByPresence,
      planAutoApproveTimeoutByPresence,
      goalMaxTurnsByPresence,
      modeSwitchAutoPlanByPresence,
      handleQuestionAutoSkipTimeoutChange,
      handlePlanAutoApproveTimeoutChange,
      handleGoalMaxTurnsChange,
      handleModeSwitchAutoPlanChange,
    ]
  );

  return (
    <div className="flex flex-col gap-3">
      <SectionContainer>
        <SectionRow label={t("myRoles.currentStatus")}>
          <Select
            value={presence.mode}
            onChange={handleStatusChange}
            options={statusOptions}
            style={SECTION_CONTROL_STYLE}
          />
        </SectionRow>
      </SectionContainer>

      <SectionContainer title={t("navigation:sidebar.presence.online")}>
        <SectionRow
          label={t("myRoles.presence.instructionForAgent")}
          layout="vertical"
        >
          <Textarea
            value={getPresenceGuidanceDisplayValue(
              "general.presenceGuidanceOnline",
              presenceGuidanceOnline
            )}
            onChange={handlePresenceGuidanceChange(
              "general.presenceGuidanceOnline"
            )}
            rows={3}
            placeholder={t("general.presenceGuidancePlaceholder")}
          />
        </SectionRow>
        {renderPolicyRows(
          USER_PRESENCE_MODE.ONLINE,
          t("navigation:sidebar.presence.online")
        )}
      </SectionContainer>

      <SectionContainer title={t("navigation:sidebar.presence.invisible")}>
        <SectionRow
          label={t("myRoles.presence.instructionForAgent")}
          layout="vertical"
        >
          <Textarea
            value={getPresenceGuidanceDisplayValue(
              "general.presenceGuidanceInvisible",
              presenceGuidanceInvisible
            )}
            onChange={handlePresenceGuidanceChange(
              "general.presenceGuidanceInvisible"
            )}
            rows={3}
            placeholder={t("general.presenceGuidancePlaceholder")}
          />
        </SectionRow>
        {renderPolicyRows(
          USER_PRESENCE_MODE.INVISIBLE,
          t("navigation:sidebar.presence.invisible")
        )}
      </SectionContainer>

      <SectionContainer title={t("navigation:sidebar.presence.away")}>
        <SectionRow
          label={t("myRoles.presence.instructionForAgent")}
          layout="vertical"
        >
          <Textarea
            value={getPresenceGuidanceDisplayValue(
              "general.presenceGuidanceAway",
              presenceGuidanceAway
            )}
            onChange={handlePresenceGuidanceChange(
              "general.presenceGuidanceAway"
            )}
            rows={3}
            placeholder={t("general.presenceGuidancePlaceholder")}
          />
        </SectionRow>
        {renderPolicyRows(
          USER_PRESENCE_MODE.AWAY,
          t("navigation:sidebar.presence.away")
        )}
      </SectionContainer>
    </div>
  );
};
