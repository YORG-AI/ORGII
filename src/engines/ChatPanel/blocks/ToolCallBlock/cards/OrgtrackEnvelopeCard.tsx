import { useSetAtom } from "jotai";
import { CheckCircle2, ChevronRight, XCircle } from "lucide-react";
import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { parseCloudOrgSelectorValue } from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import { useWorkStationTabs } from "@src/hooks/workStation/tabs";
import { activeStationChatVisibleAtom } from "@src/store/ui/chatPanelAtom";
import { stationModeAtom } from "@src/store/ui/simulatorAtom";
import { createWorkItemDetailTab } from "@src/store/workstation";

import type { OrgtrackEnvelopeData } from "../types";
import {
  ToolResultCardFrame,
  ToolResultCardFrameButton,
} from "./ToolResultCardFrame";

interface OrgtrackEnvelopeCardProps {
  card: OrgtrackEnvelopeData;
}

const NAVIGABLE_WORK_ITEM_OPERATIONS = new Set(["work.create", "work.update"]);

export interface WorkItemNavigationTarget {
  shortId: string;
  title: string;
  status: string;
  projectId?: string;
  projectName?: string;
  projectSlug?: string;
  orgId?: string;
}

function normalizeWorkItemOrgId(orgId: string | undefined): string | undefined {
  if (!orgId) return undefined;
  let normalized = orgId;
  // Historical and imported session rows may already contain a selector and
  // then pass through another selector-producing boundary. Strip every
  // namespace layer; the project API always wants the underlying org id.
  let parsed = parseCloudOrgSelectorValue(normalized);
  while (parsed && parsed !== normalized) {
    normalized = parsed;
    parsed = parseCloudOrgSelectorValue(normalized);
  }
  return normalized;
}

export function buildWorkItemNavigationTarget(
  card: OrgtrackEnvelopeData
): WorkItemNavigationTarget | null {
  if (
    !card.ok ||
    !NAVIGABLE_WORK_ITEM_OPERATIONS.has(card.operationId) ||
    !card.workItem ||
    (!card.isStandalone && !card.projectSlug)
  ) {
    return null;
  }

  return {
    shortId: card.workItem.frontmatter.short_id,
    title: card.workItem.frontmatter.title,
    status: card.workItem.frontmatter.status,
    projectId: card.isStandalone
      ? undefined
      : (card.projectId ?? card.workItem.frontmatter.project),
    projectSlug: card.isStandalone ? undefined : card.projectSlug,
    projectName: card.isStandalone
      ? undefined
      : (card.projectName ?? card.projectSlug),
    // Session rows store cloud orgs in selector form (`cloud:<id>`), while
    // Work Item APIs take the raw organization id. Normalize at the navigation
    // boundary so a My Station detail tab does not briefly open and then fall
    // back to an empty result.
    orgId: normalizeWorkItemOrgId(card.orgId),
  };
}

const OrgtrackEnvelopeCard: React.FC<OrgtrackEnvelopeCardProps> = ({
  card,
}) => {
  const { t } = useTranslation("common");
  const { openTab: openStationTab } = useWorkStationTabs();
  const setStationMode = useSetAtom(stationModeAtom);
  const setStationChatVisible = useSetAtom(activeStationChatVisibleAtom);
  const target = useMemo(() => buildWorkItemNavigationTarget(card), [card]);
  const handleOpen = useCallback(() => {
    if (!target) return;
    setStationMode("my-station");
    setStationChatVisible("my-station", true);
    openStationTab(
      createWorkItemDetailTab(
        target.projectId,
        target.projectName,
        target.shortId,
        target.title,
        target.projectSlug,
        undefined,
        undefined,
        target.status,
        target.orgId
      )
    );
  }, [openStationTab, setStationChatVisible, setStationMode, target]);
  const detail = card.ok
    ? card.itemCount !== undefined
      ? `${card.itemCount} item${card.itemCount === 1 ? "" : "s"}`
      : [card.shortId, card.title, card.status ? `→ ${card.status}` : null]
          .filter(Boolean)
          .join(" · ")
    : (card.errorMessage ?? card.errorCode ?? "error");

  const content = (
    <>
      <div className="flex items-center gap-2 border-b border-fill-4 px-3 py-2">
        {card.ok ? (
          <CheckCircle2 size={12} className="shrink-0 text-success-6" />
        ) : (
          <XCircle size={12} className="shrink-0 text-danger-6" />
        )}
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-text-2">
          {card.operation}
        </span>
        {!card.ok && card.errorCode ? (
          <span className="shrink-0 text-xs text-danger-6">
            {card.errorCode}
            {card.retryable ? " · retryable" : ""}
          </span>
        ) : null}
        {target ? (
          <ChevronRight
            size={14}
            className="shrink-0 text-text-4"
            aria-hidden
          />
        ) : null}
      </div>
      {detail ? (
        <div className="px-3 py-2">
          <p className="chat-block-content text-xs text-text-2">{detail}</p>
        </div>
      ) : null}
    </>
  );

  if (target) {
    return (
      <ToolResultCardFrameButton
        padded={false}
        className="overflow-hidden"
        data-testid="work-item-result-card"
        data-work-item-id={target.shortId}
        aria-label={`${t("teamInbox.actions.openWorkItem")}: ${target.shortId}`}
        onClick={handleOpen}
      >
        {content}
      </ToolResultCardFrameButton>
    );
  }

  return (
    <ToolResultCardFrame
      padded={false}
      hoverable={false}
      className="overflow-hidden"
    >
      {content}
    </ToolResultCardFrame>
  );
};

OrgtrackEnvelopeCard.displayName = "OrgtrackEnvelopeCard";

export default OrgtrackEnvelopeCard;
