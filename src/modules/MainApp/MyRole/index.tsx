/**
 * My Role — page module.
 *
 * Rendered by the unified Settings surface for the route:
 *   /orgii/app/settings/my-role
 *
 * This page is where the user manages presence-mode guidance and adds
 * custom roles on top of the three built-ins (Online / Invisible /
 * Away). The active mode + its guidance string travel with every agent
 * turn via the ADE context payload (see `userPresenceWireAtom`).
 *
 * Sidebar navigation lives in `SettingsSidebar` under the My Role
 * drill-down. This module is a full-width detail panel and has no
 * sub-tabs — the single visible heading is "My Roles".
 */
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Circle, HatGlasses, Moon, Plus, Trash2 } from "lucide-react";
import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Input from "@src/components/Input";
import NumberInput from "@src/components/NumberInput";
import Select from "@src/components/Select";
import Switch from "@src/components/Switch";
import Textarea from "@src/components/Textarea";
import {
  SECTION_CONTROL_STYLE,
  SectionContainer,
  SectionHeading,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import {
  CUSTOM_ROLE_ICON_IDS,
  resolveCustomRoleIcon,
} from "@src/scaffold/NavigationSidebar/blocks/customRoleIcons";
import {
  settingsAtom,
  updateSettingAtom,
} from "@src/store/settings/settingsAtom";
import { userPresenceModeAtom } from "@src/store/user/userPresenceAtom";
import {
  generateRoleId,
  userCustomRolesAtom,
} from "@src/store/user/userRolesAtom";
import {
  BUILT_IN_PRESENCE_POLICY,
  type BuiltInPresenceMode,
  type CustomRoleDefinition,
  type CustomRoleIconId,
  PRESENCE_STANCE,
  type PresenceStance,
  USER_PRESENCE_MODE,
  buildCustomRoleMode,
} from "@src/types/userPresence";
import { confirmDestructiveAction } from "@src/util/dialogs/confirmDestructiveAction";

interface BuiltInRoleConfig {
  mode:
    | typeof USER_PRESENCE_MODE.ONLINE
    | typeof USER_PRESENCE_MODE.INVISIBLE
    | typeof USER_PRESENCE_MODE.AWAY;
  labelKey: string;
  settingsKey:
    | "general.presenceGuidanceOnline"
    | "general.presenceGuidanceInvisible"
    | "general.presenceGuidanceAway";
  icon: typeof Circle;
  colorClass: string;
}

const BUILT_IN_ROLES: BuiltInRoleConfig[] = [
  {
    mode: USER_PRESENCE_MODE.ONLINE,
    labelKey: "sidebar.presence.online",
    settingsKey: "general.presenceGuidanceOnline",
    icon: Circle,
    colorClass: "text-success-6",
  },
  {
    mode: USER_PRESENCE_MODE.INVISIBLE,
    labelKey: "sidebar.presence.invisible",
    settingsKey: "general.presenceGuidanceInvisible",
    icon: HatGlasses,
    colorClass: "text-text-3",
  },
  {
    mode: USER_PRESENCE_MODE.AWAY,
    labelKey: "sidebar.presence.away",
    settingsKey: "general.presenceGuidanceAway",
    icon: Moon,
    colorClass: "text-warning-6",
  },
];

const MyRolePage: React.FC = () => {
  const { t } = useTranslation("navigation");

  const [settings] = useAtom(settingsAtom);
  const updateSetting = useSetAtom(updateSettingAtom);
  const [customRoles, setCustomRoles] = useAtom(userCustomRolesAtom);
  const activeMode = useAtomValue(userPresenceModeAtom);

  const guidancePlaceholder = t("myRole.guidancePlaceholder", {
    defaultValue:
      "How should the agent adapt its behavior when this role is active?",
  });

  const handleBuiltInChange = useCallback(
    (key: BuiltInRoleConfig["settingsKey"]) => (value: string) => {
      updateSetting({ key, value });
    },
    [updateSetting]
  );

  const handleAddRole = useCallback(() => {
    const baseLabel = t("myRole.newRoleDefaultLabel", {
      defaultValue: "Custom role",
    });
    const taken = new Set(customRoles.map((role) => role.id));
    const id = generateRoleId(baseLabel, taken);
    const next: CustomRoleDefinition = {
      id,
      label: baseLabel,
      iconId: "sparkles",
      guidance: "",
      createdAtMs: Date.now(),
    };
    setCustomRoles((prev) => [...prev, next]);
  }, [customRoles, setCustomRoles, t]);

  const handleRoleChange = useCallback(
    (id: string, patch: Partial<CustomRoleDefinition>) => {
      setCustomRoles((prev) =>
        prev.map((role) => (role.id === id ? { ...role, ...patch } : role))
      );
    },
    [setCustomRoles]
  );

  const handleDeleteRole = useCallback(
    async (role: CustomRoleDefinition) => {
      const confirmed = await confirmDestructiveAction({
        title: t("myRole.deleteRoleTitle", {
          defaultValue: "Delete role?",
        }),
        message: t("myRole.deleteRoleMessage", {
          name: role.label,
          defaultValue: `"${role.label}" will be removed. This cannot be undone.`,
        }),
        okLabel: t("myRole.deleteRoleOk", { defaultValue: "Delete" }),
        cancelLabel: t("myRole.deleteRoleCancel", {
          defaultValue: "Cancel",
        }),
      });
      if (!confirmed) return;
      setCustomRoles((prev) =>
        prev.filter((existing) => existing.id !== role.id)
      );
    },
    [setCustomRoles, t]
  );

  const iconOptions = useMemo(
    () =>
      CUSTOM_ROLE_ICON_IDS.map((id) => {
        const IconComp = resolveCustomRoleIcon(id);
        return {
          value: id,
          label: (
            <span className="inline-flex items-center gap-2">
              <IconComp size={14} />
              <span className="capitalize">{id}</span>
            </span>
          ),
        };
      }),
    []
  );

  const stanceOptions = useMemo(
    () => [
      {
        value: PRESENCE_STANCE.INTERACTIVE,
        label: t("myRole.stanceInteractive", {
          defaultValue: "Interactive — ask me freely",
        }),
      },
      {
        value: PRESENCE_STANCE.DEFER_AND_BATCH,
        label: t("myRole.stanceDeferAndBatch", {
          defaultValue: "Defer & batch — work first, ask later",
        }),
      },
      {
        value: PRESENCE_STANCE.AUTONOMOUS,
        label: t("myRole.stanceAutonomous", {
          defaultValue: "Autonomous — never wait for me",
        }),
      },
    ],
    [t]
  );

  // Per-mode behavior policy editor shared by every role row: stance
  // selector + three 0=disabled numbers. The agent both reads the
  // guidance (prompt) and enforces the numbers (runtime).
  const renderPolicyEditor = useCallback(
    (
      values: {
        stance: PresenceStance;
        questionAutoResolveSecs: number;
        planAutoApproveSecs: number;
        modeSwitchAutoPlan: boolean;
        goalMaxTurns: number;
      },
      onChange: (patch: {
        stance?: PresenceStance;
        questionAutoResolveSecs?: number;
        planAutoApproveSecs?: number;
        modeSwitchAutoPlan?: boolean;
        goalMaxTurns?: number;
      }) => void,
      options?: { lockStance?: boolean }
    ) => (
      <>
        <SectionRow
          label={t("myRole.stanceLabel", { defaultValue: "Behavior stance" })}
          description={t("myRole.stanceDesc", {
            defaultValue:
              "How the agent treats blocking decisions while this role is active.",
          })}
        >
          <Select
            value={values.stance}
            onChange={(value) =>
              onChange({ stance: String(value) as PresenceStance })
            }
            options={stanceOptions}
            style={SECTION_CONTROL_STYLE}
            disabled={options?.lockStance}
          />
        </SectionRow>
        <SectionRow
          label={t("myRole.questionAutoSkipLabel", {
            defaultValue: "Question auto-skip",
          })}
          description={t("myRole.questionAutoSkipDesc", {
            defaultValue:
              "Auto-skip pending agent questions after N seconds (0 = wait for me).",
          })}
        >
          <NumberInput
            value={values.questionAutoResolveSecs}
            onChange={(value) =>
              value !== undefined &&
              onChange({ questionAutoResolveSecs: value })
            }
            min={0}
            max={300}
            step={5}
            controlsPosition="sides"
            style={SECTION_CONTROL_STYLE}
          />
        </SectionRow>
        <SectionRow
          label={t("myRole.planAutoApproveLabel", {
            defaultValue: "Plan auto-approve",
          })}
          description={t("myRole.planAutoApproveDesc", {
            defaultValue:
              "Auto-approve pending plans after N seconds (0 = wait for me).",
          })}
        >
          <NumberInput
            value={values.planAutoApproveSecs}
            onChange={(value) =>
              value !== undefined && onChange({ planAutoApproveSecs: value })
            }
            min={0}
            max={3600}
            step={10}
            controlsPosition="sides"
            style={SECTION_CONTROL_STYLE}
          />
        </SectionRow>
        <SectionRow
          label={t("myRole.modeSwitchAutoPlanLabel", {
            defaultValue: "Mode switch auto-plan",
          })}
          description={t("myRole.modeSwitchAutoPlanDesc", {
            defaultValue:
              "Auto-switch pending Plan mode suggestions when their confirmation timer expires.",
          })}
        >
          <Switch
            checked={values.modeSwitchAutoPlan}
            onChange={(checked) => onChange({ modeSwitchAutoPlan: checked })}
            ariaLabel={t("myRole.modeSwitchAutoPlanLabel", {
              defaultValue: "Mode switch auto-plan",
            })}
          />
        </SectionRow>
        <SectionRow
          label={t("myRole.goalMaxTurnsLabel", {
            defaultValue: "Goal continuation budget",
          })}
          description={t("myRole.goalMaxTurnsDesc", {
            defaultValue:
              "Keep working toward my last request for up to N extra turns after the agent would normally stop (0 = off).",
          })}
        >
          <NumberInput
            value={values.goalMaxTurns}
            onChange={(value) =>
              value !== undefined && onChange({ goalMaxTurns: value })
            }
            min={0}
            max={100}
            step={1}
            controlsPosition="sides"
            style={SECTION_CONTROL_STYLE}
          />
        </SectionRow>
      </>
    ),
    [t, stanceOptions]
  );

  const questionByPresence = settings[
    "agent.sde.questionAutoSkipTimeoutByPresence"
  ] as Record<BuiltInPresenceMode, number>;
  const planByPresence = settings[
    "agent.sde.planAutoApproveTimeoutByPresence"
  ] as Record<BuiltInPresenceMode, number>;
  const modeSwitchByPresence = settings[
    "agent.sde.modeSwitchAutoPlanByPresence"
  ] as Record<BuiltInPresenceMode, boolean>;
  const goalByPresence = settings["agent.sde.goalMaxTurnsByPresence"] as Record<
    BuiltInPresenceMode,
    number
  >;

  const handleBuiltInPolicyChange = useCallback(
    (mode: BuiltInPresenceMode) =>
      (patch: {
        stance?: PresenceStance;
        questionAutoResolveSecs?: number;
        planAutoApproveSecs?: number;
        modeSwitchAutoPlan?: boolean;
        goalMaxTurns?: number;
      }) => {
        // Built-in stances are fixed (they define the mode); only the
        // numbers are editable.
        if (patch.questionAutoResolveSecs !== undefined) {
          updateSetting({
            key: "agent.sde.questionAutoSkipTimeoutByPresence",
            value: {
              ...questionByPresence,
              [mode]: patch.questionAutoResolveSecs,
            },
          });
        }
        if (patch.planAutoApproveSecs !== undefined) {
          updateSetting({
            key: "agent.sde.planAutoApproveTimeoutByPresence",
            value: { ...planByPresence, [mode]: patch.planAutoApproveSecs },
          });
        }
        if (patch.modeSwitchAutoPlan !== undefined) {
          updateSetting({
            key: "agent.sde.modeSwitchAutoPlanByPresence",
            value: {
              ...modeSwitchByPresence,
              [mode]: patch.modeSwitchAutoPlan,
            },
          });
        }
        if (patch.goalMaxTurns !== undefined) {
          updateSetting({
            key: "agent.sde.goalMaxTurnsByPresence",
            value: { ...goalByPresence, [mode]: patch.goalMaxTurns },
          });
        }
      },
    [
      updateSetting,
      questionByPresence,
      planByPresence,
      modeSwitchByPresence,
      goalByPresence,
    ]
  );

  return (
    <div className="settings-page absolute inset-0 overflow-hidden rounded-page">
      <div className="custom-scrollbar h-full overflow-y-auto px-6 pb-8 pt-2">
        <SectionHeading
          title={t("myRole.pageTitle", { defaultValue: "My Roles" })}
        >
          <p className="text-[13px] leading-relaxed text-text-2">
            {t("myRole.pageDescription", {
              defaultValue:
                "Define the role you're playing right now. The agent reads the active role's guidance and adapts its behavior accordingly — for example, asking fewer clarifying questions when you're heads-down, or batching summaries when you're away.",
            })}
          </p>

          <SectionContainer
            title={t("myRole.builtInTitle", { defaultValue: "Built-in roles" })}
          >
            {BUILT_IN_ROLES.map((role) => {
              const RoleIcon = role.icon;
              const value =
                (settings[role.settingsKey] as string | undefined) ?? "";
              const isActive = role.mode === activeMode;
              return (
                <React.Fragment key={role.mode}>
                  <SectionRow
                    layout="vertical"
                    label={
                      <span className="inline-flex items-center gap-2">
                        <RoleIcon size={14} className={role.colorClass} />
                        <span>{t(role.labelKey)}</span>
                        {isActive && (
                          <span className="rounded-full bg-primary-1 px-2 py-[1px] text-[10px] font-medium text-primary-6">
                            {t("myRole.activeBadge", {
                              defaultValue: "Active",
                            })}
                          </span>
                        )}
                      </span>
                    }
                  >
                    <Textarea
                      value={value}
                      onChange={handleBuiltInChange(role.settingsKey)}
                      rows={3}
                      placeholder={guidancePlaceholder}
                    />
                  </SectionRow>
                  {renderPolicyEditor(
                    {
                      stance: BUILT_IN_PRESENCE_POLICY[role.mode].stance,
                      questionAutoResolveSecs:
                        questionByPresence[role.mode] ??
                        BUILT_IN_PRESENCE_POLICY[role.mode]
                          .questionAutoResolveSecs,
                      planAutoApproveSecs:
                        planByPresence[role.mode] ??
                        BUILT_IN_PRESENCE_POLICY[role.mode].planAutoApproveSecs,
                      modeSwitchAutoPlan:
                        modeSwitchByPresence[role.mode] ??
                        BUILT_IN_PRESENCE_POLICY[role.mode].modeSwitchAutoPlan,
                      goalMaxTurns:
                        goalByPresence[role.mode] ??
                        BUILT_IN_PRESENCE_POLICY[role.mode].goalMaxTurns,
                    },
                    handleBuiltInPolicyChange(role.mode),
                    { lockStance: true }
                  )}
                </React.Fragment>
              );
            })}
          </SectionContainer>

          <SectionContainer
            title={t("myRole.customTitle", { defaultValue: "Custom roles" })}
          >
            {customRoles.length === 0 ? (
              <div className="px-2 py-4 text-[13px] text-text-3">
                {t("myRole.customEmpty", {
                  defaultValue:
                    'No custom roles yet. Add one to capture a stance the built-in three don\'t cover — e.g. "Deep work", "Pairing", or "On call".',
                })}
              </div>
            ) : (
              customRoles.map((role) => {
                const RoleIcon = resolveCustomRoleIcon(role.iconId);
                const isActive = buildCustomRoleMode(role.id) === activeMode;
                return (
                  <div
                    key={role.id}
                    className="flex flex-col gap-3 border-t border-border-2 pt-3 first:border-t-0 first:pt-0"
                  >
                    <SectionRow
                      layout="vertical"
                      label={
                        <span className="inline-flex items-center gap-2">
                          <RoleIcon size={14} className="text-primary-6" />
                          <span>
                            {t("myRole.roleNameLabel", {
                              defaultValue: "Name",
                            })}
                          </span>
                          {isActive && (
                            <span className="rounded-full bg-primary-1 px-2 py-[1px] text-[10px] font-medium text-primary-6">
                              {t("myRole.activeBadge", {
                                defaultValue: "Active",
                              })}
                            </span>
                          )}
                        </span>
                      }
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <Input
                          value={role.label}
                          onChange={(value) =>
                            handleRoleChange(role.id, { label: value })
                          }
                          style={SECTION_CONTROL_STYLE}
                          placeholder={t("myRole.roleNamePlaceholder", {
                            defaultValue: "Role name",
                          })}
                        />
                        <Select
                          value={role.iconId}
                          onChange={(value) =>
                            handleRoleChange(role.id, {
                              iconId: value as CustomRoleIconId,
                            })
                          }
                          options={iconOptions}
                          style={{ width: 180 }}
                        />
                        <Button
                          variant="tertiary"
                          size="small"
                          iconOnly
                          icon={<Trash2 size={14} />}
                          onClick={() => void handleDeleteRole(role)}
                          aria-label={t("myRole.deleteRoleOk", {
                            defaultValue: "Delete",
                          })}
                          title={t("myRole.deleteRoleOk", {
                            defaultValue: "Delete",
                          })}
                        />
                      </div>
                    </SectionRow>
                    <SectionRow
                      layout="vertical"
                      label={t("myRole.guidanceLabel", {
                        defaultValue: "Agent guidance",
                      })}
                    >
                      <Textarea
                        value={role.guidance}
                        onChange={(value) =>
                          handleRoleChange(role.id, { guidance: value })
                        }
                        rows={3}
                        placeholder={guidancePlaceholder}
                      />
                    </SectionRow>
                    {renderPolicyEditor(
                      {
                        stance: role.stance ?? PRESENCE_STANCE.INTERACTIVE,
                        questionAutoResolveSecs:
                          role.questionAutoResolveSecs ?? 0,
                        planAutoApproveSecs: role.planAutoApproveSecs ?? 0,
                        modeSwitchAutoPlan: role.modeSwitchAutoPlan ?? false,
                        goalMaxTurns: role.goalMaxTurns ?? 0,
                      },
                      (patch) => handleRoleChange(role.id, patch)
                    )}
                  </div>
                );
              })
            )}
            <div className="flex pt-2">
              <Button
                variant="secondary"
                size="default"
                icon={<Plus size={14} />}
                onClick={handleAddRole}
              >
                {t("myRole.addRole", { defaultValue: "Add custom role" })}
              </Button>
            </div>
          </SectionContainer>
        </SectionHeading>
      </div>
    </div>
  );
};

export default MyRolePage;
