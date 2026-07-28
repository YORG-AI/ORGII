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

interface SessionProvenanceHooksPanelProps {
  showTitle?: boolean;
}

const SessionProvenanceHooksPanel: React.FC<
  SessionProvenanceHooksPanelProps
> = ({ showTitle = true }) => {
  const { t } = useTranslation("integrations");

  return (
    <div
      className={SECTION_GAP_CLASSES}
      data-testid="session-provenance-hooks-panel"
    >
      {showTitle ? (
        <h3
          className={SECTION_SUBHEADING_CLASSES}
          data-testid="session-provenance-hooks-title"
        >
          {t("agentOrgs.sessionProvenance.title")}
        </h3>
      ) : null}
      <HookPlatformsTable />
      <RecentSignalsTable />
    </div>
  );
};

export default SessionProvenanceHooksPanel;
