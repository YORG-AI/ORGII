/**
 * Renders work-items search control on the Workstation tab bar when the
 * active tab is a Projects/work-items surface that registered via
 * `projectManagerWorkItemsTabBarAtom`.
 */
import { useAtomValue } from "jotai";
import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import { TabBarTrailingIconButton } from "@src/components/TabPill/TabBarTrailingIconButton";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import { HugeiconsIcon, Search01Icon } from "@src/icons";
import { projectManagerWorkItemsTabBarAtom } from "@src/modules/ProjectManager/store/projectManagerWorkItemsTabBarAtom";

export interface ProjectManagerWorkItemsTabBarTrailingProps {
  activeTabId: string | null;
  onAddProject?: () => void;
}

const ProjectManagerWorkItemsTabBarTrailing: React.FC<ProjectManagerWorkItemsTabBarTrailingProps> =
  memo(({ activeTabId }) => {
    const { t } = useTranslation("projects");
    const payload = useAtomValue(projectManagerWorkItemsTabBarAtom);

    if (!payload || !activeTabId || payload.workStationTabId !== activeTabId) {
      return null;
    }

    if (!payload.onSearch) return null;

    return (
      <TabBarTrailingIconButton
        title={t("common:actions.search")}
        onClick={payload.onSearch}
      >
        <HugeiconsIcon
          icon={Search01Icon}
          data-icon="search"
          size={HEADER_ICON_SIZE.md}
          strokeWidth={2}
        />
      </TabBarTrailingIconButton>
    );
  });

ProjectManagerWorkItemsTabBarTrailing.displayName =
  "ProjectManagerWorkItemsTabBarTrailing";

export default ProjectManagerWorkItemsTabBarTrailing;
