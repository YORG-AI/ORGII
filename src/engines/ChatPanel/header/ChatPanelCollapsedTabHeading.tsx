import { useAtomValue } from "jotai";
import React, { memo } from "react";

import {
  type ChatPanelTab,
  activeChatPanelTabAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";

import { useChatPanelTabDisplayTitle } from "../hooks/useChatPanelTabDisplayTitle";

const CollapsedTabHeadingLabel: React.FC<{ tab: ChatPanelTab }> = ({ tab }) => (
  <span className="truncate px-1 text-[13px] font-medium text-text-1">
    {useChatPanelTabDisplayTitle(tab)}
  </span>
);

/**
 * Names the lone surface in the collapsed 36px header.
 *
 * Only surfaces that publish no header content of their own reach this: with
 * the tab row folded away, a terminal or Launchpad tab would otherwise sit
 * under an unlabeled bar. The label is the pill's, so folding the row never
 * renames the surface.
 */
export const ChatPanelCollapsedTabHeading: React.FC = memo(() => {
  const activeTab = useAtomValue(activeChatPanelTabAtom);
  if (!activeTab) return null;
  return <CollapsedTabHeadingLabel tab={activeTab} />;
});

ChatPanelCollapsedTabHeading.displayName = "ChatPanelCollapsedTabHeading";
