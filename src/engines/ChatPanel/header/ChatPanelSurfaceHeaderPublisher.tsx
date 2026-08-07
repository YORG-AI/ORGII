import React, { useMemo } from "react";

import {
  ChatPanelHeaderAgentSwitch,
  ChatPanelHeaderTitlePill,
} from "./ChatPanelHeaderPrimitives";
import { usePublishChatPanelHeader } from "./usePublishChatPanelHeader";

interface ChatPanelSurfaceHeaderPublisherProps {
  title?: string;
  titleContent?: React.ReactNode;
  enabled: boolean;
  showAgentSwitch?: boolean;
  agentSwitchLabel?: string;
  agentSwitchChecked?: boolean;
  onAgentSwitchChange?: (enabled: boolean) => void;
}

export function ChatPanelSurfaceHeaderPublisher({
  title,
  titleContent,
  enabled,
  showAgentSwitch = false,
  agentSwitchLabel = "Agent",
  agentSwitchChecked = false,
  onAgentSwitchChange,
}: ChatPanelSurfaceHeaderPublisherProps): null {
  const content = useMemo(() => {
    if (!enabled) return null;

    const titleNode = titleContent ?? (
      <ChatPanelHeaderTitlePill>{title}</ChatPanelHeaderTitlePill>
    );

    return {
      content: (
        <span className="flex min-w-0 max-w-full cursor-default items-center gap-2">
          {titleNode}
          {showAgentSwitch && onAgentSwitchChange ? (
            <>
              <div
                className="h-4 w-px shrink-0 bg-border-2"
                role="separator"
                aria-hidden
              />
              <ChatPanelHeaderAgentSwitch
                checked={agentSwitchChecked}
                label={agentSwitchLabel}
                onChange={onAgentSwitchChange}
                dataTestId="chat-panel-explore-agent-search-switch"
              />
            </>
          ) : null}
        </span>
      ),
    };
  }, [
    agentSwitchChecked,
    agentSwitchLabel,
    enabled,
    onAgentSwitchChange,
    showAgentSwitch,
    title,
    titleContent,
  ]);

  usePublishChatPanelHeader({ content, enabled });
  return null;
}
