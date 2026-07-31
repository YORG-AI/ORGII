/**
 * Journey Station
 *
 * First-class workstation surface (peer of Ops Control) hosting Project
 * Journeys and Session Journeys. Both scopes render through the shared
 * `JourneyContainer`, so lineage, evidence, coverage, and fail-closed
 * semantics come from the single canonical `journey_graph_query` path —
 * this surface never derives its own facts.
 */
import { useAtomValue } from "jotai";
import { GitFork } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import type { JourneyScope } from "@src/api/tauri/journeyGraph";
import { usePrimarySidebarState } from "@src/hooks/workStation/panels/useWorkStationPanels";
import { JourneyContainer } from "@src/modules/ProjectManager/JourneyGraph";
import {
  WorkStationShell,
  buildPrimarySidebarConfig,
} from "@src/modules/WorkStation/shared";
import { journeyStationSelectionAtom } from "@src/store/ui/journeyStationAtom";

import JourneyStationSidebar from "./JourneyStationSidebar";

const JourneyStationPage: React.FC = () => {
  const { t } = useTranslation(["navigation", "common"]);
  const selection = useAtomValue(journeyStationSelectionAtom);
  const {
    primarySidebarCollapsed,
    primarySidebarWidth,
    setPrimarySidebarWidth,
    closePrimarySidebar,
  } = usePrimarySidebarState();

  const mainContent = (
    <div
      className="flex h-full min-h-0 w-full flex-col overflow-hidden"
      data-testid="journey-station-page"
    >
      {selection ? (
        <JourneyContainer
          key={`${selection.kind}/${selection.id}`}
          scope={`${selection.kind}/${selection.id}` as JourneyScope}
          title={
            selection.kind === "project"
              ? `${t("navigation:journeyStation.projectJourney", {
                  defaultValue: "Project Journey",
                })}${selection.name ? ` · ${selection.name}` : ""}`
              : `${t("navigation:journeyStation.sessionJourney", {
                  defaultValue: "Session Journey",
                })}${selection.name ? ` · ${selection.name}` : ""}`
          }
        />
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-text-3">
          <GitFork size={24} strokeWidth={1.5} />
          <p className="text-sm">
            {t("navigation:journeyStation.emptyTitle", {
              defaultValue: "Select a project or session journey",
            })}
          </p>
          <p className="max-w-md px-6 text-center text-xs text-text-4">
            {t("navigation:journeyStation.emptyHint", {
              defaultValue:
                "Journeys are read-only fact graphs: every milestone, branch, and file lineage entry carries evidence and coverage.",
            })}
          </p>
        </div>
      )}
    </div>
  );

  const primarySidebarConfig = buildPrimarySidebarConfig({
    content: <JourneyStationSidebar />,
    collapsed: primarySidebarCollapsed,
    size: primarySidebarWidth,
    onSizeChange: setPrimarySidebarWidth,
    onClose: closePrimarySidebar,
  });

  return (
    <WorkStationShell
      primarySidebarConfig={primarySidebarConfig}
      content={mainContent}
      statusBar={null}
      appClassName="journey-station-workstation"
    />
  );
};

export default JourneyStationPage;
