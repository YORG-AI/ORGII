import React from "react";
import { useTranslation } from "react-i18next";

import type {
  LinearProjectSummary,
  LinearWorkflowStateCreateRequest,
  LinearWorkflowStateSummary,
  LinearWorkflowStateUpdateRequest,
} from "@src/api/http/integrations";

import LinearWorkflowStatesSection from "../LinearWorkflowStatesSection";

interface LinearProjectSettingsProps {
  project: LinearProjectSummary;
  states: LinearWorkflowStateSummary[];
  loadingStates: boolean;
  savingStateId: string | null;
  onRefreshStates: () => void;
  onCreateState: (request: LinearWorkflowStateCreateRequest) => Promise<void>;
  onUpdateState: (
    stateId: string,
    request: LinearWorkflowStateUpdateRequest
  ) => Promise<void>;
  onArchiveState: (stateId: string) => Promise<void>;
}

const LinearProjectSettings: React.FC<LinearProjectSettingsProps> = ({
  project,
  states,
  loadingStates,
  savingStateId,
  onRefreshStates,
  onCreateState,
  onUpdateState,
  onArchiveState,
}) => {
  const { t } = useTranslation("projects");
  const primaryTeam = project.teams[0];

  return (
    <main className="scrollbar-hide h-full overflow-x-hidden overflow-y-auto p-5">
      <section className="mx-auto max-w-3xl rounded-lg border border-border-1 bg-fill-1 p-5 shadow-xs">
        <div className="mb-4 border-b border-border-1 pb-4">
          <div className="text-sm font-semibold text-text-1">
            {t("workItems.tabs.settings")}
          </div>
          <div className="mt-1 text-xs text-text-3">
            {primaryTeam
              ? `${project.name} · ${primaryTeam.name} · ${primaryTeam.key}`
              : project.name}
          </div>
        </div>
        <LinearWorkflowStatesSection
          team={primaryTeam}
          states={states}
          loadingStates={loadingStates}
          savingStateId={savingStateId}
          onRefreshStates={onRefreshStates}
          onCreateState={onCreateState}
          onUpdateState={onUpdateState}
          onArchiveState={onArchiveState}
        />
      </section>
    </main>
  );
};

export default LinearProjectSettings;
