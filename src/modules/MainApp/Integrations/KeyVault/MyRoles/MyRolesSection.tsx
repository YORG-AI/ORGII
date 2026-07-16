import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Circle, HatGlasses, Moon } from "lucide-react";
import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Input from "@src/components/Input";
import NumberInput from "@src/components/NumberInput";
import Select, { type SelectOption } from "@src/components/Select";
import Switch from "@src/components/Switch";
import TagsInput from "@src/components/TagsInput";
import Textarea from "@src/components/Textarea";
import {
  FAMILIAR_LANGUAGE_TECH_STACKS,
  type FamiliarLanguageTechStack,
  TECH_SAVVY_LEVELS,
  type UserTechSavvySelection,
} from "@src/config/profile/userProfile";
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

export const MY_ROLES_TAB = {
  PRESENCE: "presence",
  PROFILE: "profile",
} as const;

export type MyRolesTab = (typeof MY_ROLES_TAB)[keyof typeof MY_ROLES_TAB];

type PresenceGuidanceKey =
  | "general.presenceGuidanceOnline"
  | "general.presenceGuidanceInvisible"
  | "general.presenceGuidanceAway";

const PRESENCE_GUIDANCE_DEFAULT_VALUES: Record<PresenceGuidanceKey, string[]> =
  {
    "general.presenceGuidanceOnline": [
      "I am at the keyboard. Feel free to ask me clarifying questions at any time and confirm any destructive actions with me before running them.",
      "I am at the keyboard. Feel free to ask me clarifying questions at any time and confirm any destructive actions with me before running them",
    ],
    "general.presenceGuidanceInvisible": [
      "I am around but appearing offline. Default to autonomous execution and only notify me for high-risk actions or significant refactoring work; batch any other questions into a single summary instead of asking one by one.",
      "I am around but appearing offline. Default to autonomous execution and only notify me for high-risk actions or significant refactoring work; batch any other questions into a single summary instead of asking one by one",
    ],
    "general.presenceGuidanceAway": [
      "I am away from the keyboard. Do not block on me — make the best decision you can with the information you have, finish what you can finish, and leave a concise summary of what happened and any open questions for when I return.",
      "I am away from the keyboard. Do not block on me — make the best decision you can with the information you have, finish what you can finish, and leave a concise summary of what happened and any open questions for when I return",
    ],
  };

const PRESENCE_GUIDANCE_DEFAULT_I18N_KEYS: Record<PresenceGuidanceKey, string> =
  {
    "general.presenceGuidanceOnline": "general.presenceGuidanceOnlineDefault",
    "general.presenceGuidanceInvisible":
      "general.presenceGuidanceInvisibleDefault",
    "general.presenceGuidanceAway": "general.presenceGuidanceAwayDefault",
  };

interface MyRolesSectionProps {
  activeTab?: MyRolesTab;
}

const CUSTOM_ROLE_COLOR_CLASS = "text-primary-6";
const DEFAULT_PROFILE_ID = "default";

interface UserProfilePreset {
  id: string;
  name: string;
  techSavvy: UserTechSavvySelection;
  jobRoles: string[];
  familiarTechStacks: FamiliarLanguageTechStack[];
  description: string;
}

const emptyProfilePreset = (name: string): UserProfilePreset => ({
  id: `profile-${Date.now()}`,
  name,
  techSavvy: "",
  jobRoles: [],
  familiarTechStacks: [],
  description: "",
});

const BUILT_IN_STATUS_OPTIONS = [
  {
    mode: USER_PRESENCE_MODE.ONLINE,
    labelKey: "sidebar.presence.online",
    icon: Circle,
    colorClass: "text-success-6",
  },
  {
    mode: USER_PRESENCE_MODE.INVISIBLE,
    labelKey: "sidebar.presence.invisible",
    icon: HatGlasses,
    colorClass: "text-text-3",
  },
  {
    mode: USER_PRESENCE_MODE.AWAY,
    labelKey: "sidebar.presence.away",
    icon: Moon,
    colorClass: "text-warning-6",
  },
] as const;

const MyRolesSection: React.FC<MyRolesSectionProps> = ({
  activeTab = MY_ROLES_TAB.PRESENCE,
}) => {
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
      const StatusIcon = option.icon;
      return {
        value: option.mode,
        label: (
          <span className="inline-flex items-center gap-2">
            <StatusIcon size={14} className={option.colorClass} />
            <span>{t(option.labelKey, { ns: "navigation" })}</span>
          </span>
        ),
        triggerLabel: t(option.labelKey, { ns: "navigation" }),
      };
    });

    const customOptions = customRoles.map((role) => {
      const RoleIcon = resolveCustomRoleIcon(role.iconId);
      const mode = buildCustomRoleMode(role.id);
      return {
        value: mode,
        label: (
          <span className="inline-flex items-center gap-2">
            <RoleIcon size={14} className={CUSTOM_ROLE_COLOR_CLASS} />
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
            onChange={handleQuestionAutoSkipTimeoutChange(mode)}
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
            onChange={handlePlanAutoApproveTimeoutChange(mode)}
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
            onChange={handleGoalMaxTurnsChange(mode)}
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
            onChange={handleModeSwitchAutoPlanChange(mode)}
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

  const activeProfileId =
    (settings["general.activeProfileId"] as string | undefined) ??
    DEFAULT_PROFILE_ID;
  const profilePresets = useMemo(
    () => (settings["general.profilePresets"] ?? []) as UserProfilePreset[],
    [settings]
  );
  const activeProfilePreset = profilePresets.find(
    (profile) => profile.id === activeProfileId
  );
  const editingDefaultProfile = activeProfileId === DEFAULT_PROFILE_ID;
  const techSavvy = editingDefaultProfile
    ? (settings["general.profileTechSavvy"] as UserTechSavvySelection)
    : (activeProfilePreset?.techSavvy ?? "");
  const jobRoles = editingDefaultProfile
    ? (settings["general.profileJobRoles"] as string[])
    : (activeProfilePreset?.jobRoles ?? []);
  const familiarTechStacks = editingDefaultProfile
    ? (settings[
        "general.profileFamiliarTechStacks"
      ] as FamiliarLanguageTechStack[])
    : (activeProfilePreset?.familiarTechStacks ?? []);
  const profileDescription = editingDefaultProfile
    ? (settings["general.profileDescription"] as string)
    : (activeProfilePreset?.description ?? "");

  const techSavvyOptions = useMemo<SelectOption[]>(
    () =>
      TECH_SAVVY_LEVELS.map((level) => ({
        value: level,
        label: t(`myRoles.profile.techSavvyLevels.${level}`),
      })),
    [t]
  );

  const familiarTechStackOptions = useMemo<SelectOption[]>(
    () =>
      FAMILIAR_LANGUAGE_TECH_STACKS.map((stack) => ({
        value: stack,
        label: stack,
      })),
    []
  );

  const updateProfilePreset = useCallback(
    (id: string, patch: Partial<UserProfilePreset>) => {
      updateSetting({
        key: "general.profilePresets",
        value: profilePresets.map((profile) =>
          profile.id === id ? { ...profile, ...patch } : profile
        ),
      });
    },
    [profilePresets, updateSetting]
  );

  const updateActiveProfile = useCallback(
    (patch: Partial<UserProfilePreset>) => {
      if (editingDefaultProfile) {
        if (patch.techSavvy !== undefined) {
          updateSetting({
            key: "general.profileTechSavvy",
            value: patch.techSavvy,
          });
        }
        if (patch.jobRoles !== undefined) {
          updateSetting({
            key: "general.profileJobRoles",
            value: patch.jobRoles,
          });
        }
        if (patch.familiarTechStacks !== undefined) {
          updateSetting({
            key: "general.profileFamiliarTechStacks",
            value: patch.familiarTechStacks,
          });
        }
        if (patch.description !== undefined) {
          updateSetting({
            key: "general.profileDescription",
            value: patch.description,
          });
        }
        return;
      }
      updateProfilePreset(activeProfileId, patch);
    },
    [activeProfileId, editingDefaultProfile, updateProfilePreset, updateSetting]
  );

  const profileOptions = useMemo<SelectOption[]>(
    () => [
      {
        value: DEFAULT_PROFILE_ID,
        label: t("myRoles.profile.defaultProfile", {
          defaultValue: "Default profile",
        }),
      },
      ...profilePresets.map((profile) => ({
        value: profile.id,
        label: profile.name,
      })),
    ],
    [profilePresets, t]
  );

  const handleActiveProfileChange = useCallback(
    (value: string | number | (string | number)[]) => {
      if (Array.isArray(value)) return;
      updateSetting({ key: "general.activeProfileId", value: String(value) });
    },
    [updateSetting]
  );

  const handleAddProfile = useCallback(() => {
    const name = t("myRoles.profile.newProfileName", {
      defaultValue: "New profile",
    });
    const profile = emptyProfilePreset(name);
    updateSetting({
      key: "general.profilePresets",
      value: [...profilePresets, profile],
    });
    updateSetting({ key: "general.activeProfileId", value: profile.id });
  }, [profilePresets, t, updateSetting]);

  const handleDeleteProfile = useCallback(() => {
    if (editingDefaultProfile) return;
    updateSetting({
      key: "general.profilePresets",
      value: profilePresets.filter((profile) => profile.id !== activeProfileId),
    });
    updateSetting({
      key: "general.activeProfileId",
      value: DEFAULT_PROFILE_ID,
    });
  }, [activeProfileId, editingDefaultProfile, profilePresets, updateSetting]);

  const handleProfileNameChange = useCallback(
    (value: string) => {
      if (editingDefaultProfile) return;
      updateProfilePreset(activeProfileId, { name: value });
    },
    [activeProfileId, editingDefaultProfile, updateProfilePreset]
  );

  const handleTechSavvyChange = useCallback(
    (value: string | number | (string | number)[]) => {
      if (Array.isArray(value)) return;
      updateActiveProfile({
        techSavvy: String(value) as UserTechSavvySelection,
      });
    },
    [updateActiveProfile]
  );

  const handleJobRolesChange = useCallback(
    (next: string[]) => {
      updateActiveProfile({ jobRoles: next });
    },
    [updateActiveProfile]
  );

  const handleFamiliarTechStacksChange = useCallback(
    (value: string | number | (string | number)[]) => {
      if (!Array.isArray(value)) return;
      updateActiveProfile({
        familiarTechStacks: value.map(String) as FamiliarLanguageTechStack[],
      });
    },
    [updateActiveProfile]
  );

  const handleProfileDescriptionChange = useCallback(
    (value: string) => {
      updateActiveProfile({ description: value });
    },
    [updateActiveProfile]
  );

  const removeJobRoleAriaLabel = useCallback(
    (role: string) => t("myRoles.profile.removeJobRole", { role }),
    [t]
  );

  if (activeTab === MY_ROLES_TAB.PROFILE) {
    return (
      <div className="flex flex-col gap-3">
        <SectionContainer>
          <SectionRow
            label={t("myRoles.profile.activeProfile", {
              defaultValue: "Active profile",
            })}
            description={t("myRoles.profile.activeProfileDescription", {
              defaultValue:
                "Choose which profile is sent to agents. Switching is manual and under your control.",
            })}
          >
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={activeProfileId}
                onChange={handleActiveProfileChange}
                options={profileOptions}
                style={SECTION_CONTROL_STYLE}
              />
              <Button
                variant="secondary"
                size="small"
                onClick={handleAddProfile}
              >
                {t("myRoles.profile.addProfile", {
                  defaultValue: "Add profile",
                })}
              </Button>
              {!editingDefaultProfile && (
                <Button
                  variant="tertiary"
                  size="small"
                  onClick={handleDeleteProfile}
                >
                  {t("common:actions.delete", { defaultValue: "Delete" })}
                </Button>
              )}
            </div>
          </SectionRow>
          {!editingDefaultProfile && (
            <SectionRow
              label={t("myRoles.profile.profileName", {
                defaultValue: "Profile name",
              })}
            >
              <Input
                value={activeProfilePreset?.name ?? ""}
                onChange={handleProfileNameChange}
                style={SECTION_CONTROL_STYLE}
              />
            </SectionRow>
          )}
          <SectionRow
            label={t("myRoles.profile.techSavvy")}
            description={t("myRoles.profile.techSavvyDescription")}
          >
            <Select
              value={techSavvy}
              onChange={handleTechSavvyChange}
              options={techSavvyOptions}
              placeholder={t("myRoles.profile.techSavvyPlaceholder")}
              allowClear
              style={SECTION_CONTROL_STYLE}
            />
          </SectionRow>
          <SectionRow
            label={t("myRoles.profile.jobRoles")}
            description={t("myRoles.profile.jobRolesDescription")}
            layout="vertical"
          >
            <TagsInput
              value={jobRoles}
              onChange={handleJobRolesChange}
              placeholder={t("myRoles.profile.jobRolesPlaceholder")}
              removeAriaLabel={removeJobRoleAriaLabel}
            />
          </SectionRow>
          <SectionRow
            label={t("myRoles.profile.familiarTechStacks")}
            description={t("myRoles.profile.familiarTechStacksDescription")}
            layout="vertical"
          >
            <Select
              value={familiarTechStacks}
              onChange={handleFamiliarTechStacksChange}
              options={familiarTechStackOptions}
              placeholder={t("myRoles.profile.familiarTechStacksPlaceholder")}
              mode="multiple"
              showSearch
              allowClear
              maxTagCount={4}
              dropdownWidthMode="match"
            />
          </SectionRow>
          <SectionRow
            label={t("myRoles.profile.description")}
            description={t("myRoles.profile.descriptionHelp")}
            layout="vertical"
          >
            <Textarea
              value={profileDescription}
              onChange={handleProfileDescriptionChange}
              rows={4}
              placeholder={t("myRoles.profile.descriptionPlaceholder")}
            />
          </SectionRow>
        </SectionContainer>
      </div>
    );
  }

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

export default MyRolesSection;
