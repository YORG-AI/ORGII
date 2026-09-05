/**
 * The Hooks view of the Data Sources panel. Managed capture settings and recent
 * provenance signals remain independent so each table owns its async state.
 */
import React from "react";
import { useTranslation } from "react-i18next";

import { SECTION_GAP_CLASSES } from "@src/modules/shared/layouts/SectionLayout";

import { RuntimeSectionHeader } from "./RuntimeSectionHeader";
import HookPlatformsTable from "./SessionProvenanceHookPlatformsTable";
import RecentSignalsTable from "./SessionProvenanceRecentSignalsTable";

const SessionProvenanceHooksPanel: React.FC = () => {
  const { t } = useTranslation("integrations");

  return (
    <div
      className={SECTION_GAP_CLASSES}
      data-testid="session-provenance-hooks-panel"
    >
      <RuntimeSectionHeader
        title={t("agentOrgs.sessionProvenance.title")}
        className="-mx-4 bg-chat-pane px-4 pt-2 pb-1"
        dataTestId="session-provenance-hooks-title"
      />
      <HookPlatformsTable />
      <RecentSignalsTable />
    </div>
  );
};

export default SessionProvenanceHooksPanel;
