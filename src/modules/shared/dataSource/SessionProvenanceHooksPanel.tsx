/**
 * The Hooks view of the Data Sources panel. Managed capture settings and recent
 * provenance signals remain independent so each table owns its async state.
 */
import React from "react";
import { useTranslation } from "react-i18next";

import {
  SECTION_GAP_CLASSES,
  SECTION_SUBHEADING_CLASSES,
} from "@src/modules/shared/layouts/SectionLayout";

import HookPlatformsTable from "./SessionProvenanceHookPlatformsTable";
import RecentSignalsTable from "./SessionProvenanceRecentSignalsTable";

const SessionProvenanceHooksPanel: React.FC = () => {
  const { t } = useTranslation("integrations");

  return (
    <div
      className={SECTION_GAP_CLASSES}
      data-testid="session-provenance-hooks-panel"
    >
      <h3 className={SECTION_SUBHEADING_CLASSES}>
        {t("agentOrgs.sessionProvenance.title")}
      </h3>
      <HookPlatformsTable />
      <RecentSignalsTable />
    </div>
  );
};

export default SessionProvenanceHooksPanel;
