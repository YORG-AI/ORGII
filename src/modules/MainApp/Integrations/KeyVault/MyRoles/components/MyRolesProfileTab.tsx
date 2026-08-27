import { useSetAtom } from "jotai";
import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Input from "@src/components/Input";
import Select, { type SelectOption } from "@src/components/Select";
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
import { updateSettingAtom, useAllSettings } from "@src/store/settings";

import {
  DEFAULT_PROFILE_ID,
  type UserProfilePreset,
  emptyProfilePreset,
} from "../myRolesConstants";

export const MyRolesProfileTab: React.FC = () => {
  const { t } = useTranslation(["settings", "navigation"]);
  const settings = useAllSettings();
  const updateSetting = useSetAtom(updateSettingAtom);

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
            <Button variant="secondary" size="small" onClick={handleAddProfile}>
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
};
