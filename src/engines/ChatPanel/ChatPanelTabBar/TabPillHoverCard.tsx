/**
 * TabPillHoverCard — entity preview wrapper for a chat-panel tab pill.
 *
 * Keep entity-preview selection in one place as new tab types are added.
 */
import React from "react";

import PrHoverCard from "@src/components/PrHoverCard";
import SessionHoverCard from "@src/components/SessionHoverCard";
import WorkItemHoverCard from "@src/modules/ProjectManager/WorkItems/components/WorkItemHoverCard";
import type { ChatPanelTab } from "@src/store/chatPanel/chatPanelTabsAtom";

import {
  getPrHoverCardData,
  getWorkItemHoverCardData,
} from "./tabPillHoverCardData";

interface TabPillHoverCardProps {
  tab: ChatPanelTab;
  children: React.ReactElement;
}

export const TabPillHoverCard: React.FC<TabPillHoverCardProps> = ({
  tab,
  children,
}) => {
  if (tab.type === "session" && tab.sessionId) {
    return (
      <SessionHoverCard sessionId={tab.sessionId} position="bottom-start">
        {children}
      </SessionHoverCard>
    );
  }
  if (tab.type === "work-item" && tab.workItem) {
    return (
      <WorkItemHoverCard
        workItem={getWorkItemHoverCardData(tab.workItem)}
        position="bottom-start"
      >
        {children}
      </WorkItemHoverCard>
    );
  }
  if (tab.type === "github-pr" && tab.githubPr) {
    return (
      <PrHoverCard
        pr={getPrHoverCardData(tab.githubPr)}
        position="bottom-start"
      >
        {children}
      </PrHoverCard>
    );
  }
  return children;
};
