import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import { COMPOSER_BOTTOM_DOCK_PADDING_CLASS } from "@src/config/composerStackTokens";
import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";

import SessionReadOnlyBar from "./InputArea/components/SessionReadOnlyBar";

interface AgentOrgArchivedComposerProps {
  composerRef: React.Ref<HTMLDivElement>;
}

const AgentOrgArchivedComposer: React.FC<AgentOrgArchivedComposerProps> = memo(
  ({ composerRef }) => {
    const { t } = useTranslation("sessions");
    return (
      <div
        ref={composerRef}
        className={`absolute bottom-0 left-0 right-0 z-50 flex w-full flex-shrink-0 flex-col items-center px-2 pt-1 ${COMPOSER_BOTTOM_DOCK_PADDING_CLASS}`}
        data-testid="agent-org-archived-composer"
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 top-[-28px] bg-gradient-to-t from-chat-pane via-chat-pane/90 to-transparent"
        />
        <div
          className={`relative z-10 w-full ${DETAIL_PANEL_TOKENS.contentMaxWidth}`}
        >
          <SessionReadOnlyBar
            label={t("planner.agentOrgOverview.archivedReadOnly", {
              defaultValue: "Archived — history is read-only",
            })}
          />
        </div>
      </div>
    );
  }
);

AgentOrgArchivedComposer.displayName = "AgentOrgArchivedComposer";

export default AgentOrgArchivedComposer;
