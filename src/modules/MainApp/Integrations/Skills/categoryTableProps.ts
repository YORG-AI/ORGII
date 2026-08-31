import type { ComponentProps } from "react";

import type { useExtensionsState } from "../hooks/useExtensionsState";
import type { AddAction } from "../types";
import type { SkillsTable } from "./Table/SkillsTable";

export type SkillsCategoryTableProps = ComponentProps<typeof SkillsTable>;

export function getSkillsCategoryTableProps(params: {
  extensions: Pick<
    ReturnType<typeof useExtensionsState>,
    "skillsHubRaw" | "handleExtensionSelect" | "skillsHub"
  >;
  onAddAction: (action: AddAction) => void;
}): SkillsCategoryTableProps {
  return {
    skills: params.extensions.skillsHubRaw.installedSkills,
    loading: params.extensions.skillsHubRaw.installedLoading,
    onSelect: params.extensions.handleExtensionSelect,
    onCreate: () => params.onAddAction("create-skill"),
    onToggleSkill: params.extensions.skillsHub.onToggleSkill,
    onUninstallSkill: params.extensions.skillsHub.onUninstallSkill,
    onRefreshSkills: params.extensions.skillsHub.onRefreshInstalled,
    onAfterImport: params.extensions.skillsHub.onRefreshInstalled,
  };
}
