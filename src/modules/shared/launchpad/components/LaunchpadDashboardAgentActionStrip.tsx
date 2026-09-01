/**
 * LaunchpadDashboardAgentActionStrip — inline launch/details actions shown
 * beneath a selected agent tile in the Launchpad dashboard's Agents section.
 *
 * Extracted from LaunchpadDashboard.tsx to keep it under 600 lines.
 */
import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { ExpandIcon, HugeiconsIcon, PlayIcon } from "@src/icons";

export interface LaunchpadAgentAction {
  key: string;
  label: string;
  icon: React.ReactNode;
  onLaunch: () => void;
  onOpenDetails: () => void;
}

interface LaunchpadAgentActionStripProps {
  agent: LaunchpadAgentAction;
}

export const LaunchpadAgentActionStrip: React.FC<LaunchpadAgentActionStripProps> =
  memo(({ agent }) => {
    const { t } = useTranslation("navigation");

    return (
      <div className="w-full min-w-0 overflow-hidden rounded-full bg-fill-1 px-2 py-1.5">
        <div className="scrollbar-hide flex w-full min-w-0 items-center gap-1.5 overflow-x-auto">
          <Button
            variant="primary"
            size="small"
            shape="round"
            className="shrink-0"
            icon={<HugeiconsIcon icon={PlayIcon} data-icon="play" size={14} />}
            onClick={agent.onLaunch}
          >
            {t("navigation:launchpad.actions.startSession", {
              defaultValue: "Start session",
            })}
          </Button>
          <Button
            variant="secondary"
            size="small"
            shape="round"
            className="shrink-0"
            icon={
              <HugeiconsIcon icon={ExpandIcon} data-icon="expand" size={14} />
            }
            onClick={agent.onOpenDetails}
          >
            {t("navigation:launchpad.actions.openDetails", {
              defaultValue: "Open details",
            })}
          </Button>
        </div>
      </div>
    );
  });
LaunchpadAgentActionStrip.displayName = "LaunchpadAgentActionStrip";
