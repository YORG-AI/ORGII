import { useSetAtom } from "jotai";
import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

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

export const MyRolesProfileTab: React.FC = () => {
  const { t } = useTranslation("settings");
  const settings = useAllSettings();
  const updateSetting = useSetAtom(updateSettingAtom);

  const techSavvy = settings[
    "general.profileTechSavvy"
  ] as UserTechSavvySelection;
  const jobRoles = settings["general.profileJobRoles"] as string[];
  const familiarTechStacks = settings[
    "general.profileFamiliarTechStacks"
  ] as FamiliarLanguageTechStack[];
  const profileDescription = settings["general.profileDescription"] as string;

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

  const handleTechSavvyChange = useCallback(
    (value: string | number | (string | number)[]) => {
      if (Array.isArray(value)) return;
      updateSetting({
        key: "general.profileTechSavvy",
        value: String(value) as UserTechSavvySelection,
      });
    },
    [updateSetting]
  );

  const handleJobRolesChange = useCallback(
    (next: string[]) => {
      updateSetting({ key: "general.profileJobRoles", value: next });
    },
    [updateSetting]
  );

  const handleFamiliarTechStacksChange = useCallback(
    (value: string | number | (string | number)[]) => {
      if (!Array.isArray(value)) return;
      updateSetting({
        key: "general.profileFamiliarTechStacks",
        value: value.map(String) as FamiliarLanguageTechStack[],
      });
    },
    [updateSetting]
  );

  const handleProfileDescriptionChange = useCallback(
    (value: string) => {
      updateSetting({ key: "general.profileDescription", value });
    },
    [updateSetting]
  );

  const removeJobRoleAriaLabel = useCallback(
    (role: string) => t("myRoles.profile.removeJobRole", { role }),
    [t]
  );

  return (
    <div className="flex flex-col gap-3">
      <SectionContainer>
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
