import React from "react";
import { useTranslation } from "react-i18next";

import { getEventIcon } from "@src/config/toolIcons";
import {
  EventBlockHeader,
  EventBlockHeaderIcon,
  EventBlockHeaderSubtitle,
  EventBlockHeaderTitle,
  getEventBlockContainerClasses,
} from "@src/engines/ChatPanel/blocks/primitives";
import { useBlockHeader } from "@src/engines/ChatPanel/blocks/useBlockLocate";
import type { EventStatus } from "@src/engines/SessionCore/rendering/types/universalProps";

import CanvasRevisionSteps from "./CanvasRevisionSteps";
import { CANVAS_REVISION_TOOL_NAME } from "./canvasRevision";
import {
  type CanvasRevisionActivityPhase,
  summarizeCanvasRevisionActivity,
} from "./canvasRevisionActivityState";
import { formatCanvasRevisionCharacterCount } from "./canvasRevisionProgressState";

interface CanvasRevisionActivityProps {
  args: Record<string, unknown>;
  status: EventStatus;
  eventId?: string;
  errorDetail?: string;
}

function phaseForStatus(status: EventStatus): CanvasRevisionActivityPhase {
  switch (status) {
    case "pending":
    case "running":
      return "applying";
    case "success":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

const CanvasRevisionActivity: React.FC<CanvasRevisionActivityProps> = ({
  args,
  status,
  eventId,
  errorDetail,
}) => {
  const { t } = useTranslation("sessions");
  const { handleLocate } = useBlockHeader({ eventId });
  const handleNavigate = eventId ? handleLocate : undefined;
  const summary = summarizeCanvasRevisionActivity(args);
  const canvasTitle = summary.title || t("canvasApp.revisionCanvas", "Canvas");
  const phase = phaseForStatus(status);
  const isLoading = status === "pending" || status === "running";
  const isFailed = status === "failed" || status === "cancelled";
  const title = isLoading
    ? t("canvasApp.revisionTitle", "Updating {{title}}", { title: canvasTitle })
    : isFailed
      ? t("canvasApp.revisionFailedTitle", "Couldn’t update {{title}}", {
          title: canvasTitle,
        })
      : t("canvasApp.revisionDoneTitle", "Updated {{title}}", {
          title: canvasTitle,
        });
  const detail = errorDetail?.trim()
    ? errorDetail.trim()
    : summary.changeKind === "targeted"
      ? t(
          "canvasApp.revisionTargetedSummary",
          "{{amount}} targeted changes · same Canvas",
          {
            amount: summary.editCount,
          }
        )
      : summary.changeKind === "replacement"
        ? t(
            "canvasApp.revisionReplacementSummary",
            "Full replacement · {{amount}} characters · same Canvas",
            {
              amount: formatCanvasRevisionCharacterCount(
                summary.payloadCharacters
              ),
            }
          )
        : summary.changeKind === "url"
          ? t("canvasApp.revisionUrlSummary", "URL updated · same Canvas")
          : t(
              "canvasApp.revisionGenericSummary",
              "Existing Canvas updated in place"
            );

  return (
    <div
      className={getEventBlockContainerClasses(false)}
      data-testid="canvas-revision-activity"
      data-tool-call-event-id={eventId}
      data-tool-call-name={CANVAS_REVISION_TOOL_NAME}
    >
      <EventBlockHeader
        isCollapsed={false}
        withHover={false}
        onClick={handleNavigate}
        onNavigate={handleNavigate}
      >
        <EventBlockHeaderIcon
          icon={getEventIcon(CANVAS_REVISION_TOOL_NAME, {
            className: isFailed ? "text-danger-6" : "text-primary-6",
          })}
          hasContent={false}
          isLoading={isLoading}
          isFailed={isFailed}
        />
        <EventBlockHeaderTitle
          isLoading={isLoading}
          truncate
          title={title}
          className={isFailed ? "text-text-3" : ""}
        >
          <span className="block min-w-0 truncate">{title}</span>
        </EventBlockHeaderTitle>
        <EventBlockHeaderSubtitle
          title={detail}
          className={isFailed ? "text-text-3" : ""}
        >
          <span className="block min-w-0 truncate">{detail}</span>
        </EventBlockHeaderSubtitle>
      </EventBlockHeader>
      {summary.agentSteps.length > 0 && (
        <div className="ml-[14px] min-w-0 border-l border-border-1 py-0.5 pl-3">
          <CanvasRevisionSteps phase={phase} steps={summary.agentSteps} />
        </div>
      )}
    </div>
  );
};

CanvasRevisionActivity.displayName = "CanvasRevisionActivity";

export default CanvasRevisionActivity;
